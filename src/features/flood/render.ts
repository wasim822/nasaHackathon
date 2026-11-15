import { CLASS, type FloodData } from './pipeline';

export type RGBA = readonly [number, number, number, number];

export const FLOOD_COLORS = {
  permanent: [29, 78, 216, 215] as RGBA,
  flood: [34, 211, 238, 130] as RGBA,
  floodPersisting: [20, 184, 166, 105] as RGBA,
  floodNew: [125, 249, 255, 235] as RGBA,
  receded: [217, 137, 74, 120] as RGBA,
  recededNow: [234, 150, 80, 200] as RGBA,
  selectedFill: [236, 253, 245, 70] as RGBA,
  selectedEdge: [167, 243, 208, 255] as RGBA,
};

const cache = new WeakMap<FloodData, Map<string, string>>();

export function paint(cols: number, rows: number, color: (i: number, r: number, c: number) => RGBA | null): string {
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(cols, rows);
  const d = img.data;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const px = color(i, r, c);
      if (!px) continue;
      const o = i * 4;
      d[o] = px[0];
      d[o + 1] = px[1];
      d[o + 2] = px[2];
      d[o + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Memoised per dataset: images are generated once per observation, not per animation tick. */
function memo(data: FloodData, key: string, make: () => string): string {
  let m = cache.get(data);
  if (!m) cache.set(data, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = make()));
  return v;
}

export function permanentImage(data: FloodData): string {
  const { cols, rows } = data.grid;
  return memo(data, 'permanent', () => paint(cols, rows, (i) => (data.permanentMask[i] ? FLOOD_COLORS.permanent : null)));
}

export function floodImage(data: FloodData, index: number, highlightChanges: boolean): string {
  const { cols, rows } = data.grid;
  const f = data.frames[index];
  return memo(data, `flood:${index}:${highlightChanges}`, () =>
    paint(cols, rows, (i) => {
      if (f.classes[i] !== CLASS.FLOOD) return null;
      if (!highlightChanges) return FLOOD_COLORS.flood;
      return f.newMask[i] ? FLOOD_COLORS.floodNew : FLOOD_COLORS.floodPersisting;
    }),
  );
}

export function recededImage(data: FloodData, index: number, highlightChanges: boolean): string {
  const { cols, rows } = data.grid;
  const f = data.frames[index];
  const prev = index > 0 ? data.frames[index - 1] : null;
  return memo(data, `receded:${index}:${highlightChanges}`, () =>
    paint(cols, rows, (i) => {
      if (!f.recededMask[i]) return null;
      if (highlightChanges && prev && prev.classes[i] === CLASS.FLOOD) return FLOOD_COLORS.recededNow;
      return FLOOD_COLORS.receded;
    }),
  );
}

export function noDataImage(data: FloodData, index: number): string | null {
  const f = data.frames[index];
  if (f.coverageFraction >= 1) return null;
  const { cols, rows } = data.grid;
  return memo(data, `nodata:${index}`, () =>
    paint(cols, rows, (i, r, c) => {
      if (f.classes[i] !== CLASS.NODATA) return null;
      return (r + c) % 8 < 2 ? [203, 213, 225, 150] : [15, 23, 42, 60];
    }),
  );
}

export function selectedBlobImage(data: FloodData, index: number, label: number): string {
  const { cols, rows } = data.grid;
  const labels = data.frames[index].labels;
  return memo(data, `sel:${index}:${label}`, () =>
    paint(cols, rows, (i, r, c) => {
      if (labels[i] !== label) return null;
      const edge =
        c === 0 || labels[i - 1] !== label ||
        c === cols - 1 || labels[i + 1] !== label ||
        r === 0 || labels[i - cols] !== label ||
        r === rows - 1 || labels[i + cols] !== label;
      return edge ? FLOOD_COLORS.selectedEdge : FLOOD_COLORS.selectedFill;
    }),
  );
}

/** Grid window (rows/cols) around everything a tracked region ever covered, padded, for filmstrip crops. */
export interface CropWindow {
  r0: number;
  c0: number;
  rows: number;
  cols: number;
}

const windows = new WeakMap<FloodData, Map<string, CropWindow | null>>();

export function trackWindow(data: FloodData, trackId: string): CropWindow | null {
  let m = windows.get(data);
  if (!m) windows.set(data, (m = new Map()));
  if (m.has(trackId)) return m.get(trackId)!;
  const { cols, rows } = data.grid;
  let rMin = rows, rMax = -1, cMin = cols, cMax = -1;
  for (const f of data.frames) {
    const blob = f.blobs.find((b) => b.trackId === trackId);
    if (!blob) continue;
    for (let i = 0; i < f.labels.length; i++) {
      if (f.labels[i] !== blob.label) continue;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
    }
  }
  let win: CropWindow | null = null;
  if (rMax >= 0) {
    // Square-ish window with a margin, at least 24 cells (~13 km) so context stays visible.
    const size = Math.max(24, Math.round(Math.max(rMax - rMin + 1, cMax - cMin + 1) * 1.3));
    const rc = (rMin + rMax) / 2;
    const cc = (cMin + cMax) / 2;
    const r0 = Math.max(0, Math.min(rows - size, Math.round(rc - size / 2)));
    const c0 = Math.max(0, Math.min(cols - size, Math.round(cc - size / 2)));
    win = { r0, c0, rows: Math.min(size, rows), cols: Math.min(size, cols) };
  }
  m.set(trackId, win);
  return win;
}

/** Share of the crop window that this observation imaged (0–1). */
export function windowCoverage(data: FloodData, index: number, win: CropWindow): number {
  const f = data.frames[index];
  const { cols } = data.grid;
  let seen = 0;
  for (let r = 0; r < win.rows; r++) {
    for (let c = 0; c < win.cols; c++) if (f.classes[(win.r0 + r) * cols + win.c0 + c] !== CLASS.NODATA) seen++;
  }
  return seen / (win.rows * win.cols);
}

/** Video frame overlay: flood classes on a transparent background, to sit over a satellite image. */
export function trackFrameOverlay(data: FloodData, index: number, trackId: string, win: CropWindow): string {
  const f = data.frames[index];
  const label = f.blobs.find((b) => b.trackId === trackId)?.label ?? -1;
  const { cols } = data.grid;
  return memo(data, `overlay:${trackId}:${index}`, () =>
    paint(win.cols, win.rows, (_i, r, c) => {
      const i = (win.r0 + r) * cols + win.c0 + c;
      if (label > 0 && f.labels[i] === label) {
        const edge = f.labels[i - 1] !== label || f.labels[i + 1] !== label || f.labels[i - cols] !== label || f.labels[i + cols] !== label;
        return edge ? [236, 253, 245, 255] : [103, 232, 249, 215];
      }
      const k = f.classes[i];
      if (k === CLASS.NODATA) return (r + c) % 4 < 1 ? [226, 232, 240, 150] : null;
      if (k === CLASS.PERMANENT) return [29, 78, 216, 200];
      if (k === CLASS.FLOOD) return [34, 211, 238, 120];
      return null;
    }),
  );
}
