import type { GeoBounds, LatLng } from '../../types';
import { type GridSpec, rowCellAreasKm2, spanBounds } from './grid';

export interface RasterComponent {
  /** 1-based label in the label grid. */
  label: number;
  cells: Int32Array;
  areaKm2: number;
  bounds: GeoBounds;
  /** Area-weighted centroid. */
  centroid: LatLng;
}

export interface LabelResult {
  labels: Int32Array;
  components: RasterComponent[];
  /** Number of cells removed as small-component noise. */
  removedCells: number;
}

/**
 * Labels 4-connected components of a binary mask (1 = foreground). Components smaller
 * than `minCells` are removed as noise (labels set to 0). 4-connectivity is used
 * deliberately so diagonal single-pixel bridges do not join separate regions.
 */
export function labelComponents(mask: Uint8Array, g: GridSpec, minCells: number): LabelResult {
  const { cols, rows } = g;
  const labels = new Int32Array(cols * rows);
  const areas = rowCellAreasKm2(g);
  const components: RasterComponent[] = [];
  const stack = new Int32Array(cols * rows);
  let removedCells = 0;
  let next = 1;
  const visited = new Uint8Array(cols * rows);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const cells: number[] = [];
    while (sp) {
      const i = stack[--sp];
      cells.push(i);
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (c > 0 && mask[i - 1] && !visited[i - 1]) (visited[i - 1] = 1), (stack[sp++] = i - 1);
      if (c < cols - 1 && mask[i + 1] && !visited[i + 1]) (visited[i + 1] = 1), (stack[sp++] = i + 1);
      if (r > 0 && mask[i - cols] && !visited[i - cols]) (visited[i - cols] = 1), (stack[sp++] = i - cols);
      if (r < rows - 1 && mask[i + cols] && !visited[i + cols]) (visited[i + cols] = 1), (stack[sp++] = i + cols);
    }
    if (cells.length < minCells) {
      removedCells += cells.length;
      continue;
    }
    const label = next++;
    let r0 = rows, r1 = -1, c0 = cols, c1 = -1;
    let area = 0, latSum = 0, lngSum = 0;
    const cw = (g.east - g.west) / cols;
    for (const i of cells) {
      labels[i] = label;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      const a = areas[r];
      area += a;
      latSum += a * ((g.latEdges[r] + g.latEdges[r + 1]) / 2);
      lngSum += a * (g.west + (c + 0.5) * cw);
    }
    components.push({
      label,
      cells: Int32Array.from(cells),
      areaKm2: area,
      bounds: spanBounds(g, r0, r1, c0, c1),
      centroid: [latSum / area, lngSum / area],
    });
  }
  return { labels, components, removedCells };
}
