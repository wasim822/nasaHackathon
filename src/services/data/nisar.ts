import type { GeoBounds, LatLng, TimeRange } from '../../types';

/**
 * Real NISAR products, discovered through NASA's Common Metadata Repository (CMR).
 * CMR search is public (no login) and CORS-enabled. Each product has a public,
 * geocoded browse PNG ("LATLON") hosted by the Alaska Satellite Facility (ASF DAAC).
 * Browse images are display-stretched quick-looks — not calibrated measurements.
 */
export type NisarProduct = 'GCOV' | 'GUNW';
export type NisarStatus = 'Validated' | 'Provisional';

export const NISAR_PRODUCTS: Record<NisarProduct, { label: string; description: string; collections: { shortName: string; status: NisarStatus }[]; docs: string }> = {
  GCOV: {
    label: 'Radar backscatter (L2 GCOV)',
    description: 'Geocoded L-band polarimetric backscatter. Smooth water looks dark; forests and towns look bright.',
    collections: [
      { shortName: 'NISAR_L2_GCOV_V1', status: 'Validated' },
      { shortName: 'NISAR_L2_GCOV_PROVISIONAL_V1', status: 'Provisional' },
    ],
    docs: 'https://nisar-docs.asf.alaska.edu/gcov/',
  },
  GUNW: {
    label: 'Interferogram (L2 GUNW)',
    description: 'Geocoded unwrapped interferogram between two passes. Colour cycles reveal ground motion (e.g. earthquakes) or atmospheric noise.',
    collections: [
      { shortName: 'NISAR_L2_GUNW_V1', status: 'Validated' },
      { shortName: 'NISAR_L2_GUNW_PROVISIONAL_V1', status: 'Provisional' },
    ],
    docs: 'https://nisar-docs.asf.alaska.edu/gunw/',
  },
};

export interface NisarScene {
  id: string;
  product: NisarProduct;
  status: NisarStatus;
  /** Acquisition start (GCOV) or reference/first acquisition (GUNW). */
  start: number;
  /** Acquisition end (GCOV) or secondary/second acquisition (GUNW). */
  end: number;
  /** Representative time used for timeline placement (the later acquisition). */
  time: number;
  footprint: LatLng[];
  track: number | null;
  frame: number | null;
  direction: 'Ascending' | 'Descending' | null;
  /** Repeat-pass stack key (track + direction + frame). */
  stack: string;
  browseUrl: string;
  kmlUrl: string | null;
  earthdataUrl: string;
}

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
export const NISAR_PAGE_SIZE = 150;

interface CmrEntry {
  title: string;
  time_start: string;
  time_end?: string;
  polygons?: string[][];
  boxes?: string[];
  collection_concept_id: string;
  links: { href: string; rel?: string }[];
}

export function parsePolygon(s: string): LatLng[] {
  const n = s.trim().split(/\s+/).map(Number);
  const out: LatLng[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

/** NISAR names: ..._<cycle>_<track>_<A|D>_<frame>_... */
export function parseTrack(title: string): { track: number | null; direction: NisarScene['direction']; frame: number | null } {
  const m = title.match(/_(\d{3})_(\d{3})_([AD])_(\d{3})_/);
  if (!m) return { track: null, direction: null, frame: null };
  return { track: Number(m[2]), direction: m[3] === 'A' ? 'Ascending' : 'Descending', frame: Number(m[4]) };
}

export function parseCmrEntry(e: CmrEntry, product: NisarProduct, status: NisarStatus): NisarScene | null {
  const https = e.links.map((l) => l.href).filter((h) => h.startsWith('https://'));
  const browseUrl = https.find((h) => h.includes('/BROWSE/') && h.endsWith('_LATLON.png'));
  const poly = e.polygons?.[0]?.[0];
  if (!browseUrl || !poly) return null;
  const start = Date.parse(e.time_start);
  const end = e.time_end ? Date.parse(e.time_end) : start;
  if (!Number.isFinite(start)) return null;
  const t = parseTrack(e.title);
  return {
    id: e.title,
    product,
    status,
    start,
    end: Number.isFinite(end) ? end : start,
    time: product === 'GUNW' && Number.isFinite(end) ? end : start,
    footprint: parsePolygon(poly),
    ...t,
    stack: `${t.track ?? '?'}-${t.direction ?? '?'}-${t.frame ?? '?'}`,
    browseUrl,
    kmlUrl: https.find((h) => h.includes('/BROWSE/') && h.endsWith('_LATLON.kml')) ?? null,
    earthdataUrl: `https://search.earthdata.nasa.gov/search/granules?p=${encodeURIComponent(e.collection_concept_id)}&q=${encodeURIComponent(e.title)}`,
  };
}

function clampBounds(b: GeoBounds): GeoBounds {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { west: c(b.west, -180, 180), east: c(b.east, -180, 180), south: c(b.south, -90, 90), north: c(b.north, -90, 90) };
}

export interface NisarSearchResult {
  scenes: NisarScene[];
  truncated: boolean;
}

export async function searchNisar(product: NisarProduct, bounds: GeoBounds, range: TimeRange, signal: AbortSignal): Promise<NisarSearchResult> {
  const b = clampBounds(bounds);
  const temporal = `${new Date(range.start).toISOString()},${new Date(range.end).toISOString()}`;
  const results = await Promise.all(
    NISAR_PRODUCTS[product].collections.map(async ({ shortName, status }) => {
      const params = new URLSearchParams({
        short_name: shortName,
        bounding_box: `${b.west},${b.south},${b.east},${b.north}`,
        temporal,
        page_size: String(NISAR_PAGE_SIZE),
        sort_key: '-start_date',
      });
      const res = await fetch(`${CMR}?${params}`, { signal });
      if (!res.ok) throw new Error(`NASA CMR search failed (HTTP ${res.status})`);
      const hits = Number(res.headers.get('CMR-Hits') ?? '0');
      const json = (await res.json()) as { feed: { entry: CmrEntry[] } };
      const scenes = json.feed.entry.map((e) => parseCmrEntry(e, product, status)).filter((x): x is NisarScene => !!x);
      return { scenes, truncated: hits > NISAR_PAGE_SIZE };
    }),
  );
  // A validated product supersedes a provisional one of the same acquisition.
  const byKey = new Map<string, NisarScene>();
  for (const s of results.flatMap((r) => r.scenes)) {
    const key = `${s.stack}|${s.start}|${s.end}`;
    const prev = byKey.get(key);
    if (!prev || (prev.status === 'Provisional' && s.status === 'Validated')) byKey.set(key, s);
  }
  return {
    scenes: [...byKey.values()].sort((a, b) => a.time - b.time),
    truncated: results.some((r) => r.truncated),
  };
}

/**
 * One clean strip: the single acquisition nearest the reference time (or the pinned
 * scene), plus the other frames of that same pass (same track and direction, acquired
 * within minutes), so adjacent frames join seamlessly instead of overlapping.
 */
export function selectPass(scenes: NisarScene[], refTime: number, windowMs: number, pinnedId: string | null, max = 12): NisarScene[] {
  let anchor = pinnedId ? scenes.find((s) => s.id === pinnedId) : undefined;
  if (!anchor) {
    for (const s of scenes) {
      const d = Math.abs(s.time - refTime);
      if (d <= windowMs && (!anchor || d < Math.abs(anchor.time - refTime))) anchor = s;
    }
  }
  if (!anchor) return [];
  const a = anchor;
  const near = (x: number, y: number) => Math.abs(x - y) <= 15 * 60 * 1000;
  const samePass = scenes.filter((s) => s.id !== a.id && s.track === a.track && s.direction === a.direction && near(s.start, a.start) && near(s.end, a.end));
  return [a, ...samePass].slice(0, max);
}

/**
 * Chooses which scenes to draw for a reference time: for each repeat-pass stack the
 * acquisition nearest in time (within ±windowDays). A pinned scene is always included.
 */
export function selectScenes(scenes: NisarScene[], refTime: number, windowMs: number, pinnedId: string | null, max = 10): NisarScene[] {
  const best = new Map<string, NisarScene>();
  for (const s of scenes) {
    const d = Math.abs(s.time - refTime);
    if (d > windowMs) continue;
    const cur = best.get(s.stack);
    if (!cur || d < Math.abs(cur.time - refTime)) best.set(s.stack, s);
  }
  let out = [...best.values()].sort((a, b) => Math.abs(a.time - refTime) - Math.abs(b.time - refTime)).slice(0, max);
  const pinned = pinnedId ? scenes.find((s) => s.id === pinnedId) : undefined;
  if (pinned) out = [pinned, ...out.filter((s) => s.id !== pinned.id && s.stack !== pinned.stack)].slice(0, max);
  return out;
}
