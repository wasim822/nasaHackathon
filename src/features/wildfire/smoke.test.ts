import { afterEach, describe, expect, it, vi } from 'vitest';
import sample from './hms_sample.test-fixture.kml?raw';
import type { LatLng } from '../../types';
import { SMOKE_FIT_STEPS, fitSmokeHalf, hmsUrl, parseHmsKml, ringBounds, smokeBoxesIn, type SmokeArea } from './smoke';
import { compass, fetchWind, goesLayer, goesTimes } from './smokeDriftData';

describe('NOAA HMS smoke', () => {
  it('parses density, analysis window and lat/lng rings from a real HMS KML excerpt (2026-10-16)', () => {
    const areas = parseHmsKml(sample);
    expect(areas.map((a) => a.density)).toEqual(['light', 'heavy']); // light drawn first, heavy on top
    expect(areas[0].window).toBe('1200–1500 UTC');
    expect(areas[0].ring[0]).toEqual([29.103904, -82.220549]);
    expect(areas[0].ring).toHaveLength(6);
  });
  it('builds the per-day file path behind the proxy', () => {
    expect(hmsUrl(Date.UTC(2026, 9, 16))).toBe('/proxy/hms/2026/10/hms_smoke20261016.kml');
  });
});

describe('smoke boxes', () => {
  // A triangle with corners (lat, lng) (0,0), (0,10), (10,0).
  const tri: SmokeArea = { density: 'heavy', window: null, ring: [[0, 0], [0, 10], [10, 0]] };

  it('bounds a whole area', () => {
    expect(ringBounds(tri.ring)).toEqual({ south: 0, north: 10, west: 0, east: 10 });
  });
  it('boxes only the part of an area inside the view', () => {
    const { boxes, covering } = smokeBoxesIn([tri], { south: 6, north: 20, west: -5, east: 20 });
    expect(covering).toBeNull();
    const [b] = boxes;
    expect(b.density).toBe('heavy');
    expect(b.south).toBeCloseTo(6);
    expect(b.north).toBeCloseTo(10);
    expect(b.west).toBeCloseTo(0);
    expect(b.east).toBeCloseTo(4); // the hypotenuse lat + lng = 10 at lat 6
  });
  it('drops areas outside the view', () => {
    expect(smokeBoxesIn([tri], { south: 20, north: 30, west: 0, east: 10 })).toEqual({ boxes: [], covering: null });
  });
  it('reports smoke covering most of the view as `covering` instead of a frame-sized box', () => {
    expect(smokeBoxesIn([tri], { south: 1, north: 2, west: 1, east: 2 })).toEqual({ boxes: [], covering: 'heavy' });
  });
  it('keeps only the densest of the nested areas over the fire (the view centre)', () => {
    // View centred on (5, 5); light and medium both cover the fire, a heavy patch elsewhere does not.
    const square = (s: number, n: number, w: number, e: number): LatLng[] => [[s, w], [s, e], [n, e], [n, w]];
    const light: SmokeArea = { density: 'light', window: null, ring: square(4, 5.8, 4, 5.8) };
    const medium: SmokeArea = { density: 'medium', window: null, ring: square(4.5, 5.5, 4.5, 5.5) };
    const heavy: SmokeArea = { density: 'heavy', window: null, ring: square(0.5, 1.5, 0.5, 1.5) };
    const { boxes } = smokeBoxesIn([light, medium, heavy], { south: 0, north: 10, west: 0, east: 10 });
    expect(boxes.map((b) => b.density)).toEqual(['medium', 'heavy']);
  });
});

describe('zooming out to the smoke edges', () => {
  // A 2° x 2° smoke square centred on a fire at (0, 0).
  const area: SmokeArea = { density: 'light', window: null, ring: [[-1, -1], [-1, 1], [1, 1], [1, -1]] };

  it('keeps the chosen view when the smoke does not fill it', () => {
    expect(fitSmokeHalf([[area]], [5, 5], 0.11)).toBe(0.11);
    expect(fitSmokeHalf([[], []], [0, 0], 0.11)).toBe(0.11);
  });
  it('widens to the first step where the smoke no longer fills the view', () => {
    expect(fitSmokeHalf([[area]], [0, 0], 0.11)).toBe(1.8);
  });
  it('considers every day shown (before and after)', () => {
    expect(fitSmokeHalf([[], [area]], [0, 0], 0.11)).toBe(1.8);
  });
  it('stops at the widest step for continent-sized smoke', () => {
    const huge: SmokeArea = { density: 'light', window: null, ring: [[-40, -60], [-40, 60], [40, 60], [40, -60]] };
    expect(fitSmokeHalf([[huge]], [0, 0], 0.11)).toBe(SMOKE_FIT_STEPS[SMOKE_FIT_STEPS.length - 1]);
  });
});

describe('smoke drift', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the GOES satellite that sees the fire and daylight frames around local noon', () => {
    expect(goesLayer(-120)).toBe('GOES-West_ABI_GeoColor');
    expect(goesLayer(-80)).toBe('GOES-East_ABI_GeoColor');
    const day = Date.UTC(2026, 8, 15);
    const t = goesTimes(-120, day); // solar noon ≈ 20:00 UTC
    expect(t).toHaveLength(17);
    expect(new Date(t[8]).toISOString()).toBe('2026-09-15T20:00:00.000Z');
    expect(t.every((x) => x % 6e5 === 0)).toBe(true); // aligned to 10-min scans
  });

  it('turns model wind "from" into the direction smoke is carried toward', async () => {
    const hourly = { time: Array.from({ length: 24 }, (_, h) => `2026-09-15T${String(h).padStart(2, '0')}:00`), wind_direction_850hPa: Array(24).fill(270), wind_speed_850hPa: Array(24).fill(18) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hourly }), { status: 200 })));
    const w = await fetchWind([37.6, -120], Date.UTC(2026, 8, 15));
    expect(w.fromDeg).toBe(270);
    expect(w.towardDeg).toBe(90);
    expect(compass(w.fromDeg)).toBe('W');
    expect(compass(w.towardDeg)).toBe('E');
    expect(new Date(w.time).toISOString()).toBe('2026-09-15T20:00:00.000Z');
  });
});
