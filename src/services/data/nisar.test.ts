import { parseCmrEntry, parsePolygon, parseTrack, groupPasses, pointInPolygon, scenesAt, type NisarScene } from './nisar';
import { boundsFromKml, registerFromFootprint } from './nisarImage';

const entry = {
  title: 'NISAR_L2_PR_GCOV_023_076_A_021_2005_QPDH_A_20260619T110439_20260619T110517_P05023_N_F_J_001',
  time_start: '2026-06-19T11:04:39.000Z',
  time_end: '2026-06-19T11:05:17.000Z',
  polygons: [['37.70567 -87.40431 39.98746 -88.29361 39.281 -91.07123 37.0214 -90.10243 37.70567 -87.40431']],
  collection_concept_id: 'C123-ASF',
  links: [
    { href: 'https://nisar.asf.earthdatacloud.nasa.gov/BROWSE/X/NISAR_..._LATLON.png' },
    { href: 'https://nisar.asf.earthdatacloud.nasa.gov/BROWSE/X/NISAR_..._LATLON_thumbnail.png' },
    { href: 's3://bucket/x_LATLON.png' },
  ],
};

describe('NISAR CMR parsing', () => {
  it('parses footprint lat/lon pairs', () => {
    expect(parsePolygon('1 2 3 4 5 6')).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
  it('parses track, direction and frame from product names', () => {
    expect(parseTrack(entry.title)).toEqual({ track: 76, direction: 'Ascending', frame: 21 });
    expect(parseTrack('NISAR_L2_PR_GUNW_032_141_D_076_033_4000_SH_x')).toEqual({ track: 141, direction: 'Descending', frame: 76 });
  });
  it('builds a scene with the real acquisition time and the full-size browse image', () => {
    const s = parseCmrEntry(entry, 'GCOV', 'Provisional')!;
    expect(s.time).toBe(Date.parse('2026-06-19T11:04:39Z'));
    expect(s.browseUrl.endsWith('_LATLON.png')).toBe(true);
    expect(s.thumbUrl?.endsWith('_LATLON_thumbnail.png')).toBe(true);
    expect(s.footprint).toHaveLength(5);
    expect(s.stack).toBe('76-Ascending-21');
    expect(s.earthdataUrl).toContain('C123-ASF');
  });
  it('uses the later acquisition as the time of an interferogram', () => {
    const s = parseCmrEntry({ ...entry, title: 'NISAR_L2_PR_GUNW_032_141_D_076_033_x', time_end: '2026-07-01T11:04:39Z' }, 'GUNW', 'Validated')!;
    expect(s.start).toBe(Date.parse('2026-06-19T11:04:39Z'));
    expect(s.time).toBe(Date.parse('2026-07-01T11:04:39Z'));
  });
  it('skips entries without a browse image or footprint', () => {
    expect(parseCmrEntry({ ...entry, links: [] }, 'GCOV', 'Validated')).toBeNull();
    expect(parseCmrEntry({ ...entry, polygons: undefined }, 'GCOV', 'Validated')).toBeNull();
  });
});

describe('groupPasses (one timeline frame per satellite pass)', () => {
  const day = 864e5;
  const min = 60_000;
  const sq = (lat: number, lng: number): [number, number][] => [[lat, lng], [lat + 1, lng], [lat + 1, lng + 1], [lat, lng + 1], [lat, lng]];
  const mk = (id: string, track: number, dir: 'Ascending' | 'Descending', t: number, frame = 1, status: 'Validated' | 'Provisional' = 'Validated', fp = sq(0, 0)): NisarScene => ({
    id, stack: `${track}-${dir}-${frame}`, time: t, start: t, end: t + 30_000, product: 'GCOV', status, footprint: fp,
    track, frame, direction: dir, browseUrl: '', thumbUrl: null, kmlUrl: null, earthdataUrl: '',
  });
  const scenes = [
    mk('p3', 10, 'Ascending', 15 * day), // same track, next repeat cycle
    mk('p1', 10, 'Ascending', 3 * day, 1, 'Validated', sq(30, -90)),
    mk('p2', 10, 'Ascending', 3 * day + 40_000, 2, 'Provisional', sq(31, -90)), // next frame along the same pass
    mk('q1', 22, 'Descending', 4 * day),
    mk('q2', 10, 'Descending', 3 * day + 5 * min), // same track number, other direction
  ];
  const passes = groupPasses(scenes);

  it('joins adjoining frames of one pass and orders passes by real time', () => {
    expect(passes.map((p) => p.scenes.map((s) => s.id))).toEqual([['p1', 'p2'], ['q2'], ['q1'], ['p3']]);
    expect(passes[0].time).toBe(3 * day);
  });
  it('marks a pass provisional unless every frame is validated', () => {
    expect(passes[0].status).toBe('Provisional');
    expect(passes[1].status).toBe('Validated');
  });
  it('finds which pass and frame cover a clicked point, or none', () => {
    const hit = scenesAt(passes, [31.5, -89.5]);
    expect(hit.map((h) => h.scene.id)).toEqual(['p2']);
    expect(scenesAt(passes, [45, 10])).toEqual([]);
    expect(pointInPolygon([0.5, 0.5], sq(0, 0))).toBe(true);
    expect(pointInPolygon([1.5, 0.5], sq(0, 0))).toBe(false);
  });
});

describe('browse georeferencing', () => {
  it('reads LatLonQuad bounds from KML', () => {
    const kml = '<kml><coordinates>-79.0,23.1 -75.5,23.1 -75.5,26.3 -79.0,26.3</coordinates></kml>';
    expect(boundsFromKml(kml)).toEqual({ west: -79, east: -75.5, south: 23.1, north: 26.3 });
    expect(boundsFromKml('<kml/>')).toBeNull();
  });

  it('fits image bounds from a rotated swath and its footprint', () => {
    // Synthetic 100x100 image covering lon -100..-90, lat 40..30 with a rotated diamond swath.
    const w = 100, h = 100;
    const lon = (x: number) => -100 + (x / w) * 10;
    const lat = (y: number) => 40 - (y / h) * 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const cx = 50, cy = 50;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) <= 40) {
        const o = (y * w + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 180;
        rgba[o + 3] = 255;
      }
    }
    // Diamond vertices in geographic coordinates (pixel centres → lat/lon).
    const fp: [number, number][] = [[lat(50), lon(10)], [lat(10), lon(50)], [lat(50), lon(90)], [lat(90), lon(50)], [lat(50), lon(10)]];
    const r = registerFromFootprint(rgba, w, h, fp)!;
    expect(r.method).toBe('footprint-fit');
    expect(r.bounds.west).toBeCloseTo(-100, 5);
    expect(r.bounds.east).toBeCloseTo(-90, 5);
    expect(r.bounds.north).toBeCloseTo(40, 5);
    expect(r.bounds.south).toBeCloseTo(30, 5);
    expect(r.residualPx).toBeLessThan(1);
  });

  it('returns null for an empty image', () => {
    expect(registerFromFootprint(new Uint8ClampedArray(16 * 4), 4, 4, [[0, 0], [1, 1], [0, 1]])).toBeNull();
  });
});
