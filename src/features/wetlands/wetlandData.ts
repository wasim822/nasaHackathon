import type { GeoBounds, Observation, TimeRange } from '../../types';
import type { AoiSpec } from '../flood/baseline';
import { type GridSpec, gridBounds, rowCellAreasKm2 } from '../../services/geospatial/grid';
import { type NisarFloodManifest, loadManifest, loadPassClasses, passObservation, datasetUrl } from '../flood/nisarFlood';

/** Atchafalaya Basin, Louisiana — the largest river swamp in the United States. */
export const WETLAND_AOI: AoiSpec = {
  key: 'atchafalaya',
  name: 'Atchafalaya Basin wetlands, Louisiana (USA)',
  z: 9,
  x0: 124,
  y0: 209,
  tilesX: 3,
  tilesY: 3,
  cellsPerTile: 128,
};

export const WCLASS = { NODATA: 0, OTHER: 1, OPEN: 2, VEG: 3 } as const;

export interface WetComparison {
  beforeKm2: number;
  afterKm2: number;
  commonFraction: number;
}

export interface WetFrame {
  obs: Observation;
  classes: Uint8Array;
  coverageFraction: number;
  imagedKm2: number;
  openKm2: number;
  vegKm2: number;
  /** (open water + inundated vegetation) / imaged area. */
  share: number;
  vsPrev: WetComparison | null;
}

export interface WetlandData {
  grid: GridSpec;
  bounds: GeoBounds;
  occurrence: Uint8Array;
  persistent: Uint8Array;
  frames: WetFrame[];
  maxShare: { index: number; share: number };
  method: string;
  limitations: string;
  manifest: NisarFloodManifest;
}

export const MIN_COMMON = 0.25;

const isWet = (c: number) => c === WCLASS.OPEN || c === WCLASS.VEG;

export function compareWet(a: Uint8Array, b: Uint8Array, cellArea: (i: number) => number): WetComparison {
  let before = 0, after = 0, common = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] || !b[i]) continue;
    common++;
    if (isWet(a[i])) before += cellArea(i);
    if (isWet(b[i])) after += cellArea(i);
  }
  return { beforeKm2: before, afterKm2: after, commonFraction: common / a.length };
}

export function buildWetlandData(
  grid: GridSpec,
  occurrence: Uint8Array,
  persistent: Uint8Array,
  scenes: { obs: Observation; classes: Uint8Array }[],
  manifest: NisarFloodManifest,
): WetlandData {
  const rowAreas = rowCellAreasKm2(grid);
  const cellArea = (i: number) => rowAreas[(i / grid.cols) | 0];
  const sorted = [...scenes].sort((a, b) => a.obs.time - b.obs.time);
  const frames: WetFrame[] = sorted.map(({ obs, classes }) => {
    let imaged = 0, open = 0, veg = 0, covered = 0;
    for (let i = 0; i < classes.length; i++) {
      const c = classes[i];
      if (!c) continue;
      covered++;
      const a = cellArea(i);
      imaged += a;
      if (c === WCLASS.OPEN) open += a;
      else if (c === WCLASS.VEG) veg += a;
    }
    return { obs, classes, coverageFraction: covered / classes.length, imagedKm2: imaged, openKm2: open, vegKm2: veg, share: imaged ? (open + veg) / imaged : 0, vsPrev: null };
  });
  frames.forEach((f, i) => {
    if (i > 0) f.vsPrev = compareWet(frames[i - 1].classes, f.classes, cellArea);
  });
  let maxShare = { index: -1, share: 0 };
  frames.forEach((f, i) => {
    if (f.share > maxShare.share) maxShare = { index: i, share: f.share };
  });
  return { grid, bounds: gridBounds(grid), occurrence, persistent, frames, maxShare, method: manifest.method, limitations: manifest.limitations, manifest };
}

/** Share of observed passes (up to and including `index`) in which each cell was inundated. */
export function inundationFrequency(data: WetlandData, index: number): { wet: Uint16Array; seen: Uint16Array } {
  const n = data.grid.cols * data.grid.rows;
  const wet = new Uint16Array(n);
  const seen = new Uint16Array(n);
  for (let f = 0; f <= index && f < data.frames.length; f++) {
    const c = data.frames[f].classes;
    for (let i = 0; i < n; i++) {
      if (!c[i]) continue;
      seen[i]++;
      if (isWet(c[i])) wet[i]++;
    }
  }
  return { wet, seen };
}

export async function loadWetlandScenes(range: TimeRange, cells: number, signal: AbortSignal) {
  const manifest = await loadManifest(WETLAND_AOI.key, signal, 'nisar-wetland');
  const passes = manifest.passes.filter((p) => {
    const t = passObservation(p).time;
    return t >= range.start && t <= range.end;
  });
  const [scenes, persistent] = await Promise.all([
    Promise.all(passes.map(async (p) => ({ obs: passObservation(p), classes: await loadPassClasses('nisar-wetland', WETLAND_AOI.key, p.id, cells, signal) }))),
    fetch(datasetUrl('nisar-wetland', WETLAND_AOI.key, 'persistent_bright.bin'), { signal })
      .then(async (r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array(cells)))
      .catch(() => new Uint8Array(cells)),
  ]);
  return { manifest, scenes, persistent: persistent.length === cells ? persistent : new Uint8Array(cells) };
}
