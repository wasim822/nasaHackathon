import type { GeoBounds, LatLng } from '../../types';
import type { RasterComponent } from './components';
import { haversineKm } from './grid';

export type BlobEvent = 'appeared' | 'expanded' | 'contracted' | 'stable' | 'merged' | 'split';
export type TrackEnd = 'disappeared' | 'merged' | 'split' | 'unobserved';

export interface TrackingFrame {
  time: number;
  labels: Int32Array;
  components: RasterComponent[];
  /** 1 where the frame has valid data. */
  coverage: Uint8Array;
}

export interface TrackedBlob {
  trackId: string;
  label: number;
  areaKm2: number;
  bounds: GeoBounds;
  centroid: LatLng;
  event: BlobEvent;
  /** Other track IDs involved in a merge/split this frame (absorbed parents or source). */
  parents: string[];
  gainedKm2: number;
  lostKm2: number;
  previousAreaKm2: number | null;
}

export interface TrackHistoryPoint {
  frameIndex: number;
  time: number;
  areaKm2: number;
  centroid: LatLng;
  bounds: GeoBounds;
  event: BlobEvent;
}

export interface Track {
  id: string;
  parents: string[];
  children: string[];
  history: TrackHistoryPoint[];
  end: { frameIndex: number; time: number; reason: TrackEnd } | null;
}

export interface TrackingOptions {
  idPrefix: string;
  /** Minimum intersection-over-union to link two regions. */
  minIoU: number;
  /** Alternative link criterion: overlap / smaller area. */
  minContainment: number;
  /** Maximum centroid distance between linked regions. */
  maxCentroidKm: number;
  /** Fraction of a track's last footprint that must be covered by data to evaluate it. */
  minCoverage: number;
  /** Frames a track may go unobserved (no data) before being closed. */
  maxUnobservedFrames: number;
  /** Relative area change below which a region is "stable". */
  stableTolerance: number;
  /** Share of overlap a parent/child needs to keep its ID through a merge/split. */
  dominance: number;
}

export const DEFAULT_TRACKING: TrackingOptions = {
  idPrefix: 'F',
  minIoU: 0.15,
  minContainment: 0.5,
  maxCentroidKm: 25,
  minCoverage: 0.5,
  maxUnobservedFrames: 2,
  stableTolerance: 0.1,
  dominance: 0.7,
};

export interface TrackingResult {
  frames: { blobs: TrackedBlob[]; ended: { trackId: string; reason: TrackEnd }[]; unobserved: string[] }[];
  tracks: Record<string, Track>;
}

interface ActiveTrack {
  id: string;
  cells: Int32Array;
  areaKm2: number;
  centroid: LatLng;
  bounds: GeoBounds;
  missed: number;
}

/** Approximate distance (km) from a point to a geographic box (0 if inside). */
function pointToBoundsKm(p: LatLng, b: GeoBounds): number {
  const lat = Math.min(b.north, Math.max(b.south, p[0]));
  const lng = Math.min(b.east, Math.max(b.west, p[1]));
  return haversineKm(p, [lat, lng]);
}

/**
 * Conservative overlap-based tracking. Regions are linked only when their footprints
 * overlap substantially AND centroids are close. Merges and splits produce new IDs that
 * record their parents; unmatched regions get new IDs rather than being forced onto an
 * existing track. Tracks outside a frame's data coverage are held as "unobserved"
 * instead of being declared disappeared.
 */
export function trackComponents(
  frames: TrackingFrame[],
  cellArea: (cell: number) => number,
  opts: TrackingOptions = DEFAULT_TRACKING,
): TrackingResult {
  let counter = 0;
  const newId = () => `${opts.idPrefix}-${String(++counter).padStart(3, '0')}`;
  const tracks: Record<string, Track> = {};
  let active: ActiveTrack[] = [];
  const out: TrackingResult['frames'] = [];
  let mark: Int32Array | null = null;
  let stamp = 0;

  frames.forEach((frame, fi) => {
    if (!mark) mark = new Int32Array(frame.labels.length);
    const m = mark;
    const ended: { trackId: string; reason: TrackEnd }[] = [];
    const unobserved: string[] = [];
    const candidates: ActiveTrack[] = [];
    const carried: ActiveTrack[] = [];

    for (const t of active) {
      let covered = 0;
      for (const c of t.cells) covered += frame.coverage[c];
      if (covered / t.cells.length >= opts.minCoverage) candidates.push(t);
      else if (t.missed + 1 > opts.maxUnobservedFrames) {
        ended.push({ trackId: t.id, reason: 'unobserved' });
        tracks[t.id].end = { frameIndex: fi, time: frame.time, reason: 'unobserved' };
      } else {
        carried.push({ ...t, missed: t.missed + 1 });
        unobserved.push(t.id);
      }
    }

    // Overlap areas between candidate tracks and current components.
    const byLabel = new Map<number, RasterComponent>(frame.components.map((c) => [c.label, c]));
    const overlap = new Map<string, Map<number, number>>();
    // Footprint area of each track that this frame actually imaged; comparisons use it so
    // a partially imaged scene isn't mistaken for contraction or disappearance.
    const coveredArea = new Map<string, number>();
    for (const t of candidates) {
      const row = new Map<number, number>();
      let cov = 0;
      for (const c of t.cells) {
        if (frame.coverage[c]) cov += cellArea(c);
        const l = frame.labels[c];
        if (l > 0) row.set(l, (row.get(l) ?? 0) + cellArea(c));
      }
      overlap.set(t.id, row);
      coveredArea.set(t.id, cov);
    }

    const parentsOf = new Map<number, ActiveTrack[]>();
    const childrenOf = new Map<string, RasterComponent[]>();
    for (const t of candidates) {
      for (const [label, ov] of overlap.get(t.id)!) {
        const comp = byLabel.get(label);
        if (!comp) continue;
        const tArea = coveredArea.get(t.id)!;
        const iou = ov / (tArea + comp.areaKm2 - ov);
        const containment = ov / Math.min(tArea, comp.areaKm2);
        // Elongated regions (rivers) can have distant centroids; require each centroid to
        // be near the other's measured extent instead.
        const near =
          Math.min(pointToBoundsKm(comp.centroid, t.bounds), pointToBoundsKm(t.centroid, comp.bounds)) <= opts.maxCentroidKm;
        if (near && (iou >= opts.minIoU || containment >= opts.minContainment)) {
          if (!parentsOf.has(label)) parentsOf.set(label, []);
          parentsOf.get(label)!.push(t);
          if (!childrenOf.has(t.id)) childrenOf.set(t.id, []);
          childrenOf.get(t.id)!.push(comp);
        }
      }
    }

    const blobs: TrackedBlob[] = [];
    const nextActive: ActiveTrack[] = [...carried];

    const ov = (t: ActiveTrack, comp: RasterComponent) => overlap.get(t.id)!.get(comp.label) ?? 0;
    const continued = new Set<string>();

    for (const comp of frame.components) {
      const parents = parentsOf.get(comp.label) ?? [];
      let id: string | null = null;
      let event: BlobEvent;
      let related: string[] = [];

      if (parents.length === 1 && (childrenOf.get(parents[0].id)?.length ?? 0) === 1) {
        id = parents[0].id;
        const ratio = comp.areaKm2 / Math.max(1e-9, coveredArea.get(parents[0].id)!);
        event = ratio > 1 + opts.stableTolerance ? 'expanded' : ratio < 1 - opts.stableTolerance ? 'contracted' : 'stable';
      } else if (parents.length > 1) {
        event = 'merged';
        // A parent keeps its ID only if it clearly dominates the merged region.
        const total = parents.reduce((sum, p) => sum + ov(p, comp), 0);
        const top = parents.reduce((a, b) => (ov(b, comp) > ov(a, comp) ? b : a));
        if (ov(top, comp) / total >= opts.dominance && (childrenOf.get(top.id)?.length ?? 0) === 1) {
          id = top.id;
          related = parents.filter((p) => p !== top).map((p) => p.id);
        } else {
          related = parents.map((p) => p.id);
        }
      } else if (parents.length === 1) {
        event = 'split';
        const p = parents[0];
        const kids = childrenOf.get(p.id)!;
        const total = kids.reduce((sum, k) => sum + ov(p, k), 0);
        if (ov(p, comp) / total >= opts.dominance) id = p.id;
        else related = [p.id];
      } else {
        event = 'appeared';
      }

      const isNew = id === null;
      if (id === null) {
        id = newId();
        tracks[id] = { id, parents: related, children: [], history: [], end: null };
        for (const pid of related) tracks[pid].children.push(id);
      } else {
        continued.add(id);
        // Absorbed parents of a dominant merge end here and point to the survivor.
        for (const pid of related) tracks[pid].children.push(id);
      }

      // Gained / lost area relative to parent footprint(s), within covered cells.
      stamp++;
      let parentArea = 0;
      for (const p of parents) {
        for (const c of p.cells) {
          if (frame.coverage[c] && m[c] !== stamp) {
            m[c] = stamp;
            parentArea += cellArea(c);
          }
        }
      }
      let gained = 0;
      let shared = 0;
      for (const c of comp.cells) {
        if (m[c] === stamp) shared += cellArea(c);
        else gained += cellArea(c);
      }
      const lost = parents.length ? Math.max(0, parentArea - shared) : 0;

      tracks[id].history.push({ frameIndex: fi, time: frame.time, areaKm2: comp.areaKm2, centroid: comp.centroid, bounds: comp.bounds, event });
      blobs.push({
        trackId: id,
        label: comp.label,
        areaKm2: comp.areaKm2,
        bounds: comp.bounds,
        centroid: comp.centroid,
        event,
        parents: related,
        gainedKm2: gained,
        lostKm2: lost,
        previousAreaKm2: event === 'appeared' || (isNew && event === 'split') ? null : parentArea,
      });
      nextActive.push({ id, cells: comp.cells, areaKm2: comp.areaKm2, centroid: comp.centroid, bounds: comp.bounds, missed: 0 });
    }

    for (const t of candidates) {
      if (continued.has(t.id)) continue;
      const kids = childrenOf.get(t.id) ?? [];
      const reason: TrackEnd = !kids.length ? 'disappeared' : kids.length > 1 ? 'split' : 'merged';
      ended.push({ trackId: t.id, reason });
      tracks[t.id].end = { frameIndex: fi, time: frame.time, reason };
    }

    active = nextActive;
    out.push({ blobs, ended, unobserved });
  });

  return { frames: out, tracks };
}
