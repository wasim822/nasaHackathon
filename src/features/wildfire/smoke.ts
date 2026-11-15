import type { LatLng } from '../../types';

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
