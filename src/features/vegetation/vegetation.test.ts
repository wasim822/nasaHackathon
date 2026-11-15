import { describe, expect, it } from 'vitest';
import { L3_LAST, L3_LAYER, MAX_LOOKBACK_DAYS, NRT_LAYER, l3Start, landCoverYear, vegLayersFor } from './vegLayers';
import { vegetationFilter } from './vegetationFilter';
import { EFFECT_PRESETS } from '../../state/store';

const DAY = 864e5;
const d = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe('vegetation map stacking for a chosen date', () => {
  it('uses the 16-day composite whose period contains the date (Jan 1 + 8k days)', () => {
    expect(new Date(l3Start(d('2026-06-12'))).toISOString().slice(0, 10)).toBe('2026-06-10');
    expect(new Date(l3Start(d('2026-06-10'))).toISOString().slice(0, 10)).toBe('2026-06-10');
    expect(new Date(l3Start(d('2026-01-03'))).toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('stacks newest first, never starting after the date, within the look-back window', () => {
    const date = d('2026-06-12');
    const layers = vegLayersFor(date);
    expect(layers[0]).toMatchObject({ layer: L3_LAYER, date: '2026-06-10' });
    expect(layers.map((l) => l.date)).toEqual(['2026-06-10', '2026-06-02', '2026-05-25', '2026-05-17', '2026-05-09']);
    for (const l of layers) {
      expect(l.from).toBeLessThanOrEqual(date);
      expect(l.from).toBeGreaterThanOrEqual(date - MAX_LOOKBACK_DAYS * DAY);
    }
  });

  it('steps back across a year boundary to the previous year’s last composite', () => {
    const layers = vegLayersFor(d('2026-01-05'));
    expect(layers[0].date).toBe('2026-01-01');
    expect(layers[1].date).toBe('2025-12-27');
  });

  it('uses the near-real-time product after the science product ends, then falls back to it', () => {
    const layers = vegLayersFor(d('2026-11-13'));
    expect(layers[0]).toMatchObject({ layer: NRT_LAYER, date: '2026-11-13' });
    expect(layers.some((l) => l.layer === L3_LAYER && l.from <= L3_LAST)).toBe(true);
  });

  it('clamps land cover to the years that exist', () => {
    expect(landCoverYear(d('2026-06-12'))).toBe(2024);
    expect(landCoverYear(d('2019-06-12'))).toBe(2019);
  });
});

describe('Vegetation filter', () => {
  it('turns the timeline off, loads one chosen date and draws the newest map on top', async () => {
    expect(vegetationFilter.timeline).toBe(false);
    const options = { date: '2026-06-12', opacity: 0.8, barePink: true };
    const r = await vegetationFilter.load({ range: { start: 0, end: 1 }, options, signal: new AbortController().signal });
    expect(r.observations).toHaveLength(1);
    expect(r.notices[0]).toContain('not NISAR');
    const ov = vegetationFilter.overlays({ data: r.data, observations: r.observations, index: 0, effects: EFFECT_PRESETS.off, layers: { ndvi: true, landcover: true }, selectedId: null, reducedMotion: false, options });
    const tiles = ov.filter((o) => o.kind === 'tile' && o.id.startsWith('ndvi-')) as { id: string; zIndex?: number }[];
    const top = tiles.reduce((a, b) => ((b.zIndex ?? 0) > (a.zIndex ?? 0) ? b : a));
    expect(top.id).toContain('2026-06-10');
    expect(ov.some((o) => o.id === 'landcover-2024')).toBe(true);
    // Bare land highlighted in pink by default; the original colours when switched off.
    expect(ov.filter((o) => o.id.startsWith('ndvi-')).every((o) => o.kind === 'tile' && o.recolor === 'bare-pink')).toBe(true);
    const plain = vegetationFilter.overlays({ data: r.data, observations: r.observations, index: 0, effects: EFFECT_PRESETS.off, layers: { ndvi: true }, selectedId: null, reducedMotion: false, options: { ...options, barePink: false } });
    expect(plain.every((o) => o.kind === 'tile' && !o.recolor)).toBe(true);
  });

  it('rejects dates before the data starts', async () => {
    await expect(vegetationFilter.load({ range: { start: 0, end: 1 }, options: { date: '2015-01-01', opacity: 1, barePink: true }, signal: new AbortController().signal })).rejects.toThrow(/start/);
  });
});

describe('bare land in pink', async () => {
  const { barePink, recolorPixels } = await import('../../components/map/recolor');
  it('turns the brown/tan end of NASA’s NDVI ramp pink, deeper for barer ground, and keeps greens', () => {
    const brown = barePink(150, 90, 70)!; // barest colour in the ramp
    const pale = barePink(239, 231, 232)!; // near-white, sparse
    expect(brown).toEqual([219, 39, 119]);
    expect(pale[1]).toBeGreaterThan(brown[1]); // lighter pink
    expect(barePink(10, 105, 0)).toBeNull(); // dense vegetation unchanged
    expect(barePink(191, 222, 119)).toBeNull(); // sparse yellow-green unchanged
  });
  it('leaves transparent pixels (water, gaps) alone', () => {
    const px = new Uint8ClampedArray([150, 90, 70, 0, 150, 90, 70, 255]);
    recolorPixels(px, 'bare-pink');
    expect([...px.slice(0, 4)]).toEqual([150, 90, 70, 0]);
    expect([...px.slice(4)]).toEqual([219, 39, 119, 255]);
  });
});
