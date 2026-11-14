import { aoiGrid } from '../flood/baseline';
import { WCLASS, WETLAND_AOI, buildWetlandData, compareWet, inundationFrequency } from './wetlandData';
import { wetlandEvents, wetlandFilter, wetlandStats } from './wetlandFilter';
import { EFFECT_PRESETS } from '../../state/store';
import type { NisarFloodManifest } from '../flood/nisarFlood';
import type { Observation } from '../../types';

const grid = aoiGrid(WETLAND_AOI);
const n = grid.cols * grid.rows;
const manifest = { method: 'm', limitations: 'l', passes: [] } as unknown as NisarFloodManifest;
const obs = (d: number): Observation => ({ id: `p${d}`, time: Date.UTC(2026, 0, d), kind: 'observed' });

/** Pass with given coverage (first `covered` cells imaged) and wet cells. */
function pass(covered: number, open: number[], veg: number[]): Uint8Array {
  const c = new Uint8Array(n);
  for (let i = 0; i < covered; i++) c[i] = WCLASS.OTHER;
  for (const i of open) c[i] = WCLASS.OPEN;
  for (const i of veg) c[i] = WCLASS.VEG;
  return c;
}

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);
const scenes = [
  { obs: obs(1), classes: pass(n, range(0, 100), range(100, 200)) },
  { obs: obs(13), classes: pass(n, range(0, 100), range(100, 600)) }, // inundation expands
  { obs: obs(25), classes: pass(n / 2, range(0, 100), range(100, 150)) }, // half imaged
];
const data = buildWetlandData(grid, new Uint8Array(n), new Uint8Array(n), scenes, manifest);

describe('wetland data', () => {
  it('measures open water and inundated vegetation per pass', () => {
    expect(data.frames).toHaveLength(3);
    expect(data.frames[1].vegKm2).toBeGreaterThan(data.frames[0].vegKm2 * 4);
    expect(data.frames[0].openKm2).toBeGreaterThan(0);
    expect(data.maxShare.index).toBe(1);
  });

  it('compares passes only over area imaged by both', () => {
    const c = data.frames[2].vsPrev!;
    expect(c.commonFraction).toBeCloseTo(0.5, 3);
    const self = compareWet(scenes[0].classes, scenes[0].classes, () => 1);
    expect(self.beforeKm2).toBe(self.afterKm2);
  });

  it('computes inundation frequency only over passes that imaged each cell', () => {
    const { wet, seen } = inundationFrequency(data, 2);
    expect(seen[0]).toBe(3);
    expect(wet[0]).toBe(3);
    expect(seen[n - 1]).toBe(2); // not imaged by the half-coverage pass
    expect(wet[300]).toBe(1); // inundated only in the expansion pass
  });

  it('reports stats and events without inventing comparisons', () => {
    const ctx = { data, observations: data.frames.map((f) => f.obs), index: 1, effects: EFFECT_PRESETS.off, layers: {}, selectedId: null, reducedMotion: false, options: {} };
    const s = wetlandStats(ctx);
    expect(s.find((x) => x.id === 'dprev')?.tone).toBe('up');
    const ev = wetlandEvents(data);
    expect(ev.some((e) => e.type === 'max-extent' && e.time === obs(13).time)).toBe(true);
    expect(ev.some((e) => e.type === 'expansion')).toBe(true);
  });

  it('hit-testing a map point selects that location', () => {
    const ctx = { data, observations: [], index: 0, effects: EFFECT_PRESETS.off, layers: {}, selectedId: null, reducedMotion: false, options: {} };
    expect(wetlandFilter.hitTest!(ctx, [30.3, -91.7])).toMatch(/^cell:\d+$/);
    expect(wetlandFilter.hitTest!(ctx, [45, -100])).toBeNull();
  });
});
