import { afterEach, describe, expect, it, vi } from 'vitest';
import sample from './hms_sample.test-fixture.kml?raw';
import { hmsUrl, parseHmsKml } from './smoke';
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
