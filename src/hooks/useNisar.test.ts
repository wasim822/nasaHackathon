import { describe, expect, it } from 'vitest';
import { NISAR_TRAIL_PASSES, shownPasses } from './useNisar';
import { passBounds, touchesRegion, type NisarPass } from '../services/data/nisar';

const passes = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, time: i }) as unknown as NisarPass);
const ids = (ps: NisarPass[]) => ps.map((p) => p.id);

describe('shownPasses', () => {
  it('shows the current pass with the previous one fading behind, oldest first', () => {
    expect(NISAR_TRAIL_PASSES).toBe(1);
    expect(ids(shownPasses(passes, 7))).toEqual(['p6', 'p7']);
    expect(ids(shownPasses(passes, 0))).toEqual(['p0']);
  });
  it('shows nothing without a current pass', () => {
    expect(shownPasses(passes, -1)).toEqual([]);
    expect(shownPasses([], 0)).toEqual([]);
  });
});

describe('North America only', () => {
  const sq = (lat: number, lng: number): [number, number][] => [[lat, lng], [lat + 2, lng], [lat + 2, lng + 2], [lat, lng + 2]];
  it('keeps frames over the US & Canada and drops ocean, Mexico and other continents', () => {
    expect(touchesRegion(sq(38, -95))).toBe(true); // Kansas
    expect(touchesRegion(sq(55, -110))).toBe(true); // Alberta/Saskatchewan
    expect(touchesRegion(sq(48.5, 2))).toBe(false); // France
    expect(touchesRegion(sq(19, -100))).toBe(false); // central Mexico
    // The app's region is a coarse box (to 141°W), so near-shore ocean counts; the mid-Pacific doesn't.
    expect(touchesRegion(sq(30, -150))).toBe(false);
  });
  it('frames the camera on all of a pass’s frames', () => {
    const pass = { scenes: [{ footprint: sq(38, -95) }, { footprint: sq(40, -96) }] } as unknown as NisarPass;
    expect(passBounds(pass)).toEqual({ south: 38, north: 42, west: -96, east: -93 });
  });
});

describe('missing frames', async () => {
  const { missingFrames } = await import('../services/data/nisar');
  const { frameSummary } = await import('./useNisar');
  const pass = (frames: number[]) => ({ scenes: frames.map((frame) => ({ frame })) }) as unknown as NisarPass;
  it('lists frame numbers missing between the ends of a pass', () => {
    expect(missingFrames(pass([33, 34, 37, 38, 39]))).toEqual([35, 36]);
    expect(missingFrames(pass([29, 31, 32]))).toEqual([30]);
    expect(missingFrames(pass([50, 51, 52]))).toEqual([]);
  });
  it('summarises present vs expected frames, counting duplicates once', () => {
    expect(frameSummary(pass([33, 34, 37, 38, 39]))).toBe('5 of 7 frames · 35, 36 not available');
    expect(frameSummary(pass([55, 55]))).toBe('1 frame');
  });
});

describe('satellite follow mode', async () => {
  const { flattenFrames } = await import('../services/data/nisar');
  const { drawnPasses } = await import('./useNisar');
  const sc = (id: string, frame: number, start: number) => ({ id, frame, start }) as unknown as import('../services/data/nisar').NisarScene;
  const ps = [
    { id: 'A', scenes: [sc('a2', 2, 20), sc('a1', 1, 10), sc('a1dup', 1, 11)] },
    { id: 'B', scenes: [sc('b1', 7, 100), sc('b2', 8, 140), sc('b3', 9, 180)] },
  ] as unknown as NisarPass[];
  const frames = flattenFrames(ps);

  it('steps through images in the order they were taken, each frame once', () => {
    expect(frames.map((f) => f.scene.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'b3']);
    expect(frames.map((f) => f.passIndex)).toEqual([0, 0, 1, 1, 1]);
  });
  it('draws the current pass only up to the current image, with the previous pass behind', () => {
    const d = drawnPasses(ps, frames, 3, 'satellite'); // b2
    expect(d.map((p) => p.id)).toEqual(['A', 'B']);
    expect(d[1].scenes.map((s) => s.id)).toEqual(['b1', 'b2']);
    expect(drawnPasses(ps, frames, 0, 'satellite').map((p) => p.scenes.map((s) => s.id))).toEqual([['a1']]);
  });
  it('draws whole passes in pass mode', () => {
    expect(drawnPasses(ps, frames, 1, 'pass').map((p) => p.id)).toEqual(['A', 'B']);
  });
});
