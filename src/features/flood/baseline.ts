import { type GridSpec, mercatorGrid } from '../../services/geospatial/grid';

/**
 * Area of interest for the flood demo: the Mississippi–Missouri–Illinois river
 * confluence around St. Louis (Missouri/Illinois, USA), a floodplain with recurring
 * spring floods (e.g. 1993, 2019). Grid is aligned to Web-Mercator zoom-9 tiles so
 * JRC Global Surface Water tiles map 1:1 onto it.
 */
export interface AoiSpec {
  /** Short key used for data folders, e.g. "stl". */
  key: string;
  name: string;
  z: number;
  x0: number;
  y0: number;
  tilesX: number;
  tilesY: number;
  cellsPerTile: number;
}

export const AOI: AoiSpec = {
  key: 'stl',
  name: 'Mississippi–Missouri confluence, St. Louis (USA)',
  z: 9,
  x0: 126,
  y0: 195,
  tilesX: 3,
  tilesY: 3,
  /** 256 px tile / 128 cells = 2 px per cell (~0.55 km at this latitude). */
  cellsPerTile: 128,
};

export const JRC_OCCURRENCE_TILES =
  'https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/{z}/{x}/{y}.png';

export interface WaterBaseline {
  grid: GridSpec;
  /** Historical water occurrence 0–100 % per cell (JRC GSW 1984–2021), or synthetic. */
  occurrence: Uint8Array;
  source: 'jrc' | 'synthetic';
  note: string;
}

export function aoiGrid(a: AoiSpec = AOI): GridSpec {
  return mercatorGrid(a.z, a.x0, a.y0, a.tilesX, a.tilesY, a.cellsPerTile);
}

/**
 * JRC occurrence tiles encode occurrence as RGBA ≈ (255−v, 0, v, v) where v/255 is the
 * fraction of valid observations (1984–2021) in which water was present. We read the
 * blue channel of each non-transparent pixel and average within each grid cell.
 */
export function occurrenceFromTilePixels(
  tiles: { tx: number; ty: number; rgba: Uint8ClampedArray }[],
  grid: GridSpec,
  cellsPerTile: number,
): Uint8Array {
  const px = 256 / cellsPerTile;
  const out = new Uint8Array(grid.cols * grid.rows);
  for (const { tx, ty, rgba } of tiles) {
    for (let cr = 0; cr < cellsPerTile; cr++) {
      for (let cc = 0; cc < cellsPerTile; cc++) {
        let sum = 0;
        for (let y = cr * px; y < (cr + 1) * px; y++) {
          for (let x = cc * px; x < (cc + 1) * px; x++) {
            const o = (y * 256 + x) * 4;
            if (rgba[o + 3] > 0) sum += rgba[o + 2];
          }
        }
        const v = Math.round(((sum / (px * px)) * 100) / 255);
        const row = ty * cellsPerTile + cr;
        const col = tx * cellsPerTile + cc;
        out[row * grid.cols + col] = Math.min(100, v);
      }
    }
  }
  return out;
}

async function fetchTileRgba(url: string, signal: AbortSignal): Promise<Uint8ClampedArray> {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`JRC tile HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, 256, 256).data;
}

const cache = new Map<string, Promise<WaterBaseline>>();

/** Loads the real JRC baseline once (cached); falls back to an explicit synthetic river. */
export function loadBaseline(signal: AbortSignal, aoi: AoiSpec = AOI): Promise<WaterBaseline> {
  const hit = cache.get(aoi.key);
  if (hit) return hit;
  const grid = aoiGrid(aoi);
  const attempt = (async (): Promise<WaterBaseline> => {
    try {
      const jobs: Promise<{ tx: number; ty: number; rgba: Uint8ClampedArray }>[] = [];
      for (let ty = 0; ty < aoi.tilesY; ty++) {
        for (let tx = 0; tx < aoi.tilesX; tx++) {
          const url = JRC_OCCURRENCE_TILES.replace('{z}', String(aoi.z))
            .replace('{x}', String(aoi.x0 + tx))
            .replace('{y}', String(aoi.y0 + ty));
          jobs.push(fetchTileRgba(url, signal).then((rgba) => ({ tx, ty, rgba })));
        }
      }
      const tiles = await Promise.all(jobs);
      return {
        grid,
        occurrence: occurrenceFromTilePixels(tiles, grid, aoi.cellsPerTile),
        source: 'jrc',
        note: 'Historical water occurrence from JRC Global Surface Water v1.4 (1984–2021), resampled to ~0.55 km cells.',
      };
    } catch (e) {
      if (signal.aborted) throw e;
      return {
        grid,
        occurrence: syntheticOccurrence(grid.cols, grid.rows),
        source: 'synthetic',
        note: `JRC tiles could not be loaded (${(e as Error).message}); using a SYNTHETIC river baseline that does not match real geography.`,
      };
    }
  })();
  cache.set(aoi.key, attempt);
  // Don't cache aborted attempts.
  attempt.catch(() => {
    if (cache.get(aoi.key) === attempt) cache.delete(aoi.key);
  });
  return attempt;
}

/** Deterministic synthetic meandering river (fallback and tests). */
export function syntheticOccurrence(cols: number, rows: number): Uint8Array {
  const occ = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    const center = rows * 0.5 + Math.sin(c / 14) * rows * 0.08 + Math.sin(c / 5.3) * 2;
    for (let r = 0; r < rows; r++) {
      const d = Math.abs(r - center);
      const v = d < 2.2 ? 95 : d < 5 ? 45 : d < 7 ? 12 : 0;
      occ[r * cols + c] = v;
    }
  }
  return occ;
}
