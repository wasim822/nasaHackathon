import { describe, expect, it } from 'vitest';
import { mercatorGrid } from '../../services/geospatial/grid';
import { type DefManifest, type DefPairMeta, buildDeformationData, decodeGrid, pairObservation } from './deformationData';
import { losColor } from './deformationFilter';

const grid = mercatorGrid(9, 85, 200, 1, 1, 2); // 2×2 cells
const n = 4;
const manifest = { frames: [], layers: {} } as unknown as DefManifest;

function meta(id: string, start: string, end: string, track = 34, direction: 'Ascending' | 'Descending' = 'Ascending'): DefPairMeta {
  return { id, start, end, track, direction, status: 'Provisional', granules: [], validFraction: 1, medianCoherence: 0.6, referenceOffsetMm: 0, ionosphereCorrected: true, wavelengthM: 0.24, p95AbsMm: 10 };
}
const arr = (...v: number[]) => Float32Array.from(v);
const coh = arr(0.5, 0.5, 0.5, 0.5);

describe('deformation data', () => {
  it('decodes scaled int16 with nodata to NaN', () => {
    const buf = Int16Array.from([100, -32768, -250, 0]).buffer;
    const out = decodeGrid(buf, { dtype: 'int16', scale: 0.1, unit: 'mm', nodata: -32768, description: '' }, n);
    expect(out[0]).toBeCloseTo(10);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(-25);
    expect(() => decodeGrid(buf, { dtype: 'int16', scale: 0.1, unit: 'mm', nodata: -32768, description: '' }, 9)).toThrow();
  });

  it('uses the second acquisition as the observation time, and labels the real baseline', () => {
    const o = pairObservation(meta('p', '2026-09-08T13:08:22', '2026-09-20T13:08:23'));
    expect(o.time).toBe(Date.UTC(2026, 8, 20, 13, 8, 23));
    expect(o.kind).toBe('observed');
    expect(o.quality?.['Temporal baseline']).toBe('12 days');
  });

  it('sums consecutive pairs per track and propagates no-data', () => {
    const d = buildDeformationData(
      grid,
      [
        { meta: meta('b', '2026-09-20T13:00:00', '2026-10-02T13:00:00'), disp: arr(-10, -5, NaN, 2), coh },
        { meta: meta('a', '2026-09-08T13:00:00', '2026-09-20T13:00:00'), disp: arr(-12, NaN, 1, 3), coh },
      ],
      manifest,
      20,
    );
    expect(d.frames.map((f) => f.meta.id)).toEqual(['a', 'b']); // sorted by real time
    const b = d.frames[1];
    expect(b.chainPairs).toBe(2);
    expect(b.chainStart).toBe(Date.UTC(2026, 8, 8, 13));
    expect(b.cumulative[0]).toBeCloseTo(-22);
    expect(Number.isNaN(b.cumulative[1])).toBe(true); // missing in pair a
    expect(Number.isNaN(b.cumulative[2])).toBe(true); // missing in pair b
    expect(b.cumulative[3]).toBeCloseTo(5);
    expect(b.cumAwayKm2).toBeGreaterThan(0); // cell 0 ≤ −20 mm
    expect(d.frames[0].cumAwayKm2).toBe(0);
  });

  it('restarts the chain after a gap and keeps tracks separate', () => {
    const d = buildDeformationData(
      grid,
      [
        { meta: meta('a', '2026-09-08T13:00:00', '2026-09-20T13:00:00'), disp: arr(-1, -1, -1, -1), coh },
        { meta: meta('d', '2026-09-14T02:00:00', '2026-09-26T02:00:00', 114, 'Descending'), disp: arr(-4, -4, -4, -4), coh },
        // Gap: the 2026-09-20 → 10-02 pair on track 34 is missing.
        { meta: meta('c', '2026-10-02T13:00:00', '2026-10-14T13:00:00'), disp: arr(-2, -2, -2, -2), coh },
      ],
      manifest,
    );
    const [a, dsc, c] = d.frames;
    expect(a.chainPairs).toBe(1);
    expect(dsc.chainPairs).toBe(1);
    expect(dsc.cumulative[0]).toBeCloseTo(-4);
    expect(c.chainPairs).toBe(1);
    expect(c.cumulative[0]).toBeCloseTo(-2);
  });

  it('colours away/toward with opposite hues and leaves no-data transparent', () => {
    expect(losColor(NaN, 30)).toBeNull();
    const away = losColor(-30, 30)!;
    const toward = losColor(30, 30)!;
    expect(away[0]).toBeGreaterThan(away[2]);
    expect(toward[2]).toBeGreaterThan(toward[0]);
  });
});
