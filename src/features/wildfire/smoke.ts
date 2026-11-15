import type { GeoBounds, LatLng } from '../../types';
import { boxAround } from './gibsSnapshots';

/**
 * NOAA Hazard Mapping System (HMS) smoke: daily smoke areas outlined by NOAA analysts from
 * GOES/polar satellite imagery, rated Light / Medium / Heavy. One KML per UTC day.
 * NOAA's server sends no CORS header, so the browser reaches it through the dev/preview proxy
 * configured in vite.config.ts (`/proxy/hms` → NOAA). A static deployment needs the same rewrite.
 */
export const HMS_PROXY = '/proxy/hms';
export const HMS_INFO = 'https://www.ospo.noaa.gov/products/land/hms.html';

export type SmokeDensity = 'light' | 'medium' | 'heavy';

export interface SmokeArea {
  density: SmokeDensity;
  ring: LatLng[];
  /** Analysis window from NOAA, e.g. "1200–1500 UTC". */
  window: string | null;
}

export type SmokeDay = { status: 'loading' } | { status: 'ready'; areas: SmokeArea[] } | { status: 'error'; message: string };

/** Keep outlines light: at most this many vertices per ring. */
const MAX_VERTICES = 120;

export function hmsUrl(day: number): string {
  const d = new Date(day);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${HMS_PROXY}/${y}/${m}/hms_smoke${y}${m}${dd}.kml`;
}

/** Parses an HMS smoke KML into areas (outer rings only; HMS polygons have no holes). */
export function parseHmsKml(kml: string): SmokeArea[] {
  const out: SmokeArea[] = [];
  for (const pm of kml.split('<Placemark').slice(1)) {
    const dens = pm.match(/Density:\s*(Light|Medium|Heavy)/i)?.[1].toLowerCase() as SmokeDensity | undefined;
    const coords = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/)?.[1];
    if (!dens || !coords) continue;
    const ring: LatLng[] = [];
    for (const t of coords.trim().split(/\s+/)) {
      const [lng, lat] = t.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) ring.push([lat, lng]);
    }
    if (ring.length < 3) continue;
    const step = Math.ceil(ring.length / MAX_VERTICES);
    const start = pm.match(/Start Time:\s*\d{7}\s*(\d{4})UTC/)?.[1];
    const end = pm.match(/End Time:\s*\d{7}\s*(\d{4})UTC/)?.[1];
    out.push({ density: dens, ring: step > 1 ? ring.filter((_, i) => i % step === 0) : ring, window: start && end ? `${start}–${end} UTC` : null });
  }
  // Draw light first so heavier smoke sits on top.
  const order: Record<SmokeDensity, number> = { light: 0, medium: 1, heavy: 2 };
  return out.sort((a, b) => order[a.density] - order[b.density]);
}

/** Lat/lng bounding box of a ring. */
export function ringBounds(ring: LatLng[]): GeoBounds {
  const lats = ring.map((p) => p[0]);
  const lngs = ring.map((p) => p[1]);
  return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
}

/** Keeps the part of a ring on one side of a lat (k=0) or lng (k=1) line (Sutherland–Hodgman step). */
function clipEdge(ring: LatLng[], k: 0 | 1, v: number, keepAbove: boolean): LatLng[] {
  const inside = (p: LatLng) => (keepAbove ? p[k] >= v : p[k] <= v);
  const cross = (a: LatLng, b: LatLng): LatLng => {
    const t = (v - a[k]) / (b[k] - a[k]);
    const p: LatLng = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    p[k] = v;
    return p;
  };
  const out: LatLng[] = [];
  ring.forEach((cur, i) => {
    const prev = ring[(i + ring.length - 1) % ring.length];
    if (inside(cur)) {
      if (!inside(prev)) out.push(cross(prev, cur));
      out.push(cur);
    } else if (inside(prev)) out.push(cross(prev, cur));
  });
  return out;
}

export interface SmokeBox extends GeoBounds {
  density: SmokeDensity;
  /** The area's outline cut to the view. */
  ring: LatLng[];
}

export interface SmokeInView {
  boxes: SmokeBox[];
  /** Densest smoke that covers most of the view: shown as a badge instead of a frame-sized box. */
  covering: SmokeDensity | null;
}

/** An area covering at least this share of the view counts as "smoke over the entire view". */
const COVER_FRACTION = 0.8;
const RANK: Record<SmokeDensity, number> = { light: 0, medium: 1, heavy: 2 };

function clipToView(ring: LatLng[], v: GeoBounds): LatLng[] {
  let r = clipEdge(ring, 0, v.south, true);
  r = clipEdge(r, 0, v.north, false);
  r = clipEdge(r, 1, v.west, true);
  return clipEdge(r, 1, v.east, false);
}

/** Planar (degree²) area; only compared with the view's area in the same units. */
function ringArea(r: LatLng[]): number {
  let a = 0;
  r.forEach((p, i) => {
    const q = r[(i + 1) % r.length];
    a += p[1] * q[0] - q[1] * p[0];
  });
  return Math.abs(a) / 2;
}

function contains(ring: LatLng[], [lat, lng]: LatLng): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (ai > lat !== aj > lat && lng < ((bj - bi) * (lat - ai)) / (aj - ai) + bi) inside = !inside;
  }
  return inside;
}

/**
 * Smoke areas inside `view`, an image centred on the fire, cut to the view (outline + its extent):
 *  - HMS nests light/medium/heavy areas, so of the areas over the fire only the densest is kept;
 *  - an area covering most of the view becomes `covering` instead of a box the size of the frame.
 */
export function smokeBoxesIn(areas: SmokeArea[], view: GeoBounds): SmokeInView {
  const fire: LatLng = [(view.south + view.north) / 2, (view.west + view.east) / 2];
  const viewArea = (view.north - view.south) * (view.east - view.west);
  const parts = areas.map((a) => ({ a, r: clipToView(a.ring, view) })).filter((p) => p.r.length >= 3 && ringArea(p.r) > 0);
  const overFire = parts.filter((p) => contains(p.a.ring, fire));
  const densest = overFire.reduce<(typeof parts)[number] | null>((m, p) => (!m || RANK[p.a.density] > RANK[m.a.density] ? p : m), null);

  const out: SmokeInView = { boxes: [], covering: null };
  for (const p of parts) {
    if (overFire.includes(p) && p !== densest) continue;
    if (ringArea(p.r) >= COVER_FRACTION * viewArea) {
      if (!out.covering || RANK[p.a.density] > RANK[out.covering]) out.covering = p.a.density;
    } else {
      out.boxes.push({ density: p.a.density, ring: p.r, ...ringBounds(p.r) });
    }
  }
  return out;
}

/** View half-heights (degrees of latitude) tried when zooming out to a smoke area's edges: up to ~1,600 km tall. */
export const SMOKE_FIT_STEPS = [0.045, 0.11, 0.3, 0.45, 0.9, 1.8, 3.6, 7.2];

/**
 * Smallest view around `at`, from `half` upward, in which no day's smoke fills the frame, so the edges
 * of the smoke show. Returns `half` when nothing fills it, and the largest step if even that is filled.
 */
export function fitSmokeHalf(days: SmokeArea[][], at: LatLng, half: number): number {
  const fills = (h: number) => days.some((areas) => smokeBoxesIn(areas, boxAround(at, h)).covering !== null);
  if (!fills(half)) return half;
  return SMOKE_FIT_STEPS.find((h) => h > half && !fills(h)) ?? SMOKE_FIT_STEPS[SMOKE_FIT_STEPS.length - 1];
}

const days = new Map<number, SmokeDay>();
const listeners = new Set<() => void>();

export function subscribeSmoke(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The day's smoke if loaded; starts loading it (once) otherwise. */
export function smokeFor(day: number): SmokeDay {
  const hit = days.get(day);
  if (hit) return hit;
  days.set(day, { status: 'loading' });
  fetch(hmsUrl(day))
    .then(async (r) => {
      const type = r.headers.get('content-type') ?? '';
      // Without the proxy a dev server answers with the HTML app shell instead.
      if (!r.ok || type.includes('text/html')) throw new Error(r.status === 404 ? 'No NOAA smoke analysis for this day' : 'NOAA smoke service not reachable (needs the /proxy/hms rewrite)');
      days.set(day, { status: 'ready', areas: parseHmsKml(await r.text()) });
    })
    .catch((e: unknown) => days.set(day, { status: 'error', message: e instanceof Error ? e.message : String(e) }))
    .finally(() => listeners.forEach((fn) => fn()));
  return days.get(day)!;
}
