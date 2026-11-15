import type { GeoBounds, Observation, TimelineEvent } from '../../types';
import { labelComponents } from '../../services/geospatial/components';
import { type GridSpec, gridBounds, rowCellAreasKm2 } from '../../services/geospatial/grid';
import {
  DEFAULT_TRACKING,
  type TrackedBlob,
  type Track,
  type TrackEnd,
  trackComponents,
} from '../../services/geospatial/tracking';
import type { WaterBaseline } from './baseline';
import type { DemoScene } from './demoScenario';

export const CLASS = { NODATA: 0, LAND: 1, PERMANENT: 2, FLOOD: 3 } as const;

export interface FloodOptions {
  /** JRC occurrence (%) at or above which a cell is treated as permanent water. */
  permanentThreshold: number;
  /** Connected regions smaller than this many cells are removed as noise. */
  minBlobCells: number;
  /** 'opera' = real Sentinel-1 water maps (NASA OPERA DSWx-S1); 'nisar' = real NISAR-derived water maps; 'demo' = simulated scenes. */
  source: 'opera' | 'nisar' | 'demo';
}

export const DEFAULT_FLOOD_OPTIONS: FloodOptions = { permanentThreshold: 50, minBlobCells: 16, source: 'opera' };

export interface FloodFrame {
  obs: Observation;
  /** Per-cell class after noise removal (CLASS values). */
  classes: Uint8Array;
  labels: Int32Array;
  coverageFraction: number;
  floodKm2: number;
  permanentKm2: number;
  /** Cells flooded now that were not flooded in the previous observation. */
  newMask: Uint8Array;
  newKm2: number;
  /** Cells flooded in an earlier observation of this range that are dry now. */
  recededMask: Uint8Array;
  recededKm2: number;
  removedNoiseKm2: number;
  blobs: TrackedBlob[];
  ended: { trackId: string; reason: TrackEnd }[];
  unobserved: string[];
  /** Potential-flood area as a share of imaged, normally-dry land (comparable across coverage). */
  floodShare: number;
  /** Comparison with the previous observation over the area both imaged. */
  vsPrev: Comparison | null;
  /** Comparison with the first observation in range over the area both imaged. */
  vsBase: Comparison | null;
}

/** Potential-flood areas of two observations, restricted to cells imaged in both. */
export interface Comparison {
  beforeKm2: number;
  afterKm2: number;
  /** Fraction of the AOI imaged by both observations. */
  commonFraction: number;
}

/** Minimum shared coverage for two observations to be compared at all. */
export const MIN_COMMON_FRACTION = 0.25;

export function compareFrames(a: Pick<FloodFrame, 'classes'>, b: Pick<FloodFrame, 'classes'>, cellArea: (i: number) => number): Comparison {
  let before = 0, after = 0, common = 0;
  const n = a.classes.length;
  for (let i = 0; i < n; i++) {
    if (a.classes[i] === CLASS.NODATA || b.classes[i] === CLASS.NODATA) continue;
    common++;
    if (a.classes[i] === CLASS.FLOOD) before += cellArea(i);
    if (b.classes[i] === CLASS.FLOOD) after += cellArea(i);
  }
  return { beforeKm2: before, afterKm2: after, commonFraction: common / n };
}

export interface FloodData {
  grid: GridSpec;
  bounds: GeoBounds;
  baselineSource: WaterBaseline['source'];
  baselineNote: string;
  permanentMask: Uint8Array;
  frames: FloodFrame[];
  tracks: Record<string, Track>;
  /** Observation with the highest flood share of imaged land (coverage-independent). */
  maxExtent: { index: number; km2: number; share: number };
  options: FloodOptions;
  source: 'opera' | 'nisar' | 'demo';
  /** Plain-language description of how water was classified (real data). */
  method?: string;
  limitations?: string;
}

// ---------- deterministic noise helpers (demo synthesis only) ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(cols: number, rows: number, cell: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const gw = Math.ceil(cols / cell) + 2;
  const gh = Math.ceil(rows / cell) + 2;
  const lattice = Float32Array.from({ length: gw * gh }, () => rand());
  const out = new Float32Array(cols * rows);
  const smooth = (x: number) => x * x * (3 - 2 * x);
  for (let r = 0; r < rows; r++) {
    const gy = r / cell;
    const y0 = Math.floor(gy);
    const fy = smooth(gy - y0);
    for (let c = 0; c < cols; c++) {
      const gx = c / cell;
      const x0 = Math.floor(gx);
      const fx = smooth(gx - x0);
      const a = lattice[y0 * gw + x0];
      const b = lattice[y0 * gw + x0 + 1];
      const d = lattice[(y0 + 1) * gw + x0];
      const e = lattice[(y0 + 1) * gw + x0 + 1];
      out[r * cols + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
  }
  return out;
}

/**
 * Chamfer (≈Euclidean) distance in cells from the major historical river channels.
 * Only large connected bodies of high-occurrence water count as channels, so small
 * ponds don't sprout their own floods.
 */
function distanceToChannel(occ: Uint8Array, g: GridSpec): Float32Array {
  const { cols, rows } = g;
  const water = new Uint8Array(occ.length);
  for (let i = 0; i < occ.length; i++) water[i] = occ[i] >= 30 ? 1 : 0;
  const minChannelCells = Math.max(20, Math.round((cols * rows) / 3600));
  const { components } = labelComponents(water, g, minChannelCells);
  const dist = new Float32Array(cols * rows).fill(1e9);
  for (const comp of components) for (const c of comp.cells) dist[c] = 0;
  if (!components.length) return dist.fill(120);
  const D = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      let d = dist[i];
      if (c > 0) d = Math.min(d, dist[i - 1] + 1);
      if (r > 0) {
        d = Math.min(d, dist[i - cols] + 1);
        if (c > 0) d = Math.min(d, dist[i - cols - 1] + D);
        if (c < cols - 1) d = Math.min(d, dist[i - cols + 1] + D);
      }
      dist[i] = d;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      let d = dist[i];
      if (c < cols - 1) d = Math.min(d, dist[i + 1] + 1);
      if (r < rows - 1) {
        d = Math.min(d, dist[i + cols] + 1);
        if (c < cols - 1) d = Math.min(d, dist[i + cols + 1] + D);
        if (c > 0) d = Math.min(d, dist[i + cols - 1] + D);
      }
      dist[i] = d;
    }
  }
  return dist;
}

/** Static "terrain" factors for the demo, computed once per baseline. */
export interface DemoTerrain {
  susceptibility: Float32Array;
}

export function buildDemoTerrain(baseline: WaterBaseline): DemoTerrain {
  const { cols, rows } = baseline.grid;
  const occ = baseline.occurrence;
  const dist = distanceToChannel(occ, baseline.grid);
  const n1 = valueNoise(cols, rows, 36, 7);
  const n2 = valueNoise(cols, rows, 12, 11);
  // Two low-lying basins away from the main channel, so separate regions can appear and merge.
  const basins = [
    { c: cols * 0.3, r: rows * 0.72, s: cols * 0.06 },
    { c: cols * 0.72, r: rows * 0.25, s: cols * 0.05 },
  ];
  const susceptibility = new Float32Array(cols * rows);
  for (let i = 0; i < susceptibility.length; i++) {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    let s = Math.min(dist[i], 120) / 68;
    s *= 1 - occ[i] / 140; // historically wetter ground floods first
    s += 0.26 * (n1[i] - 0.5) + 0.07 * (n2[i] - 0.5);
    for (const b of basins) {
      const d2 = ((c - b.c) ** 2 + (r - b.r) ** 2) / (2 * b.s * b.s);
      s -= 0.5 * Math.exp(-d2);
    }
    susceptibility[i] = s;
  }
  return { susceptibility };
}

/**
 * DEMO water classification for one synthetic scene. Returns 1 = water, 0 = not water,
 * and a coverage mask. Real SAR products would replace this function.
 */
export function simulateSceneWater(
  baseline: WaterBaseline,
  terrain: DemoTerrain,
  scene: DemoScene,
): { water: Uint8Array; coverage: Uint8Array } {
  const { cols, rows } = baseline.grid;
  const water = new Uint8Array(cols * rows);
  const coverage = new Uint8Array(cols * rows);
  const rand = mulberry32(scene.seed);
  const covCols = Math.round(cols * scene.coverageWest);
  for (let i = 0; i < water.length; i++) {
    const c = i % cols;
    if (c >= covCols) continue;
    coverage[i] = 1;
    const isWater = baseline.occurrence[i] >= 50 || terrain.susceptibility[i] < scene.level;
    // Simulated speckle false-positives (single-cell noise), exercised by noise removal.
    water[i] = isWater || rand() < 0.004 ? 1 : 0;
  }
  return { water, coverage };
}

/** One observation's water map on the AOI grid (real or demo). */
export interface WaterScene {
  obs: Observation;
  /** 1 = water, 0 = not water (meaningful only where coverage = 1). */
  water: Uint8Array;
  /** 1 = cell was imaged with valid data. */
  coverage: Uint8Array;
}

export function demoWaterScenes(baseline: WaterBaseline, scenes: DemoScene[], terrain: DemoTerrain = buildDemoTerrain(baseline)): WaterScene[] {
  return scenes.map((scene) => ({ obs: scene.obs, ...simulateSceneWater(baseline, terrain, scene) }));
}

export function runFloodPipeline(baseline: WaterBaseline, scenes: WaterScene[], options: FloodOptions): FloodData {
  const g = baseline.grid;
  const n = g.cols * g.rows;
  const rowAreas = rowCellAreasKm2(g);
  const cellArea = (i: number) => rowAreas[(i / g.cols) | 0];
  const permanentMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) permanentMask[i] = baseline.occurrence[i] >= options.permanentThreshold ? 1 : 0;

  const sorted = [...scenes].sort((a, b) => a.obs.time - b.obs.time);
  const prepared = sorted.map((scene) => {
    const { water, coverage } = scene;
    const potential = new Uint8Array(n);
    for (let i = 0; i < n; i++) potential[i] = coverage[i] && water[i] && !permanentMask[i] ? 1 : 0;
    const labelled = labelComponents(potential, g, options.minBlobCells);
    return { scene, water, coverage, labelled };
  });

  const tracking = trackComponents(
    prepared.map((p) => ({
      time: p.scene.obs.time,
      labels: p.labelled.labels,
      components: p.labelled.components,
      coverage: p.coverage,
    })),
    cellArea,
    DEFAULT_TRACKING,
  );

  const everFlooded = new Uint8Array(n);
  let prevClasses: Uint8Array | null = null;
  const frames: FloodFrame[] = prepared.map((p, fi) => {
    const classes = new Uint8Array(n);
    const newMask = new Uint8Array(n);
    const recededMask = new Uint8Array(n);
    let floodKm2 = 0, permanentKm2 = 0, newKm2 = 0, recededKm2 = 0, removed = 0, covered = 0, dryKm2 = 0;
    for (let i = 0; i < n; i++) {
      if (!p.coverage[i]) continue;
      covered++;
      const a = cellArea(i);
      if (permanentMask[i]) {
        classes[i] = CLASS.PERMANENT;
        permanentKm2 += a;
      } else if (p.labelled.labels[i] > 0) {
        classes[i] = CLASS.FLOOD;
        floodKm2 += a;
        if (prevClasses && prevClasses[i] === CLASS.LAND) {
          newMask[i] = 1;
          newKm2 += a;
        }
      } else {
        classes[i] = CLASS.LAND;
        dryKm2 += a;
        if (p.water[i]) removed += a;
        if (everFlooded[i]) {
          recededMask[i] = 1;
          recededKm2 += a;
        }
      }
    }
    for (let i = 0; i < n; i++) if (classes[i] === CLASS.FLOOD) everFlooded[i] = 1;
    prevClasses = classes;
    const tf = tracking.frames[fi];
    return {
      obs: p.scene.obs,
      classes,
      labels: p.labelled.labels,
      coverageFraction: covered / n,
      floodKm2,
      permanentKm2,
      newMask,
      newKm2,
      recededMask,
      recededKm2,
      removedNoiseKm2: removed,
      blobs: tf.blobs,
      ended: tf.ended,
      unobserved: tf.unobserved,
      floodShare: floodKm2 + dryKm2 > 0 ? floodKm2 / (floodKm2 + dryKm2) : 0,
      vsPrev: null,
      vsBase: null,
    };
  });
  frames.forEach((f, i) => {
    if (i > 0) {
      f.vsPrev = compareFrames(frames[i - 1], f, cellArea);
      f.vsBase = compareFrames(frames[0], f, cellArea);
    }
  });

  let maxExtent = { index: -1, km2: 0, share: 0 };
  frames.forEach((f, i) => {
    if (f.floodShare > maxExtent.share) maxExtent = { index: i, km2: f.floodKm2, share: f.floodShare };
  });

  return {
    grid: g,
    bounds: gridBounds(g),
    baselineSource: baseline.source,
    baselineNote: baseline.note,
    permanentMask,
    frames,
    tracks: tracking.tracks,
    maxExtent,
    options,
    source: 'demo',
  };
}

export function floodTimelineEvents(data: FloodData): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  // Recession is only claimed against a fully imaged scene; a partial scene would
  // show less water simply because less area was observed.
  const peak = data.maxExtent.index;
  const rowAreas = rowCellAreasKm2(data.grid);
  const cellArea = (i: number) => rowAreas[(i / data.grid.cols) | 0];
  // Recession is only claimed over area imaged by both the peak and the later observation.
  const recessionIndex =
    peak < 0
      ? -1
      : data.frames.findIndex((f, i) => {
          if (i <= peak) return false;
          const c = compareFrames(data.frames[peak], f, cellArea);
          return c.commonFraction >= MIN_COMMON_FRACTION && c.beforeKm2 > 0 && c.afterKm2 < c.beforeKm2 * 0.9;
        });
  data.frames.forEach((f, i) => {
    const t = f.obs.time;
    const appeared = f.blobs.filter((b) => b.event === 'appeared');
    if (appeared.length) {
      events.push({
        time: t,
        type: 'appeared',
        label: i === 0
          ? `${appeared.length} region${appeared.length > 1 ? 's' : ''} present at first observation`
          : `New region${appeared.length > 1 ? 's' : ''}: ${appeared.map((b) => b.trackId).join(', ')}`,
      });
    }
    const merged = f.blobs.filter((b) => b.event === 'merged');
    for (const b of merged) events.push({ time: t, type: 'merged', label: `${b.parents.join(' + ')} merged → ${b.trackId}` });
    const split = f.blobs.filter((b) => b.event === 'split');
    const splitParents = [...new Set(split.flatMap((b) => b.parents))];
    for (const p of splitParents) {
      events.push({ time: t, type: 'split', label: `${p} split → ${split.filter((b) => b.parents.includes(p)).map((b) => b.trackId).join(', ')}` });
    }
    const c = f.vsPrev;
    if (c && c.commonFraction >= MIN_COMMON_FRACTION && c.beforeKm2 > 0 && c.afterKm2 / c.beforeKm2 > 1.25 && c.afterKm2 - c.beforeKm2 > 5) {
      events.push({ time: t, type: 'expansion', label: `Sudden expansion: +${Math.round(((c.afterKm2 - c.beforeKm2) / c.beforeKm2) * 100)}% potential flood area (area imaged by both passes)` });
    }
    if (i === data.maxExtent.index) {
      events.push({ time: t, type: 'max-extent', label: `Highest potential-flood share of imaged land (${(f.floodShare * 100).toFixed(2)}%, ${Math.round(f.floodKm2).toLocaleString()} km²)` });
    }
    if (i === recessionIndex) {
      events.push({ time: t, type: 'recession', label: 'Recession: less potential flood than at the peak, over area imaged by both' });
    }
  });
  return events.sort((a, b) => a.time - b.time);
}
