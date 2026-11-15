import type { DetailProps, FilterDefinition, FrameContext, LatLng, OverlaySpec, StatItem, TimelineEvent } from '../../types';
import { cellAt, cellCenter } from '../../services/geospatial/grid';
import { fmtCoord, fmtKm2, fmtPct, fmtSignedKm2 } from '../../services/format';
import { fmtDate, fmtDateTime } from '../../services/time/format';
import { JRC_OCCURRENCE_TILES, aoiGrid, loadBaseline } from '../flood/baseline';
import { paint, type RGBA } from '../flood/render';
import {
  MIN_COMMON,
  WCLASS,
  WETLAND_AOI,
  type WetlandData,
  buildWetlandData,
  inundationFrequency,
  loadWetlandScenes,
} from './wetlandData';

type Options = Record<string, never>;
type Ctx = FrameContext<WetlandData, Options>;

const COLORS = {
  open: [59, 130, 246, 205] as RGBA,
  veg: [52, 211, 153, 200] as RGBA,
};

// ---------- images (memoised per dataset & frame) ----------
const images = new WeakMap<WetlandData, Map<string, string>>();
function memo(data: WetlandData, key: string, make: () => string): string {
  let m = images.get(data);
  if (!m) images.set(data, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = make()));
  return v;
}

function classImage(data: WetlandData, index: number, cls: number, color: RGBA): string {
  const c = data.frames[index].classes;
  return memo(data, `c${cls}:${index}`, () => paint(data.grid.cols, data.grid.rows, (i) => (c[i] === cls ? color : null)));
}

function noDataImage(data: WetlandData, index: number): string {
  const c = data.frames[index].classes;
  return memo(data, `nd:${index}`, () =>
    paint(data.grid.cols, data.grid.rows, (i, r, col) => (c[i] ? null : (r + col) % 8 < 2 ? [203, 213, 225, 120] : [15, 23, 42, 50])),
  );
}

/** Violet ramp: rarely → always inundated, for cells observed at least 3 times. */
function frequencyImage(data: WetlandData, index: number): string {
  return memo(data, `freq:${index}`, () => {
    const { wet, seen } = inundationFrequency(data, index);
    return paint(data.grid.cols, data.grid.rows, (i) => {
      if (seen[i] < 3 || !wet[i]) return null;
      const f = wet[i] / seen[i];
      return [Math.round(237 - 160 * f), Math.round(233 - 200 * f), Math.round(254 - 40 * f), Math.round(90 + 150 * f)];
    });
  });
}

function persistentImage(data: WetlandData): string {
  return memo(data, 'persist', () =>
    paint(data.grid.cols, data.grid.rows, (i, r, c) => (data.persistent[i] ? ((r + c) % 4 < 2 ? [148, 163, 184, 200] : [71, 85, 105, 140]) : null)),
  );
}

function wetlandOverlays({ data, index, layers, selectedId }: Ctx): OverlaySpec[] {
  const f = data.frames[index];
  if (!f) return [];
  const b = data.bounds;
  const id = f.obs.id;
  const out: OverlaySpec[] = [];
  if (layers.jrc) {
    out.push({ kind: 'tile', id: 'wet-jrc', pane: 'reference', url: JRC_OCCURRENCE_TILES, opacity: 0.8, maxNativeZoom: 13, attribution: 'Surface water: EC JRC/Google (Global Surface Water)' });
  }
  if (layers.frequency) out.push({ kind: 'image', id: `wet-freq-${id}`, pane: 'reference', url: frequencyImage(data, index), bounds: b, opacity: 1, pixelated: true });
  if (layers.persistent) out.push({ kind: 'image', id: 'wet-persist', pane: 'reference', url: persistentImage(data), bounds: b, opacity: 1, pixelated: true });
  if (layers.veg) out.push({ kind: 'image', id: `wet-veg-${id}`, pane: 'data', url: classImage(data, index, WCLASS.VEG, COLORS.veg), bounds: b, opacity: 1, pixelated: true });
  if (layers.open) out.push({ kind: 'image', id: `wet-open-${id}`, pane: 'data', url: classImage(data, index, WCLASS.OPEN, COLORS.open), bounds: b, opacity: 1, pixelated: true });
  if (layers.nodata && f.coverageFraction < 0.999) out.push({ kind: 'image', id: `wet-nd-${id}`, pane: 'data', url: noDataImage(data, index), bounds: b, opacity: 1, pixelated: true });
  const cell = parseCell(selectedId);
  if (cell != null) {
    out.push({ kind: 'circle', id: 'wet-cell', pane: 'effects', center: cellCenter(data.grid, cell), radiusPx: 7, color: '#fde68a', fillOpacity: 0, strokeOpacity: 1, weight: 2, tooltip: 'Selected location' });
  }
  return out;
}

export function wetlandStats({ data, index }: Ctx): StatItem[] {
  const f = data.frames[index];
  if (!f) return [];
  const c = f.vsPrev;
  const prev = index > 0 ? data.frames[index - 1] : null;
  const stats: StatItem[] = [
    { id: 'open', label: 'Open water', value: fmtKm2(f.openKm2), hint: 'Radar-dark (smooth water surface)' },
    { id: 'veg', label: 'Inundated vegetation (possible)', value: fmtKm2(f.vegKm2), hint: 'L-band double bounce: very bright HH with high HH/HV ratio' },
    { id: 'share', label: 'Inundated share of imaged area', value: `${(f.share * 100).toFixed(1)}%`, hint: `Highest in range: ${(data.maxShare.share * 100).toFixed(1)}% on ${fmtDate(data.frames[data.maxShare.index]?.obs.time ?? 0)}` },
  ];
  if (prev) {
    if (!c || c.commonFraction < MIN_COMMON) {
      stats.push({ id: 'dprev', label: 'Change vs previous pass', value: 'Not comparable', hint: 'Too little area imaged by both passes', tone: 'neutral' });
    } else {
      const d = c.afterKm2 - c.beforeKm2;
      stats.push({
        id: 'dprev',
        label: 'Change vs previous pass',
        value: `${fmtSignedKm2(d)} (${fmtPct(c.beforeKm2 ? (d / c.beforeKm2) * 100 : NaN)})`,
        hint: `Previous: ${fmtDate(prev.obs.time)} · over the ${Math.round(c.commonFraction * 100)}% imaged by both`,
        tone: d > 0 ? 'up' : d < 0 ? 'down' : 'neutral',
      });
    }
  }
  stats.push({ id: 'imaged', label: 'Area imaged', value: `${Math.round(f.coverageFraction * 100)}%`, hint: 'Unimaged cells are no-data, not dry' });
  return stats;
}

export function wetlandEvents(data: WetlandData): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  const m = data.frames[data.maxShare.index];
  if (m) ev.push({ time: m.obs.time, type: 'max-extent', label: `Highest inundated share of imaged area (${(m.share * 100).toFixed(1)}%)` });
  data.frames.forEach((f) => {
    const c = f.vsPrev;
    if (c && c.commonFraction >= MIN_COMMON && c.beforeKm2 > 20 && c.afterKm2 / c.beforeKm2 > 1.3) {
      ev.push({ time: f.obs.time, type: 'expansion', label: `Inundation +${Math.round((c.afterKm2 / c.beforeKm2 - 1) * 100)}% vs previous pass (shared area)` });
    }
    if (c && c.commonFraction >= MIN_COMMON && c.beforeKm2 > 20 && c.afterKm2 / c.beforeKm2 < 0.7) {
      ev.push({ time: f.obs.time, type: 'recession', label: `Inundation ${Math.round((c.afterKm2 / c.beforeKm2 - 1) * 100)}% vs previous pass (shared area)` });
    }
  });
  return ev.sort((a, b) => a.time - b.time);
}

const parseCell = (id: string | null) => (id && id.startsWith('cell:') ? Number(id.slice(5)) : null);

const CLASS_TEXT = ['No data', 'Not inundated', 'Open water', 'Inundated vegetation (possible)'];
const CLASS_DOT = ['#334155', '#94a3b8', '#3b82f6', '#34d399'];

function WetlandDetail({ data, index, selectedId, onClose }: DetailProps<WetlandData, Options>) {
  const cell = parseCell(selectedId);
  if (cell == null || !data.frames.length) return null;
  const [lat, lng] = cellCenter(data.grid, cell);
  const hist = data.frames.map((f) => ({ time: f.obs.time, c: f.classes[cell] }));
  const seen = hist.filter((h) => h.c > 0);
  const wet = seen.filter((h) => h.c === WCLASS.OPEN || h.c === WCLASS.VEG);
  const now = data.frames[index]?.classes[cell] ?? 0;
  const t0 = data.frames[0].obs.time;
  const t1 = data.frames[data.frames.length - 1].obs.time;
  const x = (t: number) => (t1 === t0 ? 50 : ((t - t0) / (t1 - t0)) * 100);
  return (
    <section className="detail" aria-label="Location inundation history">
      <header className="detail-head">
        <div>
          <div className="detail-id">Location history</div>
          <div className="muted small">{fmtCoord(lat, lng)}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close location history">✕</button>
      </header>
      <dl className="kv">
        <dt>This pass</dt>
        <dd>{CLASS_TEXT[now]}</dd>
        <dt>Inundated</dt>
        <dd>{seen.length ? `${wet.length} of ${seen.length} observed passes (${Math.round((wet.length / seen.length) * 100)}%)` : 'Never imaged in this range'}</dd>
        <dt>Historical water</dt>
        <dd>{`JRC occurrence ${data.occurrence[cell]}% (1984–2021)`}</dd>
        {data.persistent[cell] ? (
          <>
            <dt>Note</dt>
            <dd>Persistently bright all year: treated as a structure (e.g. urban), not flooded vegetation.</dd>
          </>
        ) : null}
      </dl>
      <div className="small muted">Each dot is a real NISAR pass at its acquisition date</div>
      <div className="cell-strip" role="img" aria-label={`Inundation history: ${wet.length} of ${seen.length} passes inundated`}>
        {hist.map((h, i) => (
          <span
            key={h.time}
            className={`cell-dot ${i === index ? 'current' : ''}`}
            style={{ left: `${x(h.time)}%`, background: CLASS_DOT[h.c] }}
            title={`${fmtDateTime(h.time)} · ${CLASS_TEXT[h.c]}`}
          />
        ))}
      </div>
      <div className="cell-strip-axis small muted">
        <span>{fmtDate(t0)}</span>
        <span>{fmtDate(t1)}</span>
      </div>
    </section>
  );
}

export const wetlandFilter: FilterDefinition<WetlandData, Options> = {
  id: 'wetlands',
  label: 'Wetlands',
  icon: 'sprout',
  status: 'live',
  summary: `Open water and inundated vegetation from real NISAR L-band passes — ${WETLAND_AOI.name}. L-band radar sees water under the forest canopy through “double bounce”.`,
  missionId: 'nisar',
  supportsTracking: false,
  expectedCadenceMs: 12 * 864e5,
  defaultOptions: {},
  availableLayers: [
    { id: 'open', label: 'Open water', description: 'Radar-dark cells (smooth water) on this pass.', provenance: 'observed', defaultVisible: true, swatch: 'rgba(59,130,246,0.85)' },
    { id: 'veg', label: 'Inundated vegetation (possible)', description: 'Very bright HH with high HH/HV ratio — water under trees or marsh (double bounce). Not confirmed; urban structures can look similar.', provenance: 'derived', defaultVisible: true, swatch: 'rgba(52,211,153,0.85)' },
    { id: 'frequency', label: 'Inundation frequency', description: 'Share of passes so far in which each cell was inundated (cells seen ≥ 3 times). Light = rarely, deep violet = almost always.', provenance: 'derived', defaultVisible: false, swatch: 'linear-gradient(90deg,#ede9fe,#4d21d6)' },
    { id: 'persistent', label: 'Excluded: persistently bright', description: 'Bright in ≥ 90% of passes all year — likely towns, bridges or structures, so excluded from inundated vegetation.', provenance: 'derived', defaultVisible: false, swatch: 'hatch' },
    { id: 'nodata', label: 'No data', description: 'Not imaged by this pass. Unknown — not dry.', provenance: 'derived', defaultVisible: true, swatch: 'hatch' },
    { id: 'jrc', label: 'JRC water occurrence (reference)', description: 'Historical Landsat surface-water occurrence, 1984–2021.', provenance: 'reference', defaultVisible: false, swatch: 'linear-gradient(90deg,#ffcccc,#0000ff)' },
  ],
  sourceAttribution: [
    { name: 'NASA–ISRO SAR (NISAR) L2 GCOV', url: 'https://nisar-docs.asf.alaska.edu/gcov/', type: 'Satellite SAR observations (L-band, 80 m)', detail: 'Classified per pass by server/flood_prep.py (open water from trained dark thresholds; inundated vegetation from the double-bounce signature). Data from ASF DAAC.' },
    { name: 'JRC Global Surface Water v1.4', url: 'https://global-surface-water.appspot.com/', type: 'Historical water reference (Landsat 1984–2021)', detail: 'Used to train the open-water thresholds and as a reference layer.' },
  ],
  defaultRange: (now) => ({ start: Date.UTC(2025, 10, 1), end: Math.min(now, Date.UTC(2026, 10, 14, 23, 59)) }),
  dataBounds: (now) => ({ start: Date.UTC(2025, 6, 30), end: now }),

  async load({ range, signal }) {
    const grid = aoiGrid(WETLAND_AOI);
    const cells = grid.cols * grid.rows;
    const [baseline, loaded] = await Promise.all([loadBaseline(signal, WETLAND_AOI), loadWetlandScenes(range, cells, signal)]);
    const data = buildWetlandData(grid, baseline.occurrence, loaded.persistent, loaded.scenes, loaded.manifest);
    const m = loaded.manifest;
    const notices = [
      `Real NISAR passes processed ${m.generated.slice(0, 10)} (${m.passes.length} passes, ${m.range.start} → ${m.range.end}). Each pass images part of the basin; comparisons use only area imaged by both passes.`,
    ];
    if (!loaded.scenes.length && m.passes.length) notices.push(`No processed passes in this range. Available: ${m.passes[0].time.slice(0, 10)} → ${m.passes[m.passes.length - 1].time.slice(0, 10)}.`);
    return { observations: data.frames.map((f) => f.obs), data, notices };
  },

  overlays: wetlandOverlays,
  stats: wetlandStats,
  timelineEvents: (data) => wetlandEvents(data),
  chart: (data) =>
    data.frames.length
      ? { label: 'Inundated share of imaged area', unit: '%', points: data.frames.map((f) => ({ time: f.obs.time, value: f.share * 100 })) }
      : null,
  hitTest({ data }, at: LatLng) {
    const cell = cellAt(data.grid, at);
    return cell >= 0 ? `cell:${cell}` : null;
  },
  extent: (data) => data.bounds,
  Detail: WetlandDetail,
};

