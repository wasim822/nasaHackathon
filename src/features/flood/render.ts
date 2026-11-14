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
