import { stepIndex, transitionMs, frameDelayMs } from './playback';
import { useAppStore } from '../state/store';
import type { Observation } from '../types';

// Irregularly spaced observations (11-day steps + jitter) — frames are not ticks.
const obs = (n: number): Observation[] =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i}`, time: Date.UTC(2026, 0, 1 + i * 11, i), kind: 'observed' as const }));

describe('stepIndex', () => {
  it('moves exactly one observation', () => {
    expect(stepIndex(2, 5, 1, false)).toEqual({ index: 3, stop: false });
    expect(stepIndex(2, 5, -1, false)).toEqual({ index: 1, stop: false });
  });
  it('stops at the ends without loop', () => {
    expect(stepIndex(4, 5, 1, false)).toEqual({ index: 4, stop: true });
    expect(stepIndex(0, 5, -1, false)).toEqual({ index: 0, stop: true });
  });
  it('wraps with loop', () => {
    expect(stepIndex(4, 5, 1, true)).toEqual({ index: 0, stop: false });
  });
  it('handles no observations', () => {
    expect(stepIndex(-1, 0, 1, true)).toEqual({ index: -1, stop: true });
  });
});

describe('timing', () => {
  it('speed scales frame delay; transitions stay within 250-500ms', () => {
    expect(frameDelayMs(2)).toBe(frameDelayMs(1) / 2);
    for (const s of [0.5, 1, 2, 4] as const) {
      const t = transitionMs(s, false);
      expect(t).toBeGreaterThanOrEqual(250);
      expect(t).toBeLessThanOrEqual(500);
    }
    expect(transitionMs(1, true)).toBe(0);
  });
});

describe('store playback', () => {
  beforeEach(() => {
    useAppStore.setState({ observations: [], currentIndex: -1, playing: false, loop: false });
  });

  it('plays through real frames and stops at the end', () => {
    useAppStore.getState().finishLoad(obs(3), {}, []);
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().tick();
    expect(useAppStore.getState().currentIndex).toBe(1);
    useAppStore.getState().tick();
    expect(useAppStore.getState().currentIndex).toBe(2);
    expect(useAppStore.getState().playing).toBe(false);
  });

  it('loops when enabled', () => {
    useAppStore.getState().finishLoad(obs(2), {}, []);
    useAppStore.getState().setLoop(true);
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().tick();
    useAppStore.getState().tick();
    expect(useAppStore.getState().currentIndex).toBe(0);
    expect(useAppStore.getState().playing).toBe(true);
  });

  it('pause preserves the current frame; stepping pauses', () => {
    useAppStore.getState().finishLoad(obs(4), {}, []);
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().tick();
    useAppStore.getState().setPlaying(false);
    expect(useAppStore.getState().currentIndex).toBe(1);
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().step(1);
    expect(useAppStore.getState()).toMatchObject({ currentIndex: 2, playing: false });
  });

  it('pressing play at the last frame restarts from the first', () => {
    useAppStore.getState().finishLoad(obs(3), {}, []);
    useAppStore.getState().setIndex(2);
    useAppStore.getState().setPlaying(true);
    expect(useAppStore.getState()).toMatchObject({ currentIndex: 0, playing: true });
  });

  it('sorts observations by real timestamp', () => {
    useAppStore.getState().finishLoad(obs(3).reverse(), {}, []);
    const times = useAppStore.getState().observations.map((x) => x.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('will not play with fewer than two frames, and empty loads report "empty"', () => {
    useAppStore.getState().finishLoad(obs(1), {}, []);
    useAppStore.getState().setPlaying(true);
    expect(useAppStore.getState().playing).toBe(false);
    useAppStore.getState().finishLoad([], {}, []);
    expect(useAppStore.getState()).toMatchObject({ loadState: 'empty', currentIndex: -1 });
  });

  it('switching filters pauses playback and releases data and selection', () => {
    useAppStore.getState().finishLoad(obs(3), { big: true }, []);
    useAppStore.getState().select('F-001');
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().activateFilter('wildfire', { start: 0, end: 1 }, { reports: true }, {});
    expect(useAppStore.getState()).toMatchObject({
      playing: false, data: null, observations: [], currentIndex: -1, selectedId: null, activeFilterId: 'wildfire',
    });
    expect(useAppStore.getState().layerVisibility).toEqual({ reports: true });
  });

  it('opening the About drawer does not change filter or playback', () => {
    useAppStore.getState().activateFilter('flood', { start: 0, end: 1 }, {}, {});
    useAppStore.getState().finishLoad(obs(3), {}, []);
    useAppStore.getState().setPlaying(true);
    useAppStore.getState().openAbout('nisar');
    expect(useAppStore.getState()).toMatchObject({ activeFilterId: 'flood', playing: true, aboutOpen: true });
  });
});
