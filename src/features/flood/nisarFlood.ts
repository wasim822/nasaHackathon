import type { Observation, TimeRange } from '../../types';
import type { WaterScene } from './pipeline';

/**
 * Real flood input: per-pass water maps derived from NISAR L2 GCOV backscatter by
 * server/flood_prep.py (run locally with an Earthdata token) and saved as static files.
 * Each .bin holds one uint8 per AOI grid cell: 0 = no data, 1 = dry, 2 = water.
 */
export interface NisarFloodPass {
  id: string;
  time: string;
  track: number;
  direction: 'Ascending' | 'Descending';
  status: 'Validated' | 'Provisional';
  granules: string[];
  coverage: number;
  waterFraction: number;
  inundatedVegFraction?: number;
  threshold_hh_db: number | null;
  separation_hh_db: number | null;
  threshold_hv_db: number | null;
  separation_hv_db: number | null;
  channels: string;
  frames: number;
}

export interface NisarFloodManifest {
  aoi: string;
  name: string;
  grid: { z: number; x0: number; y0: number; tilesX: number; tilesY: number; cellsPerTile: number };
  generated: string;
  range: { start: string; end: string };
  product: string;
  classes?: Record<string, string>;
  method: string;
  limitations: string;
  passes: NisarFloodPass[];
}

/** Data folders written by server/flood_prep.py. */
export type NisarDataset = 'nisar-flood' | 'nisar-wetland';

export const datasetUrl = (dataset: NisarDataset, aoi: string, file: string) =>
  `${import.meta.env.BASE_URL ?? '/'}data/${dataset}/${aoi}/${file}`;

const manifestCache = new Map<string, Promise<NisarFloodManifest>>();

export function loadManifest(aoi: string, signal: AbortSignal, dataset: NisarDataset = 'nisar-flood'): Promise<NisarFloodManifest> {
  const key = `${dataset}/${aoi}`;
  let p = manifestCache.get(key);
  if (!p) {
    const req = fetch(datasetUrl(dataset, aoi, 'manifest.json'), { signal }).then(async (r) => {
      // Dev servers answer missing files with the HTML app shell (200), so reject HTML too.
      if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) {
        throw new Error(`No processed NISAR data found for ${aoi} (HTTP ${r.status}). Run: npm run prep:flood -- --aoi ${aoi} --start … --end …`);
      }
      return (await r.json()) as NisarFloodManifest;
    });
    manifestCache.set(key, req);
    req.catch(() => {
      if (manifestCache.get(key) === req) manifestCache.delete(key);
    });
    p = req;
  }
  return p;
}

/** Fetches one pass's class grid (0 no data, 1 other, 2 open water, 3 possible inundated vegetation). */
export async function loadPassClasses(dataset: NisarDataset, aoi: string, id: string, cells: number, signal: AbortSignal): Promise<Uint8Array> {
  const r = await fetch(datasetUrl(dataset, aoi, `${id}.bin`), { signal });
  if (!r.ok) throw new Error(`Missing NISAR map ${id} (HTTP ${r.status})`);
  const cls = new Uint8Array(await r.arrayBuffer());
  if (cls.length !== cells) throw new Error(`NISAR map ${id} has ${cls.length} cells, expected ${cells}`);
  return cls;
}

export function passObservation(p: NisarFloodPass): Observation {
  const q: Record<string, string> = {
    Product: 'NISAR L2 GCOV · L-band · 80 m (frequency B)',
    Status: p.status,
    Orbit: `${p.direction} · track ${p.track}`,
    'Area imaged': `${Math.round(p.coverage * 100)}%`,
    Channels: p.channels,
  };
  if (p.threshold_hh_db != null) q['HH water threshold'] = `${p.threshold_hh_db.toFixed(1)} dB`;
  if (p.threshold_hv_db != null) q['HV water threshold'] = `${p.threshold_hv_db.toFixed(1)} dB`;
  if (p.separation_hh_db != null) q['Water/land contrast (HH)'] = `${p.separation_hh_db.toFixed(1)} dB`;
  return {
    id: `nisar-${p.id}`,
    time: Date.parse(p.time.endsWith('Z') ? p.time : `${p.time}Z`),
    kind: 'observed',
    label: `NISAR L-band GCOV · ${p.status} · ${p.direction} T${p.track}`,
    quality: q,
  };
}

const sceneCache = new Map<string, WaterScene>();

export async function loadPassScenes(manifest: NisarFloodManifest, range: TimeRange, cells: number, signal: AbortSignal): Promise<WaterScene[]> {
  const passes = manifest.passes.filter((p) => {
    const t = passObservation(p).time;
    return t >= range.start && t <= range.end;
  });
  return Promise.all(
    passes.map(async (p) => {
      const key = `${manifest.aoi}/${p.id}`;
      const hit = sceneCache.get(key);
      if (hit) return hit;
      const cls = await loadPassClasses('nisar-flood', manifest.aoi, p.id, cells, signal);
      const water = new Uint8Array(cells);
      const coverage = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) {
        coverage[i] = cls[i] > 0 ? 1 : 0;
        water[i] = cls[i] === 2 ? 1 : 0;
      }
      const scene = { obs: passObservation(p), water, coverage };
      sceneCache.set(key, scene);
      return scene;
    }),
  );
}
