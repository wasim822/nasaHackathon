import type { Observation, TimeRange } from '../../types';
import type { AoiSpec } from './baseline';
import type { WaterScene } from './pipeline';
import { datasetUrl, loadPassClasses } from './nisarFlood';

/**
 * Real flood observations from NASA OPERA DSWx-S1: Sentinel-1 surface-water maps (30 m) for North
 * America, aggregated to the AOI grid by server/opera_prep.py. Same class files as the NISAR flood
 * maps (0 no data, 1 dry, 2 water), so the same flood pipeline runs on them.
 */
export const OPERA_AOI: AoiSpec = {
  key: 'bootheel25',
  name: 'Missouri Bootheel & NE Arkansas lowlands (USA)',
  z: 9,
  x0: 126,
  y0: 199,
  tilesX: 3,
  tilesY: 3,
  cellsPerTile: 128,
};

/** The April 2025 Mississippi–Ohio valley floods: before, peak (≈10 Apr) and recession. */
export const OPERA_DEFAULT_RANGE = { start: Date.UTC(2025, 2, 15), end: Date.UTC(2025, 4, 15, 23, 59) };
/** DSWx-S1 production starts in December 2023. */
export const OPERA_FIRST = Date.UTC(2023, 11, 1);

export interface OperaPass {
  id: string;
  time: string;
  tiles: string[];
  granules: string[];
  coverage: number;
  waterFraction: number;
}

export interface OperaManifest {
  aoi: string;
  name: string;
  product: string;
  generated: string;
  range: { start: string; end: string };
  method: string;
  limitations: string;
  passes: OperaPass[];
}

export function operaObservation(p: OperaPass): Observation {
  return {
    id: `opera-${p.id}`,
    time: Date.parse(p.time.endsWith('Z') ? p.time : `${p.time}Z`),
    kind: 'observed',
    label: 'Sentinel-1 water map · NASA OPERA DSWx-S1',
    quality: {
      Product: 'OPERA L3 DSWx-S1 v1 · Sentinel-1 C-band · 30 m',
      'Area imaged': `${Math.round(p.coverage * 100)}%`,
      'MGRS tiles': p.tiles.join(', '),
    },
  };
}

export async function loadOperaManifest(signal: AbortSignal): Promise<OperaManifest> {
  const r = await fetch(datasetUrl('opera-flood', OPERA_AOI.key, 'manifest.json'), { signal });
  // Dev servers answer missing files with the HTML app shell (200), so reject HTML too.
  if (!r.ok || (r.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`No processed OPERA flood data found (HTTP ${r.status}). Run: server/.venv/Scripts/python server/opera_prep.py --start 2025-03-15 --end 2025-05-15`);
  }
  return (await r.json()) as OperaManifest;
}

export async function loadOperaScenes(manifest: OperaManifest, range: TimeRange, cells: number, signal: AbortSignal): Promise<WaterScene[]> {
  const passes = manifest.passes.filter((p) => {
    const t = operaObservation(p).time;
    return t >= range.start && t <= range.end;
  });
  return Promise.all(
    passes.map(async (p) => {
      const cls = await loadPassClasses('opera-flood', OPERA_AOI.key, p.id, cells, signal);
      const water = new Uint8Array(cells);
      const coverage = new Uint8Array(cells);
      for (let i = 0; i < cells; i++) {
        coverage[i] = cls[i] > 0 ? 1 : 0;
        water[i] = cls[i] === 2 ? 1 : 0;
      }
      return { obs: operaObservation(p), water, coverage };
    }),
  );
}
