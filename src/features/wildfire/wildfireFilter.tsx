import type { DetailProps, FilterDefinition, FrameContext, LatLng, Observation, OptionsProps, OverlaySpec, StatItem } from '../../types';
import { REGION_BOXES, REGION_NAME, isInRegion } from '../../services/geospatial/region';
import { DAY, fmtDate, fmtDateTime, fmtIso } from '../../services/time/format';
import { groupByUtcDay } from '../../services/time/group';
import { fmtCoord } from '../../services/format';
import { FireImagery } from './FireImagery';
import { FirePopup } from './FirePopup';
import { isoDay } from './gibsSnapshots';
import { HMS_INFO, type SmokeDensity, ringBounds, smokeFor, subscribeSmoke } from './smoke';

const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const SMOKE_EDGE: Record<SmokeDensity, string> = { light: '#cbd5e1', medium: '#94a3b8', heavy: '#64748b' };

/** One dated location report for a wildfire event, as published by EONET's sources. */
export interface FireReport {
  eventId: string;
  time: number;
  at: LatLng;
  size: number | null;
  sizeUnit: string | null;
}

export interface FireEvent {
  id: string;
  title: string;
  sources: { id: string; url: string }[];
  closed: number | null;
  link: string;
  reports: FireReport[];
}

export interface FireData {
  events: Record<string, FireEvent>;
  reports: FireReport[];
  days: { day: number; reportIdx: number[] }[];
}

export interface FireOptions {
  trailingDays: number;
}

type Ctx = FrameContext<FireData, FireOptions>;

const EONET = 'https://eonet.gsfc.nasa.gov/api/v3/events';

interface EonetGeometry {
  date: string;
  type: string;
  coordinates: unknown;
  magnitudeValue?: number | null;
  magnitudeUnit?: string | null;
}
interface EonetEvent {
  id: string;
  title: string;
  link: string;
  closed: string | null;
  sources: { id: string; url: string }[];
  geometry: EonetGeometry[];
}

/** Point geometries are used directly; polygons are reduced to their vertex centroid. */
function geometryPoint(g: EonetGeometry): LatLng | null {
  if (g.type === 'Point') {
    const [lng, lat] = g.coordinates as [number, number];
    return [lat, lng];
  }
  if (g.type === 'Polygon') {
    const ring = (g.coordinates as [number, number][][])[0];
    if (!ring?.length) return null;
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const lng = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    return [lat, lng];
  }
  return null;
}

export function parseEonet(events: EonetEvent[], range: { start: number; end: number }): FireData {
  const out: Record<string, FireEvent> = {};
  const reports: FireReport[] = [];
  for (const e of events) {
    if (out[e.id]) continue;
    const evReports: FireReport[] = [];
    for (const g of e.geometry) {
      const at = geometryPoint(g);
      const time = Date.parse(g.date);
      if (!at || !Number.isFinite(time) || time < range.start || time > range.end || !isInRegion(at)) continue;
      evReports.push({ eventId: e.id, time, at, size: g.magnitudeValue ?? null, sizeUnit: g.magnitudeUnit ?? null });
    }
    if (!evReports.length) continue;
    evReports.sort((a, b) => a.time - b.time);
    out[e.id] = {
      id: e.id,
      title: e.title,
      sources: e.sources ?? [],
      closed: e.closed ? Date.parse(e.closed) : null,
      link: e.link,
      reports: evReports,
    };
    reports.push(...evReports);
  }
  reports.sort((a, b) => a.time - b.time);
  const groups = groupByUtcDay(reports.map((r, i) => ({ r, i })), (x) => x.r.time);
  return { events: out, reports, days: groups.map((g) => ({ day: g.day, reportIdx: g.items.map((x) => x.i) })) };
}

function sizeText(r: FireReport): string {
  return r.size != null ? `${r.size.toLocaleString()} ${r.sizeUnit ?? ''}`.trim() : 'size not reported';
}

function radiusFor(r: FireReport): number {
  if (r.size == null) return 4;
  const acres = r.sizeUnit === 'hectare' || r.sizeUnit === 'hectares' ? r.size * 2.471 : r.size;
  return Math.min(16, 3.5 + Math.log10(Math.max(1, acres)) * 2.4);
}

function fireOverlays({ data, observations, index, layers, effects, selectedId, reducedMotion, options }: Ctx): OverlaySpec[] {
  const obs = observations[index];
  if (!obs) return [];
  const out: OverlaySpec[] = [];
  const day = data.days[index];

  // NOAA analysts' smoke areas for this UTC day, as gray dot patterns (denser/darker = heavier).
  if (layers.smoke && day) {
    const sm = smokeFor(day.day);
    if (sm.status === 'ready') {
      sm.areas.forEach((a, k) => out.push({
        kind: 'polygon', id: `smoke-${day.day}-${k}`, pane: 'reference', rings: [a.ring],
        color: SMOKE_EDGE[a.density], weight: 0.6, opacity: 0.5, fillColor: `url(#smoke-${a.density})`, fillOpacity: 1,
      }));
      // Boxes mark where each analyst-drawn smoke area is (its outline's extent, not a measured plume edge).
      if (effects.boundingBoxes) {
        const cinematic = effects.mode === 'cinematic';
        sm.areas.forEach((a, k) => out.push({
          kind: 'rect', id: `smoke-box-${day.day}-${k}`, pane: 'effects', bounds: ringBounds(a.ring),
          color: cinematic ? '#86efac' : '#6ee7b7', weight: cinematic ? 1.6 : 1.1, opacity: cinematic ? 0.95 : 0.8, glow: cinematic,
          label: effects.trackingIds ? `Smoke · ${a.density}` : undefined,
        }));
      }
    }
  }
  // Satellite heat detections (VIIRS 375 m) for this UTC day, drawn by NASA GIBS.
  if (layers.hotspots && day) {
    out.push({
      kind: 'tile', id: `hotspots-${day.day}`, pane: 'data', url: GIBS_WMS, opacity: 1,
      attribution: 'Active fires: NASA FIRMS VIIRS NOAA-20 375 m via NASA GIBS',
      wms: { layers: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All', params: { time: isoDay(day.day) } },
    });
  }

  // Trails connect an event's own successive reported locations (identity from the source).
  if (effects.trails) {
    for (const ev of Object.values(data.events)) {
      const pts = ev.reports.filter((r) => r.time < obs.time + DAY);
      const show = ev.id === selectedId ? pts : pts.slice(-effects.trailLength);
      for (let i = 1; i < show.length; i++) {
        out.push({
          kind: 'polyline', id: `fire-trail-${ev.id}-${i}`, pane: 'effects', points: [show[i - 1].at, show[i].at],
          color: effects.mode === 'cinematic' ? '#fb923c' : '#fbbf24', weight: effects.mode === 'cinematic' ? 2.2 : 1.3,
          opacity: 0.4 + (0.5 * i) / show.length, draw: effects.mode === 'cinematic' && !reducedMotion && i === show.length - 1,
        });
      }
    }
  }
  if (layers.recent && options.trailingDays > 0) {
    const from = obs.time - options.trailingDays * DAY;
    for (let i = 0; i < index; i++) {
      const d = data.days[i];
      if (d.day < from) continue;
      for (const ri of d.reportIdx) {
        const r = data.reports[ri];
        out.push({
          kind: 'circle', id: `fire-${r.eventId}-${r.time}`, pane: 'data', center: r.at, radiusPx: radiusFor(r),
          color: '#fdba74', fillOpacity: 0.25, strokeOpacity: 0.5, weight: 1,
          tooltip: `${data.events[r.eventId].title} · reported ${fmtIso(r.time)}`, selectId: r.eventId, pulse: null,
        });
      }
    }
  }
  if (layers.reports && day) {
    for (const ri of day.reportIdx) {
      const r = data.reports[ri];
      const sel = r.eventId === selectedId;
      out.push({
        kind: 'circle', id: `fire-${r.eventId}-${r.time}`, pane: 'effects', center: r.at, radiusPx: radiusFor(r),
        color: sel ? '#ecfdf5' : '#f97316', fillOpacity: 0.85, strokeOpacity: 1, weight: sel ? 2.5 : 1.2,
        tooltip: `${data.events[r.eventId].title} · ${sizeText(r)} · ${fmtIso(r.time)}`, selectId: r.eventId,
        pulse: reducedMotion || effects.mode === 'off' ? null : effects.mode === 'cinematic' ? 'strong' : 'subtle',
      });
    }
  }
  if (effects.trackingIds && day) {
    for (const ri of day.reportIdx) {
      const r = data.reports[ri];
      const d = 0.02;
      out.push({
        kind: 'rect', id: `fire-label-${r.eventId}`, pane: 'labels',
        bounds: { south: r.at[0] - d, north: r.at[0] + d, west: r.at[1] - d, east: r.at[1] + d },
        color: '#6ee7b7', weight: 0, opacity: 0, label: data.events[r.eventId].title.replace(/^Wildfire\s*/i, ''), selectId: r.eventId,
        labelAlways: true, priority: r.size ?? 0,
      });
    }
  }
  return out;
}

function smokeStat(day: number): StatItem {
  const sm = smokeFor(day);
  if (sm.status === 'loading') return { id: 'smoke', label: 'Smoke areas (NOAA HMS)', value: 'Loading…' };
  if (sm.status === 'error') return { id: 'smoke', label: 'Smoke areas (NOAA HMS)', value: 'Unavailable', hint: sm.message };
  const heavy = sm.areas.filter((a) => a.density === 'heavy').length;
  return {
    id: 'smoke', label: 'Smoke areas (NOAA HMS)', value: sm.areas.length ? `${sm.areas.length} (${heavy} heavy)` : 'None mapped',
    hint: 'Outlined by NOAA analysts from satellite imagery for this UTC day, across North America',
  };
}

function fireStats({ data, index, observations, options, layers }: Ctx): StatItem[] {
  const d = data.days[index];
  if (!d) return [];
  const t = observations[index].time;
  const from = t - options.trailingDays * DAY;
  const recentEvents = new Set<string>();
  for (let i = 0; i <= index; i++) {
    if (data.days[i].day >= from) data.days[i].reportIdx.forEach((ri) => recentEvents.add(data.reports[ri].eventId));
  }
  const today = d.reportIdx.map((i) => data.reports[i]);
  const sized = today.filter((r) => r.size != null && r.sizeUnit === 'acres');
  const largest = sized.reduce<FireReport | null>((a, r) => (!a || (r.size ?? 0) > (a.size ?? 0) ? r : a), null);
  return [
    { id: 'today', label: `Reports on ${fmtDate(t)}`, value: String(today.length), hint: 'UTC day' },
    { id: 'recent', label: `Events reported in last ${options.trailingDays} days`, value: String(recentEvents.size) },
    { id: 'largest', label: 'Largest reported size that day', value: largest ? sizeText(largest) : '—', hint: largest ? data.events[largest.eventId].title : 'Incident size is reported by the source agency, not measured by satellite' },
    { id: 'total', label: 'Events in selected range', value: String(Object.keys(data.events).length) },
    ...(layers.smoke ? [smokeStat(d.day)] : []),
  ];
}

function FireDetail({ data, observations, index, selectedId, onClose }: DetailProps<FireData, FireOptions>) {
  const ev = selectedId ? data.events[selectedId] : undefined;
  if (!ev) return null;
  const last = ev.reports[ev.reports.length - 1];
  return (
    <section className="detail" aria-label="Wildfire event details">
      <header className="detail-head">
        <div>
          <div className="detail-id">{ev.title}</div>
          <div className="muted small">{`${ev.id} · reported incident`}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close wildfire details">✕</button>
      </header>
      <dl className="kv">
        <dt>Location</dt>
        <dd className="small">{fmtCoord(last.at[0], last.at[1])}</dd>
        <dt>Reports in range</dt>
        <dd>{ev.reports.length}</dd>
        <dt>Latest report</dt>
        <dd>{fmtDateTime(last.time)}</dd>
        <dt>Reported size</dt>
        <dd>{sizeText(last)}</dd>
        <dt>Status</dt>
        <dd>{ev.closed ? `Closed ${fmtDate(ev.closed)}` : 'Open'}</dd>
        <dt>Sources</dt>
        <dd>
          {ev.sources.map((s) => (
            <a key={s.id + s.url} href={s.url} target="_blank" rel="noreferrer" className="block">{`${s.id} ↗`}</a>
          ))}
        </dd>
      </dl>
      <p className="small muted">A point report of an incident location — not a mapped fire perimeter and not a satellite hotspot detection.</p>
      <FireImagery at={last.at} firstReport={ev.reports[0].time} lastReport={last.time} timelineDay={observations[index]?.time ?? null} />
    </section>
  );
}

function FireOptionsPanel({ options, onChange }: OptionsProps<FireOptions>) {
  return (
    <div className="options-grid">
      <label>
        Keep earlier reports visible
        <select value={options.trailingDays} onChange={(e) => onChange({ ...options, trailingDays: Number(e.target.value) })}>
          {[0, 3, 7, 30].map((d) => (
            <option key={d} value={d}>{d === 0 ? 'Current day only' : `${d} days`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}


export const wildfireFilter: FilterDefinition<FireData, FireOptions> = {
  id: 'wildfire',
  label: 'Wildfire',
  icon: 'flame',
  status: 'live',
  summary: `Wildfire incident reports for the ${REGION_NAME} via NASA EONET (largely from the US IRWIN incident system). These are reported locations — not satellite hotspots or perimeters.`,
  missionId: 'viirs',
  supportsTracking: true,
  effectControls: ['boundingBoxes', 'trackingIds', 'trails', 'trailLength', 'highlightSelected'],
  defaultOptions: { trailingDays: 7 },
  availableLayers: [
    { id: 'reports', label: 'Reported incidents (current day)', description: 'Incident locations reported on the selected UTC day. Size from the reporting agency when provided.', provenance: 'report', defaultVisible: true, swatch: '#f97316' },
    { id: 'recent', label: 'Earlier reports (fading)', description: 'Reports from the preceding days in the trailing window.', provenance: 'report', defaultVisible: true, swatch: 'rgba(253,186,116,0.5)' },
    { id: 'hotspots', label: 'Active-fire hotspots (VIIRS)', description: 'Satellite heat detections (VIIRS NOAA-20, 375 m, day and night) for the shown UTC day, from NASA FIRMS via GIBS. Each red dot is one detection — not a fire perimeter.', provenance: 'observed', defaultVisible: false, swatch: '#ef4444' },
    { id: 'smoke', label: 'Smoke (NOAA HMS)', description: 'Smoke areas outlined daily by NOAA analysts from satellite imagery. Sparse light dots = light smoke, dense dark dots = heavy. An analysis of the smoke layer, not ground-level air quality.', provenance: 'derived', defaultVisible: false, swatch: 'radial-gradient(circle, #94a3b8 35%, transparent 40%) 0 0 / 5px 5px' },
    { id: 'perimeters', label: 'Mapped fire perimeters', description: 'Agency-mapped perimeters (e.g. NIFC for US, CWFIS for Canada).', provenance: 'report', defaultVisible: false, unavailableReason: 'Not connected yet.' },
    { id: 'burn', label: 'Burn scars (SAR / optical change)', description: 'Burned-area change detection between observations.', provenance: 'derived', defaultVisible: false, unavailableReason: 'Not connected yet.' },
  ],
  sourceAttribution: [
    { name: 'NASA EONET v3 — Wildfires category', url: 'https://eonet.gsfc.nasa.gov/', type: 'Event aggregator (incident reports)', detail: 'Live query. Underlying sources (e.g. IRWIN, GDACS) are linked per event.' },
    { name: 'NOAA Hazard Mapping System (HMS) smoke', url: HMS_INFO, type: 'Analyst-drawn smoke areas from satellite imagery (daily)', detail: 'Light / medium / heavy smoke outlines for each UTC day, fetched through the /proxy/hms rewrite (NOAA sends no CORS header).' },
    { name: 'GOES-East / GOES-West ABI GeoColor via NASA GIBS', url: 'https://nasa-gibs.github.io/gibs-api-docs/', type: 'Geostationary satellite imagery (every 10 min)', detail: 'Smoke drift loop in the fire popup.' },
    { name: 'Open-Meteo historical forecast API', url: 'https://open-meteo.com/', type: 'Modelled weather (not an observation)', detail: '850 hPa wind at the fire near local noon, shown as the smoke-drift arrow.' },
    { name: 'NASA GIBS / Worldview Snapshots — VIIRS & MODIS', url: 'https://nasa-gibs.github.io/gibs-api-docs/', type: 'Satellite optical imagery and thermal-anomaly detections', detail: 'Shown when you click a fire: daily corrected-reflectance true colour plus the same sensor’s active-fire detections (VIIRS 375 m / MODIS 1 km) for the chosen UTC day.' },
  ],
  defaultRange: (now) => ({ start: now - 30 * DAY, end: now }),
  dataBounds: (now) => ({ start: Date.UTC(2000, 0, 1), end: now }),

  async load({ range, signal }) {
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const all = await Promise.all(
      REGION_BOXES.map(async (b) => {
        const params = new URLSearchParams({
          category: 'wildfires',
          status: 'all',
          start: day(range.start),
          end: day(range.end),
          bbox: `${b.west},${b.north},${b.east},${b.south}`,
        });
        const res = await fetch(`${EONET}?${params}`, { signal });
        if (!res.ok) throw new Error(`NASA EONET request failed (HTTP ${res.status})`);
        const json = (await res.json()) as { events: EonetEvent[] };
        return json.events ?? [];
      }),
    );
    const data = parseEonet(all.flat(), range);
    const observations: Observation[] = data.days.map((d) => ({
      id: `fire-day-${d.day}`,
      time: d.day,
      kind: 'report',
      label: `${d.reportIdx.length} incident report${d.reportIdx.length > 1 ? 's' : ''} (UTC day)`,
    }));
    const multi = Object.values(data.events).filter((e) => e.reports.length > 1).length;
    const notices = multi === 0 && observations.length ? ['Each event has a single reported location in this range, so no trails can be drawn.'] : [];
    return { observations, data, notices };
  },

  overlays: fireOverlays,
  stats: fireStats,
  chart: (data) =>
    data.days.length
      ? { label: 'Incident reports per UTC day', unit: 'reports', points: data.days.map((d) => ({ time: d.day, value: d.reportIdx.length })) }
      : null,
  extent: (data) => {
    if (!data.reports.length) return null;
    const lats = data.reports.map((r) => r.at[0]);
    const lngs = data.reports.map((r) => (r.at[1] > 0 ? r.at[1] - 360 : r.at[1]));
    return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
  },
  Detail: FireDetail,
  Popup: FirePopup,
  subscribe: subscribeSmoke,
  Options: FireOptionsPanel,
};
