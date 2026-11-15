import type { DetailProps, FilterDefinition, FrameContext, LatLng, OptionsProps, OverlaySpec, StatItem } from '../../types';
import { cellAt, cellCenter } from '../../services/geospatial/grid';
import { fmtCoord, fmtKm2 } from '../../services/format';
import { fmtDate, fmtDateTime } from '../../services/time/format';
import { aoiGrid } from '../flood/baseline';
import { paint, type RGBA } from '../flood/render';
import { DEFORMATION_AOI, type DeformationData, type DefFrame, buildDeformationData, loadDeformationPairs } from './deformationData';

export interface DeformationOptions {
  /** Colour scale saturates at ± this many mm. Fixed across frames so colours are comparable. */
  scaleMm: number;
}
type Ctx = FrameContext<DeformationData, DeformationOptions>;

const DAY = 864e5;
const SCALES = [10, 30, 100];

/** Diverging ramp: away from satellite (−) → orange/red, toward (+) → blue. Near-zero is faint. */
export function losColor(mm: number, scale: number): RGBA | null {
  if (!Number.isFinite(mm)) return null;
  const t = Math.max(-1, Math.min(1, mm / scale));
  const a = Math.abs(t);
  const alpha = Math.round(40 + 190 * Math.min(1, a * 1.4));
  if (t < 0) return [Math.round(255 - 35 * a), Math.round(237 - 170 * a), Math.round(213 - 180 * a), alpha];
  return [Math.round(224 - 190 * a), Math.round(242 - 140 * a), Math.round(254 - 30 * a), alpha];
}

const images = new WeakMap<DeformationData, Map<string, string>>();
function memo(data: DeformationData, key: string, make: () => string): string {
  let m = images.get(data);
  if (!m) images.set(data, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = make()));
  return v;
}

const rampImage = (data: DeformationData, f: DefFrame, field: 'disp' | 'cumulative', scale: number) =>
  memo(data, `${field}:${f.meta.id}:${scale}`, () => paint(data.grid.cols, data.grid.rows, (i) => losColor(f[field][i], scale)));

const cohImage = (data: DeformationData, f: DefFrame) =>
  memo(data, `coh:${f.meta.id}`, () =>
    paint(data.grid.cols, data.grid.rows, (i) => {
      const c = f.coh[i];
      if (!Number.isFinite(c)) return null;
      const v = Math.round(255 * Math.max(0, Math.min(1, c)));
      return [v, v, v, 200];
    }),
  );

const noDataImage = (data: DeformationData, f: DefFrame) =>
  memo(data, `nd:${f.meta.id}`, () =>
    paint(data.grid.cols, data.grid.rows, (i, r, c) => (Number.isFinite(f.disp[i]) ? null : (r + c) % 8 < 2 ? [203, 213, 225, 110] : [15, 23, 42, 45])),
  );

const parseCell = (id: string | null) => (id && id.startsWith('cell:') ? Number(id.slice(5)) : null);

function overlays({ data, index, layers, selectedId, options }: Ctx): OverlaySpec[] {
  const f = data.frames[index];
  if (!f) return [];
  const b = data.bounds;
  const id = f.meta.id;
  const out: OverlaySpec[] = [];
  if (layers.coherence) out.push({ kind: 'image', id: `def-coh-${id}`, pane: 'reference', url: cohImage(data, f), bounds: b, opacity: 0.9, pixelated: true });
  if (layers.los) out.push({ kind: 'image', id: `def-los-${id}-${options.scaleMm}`, pane: 'data', url: rampImage(data, f, 'disp', options.scaleMm), bounds: b, opacity: 1, pixelated: true });
  if (layers.cumulative) out.push({ kind: 'image', id: `def-cum-${id}-${options.scaleMm}`, pane: 'data', url: rampImage(data, f, 'cumulative', options.scaleMm), bounds: b, opacity: 1, pixelated: true });
  if (layers.nodata && f.validFraction < 0.999) out.push({ kind: 'image', id: `def-nd-${id}`, pane: 'data', url: noDataImage(data, f), bounds: b, opacity: 1, pixelated: true });
  const cell = parseCell(selectedId);
  if (cell != null) {
    out.push({ kind: 'circle', id: 'def-cell', pane: 'effects', center: cellCenter(data.grid, cell), radiusPx: 7, color: '#fde68a', fillOpacity: 0, strokeOpacity: 1, weight: 2, tooltip: 'Selected location' });
  }
  return out;
}

const days = (ms: number) => Math.round(ms / DAY);
const fmtMm = (v: number) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} mm` : '—');

export function deformationStats({ data, index }: Ctx): StatItem[] {
  const f = data.frames[index];
  if (!f) return [];
  const chain =
    f.chainPairs > 1
      ? `${f.chainPairs} consecutive pairs, ${fmtDate(f.chainStart)} → ${fmtDate(f.secTime)} (${days(f.secTime - f.chainStart)} days)`
      : 'This pair only (no earlier consecutive pair on this track in range)';
  return [
    { id: 'pair', label: 'Interferometric pair', value: `${fmtDate(f.refTime)} → ${fmtDate(f.secTime)}`, hint: `${days(f.secTime - f.refTime)}-day baseline · ${f.meta.direction} track ${f.meta.track} · ${f.meta.status}` },
    { id: 'noise', label: 'Single-pair spread (95th pct |LOS|)', value: `${f.meta.p95AbsMm.toFixed(1)} mm`, hint: 'Mostly atmospheric noise in one 12-day pair, not necessarily ground motion' },
    { id: 'coh', label: 'Median coherence', value: f.meta.medianCoherence.toFixed(2), hint: '0–1; higher means a more reliable phase measurement' },
    { id: 'valid', label: 'Area with valid phase', value: `${Math.round(f.validFraction * 100)}%`, hint: `${fmtKm2(f.validKm2)} · low-coherence and unimaged cells are no-data` },
    { id: 'chain', label: 'Cumulative LOS spans', value: f.chainPairs > 1 ? `${days(f.secTime - f.chainStart)} days` : '1 pair', hint: chain },
    {
      id: 'away',
      label: `Cumulative LOS ≤ −${data.awayThresholdMm} mm`,
      value: fmtKm2(f.cumAwayKm2),
      hint: 'Moving away from the satellite (consistent with subsidence, but LOS also includes horizontal motion and noise)',
      tone: f.cumAwayKm2 > 0 ? 'down' : 'neutral',
    },
    { id: 'p05', label: 'Strongest cumulative motion away (5th pct)', value: fmtMm(f.cumP05Mm), hint: 'Relative to the scene median; not an absolute rate' },
  ];
}

/** Small signed time-series chart: one line per track, plotted at real acquisition times. */
function SignedChart({ series, t0, t1, cursor }: { series: { key: string; color: string; points: { time: number; value: number }[] }[]; t0: number; t1: number; cursor: number | null }) {
  const W = 300, H = 110, pl = 40, pr = 8, pt = 8, pb = 16;
  const vals = series.flatMap((s) => s.points.map((p) => p.value));
  if (!vals.length) return <div className="small muted">No valid measurements at this location.</div>;
  const vmax = Math.max(5, ...vals.map(Math.abs));
  const x = (t: number) => pl + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pl - pr);
  const y = (v: number) => pt + ((vmax - v) / (2 * vmax)) * (H - pt - pb);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="signed-chart" role="img" aria-label="Cumulative line-of-sight displacement over time">
      <line x1={pl} x2={W - pr} y1={y(0)} y2={y(0)} stroke="var(--line-2)" />
      <text x={pl - 4} y={y(vmax) + 4} textAnchor="end" className="ts-axis">{`+${vmax.toFixed(0)}`}</text>
      <text x={pl - 4} y={y(0) + 4} textAnchor="end" className="ts-axis">0 mm</text>
      <text x={pl - 4} y={y(-vmax) + 4} textAnchor="end" className="ts-axis">{`−${vmax.toFixed(0)}`}</text>
      <text x={pl} y={H - 3} className="ts-axis">{fmtDate(t0)}</text>
      <text x={W - pr} y={H - 3} textAnchor="end" className="ts-axis">{fmtDate(t1)}</text>
      {cursor != null && <line x1={x(cursor)} x2={x(cursor)} y1={pt} y2={H - pb} stroke="var(--amber)" strokeDasharray="3 3" />}
      {series.map((s) => (
        <g key={s.key}>
          <path d={s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join('')} fill="none" stroke={s.color} strokeWidth={1.5} />
          {s.points.map((p) => (
            <circle key={p.time} cx={x(p.time)} cy={y(p.value)} r={2.5} fill={s.color}>
              <title>{`${s.key} · ${fmtDateTime(p.time)} · ${fmtMm(p.value)}`}</title>
            </circle>
          ))}
        </g>
      ))}
    </svg>
  );
}

const TRACK_COLORS = ['#5eead4', '#fbbf24', '#c4b5fd', '#f9a8d4'];

function DeformationDetail({ data, index, selectedId, onClose }: DetailProps<DeformationData, DeformationOptions>) {
  const cell = parseCell(selectedId);
  if (cell == null || !data.frames.length) return null;
  const [lat, lng] = cellCenter(data.grid, cell);
  const f = data.frames[index];
  const tracks = [...new Set(data.frames.map((fr) => `${fr.meta.direction} T${fr.meta.track}`))];
  const series = tracks.map((key, i) => {
    const pts: { time: number; value: number }[] = [];
    data.frames.forEach((fr) => {
      if (`${fr.meta.direction} T${fr.meta.track}` !== key) return;
      // Start each chain at 0 on its first reference date so the line shows accumulated motion.
      if (fr.chainPairs === 1 && Number.isFinite(fr.disp[cell])) pts.push({ time: fr.refTime, value: 0 });
      if (Number.isFinite(fr.cumulative[cell])) pts.push({ time: fr.secTime, value: fr.cumulative[cell] });
    });
    return { key, color: TRACK_COLORS[i % TRACK_COLORS.length], points: pts };
  }).filter((s) => s.points.length);
  const t0 = Math.min(...data.frames.map((fr) => fr.refTime));
  const t1 = Math.max(...data.frames.map((fr) => fr.secTime));
  const measured = data.frames.filter((fr) => Number.isFinite(fr.disp[cell])).length;
  return (
    <section className="detail" aria-label="Location displacement history">
      <header className="detail-head">
        <div>
          <div className="detail-id">Location history</div>
          <div className="muted small">{fmtCoord(lat, lng)}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close location history">✕</button>
      </header>
      <dl className="kv">
        <dt>This pair</dt>
        <dd>{f ? `${fmtMm(f.disp[cell])} (${fmtDate(f.refTime)} → ${fmtDate(f.secTime)})` : '—'}</dd>
        <dt>Cumulative</dt>
        <dd>{f ? `${fmtMm(f.cumulative[cell])} over ${f.chainPairs} pair${f.chainPairs > 1 ? 's' : ''}` : '—'}</dd>
        <dt>Coherence</dt>
        <dd>{f && Number.isFinite(f.coh[cell]) ? f.coh[cell].toFixed(2) : '—'}</dd>
        <dt>Measured in</dt>
        <dd>{`${measured} of ${data.frames.length} pairs`}</dd>
      </dl>
      <div className="small muted">Cumulative LOS per track (+ toward satellite). Points are real acquisition dates; lines between them are not measured.</div>
      <SignedChart series={series} t0={t0} t1={t1} cursor={f?.secTime ?? null} />
      <div className="legend-inline small">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} /> {s.key}
          </span>
        ))}
      </div>
    </section>
  );
}

function DeformationOptionsPanel({ options, onChange }: OptionsProps<DeformationOptions>) {
  return (
    <div className="options-grid">
      <label>
        Colour scale saturates at
        <select value={options.scaleMm} onChange={(e) => onChange({ ...options, scaleMm: Number(e.target.value) })}>
          {SCALES.map((s) => (
            <option key={s} value={s}>{`± ${s} mm`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

const RAMP = 'linear-gradient(90deg,#dc2e21,#ffedd5 45%,#e0f2fe 55%,#2266e0)';

export const deformationFilter: FilterDefinition<DeformationData, DeformationOptions> = {
  id: 'deformation',
  label: 'Ground Deformation',
  icon: '📐',
  status: 'live',
  summary: `Line-of-sight ground motion from real NISAR L-band interferograms — ${DEFORMATION_AOI.name}, where groundwater pumping causes land subsidence.`,
  missionId: 'nisar',
  supportsTracking: false,
  expectedCadenceMs: 12 * DAY,
  defaultOptions: { scaleMm: 30 },
  availableLayers: [
    { id: 'los', label: 'LOS displacement (this pair)', description: 'Motion along the radar line of sight between the pair’s two acquisitions. Red = away from the satellite, blue = toward. Relative to the scene median.', provenance: 'derived', defaultVisible: true, swatch: RAMP },
    { id: 'cumulative', label: 'Cumulative LOS (consecutive pairs, same track)', description: 'Sum of consecutive pairs on this track up to the current pair. Drawn above the single-pair layer. Restarts after a gap; noise accumulates too.', provenance: 'derived', defaultVisible: false, swatch: RAMP },
    { id: 'coherence', label: 'Coherence', description: 'Interferometric coherence (black 0 → white 1). Low coherence (fields, water, vegetation change) means unreliable phase.', provenance: 'observed', defaultVisible: false, swatch: 'linear-gradient(90deg,#000,#fff)' },
    { id: 'nodata', label: 'No data', description: 'Not imaged, low coherence (< 0.3) or not unwrapped. Unknown — not stable.', provenance: 'derived', defaultVisible: true, swatch: 'hatch' },
  ],
  sourceAttribution: [
    {
      name: 'NASA–ISRO SAR (NISAR) L2 GUNW',
      url: 'https://nisar-docs.asf.alaska.edu/',
      type: 'Satellite SAR interferograms (L-band, 80 m)',
      detail: 'Unwrapped HH phase minus ionospheric phase screen, converted to LOS displacement and aggregated to ~0.55 km cells by server/nisar_prep.py. Data from ASF DAAC.',
    },
  ],
  defaultRange: (now) => ({ start: Date.UTC(2026, 6, 1), end: Math.min(now, Date.UTC(2026, 10, 14, 23, 59)) }),
  dataBounds: (now) => ({ start: Date.UTC(2025, 6, 30), end: now }),

  async load({ range, signal }) {
    const grid = aoiGrid(DEFORMATION_AOI);
    const { manifest, pairs } = await loadDeformationPairs(range, grid.cols * grid.rows, signal);
    const data = buildDeformationData(grid, pairs, manifest);
    const notices = [
      `Real NISAR interferometric pairs processed ${manifest.generated.slice(0, 10)} (${manifest.frames.length} pairs, ${manifest.range.start} → ${manifest.range.end}). Values are line-of-sight and relative to each scene's median, not absolute vertical motion.`,
      manifest.limitations,
    ];
    if (!pairs.length && manifest.frames.length) {
      notices.push(`No processed pairs fully inside this range. Available: ${manifest.frames[0].start.slice(0, 10)} → ${manifest.frames[manifest.frames.length - 1].end.slice(0, 10)}.`);
    }
    return { observations: data.frames.map((f) => f.obs), data, notices };
  },

  overlays,
  stats: deformationStats,
  chart: (data) =>
    data.frames.length
      ? { label: 'Median coherence per pair (measurement quality)', unit: '', points: data.frames.map((f) => ({ time: f.secTime, value: f.meta.medianCoherence })) }
      : null,
  hitTest({ data }, at: LatLng) {
    const cell = cellAt(data.grid, at);
    return cell >= 0 ? `cell:${cell}` : null;
  },
  extent: (data) => data.bounds,
  Detail: DeformationDetail,
  Options: DeformationOptionsPanel,
};
