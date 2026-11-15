import type { DetailProps, FilterDefinition, FrameContext, Observation, OptionsProps, OverlaySpec, StatItem } from '../../types';
import { REGION_BOXES, REGION_NAME, isInRegion } from '../../services/geospatial/region';
import { DAY, fmtDate, fmtDateTime, fmtIso } from '../../services/time/format';
import { groupByUtcDay } from '../../services/time/group';
import { fmtCoord } from '../../services/format';

export interface Quake {
  id: string;
  time: number;
  mag: number;
  magType: string;
  place: string;
  depthKm: number;
  lat: number;
  lng: number;
  url: string;
  status: string;
  tsunami: boolean;
}

export interface QuakeData {
  quakes: Quake[];
  /** Per observation (UTC day): indexes into quakes. */
  days: { day: number; quakeIdx: number[] }[];
}

export interface QuakeOptions {
  minMagnitude: number;
  /** Days of earlier events kept visible (fading). */
  trailingDays: number;
}

type Ctx = FrameContext<QuakeData, QuakeOptions>;

const USGS = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const LIMIT = 8000;

function isoDate(t: number) {
  return new Date(t).toISOString().slice(0, 19);
}

interface UsgsFeature {
  id: string;
  properties: { mag: number | null; place: string | null; time: number; url: string; magType: string | null; status: string; tsunami: number };
  geometry: { coordinates: [number, number, number] };
}

export function parseUsgs(features: UsgsFeature[]): Quake[] {
  return features
    .filter((f) => f.properties.mag != null && f.geometry?.coordinates)
    .map((f) => ({
      id: f.id,
      time: f.properties.time,
      mag: f.properties.mag as number,
      magType: f.properties.magType ?? '',
      place: f.properties.place ?? 'Unknown location',
      depthKm: f.geometry.coordinates[2],
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      url: f.properties.url,
      status: f.properties.status,
      tsunami: f.properties.tsunami === 1,
    }));
}

const radiusFor = (mag: number) => Math.max(2.5, 2 + (mag - 2) * 2.4);

function magColor(mag: number): string {
  if (mag >= 6) return '#ef4444';
  if (mag >= 5) return '#f97316';
  if (mag >= 4) return '#f59e0b';
  if (mag >= 3) return '#facc15';
  return '#fde68a';
}

function quakeOverlays({ data, observations, index, layers, effects, selectedId, reducedMotion, options }: Ctx): OverlaySpec[] {
  const obs = observations[index];
  if (!obs) return [];
  const out: OverlaySpec[] = [];
  const currentDay = data.days[index];
  if (layers.recent) {
    const from = obs.time - options.trailingDays * DAY;
    for (let i = 0; i < index; i++) {
      const d = data.days[i];
      if (d.day < from) continue;
      const ageFrac = (obs.time - d.day) / (options.trailingDays * DAY);
      for (const qi of d.quakeIdx) {
        const q = data.quakes[qi];
        out.push({
          kind: 'circle', id: `eq-${q.id}`, pane: 'data', center: [q.lat, q.lng], radiusPx: radiusFor(q.mag),
          color: magColor(q.mag), fillOpacity: Math.max(0.08, 0.4 * (1 - ageFrac)), strokeOpacity: Math.max(0.15, 0.6 * (1 - ageFrac)), weight: 1,
          tooltip: `M${q.mag.toFixed(1)} · ${q.place} · ${fmtIso(q.time)}`, selectId: q.id, pulse: null,
        });
      }
    }
  }
  if (layers.events && currentDay) {
    for (const qi of currentDay.quakeIdx) {
      const q = data.quakes[qi];
      const sel = q.id === selectedId;
      const pulse = reducedMotion || effects.mode === 'off' ? null : effects.mode === 'cinematic' ? 'strong' : q.mag >= 4.5 ? 'subtle' : null;
      out.push({
        kind: 'circle', id: `eq-${q.id}`, pane: 'effects', center: [q.lat, q.lng], radiusPx: radiusFor(q.mag),
        color: sel ? '#ecfdf5' : magColor(q.mag), fillOpacity: 0.85, strokeOpacity: 1, weight: sel ? 2.5 : 1.2,
        tooltip: `M${q.mag.toFixed(1)} · ${q.place} · ${fmtIso(q.time)}`, selectId: q.id, pulse,
      });
    }
  }
  return out;
}

function quakeStats({ data, index, observations }: Ctx): StatItem[] {
  const d = data.days[index];
  if (!d) return [];
  const today = d.quakeIdx.map((i) => data.quakes[i]);
  const biggest = today.reduce<Quake | null>((a, q) => (!a || q.mag > a.mag ? q : a), null);
  let cumulative = 0;
  let largestSoFar: Quake | null = null;
  for (let i = 0; i <= index; i++) {
    cumulative += data.days[i].quakeIdx.length;
    for (const qi of data.days[i].quakeIdx) {
      const q = data.quakes[qi];
      if (!largestSoFar || q.mag > largestSoFar.mag) largestSoFar = q;
    }
  }
  return [
    { id: 'today', label: `Catalog events on ${fmtDate(observations[index].time)}`, value: String(today.length), hint: 'UTC day' },
    { id: 'max', label: 'Largest that day', value: biggest ? `M${biggest.mag.toFixed(1)}` : '—', hint: biggest?.place },
    { id: 'shallow', label: 'Shallowest that day', value: today.length ? `${Math.min(...today.map((q) => q.depthKm)).toFixed(1)} km` : '—' },
    { id: 'cum', label: 'Events so far in range', value: cumulative.toLocaleString() },
    { id: 'largest', label: 'Largest so far in range', value: largestSoFar ? `M${largestSoFar.mag.toFixed(1)}` : '—', hint: largestSoFar?.place },
  ];
}

function QuakeDetail({ data, selectedId, onClose }: DetailProps<QuakeData, QuakeOptions>) {
  const q = data.quakes.find((x) => x.id === selectedId);
  if (!q) return null;
  return (
    <section className="detail" aria-label="Earthquake details">
      <header className="detail-head">
        <div>
          <div className="detail-id">{`M${q.mag.toFixed(1)} ${q.magType}`}</div>
          <div className="muted small">{q.place}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close earthquake details">✕</button>
      </header>
      <dl className="kv">
        <dt>Origin time</dt>
        <dd>{fmtDateTime(q.time)}</dd>
        <dt>Epicenter</dt>
        <dd className="small">{fmtCoord(q.lat, q.lng)}</dd>
        <dt>Depth</dt>
        <dd>{`${q.depthKm.toFixed(1)} km`}</dd>
        <dt>Review status</dt>
        <dd>{q.status}</dd>
        <dt>Tsunami flag</dt>
        <dd>{q.tsunami ? 'Yes (see USGS page)' : 'No'}</dd>
        <dt>Source</dt>
        <dd>
          <a href={q.url} target="_blank" rel="noreferrer">USGS event page ↗</a>
        </dd>
      </dl>
      <p className="small muted">Catalog event time — not a satellite acquisition. Ground deformation would require InSAR observations from before and after this date.</p>
    </section>
  );
}

function QuakeOptionsPanel({ options, onChange }: OptionsProps<QuakeOptions>) {
  return (
    <div className="options-grid">
      <label>
        Minimum magnitude
        <select value={options.minMagnitude} onChange={(e) => onChange({ ...options, minMagnitude: Number(e.target.value) })}>
          {[2.5, 3.5, 4.5, 5.5].map((m) => (
            <option key={m} value={m}>{`M ${m}+`}</option>
          ))}
        </select>
      </label>
      <label>
        Keep earlier events visible
        <select value={options.trailingDays} onChange={(e) => onChange({ ...options, trailingDays: Number(e.target.value) })}>
          {[0, 3, 7, 30].map((d) => (
            <option key={d} value={d}>{d === 0 ? 'Current day only' : `${d} days`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

export const earthquakeFilter: FilterDefinition<QuakeData, QuakeOptions> = {
  id: 'earthquake',
  label: 'Earthquake',
  icon: 'pin',
  status: 'live',
  summary: `Epicenters from the USGS ComCat earthquake catalog for the ${REGION_NAME}. Each timeline frame is one UTC day containing catalog events.`,
  missionId: 'usgs',
  // Effect mode only controls epicenter pulses; there is no region tracking for catalog events.
  supportsTracking: true,
  effectControls: [],
  defaultOptions: { minMagnitude: 2.5, trailingDays: 7 },
  availableLayers: [
    { id: 'events', label: 'Epicenters (current day)', description: 'Catalog events on the selected UTC day. Size and colour scale with magnitude.', provenance: 'catalog', defaultVisible: true, swatch: '#f97316' },
    { id: 'recent', label: 'Earlier events (fading)', description: 'Events from preceding days in the chosen trailing window.', provenance: 'catalog', defaultVisible: true, swatch: 'rgba(250,204,21,0.45)' },
    { id: 'insar', label: 'Ground deformation (InSAR)', description: 'Interferometric displacement from SAR pairs.', provenance: 'observed', defaultVisible: false, unavailableReason: 'Not connected yet — requires NISAR/Sentinel-1 interferogram products for the event area.' },
  ],
  sourceAttribution: [
    { name: 'USGS Earthquake Hazards Program — ComCat', url: 'https://earthquake.usgs.gov/fdsnws/event/1/', type: 'Earthquake catalog (seismic networks, not satellite)', detail: 'Live query. Region filter is a coarse US/Canada bounding area.' },
  ],
  defaultRange: (now) => ({ start: now - 30 * DAY, end: now }),
  dataBounds: (now) => ({ start: Date.UTC(1900, 0, 1), end: now }),

  async load({ range, options, signal }) {
    const results = await Promise.all(
      REGION_BOXES.map(async (b) => {
        const params = new URLSearchParams({
          format: 'geojson',
          starttime: isoDate(range.start),
          endtime: isoDate(range.end),
          minmagnitude: String(options.minMagnitude),
          minlatitude: String(b.south),
          maxlatitude: String(b.north),
          minlongitude: String(b.west),
          maxlongitude: String(b.east),
          orderby: 'time-asc',
          limit: String(LIMIT),
        });
        const res = await fetch(`${USGS}?${params}`, { signal });
        if (res.status === 400) {
          const text = await res.text();
          throw new Error(`USGS rejected the query: ${text.slice(0, 160)}`);
        }
        if (!res.ok) throw new Error(`USGS catalog request failed (HTTP ${res.status})`);
        const json = (await res.json()) as { features: UsgsFeature[] };
        return json.features;
      }),
    );
    const notices: string[] = [];
    results.forEach((r) => {
      if (r.length >= LIMIT) notices.push(`One region query hit the ${LIMIT}-event limit; results are truncated. Raise the minimum magnitude or shorten the range.`);
    });
    const seen = new Set<string>();
    const quakes = parseUsgs(results.flat())
      .filter((q) => {
        if (seen.has(q.id)) return false;
        seen.add(q.id);
        return isInRegion([q.lat, q.lng]) && q.time >= range.start && q.time <= range.end;
      })
      .sort((a, b) => a.time - b.time);
    const groups = groupByUtcDay(quakes.map((q, i) => ({ q, i })), (x) => x.q.time);
    const observations: Observation[] = groups.map((g) => ({
      id: `eq-day-${g.day}`,
      time: g.day,
      kind: 'catalog',
      label: `${g.items.length} catalog event${g.items.length > 1 ? 's' : ''} (UTC day)`,
    }));
    return { observations, data: { quakes, days: groups.map((g) => ({ day: g.day, quakeIdx: g.items.map((x) => x.i) })) }, notices };
  },

  overlays: quakeOverlays,
  stats: quakeStats,
  timelineEvents: (data) =>
    data.quakes
      .filter((q) => q.mag >= 5.5)
      .map((q) => ({ time: q.time, type: 'major-event' as const, label: `M${q.mag.toFixed(1)} — ${q.place}` })),
  chart: (data) =>
    data.days.length
      ? { label: 'Catalog events per UTC day', unit: 'events', points: data.days.map((d) => ({ time: d.day, value: d.quakeIdx.length })) }
      : null,
  extent: (data) => {
    if (!data.quakes.length) return null;
    const lats = data.quakes.map((q) => q.lat);
    // Western Aleutians lie east of 180°; unwrap so the extent doesn't span the globe.
    const lngs = data.quakes.map((q) => (q.lng > 0 ? q.lng - 360 : q.lng));
    return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
  },
  Detail: QuakeDetail,
  Options: QuakeOptionsPanel,
};
