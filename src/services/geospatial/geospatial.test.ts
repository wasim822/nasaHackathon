import { labelComponents } from './components';
import { cellAt, haversineKm, mercatorGrid, rowCellAreasKm2, type GridSpec } from './grid';
import { trackComponents, type TrackingFrame } from './tracking';
import { isInRegion } from './region';

/** Simple 20x20 equirectangular grid near the equator (cells ~ 11 km). */
function grid(): GridSpec {
  const rows = 20;
  const latEdges = new Float64Array(rows + 1);
  for (let r = 0; r <= rows; r++) latEdges[r] = 1 - r * 0.1;
  return { cols: 20, rows, west: 0, east: 2, latEdges };
}

function maskFrom(g: GridSpec, rects: [number, number, number, number][]): Uint8Array {
  const m = new Uint8Array(g.cols * g.rows);
  for (const [r0, r1, c0, c1] of rects) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m[r * g.cols + c] = 1;
  return m;
}

function frame(g: GridSpec, t: number, rects: [number, number, number, number][], coverage?: Uint8Array): TrackingFrame {
  const { labels, components } = labelComponents(maskFrom(g, rects), g, 2);
  return { time: t, labels, components, coverage: coverage ?? new Uint8Array(g.cols * g.rows).fill(1) };
}

describe('grid geometry', () => {
  it('computes geodesic cell area (~123.6 km² for 0.1° at the equator)', () => {
    const areas = rowCellAreasKm2(grid());
    expect(areas[9]).toBeGreaterThan(122);
    expect(areas[9]).toBeLessThan(125);
  });
  it('mercator grid rows shrink in latitude toward the poles', () => {
    const g = mercatorGrid(9, 126, 195, 1, 1, 4);
    const h0 = g.latEdges[0] - g.latEdges[1];
    const h3 = g.latEdges[3] - g.latEdges[4];
    expect(h0).toBeLessThan(h3);
  });
  it('maps coordinates to cells and back', () => {
    const g = grid();
    expect(cellAt(g, [0.95, 0.05])).toBe(0);
    expect(cellAt(g, [-0.95, 1.95])).toBe(399);
    expect(cellAt(g, [5, 5])).toBe(-1);
  });
  it('haversine distance is sane', () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });
});

describe('labelComponents', () => {
  it('finds 4-connected regions, removes small noise, measures bounds and centroid', () => {
    const g = grid();
    const m = maskFrom(g, [[2, 4, 2, 4], [10, 10, 10, 10]]);
    m[6 * g.cols + 6] = 1; // diagonal-only neighbour of nothing
    const r = labelComponents(m, g, 3);
    expect(r.components).toHaveLength(1);
    expect(r.removedCells).toBe(2);
    const c = r.components[0];
    expect(c.cells.length).toBe(9);
    expect(c.bounds.west).toBeCloseTo(0.2);
    expect(c.bounds.east).toBeCloseTo(0.5);
    expect(c.bounds.north).toBeCloseTo(0.8);
    expect(c.centroid[1]).toBeCloseTo(0.35, 5);
  });
  it('does not join diagonal-only neighbours', () => {
    const g = grid();
    const m = maskFrom(g, [[0, 1, 0, 1], [2, 3, 2, 3]]);
    expect(labelComponents(m, g, 1).components).toHaveLength(2);
  });
});

describe('trackComponents', () => {
  const g = grid();
  const rowAreas = rowCellAreasKm2(g);
  const area = (i: number) => rowAreas[Math.floor(i / g.cols)];

  it('keeps stable IDs across expansion and records events', () => {
    const res = trackComponents([frame(g, 1, [[2, 4, 2, 4]]), frame(g, 2, [[2, 5, 2, 5]]), frame(g, 3, [[2, 5, 2, 5]])], area);
    expect(res.frames[0].blobs[0]).toMatchObject({ trackId: 'F-001', event: 'appeared' });
    expect(res.frames[1].blobs[0]).toMatchObject({ trackId: 'F-001', event: 'expanded' });
    expect(res.frames[1].blobs[0].gainedKm2 / rowAreas[3]).toBeCloseTo(7, 1);
    expect(res.frames[2].blobs[0]).toMatchObject({ trackId: 'F-001', event: 'stable' });
  });

  it('does not force-match a distant unrelated region', () => {
    const res = trackComponents([frame(g, 1, [[2, 4, 2, 4]]), frame(g, 2, [[14, 16, 14, 16]])], area);
    expect(res.frames[1].blobs[0]).toMatchObject({ trackId: 'F-002', event: 'appeared' });
    expect(res.frames[1].ended).toEqual([{ trackId: 'F-001', reason: 'disappeared' }]);
    expect(res.tracks['F-001'].end?.reason).toBe('disappeared');
  });

  it('records merges with parent identities', () => {
    const res = trackComponents([frame(g, 1, [[2, 4, 2, 4], [2, 4, 6, 8]]), frame(g, 2, [[2, 4, 2, 8]])], area);
    const merged = res.frames[1].blobs[0];
    expect(merged.event).toBe('merged');
    // Neither parent dominates (≈50/50), so the merged region gets a new ID listing both parents.
    expect(merged.trackId).toBe('F-003');
    expect(merged.parents.sort()).toEqual(['F-001', 'F-002']);
    expect(res.tracks['F-001'].children).toEqual(['F-003']);
  });

  it('a dominant parent keeps its ID through a merge; the absorbed one ends', () => {
    const res = trackComponents([frame(g, 1, [[0, 9, 0, 9], [0, 1, 11, 12]]), frame(g, 2, [[0, 9, 0, 9], [0, 1, 10, 12]])], area);
    const b = res.frames[1].blobs[0];
    expect(b).toMatchObject({ trackId: 'F-001', event: 'merged', parents: ['F-002'] });
    expect(res.frames[1].ended).toEqual([{ trackId: 'F-002', reason: 'merged' }]);
  });

  it('records splits with the parent identity', () => {
    const res = trackComponents([frame(g, 1, [[2, 4, 2, 8]]), frame(g, 2, [[2, 4, 2, 4], [2, 4, 6, 8]])], area);
    const blobs = res.frames[1].blobs;
    expect(blobs.every((b) => b.event === 'split')).toBe(true);
    expect(blobs.map((b) => b.parents)).toEqual([['F-001'], ['F-001']]);
    expect(res.tracks['F-001'].end?.reason).toBe('split');
  });

  it('holds tracks outside data coverage as unobserved instead of disappeared', () => {
    const noCoverage = new Uint8Array(g.cols * g.rows);
    const res = trackComponents([frame(g, 1, [[2, 4, 2, 4]]), frame(g, 2, [], noCoverage), frame(g, 3, [[2, 4, 2, 4]])], area);
    expect(res.frames[1].unobserved).toEqual(['F-001']);
    expect(res.frames[1].ended).toEqual([]);
    expect(res.frames[2].blobs[0]).toMatchObject({ trackId: 'F-001', event: 'stable' });
  });
});

describe('region filter (US & Canada)', () => {
  it.each([
    ['St. Louis', [38.63, -90.2], true],
    ['Vancouver', [49.28, -123.12], true],
    ['Anchorage', [61.22, -149.9], true],
    ['Honolulu', [21.31, -157.86], true],
    ['Western Aleutians', [52.9, 173.2], true],
    ['Mexico City', [19.43, -99.13], false],
    ['Tijuana (MX)', [32.5, -117.02], false],
    ['Ciudad Juarez (MX)', [31.69, -106.42], false],
    ['El Paso (US)', [31.78, -106.3], true],
    ['Gulf of California', [28.5, -112.5], false],
    ['London', [51.5, -0.12], false],
  ] as [string, [number, number], boolean][])('%s', (_n, p, expected) => {
    expect(isInRegion(p)).toBe(expected);
  });
});
