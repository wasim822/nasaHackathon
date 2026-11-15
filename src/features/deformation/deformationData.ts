import type { GeoBounds, Observation, TimeRange } from '../../types';
import type { AoiSpec } from '../flood/baseline';
import { type GridSpec, gridBounds, rowCellAreasKm2 } from '../../services/geospatial/grid';

/**
 * Real ground-deformation input: per-pair line-of-sight (LOS) displacement from NISAR L2 GUNW
 * unwrapped interferograms, aggregated to the AOI grid by `server/nisar_prep.py deformation`.
 * Files: <pair>.disp.bin (int16, 0.1 mm) and <pair>.coh.bin (uint16, coherence × 1000).
 */
export const DEFORMATION_AOI: AoiSpec = {
  key: 'sjv',
  name: 'San Joaquin Valley (Tulare basin), California (USA)',
  z: 9,
  x0: 85,
  y0: 200,
  tilesX: 3,
  tilesY: 3,
  cellsPerTile: 128,
};

export interface DefPairMeta {
  id: string;
  /** Reference (first) acquisition, ISO UTC. */
  start: string;
  /** Secondary (second) acquisition, ISO UTC. */
  end: string;
  track: number;
  direction: 'Ascending' | 'Descending';
  status: 'Validated' | 'Provisional';
  granules: string[];
  validFraction: number;
  medianCoherence: number;
  referenceOffsetMm: number;
  ionosphereCorrected: boolean;
  wavelengthM: number;
  p95AbsMm: number;
}

interface LayerEncoding {
  dtype: 'int16' | 'uint16';
  scale: number;
  unit: string;
  nodata: number;
  description: string;
}

export interface DefManifest {
  kind: 'deformation';
  aoi: string;
  name: string;
  product: string;
  grid: { z: number; x0: number; y0: number; tilesX: number; tilesY: number; cellsPerTile: number };
  generated: string;
  range: { start: string; end: string };
  layers: { disp: LayerEncoding; coh: LayerEncoding };
  method: string;
  limitations: string;
  frames: DefPairMeta[];
}

export interface DefFrame {
  obs: Observation;
  meta: DefPairMeta;
  refTime: number;
  secTime: number;
  /** LOS displacement in mm, NaN = no data. Positive = toward the satellite. */
  disp: Float32Array;
  /** Mean coherence 0–1, NaN = no data. */
  coh: Float32Array;
  validFraction: number;
  validKm2: number;
  /** Running sum of consecutive pairs on this track (mm); NaN where any pair in the chain lacks data. */
  cumulative: Float32Array;
  /** Reference time of the first pair in this frame's chain. */
  chainStart: number;
  /** Number of pairs summed into `cumulative` (1 = just this pair). */
  chainPairs: number;
  cumValidKm2: number;
  /** Area (km²) where cumulative LOS ≤ −threshold (moving away from the satellite). */
  cumAwayKm2: number;
  /** 5th percentile of cumulative LOS (mm): the strongest motion away from the satellite. */
  cumP05Mm: number;
}

export interface DeformationData {
  grid: GridSpec;
  bounds: GeoBounds;
  frames: DefFrame[];
  awayThresholdMm: number;
  manifest: DefManifest;
}

export const AWAY_THRESHOLD_MM = 20;

const parseUtc = (s: string) => Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
const DAY = 864e5;
/** Chained pairs must share an acquisition: the next reference within a day of the previous secondary. */
const CHAIN_TOLERANCE_MS = DAY;

export function decodeGrid(buf: ArrayBuffer, enc: LayerEncoding, cells: number): Float32Array {
  const src = enc.dtype === 'int16' ? new Int16Array(buf) : new Uint16Array(buf);
  if (src.length !== cells) throw new Error(`Expected ${cells} cells, got ${src.length}`);
  const out = new Float32Array(cells);
  for (let i = 0; i < cells; i++) out[i] = src[i] === enc.nodata ? NaN : src[i] * enc.scale;
  return out;
}

export function pairObservation(m: DefPairMeta): Observation {
  const ref = parseUtc(m.start);
  const sec = parseUtc(m.end);
  const days = Math.round((sec - ref) / DAY);
  return {
    id: `gunw-${m.id}`,
    // A pair "observes" the motion that happened up to its second acquisition.
    time: sec,
    kind: 'observed',
    label: `NISAR L2 GUNW pair · ${days}-day · ${m.direction} T${m.track}`,
    quality: {
      Product: 'NISAR L2 GUNW · L-band HH unwrapped interferogram',
      Status: m.status,
      Orbit: `${m.direction} · track ${m.track}`,
      'Reference acquisition': m.start.slice(0, 16).replace('T', ' ') + ' UTC',
      'Temporal baseline': `${days} days`,
      'Valid area': `${Math.round(m.validFraction * 100)}%`,
      'Median coherence': m.medianCoherence.toFixed(2),
      'Ionosphere corrected': m.ionosphereCorrected ? 'Yes' : 'No',
      'Noise level (95th pct |LOS|)': `${m.p95AbsMm.toFixed(1)} mm`,
    },
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/**
 * Orders pairs by second acquisition and sums consecutive pairs per track into a running
 * cumulative LOS. A chain restarts when a track has a gap (next pair doesn't start where the
 * previous one ended), so missing pairs are never bridged by assumption.
 */
export function buildDeformationData(
  grid: GridSpec,
  pairs: { meta: DefPairMeta; disp: Float32Array; coh: Float32Array }[],
  manifest: DefManifest,
  awayThresholdMm = AWAY_THRESHOLD_MM,
): DeformationData {
  const rowAreas = rowCellAreasKm2(grid);
  const n = grid.cols * grid.rows;
  const cellArea = (i: number) => rowAreas[(i / grid.cols) | 0];
  const sorted = [...pairs].sort((a, b) => parseUtc(a.meta.end) - parseUtc(b.meta.end) || a.meta.track - b.meta.track);
  const lastOnTrack = new Map<string, DefFrame>();
  const frames: DefFrame[] = sorted.map(({ meta, disp, coh }) => {
    const refTime = parseUtc(meta.start);
    const secTime = parseUtc(meta.end);
    const key = `${meta.track}${meta.direction}`;
    const prev = lastOnTrack.get(key);
    const chained = !!prev && Math.abs(refTime - prev.secTime) <= CHAIN_TOLERANCE_MS;
    const cumulative = new Float32Array(n);
    let valid = 0, validKm2 = 0, cumValidKm2 = 0, cumAwayKm2 = 0;
    const cumValues: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = disp[i];
      if (Number.isFinite(d)) {
        valid++;
        validKm2 += cellArea(i);
      }
      const c = chained ? prev!.cumulative[i] + d : d;
      cumulative[i] = c;
      if (Number.isFinite(c)) {
        cumValidKm2 += cellArea(i);
        cumValues.push(c);
        if (c <= -awayThresholdMm) cumAwayKm2 += cellArea(i);
      }
    }
    const frame: DefFrame = {
      obs: pairObservation(meta),
      meta,
      refTime,
      secTime,
      disp,
      coh,
      validFraction: valid / n,
      validKm2,
      cumulative,
      chainStart: chained ? prev!.chainStart : refTime,
      chainPairs: chained ? prev!.chainPairs + 1 : 1,
      cumValidKm2,
      cumAwayKm2,
      cumP05Mm: percentile(cumValues, 5),
    };
    lastOnTrack.set(key, frame);
    return frame;
  });
  return { grid, bounds: gridBounds(grid), frames, awayThresholdMm, manifest };
}

const base = () => `${import.meta.env.BASE_URL ?? '/'}data/nisar-deformation/${DEFORMATION_AOI.key}/`;

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
  const r = await fetch(url, { signal });
  // Dev servers answer missing files with the HTML app shell (200), so reject HTML too.
  if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`HTTP ${r.status} for ${url}`);
  return r;
}

export async function loadDeformationPairs(range: TimeRange, cells: number, signal: AbortSignal) {
  let manifest: DefManifest;
  try {
    manifest = (await (await fetchOk(`${base()}manifest.json`, signal)).json()) as DefManifest;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('No processed NISAR deformation data found. Run: server/.venv/Scripts/python server/nisar_prep.py deformation --start … --end …');
  }
  // A pair belongs to the range when both of its acquisitions do.
  const inRange = manifest.frames.filter((f) => parseUtc(f.start) >= range.start && parseUtc(f.end) <= range.end);
  const pairs = await Promise.all(
    inRange.map(async (meta) => {
      const [d, c] = await Promise.all([
        fetchOk(`${base()}${meta.id}.disp.bin`, signal).then((r) => r.arrayBuffer()),
        fetchOk(`${base()}${meta.id}.coh.bin`, signal).then((r) => r.arrayBuffer()),
      ]);
      return { meta, disp: decodeGrid(d, manifest.layers.disp, cells), coh: decodeGrid(c, manifest.layers.coh, cells) };
    }),
  );
  return { manifest, pairs };
}
