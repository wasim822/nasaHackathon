import type { GeoBounds, LatLng, TimeRange } from '../../types';

/**
 * Real NISAR products, discovered through NASA's Common Metadata Repository (CMR).
 * CMR search is public (no login) and CORS-enabled. Each product has a public,
 * geocoded browse PNG ("LATLON") hosted by the Alaska Satellite Facility (ASF DAAC).
 * Browse images are display-stretched quick-looks — not calibrated measurements.
 */
export type NisarProduct = 'GCOV' | 'GUNW';
export type NisarStatus = 'Validated' | 'Provisional';

export const NISAR_PRODUCTS: Record<NisarProduct, { label: string; description: string; collections: { shortName: string; status: NisarStatus }[]; docs: string }> = {
  GCOV: {
    label: 'Radar backscatter (L2 GCOV)',
    description: 'Geocoded L-band polarimetric backscatter. Smooth water looks dark; forests and towns look bright.',
    collections: [
      { shortName: 'NISAR_L2_GCOV_V1', status: 'Validated' },
      { shortName: 'NISAR_L2_GCOV_PROVISIONAL_V1', status: 'Provisional' },
    ],
    docs: 'https://nisar-docs.asf.alaska.edu/gcov/',
  },
  GUNW: {
    label: 'Interferogram (L2 GUNW)',
    description: 'Geocoded unwrapped interferogram between two passes. Colour cycles reveal ground motion (e.g. earthquakes) or atmospheric noise.',
    collections: [
      { shortName: 'NISAR_L2_GUNW_V1', status: 'Validated' },
      { shortName: 'NISAR_L2_GUNW_PROVISIONAL_V1', status: 'Provisional' },
    ],
    docs: 'https://nisar-docs.asf.alaska.edu/gunw/',
  },
};

export interface NisarScene {
  id: string;
  product: NisarProduct;
  status: NisarStatus;
  /** Acquisition start (GCOV) or reference/first acquisition (GUNW). */
  start: number;
  /** Acquisition end (GCOV) or secondary/second acquisition (GUNW). */
  end: number;
  /** Representative time used for timeline placement (the later acquisition). */
  time: number;
  footprint: LatLng[];
  track: number | null;
  frame: number | null;
  direction: 'Ascending' | 'Descending' | null;
  /** Repeat-pass stack key (track + direction + frame). */
  stack: string;
  browseUrl: string;
  kmlUrl: string | null;
  earthdataUrl: string;
}

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
export const NISAR_PAGE_SIZE = 150;

interface CmrEntry {
  title: string;
  time_start: string;
  time_end?: string;
  polygons?: string[][];
  boxes?: string[];
  collection_concept_id: string;
  links: { href: string; rel?: string }[];
}

export function parsePolygon(s: string): LatLng[] {
  const n = s.trim().split(/\s+/).map(Number);
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

/** NISAR names: ..._<cycle>_<track>_<A|D>_<frame>_... */
export function parseTrack(title: string): { track: number | null; direction: NisarScene['direction']; frame: number | null } {
  const m = title.match(/_(\d{3})_(\d{3})_([AD])_(\d{3})_/);
  if (!m) return { track: null, direction: null, frame: null };
  return { track: Number(m[2]), direction: m[3] === 'A' ? 'Ascending' : 'Descending', frame: Number(m[4]) };
}

export function parseCmrEntry(e: CmrEntry, product: NisarProduct, status: NisarStatus): NisarScene | null {
  const https = e.links.map((l) => l.href).filter((h) => h.startsWith('https://'));
  const browseUrl = https.find((h) => h.includes('/BROWSE/') && h.endsWith('_LATLON.png'));
  const poly = e.polygons?.[0]?.[0];
  if (!browseUrl || !poly) return null;
  const start = Date.parse(e.time_start);
  const end = e.time_end ? Date.parse(e.time_end) : start;
  if (!Number.isFinite(start)) return null;
  const t = parseTrack(e.title);
  return {
    id: e.title,
    product,
    status,
    start,
    end: Number.isFinite(end) ? end : start,
    time: product === 'GUNW' && Number.isFinite(end) ? end : start,
    footprint: parsePolygon(poly),
    ...t,
    stack: `${t.track ?? '?'}-${t.direction ?? '?'}-${t.frame ?? '?'}`,
    browseUrl,
    kmlUrl: https.find((h) => h.includes('/BROWSE/') && h.endsWith('_LATLON.kml')) ?? null,
    earthdataUrl: `https://search.earthdata.nasa.gov/search/granules?p=${encodeURIComponent(e.collection_concept_id)}&q=${encodeURIComponent(e.title)}`,
  };
}

function clampBounds(b: GeoBounds): GeoBounds {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { west: c(b.west, -180, 180), east: c(b.east, -180, 180), south: c(b.south, -90, 90), north: c(b.north, -90, 90) };
}

export interface NisarSearchResult {
  scenes: NisarScene[];
  truncated: boolean;
}

export async function searchNisar(product: NisarProduct, bounds: GeoBounds, range: TimeRange, signal: AbortSignal, maxPages = 1): Promise<NisarSearchResult> {
  const b = clampBounds(bounds);
  const temporal = `${new Date(range.start).toISOString()},${new Date(range.end).toISOString()}`;
  const results = await Promise.all(
    NISAR_PRODUCTS[product].collections.map(async ({ shortName, status }) => {
      const scenes: NisarScene[] = [];
      let hits = 0;
      for (let page = 1; page <= maxPages; page++) {
        const params = new URLSearchParams({
          short_name: shortName,
          bounding_box: `${b.west},${b.south},${b.east},${b.north}`,
          temporal,
          page_size: String(NISAR_PAGE_SIZE),
          page_num: String(page),
          sort_key: '-start_date',
        });
        const res = await fetch(`${CMR}?${params}`, { signal });
        if (!res.ok) throw new Error(`NASA CMR search failed (HTTP ${res.status})`);
        hits = Number(res.headers.get('CMR-Hits') ?? '0');
        const json = (await res.json()) as { feed: { entry: CmrEntry[] } };
        scenes.push(...json.feed.entry.map((e) => parseCmrEntry(e, product, status)).filter((x): x is NisarScene => !!x));
        if (json.feed.entry.length < NISAR_PAGE_SIZE || page * NISAR_PAGE_SIZE >= hits) break;
      }
      // Newest first, so truncation drops the oldest products.
      return { scenes, truncated: hits > maxPages * NISAR_PAGE_SIZE };
    }),
  );
  // A validated product supersedes a provisional one of the same acquisition.
  const byKey = new Map<string, NisarScene>();
  for (const s of results.flatMap((r) => r.scenes)) {
    const key = `${s.stack}|${s.start}|${s.end}`;
    const prev = byKey.get(key);
    if (!prev || (prev.status === 'Provisional' && s.status === 'Validated')) byKey.set(key, s);
  }
  return {
    scenes: [...byKey.values()].sort((a, b) => a.time - b.time),
    truncated: results.some((r) => r.truncated),
  };
}

/** One satellite pass: adjoining product frames from the same track, direction and minutes. */
export interface NisarPass {
  id: string;
  product: NisarProduct;
  /** Timeline time: first acquisition start (GCOV) or the later acquisition (GUNW). */
  time: number;
  start: number;
  end: number;
  track: number | null;
  direction: NisarScene['direction'];
  /** Validated only if every frame is. */
  status: NisarStatus;
  scenes: NisarScene[];
}

/** Frames whose acquisitions are within this of the previous frame's belong to the same pass. */
const SAME_PASS_MS = 15 * 60 * 1000;

/**
 * Groups scenes into passes in time order. Frames of one pass are acquired seconds apart along
 * the orbit; the next pass over the same area is hours or days later.
 */
export function groupPasses(scenes: NisarScene[]): NisarPass[] {
  const sorted = [...scenes].sort((a, b) => a.start - b.start || (a.frame ?? 0) - (b.frame ?? 0));
  const open: NisarPass[] = [];
  const out: NisarPass[] = [];
  for (const s of sorted) {
    const p = open.find(
      (q) => q.track === s.track && q.direction === s.direction && q.product === s.product
        && Math.abs(s.start - q.scenes[q.scenes.length - 1].start) <= SAME_PASS_MS
        && Math.abs(s.end - q.scenes[q.scenes.length - 1].end) <= SAME_PASS_MS,
    );
    if (p) {
      p.scenes.push(s);
      p.start = Math.min(p.start, s.start);
      p.end = Math.max(p.end, s.end);
      p.time = s.product === 'GUNW' ? Math.max(p.time, s.time) : p.start;
      if (s.status !== 'Validated') p.status = 'Provisional';
      continue;
    }
    const np: NisarPass = {
      id: `pass:${s.id}`, product: s.product, time: s.time, start: s.start, end: s.end,
      track: s.track, direction: s.direction, status: s.status, scenes: [s],
    };
    open.push(np);
    out.push(np);
    // Passes older than the window can't receive more frames.
    for (let i = open.length - 1; i >= 0; i--) if (s.start - open[i].start > SAME_PASS_MS * 2) open.splice(i, 1);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Ray-casting point-in-polygon on [lat, lng] rings (footprints don't cross the antimeridian here). */
export function pointInPolygon([lat, lng]: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Scenes (of the given passes) whose footprint contains the point. */
export function scenesAt(passes: NisarPass[], at: LatLng): { pass: NisarPass; scene: NisarScene }[] {
  const out: { pass: NisarPass; scene: NisarScene }[] = [];
  for (const pass of passes) {
    const scene = pass.scenes.find((s) => s.footprint.length > 2 && pointInPolygon(at, s.footprint));
    if (scene) out.push({ pass, scene });
  }
  return out;
}
