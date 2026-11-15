import { aoiGrid, syntheticOccurrence, type WaterBaseline } from './baseline';
import { DEMO_SCENES } from './demoScenario';
import { CLASS, DEFAULT_FLOOD_OPTIONS, compareFrames, demoWaterScenes, floodTimelineEvents, runFloodPipeline } from './pipeline';
import { buildFloodOverlays, floodStats, floodFilter } from './floodFilter';
import { EFFECT_PRESETS } from '../../state/store';
import type { FrameContext } from '../../types';

const g = aoiGrid();
const baseline: WaterBaseline = { grid: g, occurrence: syntheticOccurrence(g.cols, g.rows), source: 'synthetic', note: 'test' };
const DEMO_OPTIONS = { ...DEFAULT_FLOOD_OPTIONS, source: 'demo' as const };
const data = runFloodPipeline(baseline, demoWaterScenes(baseline, DEMO_SCENES), DEMO_OPTIONS);
const layers = { flood: true, permanent: true, receded: true, nodata: true, 'jrc-occurrence': false };

const ctx = (index: number, mode: 'off' | 'clean' | 'cinematic', selectedId: string | null = null): FrameContext<typeof data, typeof DEFAULT_FLOOD_OPTIONS> => ({
  data, observations: data.frames.map((f) => f.obs), index, effects: EFFECT_PRESETS[mode], layers, selectedId, reducedMotion: false, options: DEMO_OPTIONS,
});

describe('flood pipeline (demo scenes, synthetic baseline)', () => {
  it('produces one frame per scene with real, sorted timestamps', () => {
    expect(data.frames).toHaveLength(DEMO_SCENES.length);
    const times = data.frames.map((f) => f.obs.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(data.frames.every((f) => f.obs.kind === 'demo-observed')).toBe(true);
  });

  it('keeps permanent water separate from potential flood', () => {
    for (const f of data.frames) {
      for (let i = 0; i < f.classes.length; i++) {
        if (data.permanentMask[i] && f.classes[i] !== CLASS.NODATA) expect(f.classes[i]).toBe(CLASS.PERMANENT);
      }
    }
  });

  it('flood area grows then recedes, with a single maximum extent', () => {
    const areas = data.frames.map((f) => f.floodKm2);
    expect(data.maxExtent.index).toBeGreaterThan(0);
    expect(data.maxExtent.index).toBeLessThan(areas.length - 1);
    expect(areas[0]).toBeLessThan(data.maxExtent.km2);
  });

  it('marks the partial-coverage scene as no-data rather than dry land', () => {
    const partial = data.frames.find((f) => f.coverageFraction < 1)!;
    expect(partial).toBeDefined();
    const nodata = partial.classes.filter((c) => c === CLASS.NODATA).length;
    expect(nodata).toBeGreaterThan(0);
    expect(partial.recededMask.some((v, i) => v && partial.classes[i] === CLASS.NODATA)).toBe(false);
  });

  it('every blob ID has a consistent track history', () => {
    for (const [fi, f] of data.frames.entries()) {
      for (const b of f.blobs) {
        const h = data.tracks[b.trackId].history.find((x) => x.frameIndex === fi);
        expect(h?.areaKm2).toBeCloseTo(b.areaKm2);
      }
    }
  });

  it('compares observations only over area imaged by both', () => {
    const partial = data.frames.findIndex((f) => f.coverageFraction < 1);
    const c = data.frames[partial].vsPrev!;
    expect(c.commonFraction).toBeCloseTo(data.frames[partial].coverageFraction, 5);
    // The previous frame's area within the common footprint is no larger than its full area.
    expect(c.beforeKm2).toBeLessThanOrEqual(data.frames[partial - 1].floodKm2 + 1e-9);
    const self = compareFrames(data.frames[2], data.frames[2], () => 1);
    expect(self.beforeKm2).toBe(self.afterKm2);
  });

  it('timeline recession is measured over shared coverage', () => {
    const ev = floodTimelineEvents(data).find((e) => e.type === 'recession');
    expect(ev).toBeDefined();
    expect(ev!.time).toBeGreaterThan(data.frames[data.maxExtent.index].obs.time);
  });

  it('filter.load returns no observations for a range without scenes', async () => {
    // Uses the cached synthetic baseline path when fetch is unavailable.
    const orig = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    try {
      const r = await floodFilter.load({ range: { start: Date.UTC(2020, 0, 1), end: Date.UTC(2020, 1, 1) }, options: DEMO_OPTIONS, signal: new AbortController().signal });
      expect(r.observations).toEqual([]);
      expect(r.notices.join(' ')).toMatch(/SYNTHETIC/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('loads real NISAR water maps as observed frames with quality metadata', async () => {
    const cells = g.cols * g.rows;
    const bin = new Uint8Array(cells).fill(1);
    for (let i = 0; i < cells / 2; i++) bin[i] = 0; // north half not imaged
    for (let i = cells / 2; i < cells / 2 + 400; i++) bin[i] = 2;
    const manifest = {
      aoi: 'stl', name: 'test', grid: {}, generated: '2026-11-14T00:00:00+00:00', range: { start: '2026-06-01', end: '2026-11-14' },
      product: 'GCOV', method: 'm', limitations: 'l',
      passes: [{ id: '2026-06-26_T004A', time: '2026-06-26T11:12:27.000Z', track: 4, direction: 'Ascending', status: 'Provisional', granules: ['x'],
        coverage: 0.5, waterFraction: 0.01, threshold_hh_db: -14.2, separation_hh_db: 7, threshold_hv_db: -21, separation_hv_db: 5, channels: 'HH+HV', frames: 2 }],
    };
    const orig = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      if (url.endsWith('manifest.json')) return Promise.resolve(new Response(JSON.stringify(manifest)));
      if (url.endsWith('.bin')) return Promise.resolve(new Response(bin));
      return Promise.reject(new Error('offline'));
    }) as typeof fetch;
    try {
      const r = await floodFilter.load({ range: { start: Date.UTC(2026, 5, 1), end: Date.UTC(2026, 10, 14) }, options: { ...DEFAULT_FLOOD_OPTIONS, source: 'nisar' }, signal: new AbortController().signal });
      expect(r.observations).toHaveLength(1);
      expect(r.observations[0]).toMatchObject({ kind: 'observed', time: Date.parse('2026-06-26T11:12:27Z') });
      expect(r.observations[0].quality?.['HH water threshold']).toBe('-14.2 dB');
      expect(r.data.source).toBe('nisar');
      expect(r.data.frames[0].coverageFraction).toBeCloseTo(0.5, 3);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('tracking effects never alter science', () => {
  const idx = data.maxExtent.index;

  it('Off mode shows no boxes, IDs, or trails but keeps flood polygons', () => {
    const o = buildFloodOverlays(ctx(idx, 'off'));
    expect(o.some((x) => x.kind === 'rect' || x.kind === 'polyline')).toBe(false);
    expect(o.some((x) => x.id.startsWith('flood-extent'))).toBe(true);
    expect(o.some((x) => x.id === 'flood-permanent')).toBe(true);
  });

  it('Clean mode adds boxes matching measured blob bounds', () => {
    const o = buildFloodOverlays(ctx(idx, 'clean'));
    const rects = o.filter((x) => x.kind === 'rect');
    expect(rects.length).toBe(data.frames[idx].blobs.length);
    for (const r of rects) {
      if (r.kind !== 'rect') continue;
      const blob = data.frames[idx].blobs.find((b) => `box-${b.trackId}` === r.id)!;
      expect(r.bounds).toEqual(blob.bounds);
    }
  });

  it('trails only connect historical centroids of actual observations', () => {
    const o = buildFloodOverlays(ctx(idx, 'cinematic'));
    const centroids = new Set(Object.values(data.tracks).flatMap((t) => t.history.filter((h) => h.frameIndex <= idx).map((h) => h.centroid.join(','))));
    for (const l of o) if (l.kind === 'polyline') for (const p of l.points) expect(centroids.has(p.join(','))).toBe(true);
  });

  it('statistics are identical across Off / Clean / Cinematic', () => {
    const a = floodStats(ctx(idx, 'off'));
    expect(floodStats(ctx(idx, 'clean'))).toEqual(a);
    expect(floodStats(ctx(idx, 'cinematic'))).toEqual(a);
  });

  it('turning a layer off removes only that layer', () => {
    const c = ctx(idx, 'clean');
    const without = buildFloodOverlays({ ...c, layers: { ...layers, flood: false } });
    expect(without.some((x) => x.id.startsWith('flood-extent'))).toBe(false);
    expect(without.some((x) => x.id === 'flood-permanent')).toBe(true);
  });

  it('hitTest selects the blob under a clicked cell', () => {
    const b = data.frames[idx].blobs[0];
    const cell = data.frames[idx].labels.findIndex((l) => l === b.label);
    const r = Math.floor(cell / g.cols);
    const c = cell % g.cols;
    const lat = (g.latEdges[r] + g.latEdges[r + 1]) / 2;
    const lng = g.west + ((c + 0.5) * (g.east - g.west)) / g.cols;
    expect(floodFilter.hitTest!(ctx(idx, 'clean'), [lat, lng])).toBe(b.trackId);
  });
});

describe('real Sentinel-1 flood source (NASA OPERA DSWx-S1, April 2025) — default', () => {
  it('is the default and loads the processed passes from disk as observed frames that show the flood', async () => {
    // Node's fs, loaded by name so the browser-only tsconfig needs no Node types.
    const fsName = 'node:fs';
    const { readFileSync } = await import(/* @vite-ignore */ fsName);
    const dir = `${(globalThis as unknown as { process: { cwd(): string } }).process.cwd()}/public/data/opera-flood/bootheel25/`;
    expect(DEFAULT_FLOOD_OPTIONS.source).toBe('opera');
    const orig = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      const file = String(url).split('/opera-flood/bootheel25/')[1];
      if (file) return Promise.resolve(new Response(readFileSync(dir + file), { headers: { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }));
      return Promise.reject(new Error('offline')); // JRC tiles → explicit synthetic baseline
    }) as typeof fetch;
    try {
      const r = await floodFilter.load({ range: { start: Date.UTC(2025, 2, 15), end: Date.UTC(2025, 4, 15, 23, 59) }, options: DEFAULT_FLOOD_OPTIONS, signal: new AbortController().signal });
      expect(r.data.source).toBe('opera');
      expect(r.observations.length).toBe(10);
      expect(r.observations.every((o) => o.kind === 'observed' && o.label?.includes('Sentinel-1'))).toBe(true);
      expect(r.notices[0]).toContain('not NISAR');
      // The flood peak (10 Apr) has more potential-flood area than the week before it.
      const at = (iso: string) => r.data.frames.find((f) => new Date(f.obs.time).toISOString().startsWith(iso))!;
      expect(at('2025-04-10').floodKm2).toBeGreaterThan(at('2025-03-29').floodKm2 * 2);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
