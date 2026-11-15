import type {
  DetailProps,
  FilterDefinition,
  FrameContext,
  LatLng,
  OptionsProps,
  OverlaySpec,
  StatItem,
} from '../../types';
import { cellAt } from '../../services/geospatial/grid';
import { fmtCoord, fmtKm2, fmtPct, fmtSignedKm2 } from '../../services/format';
import { DAY, fmtDate, fmtDateTime } from '../../services/time/format';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import { AOI, JRC_OCCURRENCE_TILES, loadBaseline, type WaterBaseline } from './baseline';
import { DEMO_DEFAULT_RANGE, DEMO_SCENES } from './demoScenario';
import { loadManifest, loadPassScenes } from './nisarFlood';
import { OPERA_AOI, OPERA_DEFAULT_RANGE, OPERA_FIRST, loadOperaManifest, loadOperaScenes } from './operaFlood';
import { FloodPopup, SOURCE_TEXT } from './FloodPopup';
import {
  DEFAULT_FLOOD_OPTIONS,
  type DemoTerrain,
  type FloodData,
  type FloodOptions,
  buildDemoTerrain,
  floodTimelineEvents,
  runFloodPipeline,
  demoWaterScenes,
  MIN_COMMON_FRACTION,
  type Comparison,
} from './pipeline';
import { floodImage, noDataImage, permanentImage, recededImage, selectedBlobImage } from './render';

type Ctx = FrameContext<FloodData, FloodOptions>;

const terrainCache = new WeakMap<WaterBaseline, DemoTerrain>();
const resultCache = new Map<string, FloodData>();

const EVENT_TEXT: Record<string, string> = {
  appeared: 'Appeared',
  expanded: 'Expanded',
  contracted: 'Contracted',
  stable: 'Stable',
  merged: 'Merged',
  split: 'Split',
};

export function buildFloodOverlays(ctx: Ctx): OverlaySpec[] {
  const { data, index, layers, effects, selectedId, reducedMotion } = ctx;
  const frame = data.frames[index];
  if (!frame) return [];
  const out: OverlaySpec[] = [];
  const b = data.bounds;

  if (layers['jrc-occurrence']) {
    out.push({
      kind: 'tile', id: 'jrc-occurrence', pane: 'reference', url: JRC_OCCURRENCE_TILES, opacity: 0.8, maxNativeZoom: 13,
      attribution: 'Surface water: EC JRC/Google, Pekel et al. 2016 (Global Surface Water)',
    });
  }
  if (layers.permanent) {
    out.push({ kind: 'image', id: 'flood-permanent', pane: 'reference', url: permanentImage(data), bounds: b, opacity: 1, pixelated: true });
  }
  if (layers.receded) {
    out.push({ kind: 'image', id: `flood-receded-${frame.obs.id}-${effects.highlightChanges}`, pane: 'data', url: recededImage(data, index, effects.highlightChanges), bounds: b, opacity: 1, pixelated: true });
  }
  if (layers.flood) {
    out.push({ kind: 'image', id: `flood-extent-${frame.obs.id}-${effects.highlightChanges}`, pane: 'data', url: floodImage(data, index, effects.highlightChanges), bounds: b, opacity: 1, pixelated: true });
  }
  if (layers.nodata) {
    const nd = noDataImage(data, index);
    if (nd) out.push({ kind: 'image', id: `flood-nodata-${frame.obs.id}`, pane: 'data', url: nd, bounds: b, opacity: 1, pixelated: true });
  }

  const selectedBlob = selectedId ? frame.blobs.find((x) => x.trackId === selectedId) : undefined;
  if (selectedBlob && effects.highlightSelected) {
    out.push({ kind: 'image', id: `flood-selected-${frame.obs.id}-${selectedBlob.label}`, pane: 'effects', url: selectedBlobImage(data, index, selectedBlob.label), bounds: b, opacity: 1, pixelated: true });
  }

  const cinematic = effects.mode === 'cinematic';
  const motion = !reducedMotion;

  // Trails: historical centroids of actual observations only.
  if (effects.trails) {
    for (const blob of frame.blobs) {
      const track = data.tracks[blob.trackId];
      // Centroids from partially imaged scenes shift because of coverage, not water; skip them.
      const hist = track.history.filter(
        (h) => h.frameIndex <= index && (data.frames[h.frameIndex].coverageFraction >= 0.999 || h.frameIndex === index),
      );
      const isSel = blob.trackId === selectedId;
      const pts = isSel ? hist : hist.slice(-effects.trailLength);
      for (let i = 1; i < pts.length; i++) {
        const age = pts.length - 1 - i; // 0 = newest segment
        const fade = isSel ? 1 : Math.max(0.2, 1 - age / Math.max(1, effects.trailLength - 1));
        out.push({
          kind: 'polyline',
          id: `trail-${blob.trackId}-${pts[i - 1].frameIndex}-${pts[i].frameIndex}`,
          pane: 'effects',
          points: [pts[i - 1].centroid, pts[i].centroid],
          color: cinematic ? '#fb923c' : '#fbbf24',
          weight: cinematic ? 2.4 : 1.4,
          opacity: (cinematic ? 0.95 : 0.55) * fade,
          draw: cinematic && motion && age === 0,
        });
      }
    }
  }

  if (effects.boundingBoxes || effects.trackingIds || (selectedBlob && effects.highlightSelected)) {
    for (const blob of frame.blobs) {
      const isSel = blob.trackId === selectedId;
      const showBox = effects.boundingBoxes || (isSel && effects.highlightSelected);
      if (!showBox && !effects.trackingIds) continue;
      const emphasis =
        cinematic && motion
          ? blob.event === 'appeared' || blob.event === 'merged' || blob.event === 'split'
            ? 'appear'
            : blob.event === 'expanded' && blob.previousAreaKm2 && blob.areaKm2 / blob.previousAreaKm2 > 1.3
              ? 'change'
              : null
          : null;
      out.push({
        kind: 'rect',
        id: `box-${blob.trackId}`,
        pane: 'effects',
        bounds: blob.bounds,
        color: isSel ? '#ecfdf5' : cinematic ? '#86efac' : '#6ee7b7',
        weight: isSel ? 2 : cinematic ? 1.6 : 1.1,
        opacity: showBox ? (isSel ? 1 : cinematic ? 0.95 : 0.8) : 0,
        glow: cinematic || isSel,
        label: effects.trackingIds ? (cinematic ? `${blob.trackId} · ${fmtKm2(blob.areaKm2)}` : blob.trackId) : undefined,
        selectId: blob.trackId,
        emphasis,
      });
    }
  }

  if (effects.centroids) {
    for (const blob of frame.blobs) {
      out.push({
        kind: 'circle',
        id: `centroid-${blob.trackId}`,
        pane: 'effects',
        center: blob.centroid,
        radiusPx: cinematic ? 3.5 : 2.5,
        color: '#fbbf24',
        fillOpacity: 0.95,
        weight: 1,
        tooltip: `${blob.trackId} centroid (area-weighted)`,
        selectId: blob.trackId,
        pulse: null,
      });
    }
  }
  return out;
}

export function floodStats({ data, index }: Ctx): StatItem[] {
  const f = data.frames[index];
  if (!f) return [];
  const prev = index > 0 ? data.frames[index - 1] : null;
  const base = data.frames[0];
  const largest = f.blobs.reduce<(typeof f.blobs)[number] | null>((a, x) => (!a || x.areaKm2 > a.areaKm2 ? x : a), null);
  const maxShareSoFar = data.frames.slice(0, index + 1).reduce((a, x) => Math.max(a, x.floodShare), 0);
  const partial = f.coverageFraction < 0.999;
  // Changes are measured only over cells imaged by both observations.
  const change = (c: Comparison | null, id: string, label: string, hint: string): StatItem => {
    if (!c || c.commonFraction < MIN_COMMON_FRACTION) {
      return { id, label, value: 'Not comparable', hint: 'Too little area imaged by both observations', tone: 'neutral' };
    }
    const d = c.afterKm2 - c.beforeKm2;
    return {
      id,
      label,
      value: `${fmtSignedKm2(d)} (${fmtPct(c.beforeKm2 ? (d / c.beforeKm2) * 100 : NaN)})`,
      hint: `${hint} · over the ${Math.round(c.commonFraction * 100)}% of the area imaged by both`,
      tone: d > 0 ? 'up' : d < 0 ? 'down' : 'neutral',
    };
  };
  const stats: StatItem[] = [
    { id: 'water', label: 'Total detected water', value: fmtKm2(f.floodKm2 + f.permanentKm2), hint: 'Persistent water + potential flood, within imaged area' },
    { id: 'flood', label: 'Potentially flooded', value: fmtKm2(f.floodKm2), hint: 'Water now where historical occurrence is below the persistent-water threshold' },
  ];
  if (prev) stats.push(change(f.vsPrev, 'dprev', 'Change vs previous obs.', `Previous: ${fmtDate(prev.obs.time)}`));
  if (index > 0) stats.push(change(f.vsBase, 'dbase', `Change vs baseline (${fmtDate(base.obs.time)})`, 'Baseline = first observation in the selected range'));
  stats.push(
    { id: 'blobs', label: 'Active flood regions', value: String(f.blobs.length), hint: `Connected regions ≥ ${data.options.minBlobCells} cells` },
    { id: 'largest', label: 'Largest region', value: largest ? `${largest.trackId} · ${fmtKm2(largest.areaKm2)}` : '—' },
    { id: 'share', label: 'Flood share of imaged land', value: `${(f.floodShare * 100).toFixed(2)}%`, hint: `Highest so far: ${(maxShareSoFar * 100).toFixed(2)}% · range maximum ${(data.maxExtent.share * 100).toFixed(2)}% on ${fmtDate(data.frames[data.maxExtent.index]?.obs.time ?? 0)}` },
    { id: 'receded', label: 'Receded since earlier obs.', value: fmtKm2(f.recededKm2) },
    { id: 'coverage', label: 'Area imaged', value: `${Math.round(f.coverageFraction * 100)}%`, hint: partial ? 'Partial scene — unimaged area is hatched, not dry' : undefined },
  );
  return stats;
}

function FloodDetail({ data, index, selectedId, onClose }: DetailProps<FloodData, FloodOptions>) {
  if (!selectedId) return null;
  const track = data.tracks[selectedId];
  if (!track) return null;
  const frame = data.frames[index];
  const blob = frame?.blobs.find((b) => b.trackId === selectedId);
  const first = track.history[0];
  const last = track.history[track.history.length - 1];
  const domain: [number, number] = [data.frames[0].obs.time, data.frames[data.frames.length - 1].obs.time];
  return (
    <section className="detail" aria-label={`Flood region ${selectedId} details`}>
      <header className="detail-head">
        <div>
          <div className="detail-id">{selectedId}</div>
          <div className="muted small">{`Potential flood region · ${SOURCE_TEXT[data.source]}`}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close region details">✕</button>
      </header>
      <dl className="kv">
        <dt>Observation</dt>
        <dd>{frame ? fmtDateTime(frame.obs.time) : '—'}</dd>
        <dt>State</dt>
        <dd>
          {blob ? EVENT_TEXT[blob.event] : track.end && track.end.frameIndex <= index
            ? `Ended (${track.end.reason}) ${fmtDate(track.end.time)}`
            : frame?.unobserved.includes(selectedId) ? 'Not imaged in this observation' : 'Not detected in this observation'}
          {blob?.parents.length ? ` · with ${blob.parents.join(', ')}` : ''}
        </dd>
        {blob && (
          <>
            <dt>Area</dt>
            <dd>{fmtKm2(blob.areaKm2)}</dd>
            <dt>Gained / lost</dt>
            <dd>{blob.previousAreaKm2 == null ? 'n/a (new region)' : `${fmtSignedKm2(blob.gainedKm2)} / ${fmtSignedKm2(-blob.lostKm2)}`}</dd>
            <dt>Bounds</dt>
            <dd className="small">
              N {blob.bounds.north.toFixed(3)}° S {blob.bounds.south.toFixed(3)}°<br />W {blob.bounds.west.toFixed(3)}° E {blob.bounds.east.toFixed(3)}°
            </dd>
            <dt>Centroid</dt>
            <dd className="small">{fmtCoord(blob.centroid[0], blob.centroid[1])}</dd>
          </>
        )}
        <dt>First seen</dt>
        <dd>{fmtDate(first.time)}</dd>
        <dt>Last seen</dt>
        <dd>{fmtDate(last.time)}</dd>
        {track.parents.length > 0 && (
          <>
            <dt>Origin</dt>
            <dd>{`From ${track.parents.join(', ')}`}</dd>
          </>
        )}
        {track.children.length > 0 && (
          <>
            <dt>Continued as</dt>
            <dd>{track.children.join(', ')}</dd>
          </>
        )}
        <dt>Confidence</dt>
        <dd className="muted">
          {data.source === 'nisar'
            ? `No per-pixel confidence. Pass quality: ${Object.entries(frame?.obs.quality ?? {}).filter(([k]) => k.includes('threshold') || k.includes('contrast')).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`
            : data.source === 'opera'
              ? 'Not shown: OPERA publishes a per-pixel confidence layer (B03_CONF) that this app does not load yet'
              : 'Not available (demo classification has no confidence model)'}
        </dd>
      </dl>
      <div className="detail-chart">
        <div className="small muted">Area vs. observation date (km²)</div>
        <TimeSeriesChart
          points={track.history.map((h) => ({ time: h.time, value: h.areaKm2 }))}
          domain={domain}
          cursorTime={frame?.obs.time}
          unit="km²"
          label={`${selectedId} area`}
          color="var(--mint)"
        />
      </div>
    </section>
  );
}

const NISAR_DEFAULT_RANGE = { start: Date.UTC(2026, 5, 1), end: Date.UTC(2026, 10, 14, 23, 59) };

function FloodOptionsPanel({ options, onChange, onRange }: OptionsProps<FloodOptions>) {
  return (
    <div className="options-grid">
      <label>
        Observations
        <select
          value={options.source}
          onChange={(e) => {
            const source = e.target.value as FloodOptions['source'];
            onChange({ ...options, source });
            onRange?.(source === 'demo' ? { ...DEMO_DEFAULT_RANGE } : source === 'opera' ? { ...OPERA_DEFAULT_RANGE } : { ...NISAR_DEFAULT_RANGE });
          }}
        >
          <option value="opera">Real Sentinel-1 water maps (NASA OPERA) · April 2025 floods</option>
          <option value="nisar">Real NISAR L-band (GCOV water classification) · St. Louis 2026</option>
          <option value="demo">Demo (simulated scenes)</option>
        </select>
      </label>
      <label>
        Persistent-water threshold
        <select
          value={options.permanentThreshold}
          onChange={(e) => onChange({ ...options, permanentThreshold: Number(e.target.value) })}
        >
          {[30, 50, 75, 90].map((v) => (
            <option key={v} value={v}>{`JRC occurrence ≥ ${v}%`}</option>
          ))}
        </select>
      </label>
      <label>
        Noise removal (min. region size)
        <select value={options.minBlobCells} onChange={(e) => onChange({ ...options, minBlobCells: Number(e.target.value) })}>
          {[4, 16, 48].map((v) => (
            <option key={v} value={v}>{`${v} cells (~${(v * 0.3).toFixed(1)} km²)`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

export const floodFilter: FilterDefinition<FloodData, FloodOptions> = {
  id: 'flood',
  label: 'Flood',
  icon: 'waves',
  status: 'live',
  summary: `Potential flooding vs. historical surface water. Default: real Sentinel-1 radar water maps (NASA OPERA) of the April 2025 Mississippi–Ohio valley floods — ${OPERA_AOI.name}. Options: real NISAR passes (${AOI.name}, 2026) or simulated demo scenes.`,
  missionId: 'nisar',
  supportsTracking: true,
  effectControls: ['boundingBoxes', 'trackingIds', 'trails', 'centroids', 'trailLength', 'highlightSelected', 'highlightChanges'],
  expectedCadenceMs: 12 * DAY,
  availableLayers: [
    { id: 'flood', label: 'Potential newly flooded land', description: 'Radar-dark (water-like) area where the historical baseline is usually dry. Derived from the observation — not a confirmed flood.', provenance: 'derived', defaultVisible: true, swatch: 'rgba(34,211,238,0.7)' },
    { id: 'permanent', label: 'Persistent rivers & lakes', description: 'Cells with JRC Global Surface Water occurrence ≥ threshold (1984–2021). Reference layer, not a NISAR measurement.', provenance: 'reference', defaultVisible: true, swatch: '#1d4ed8' },
    { id: 'receded', label: 'Receded water', description: 'Flagged as potential flood in an earlier observation of this range, dry now.', provenance: 'derived', defaultVisible: true, swatch: 'rgba(217,137,74,0.75)' },
    { id: 'nodata', label: 'No data', description: 'Area not imaged by the current scene. Unknown — not dry land.', provenance: 'derived', defaultVisible: true, swatch: 'hatch' },
    { id: 'jrc-occurrence', label: 'JRC water occurrence (raw)', description: 'Full-resolution historical occurrence tiles: pink = rarely water, blue = always water.', provenance: 'reference', defaultVisible: false, swatch: 'linear-gradient(90deg,#ffcccc,#0000ff)' },
  ],
  sourceAttribution: [
    { name: 'NASA OPERA DSWx-S1 (Sentinel-1)', url: 'https://www.jpl.nasa.gov/go/opera/products/dswx-product-suite/', type: 'Satellite SAR water maps (Sentinel-1 C-band, 30 m) — default source', detail: 'Surface water classified by NASA/JPL OPERA from ESA Sentinel-1 radar; aggregated to ~0.55 km cells by server/opera_prep.py. Data from NASA PO.DAAC. Copernicus Sentinel data, ESA.' },
    { name: 'NASA–ISRO SAR (NISAR) L2 GCOV', url: 'https://nisar-docs.asf.alaska.edu/gcov/', type: 'Satellite SAR observations (L-band, 80 m)', detail: 'Water classified per pass from HH/HV backscatter by server/flood_prep.py; thresholds trained per pass against JRC reference water. Data from ASF DAAC.' },
    { name: 'JRC Global Surface Water v1.4 (Pekel et al., 2016)', url: 'https://global-surface-water.appspot.com/', type: 'Historical water reference (Landsat 1984–2021)' },
    { name: 'Demo SAR water scenes (simulated)', type: 'Synthetic observations — only when "Demo" is selected', detail: 'Simulated timestamps, coverage and water masks for exercising the pipeline.', isDemo: true },
  ],
  defaultOptions: DEFAULT_FLOOD_OPTIONS,
  defaultRange: (now) => ({ start: OPERA_DEFAULT_RANGE.start, end: Math.min(now, OPERA_DEFAULT_RANGE.end) }),
  dataBounds: (now) => ({ start: OPERA_FIRST, end: now }),

  async load({ range, options, signal }) {
    // Each real source covers its own area; the demo reuses the St. Louis area.
    const aoi = options.source === 'opera' ? OPERA_AOI : AOI;
    const baseline = await loadBaseline(signal, aoi);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const notices = [baseline.note];
    if (baseline.source === 'synthetic') notices.push('Baseline is SYNTHETIC — persistent water will not line up with real rivers.');
    const cells = baseline.grid.cols * baseline.grid.rows;

    let scenes;
    let extra: Pick<FloodData, 'source' | 'method' | 'limitations'>;
    if (options.source === 'opera') {
      const manifest = await loadOperaManifest(signal);
      scenes = await loadOperaScenes(manifest, range, cells, signal);
      extra = { source: 'opera', method: manifest.method, limitations: manifest.limitations };
      notices.unshift(
        `Real Sentinel-1 water maps (NASA OPERA DSWx-S1), processed ${manifest.generated.slice(0, 10)}: ${manifest.passes.length} passes, ${manifest.range.start} → ${manifest.range.end}. Sentinel-1, not NISAR — these floods predate NISAR's launch. Each pass images part of the area; changes are compared only over area imaged by both passes.`,
      );
      if (!scenes.length && manifest.passes.length) {
        notices.push(`No processed passes in this range. Available: ${manifest.passes[0].time.slice(0, 10)} → ${manifest.passes[manifest.passes.length - 1].time.slice(0, 10)}.`);
      }
    } else if (options.source === 'nisar') {
      const manifest = await loadManifest('stl', signal);
      scenes = await loadPassScenes(manifest, range, cells, signal);
      extra = { source: 'nisar', method: manifest.method, limitations: manifest.limitations };
      notices.unshift(
        `Real NISAR passes processed ${manifest.generated.slice(0, 10)} (${manifest.passes.length} passes, ${manifest.range.start} → ${manifest.range.end}). Each pass images part of the area; unimaged cells are no-data, and changes are compared only over area imaged by both passes.`,
      );
      if (!scenes.length && manifest.passes.length) {
        notices.push(`No processed NISAR passes in this range. Available: ${manifest.passes[0].time.slice(0, 10)} → ${manifest.passes[manifest.passes.length - 1].time.slice(0, 10)}.`);
      }
    } else {
      let terrain = terrainCache.get(baseline);
      if (!terrain) terrainCache.set(baseline, (terrain = buildDemoTerrain(baseline)));
      scenes = demoWaterScenes(baseline, DEMO_SCENES.filter((s) => s.obs.time >= range.start && s.obs.time <= range.end), terrain);
      extra = { source: 'demo' };
    }
    const key = `${options.source}|${baseline.source}|${options.permanentThreshold}|${options.minBlobCells}|${scenes.map((s) => s.obs.id).join(',')}`;
    let data = resultCache.get(key);
    if (!data) {
      data = { ...runFloodPipeline(baseline, scenes, options), ...extra };
      resultCache.set(key, data);
      if (resultCache.size > 6) resultCache.delete(resultCache.keys().next().value!);
    }
    return { observations: data.frames.map((f) => f.obs), data, notices };
  },

  overlays: buildFloodOverlays,
  stats: floodStats,
  timelineEvents: (data) => floodTimelineEvents(data),
  // Share of imaged land, so passes with different coverage are comparable.
  chart: (data) =>
    data.frames.length
      ? { label: 'Potential flood, share of imaged land', unit: '%', points: data.frames.map((f) => ({ time: f.obs.time, value: f.floodShare * 100 })) }
      : null,
  hitTest({ data, index }, at: LatLng) {
    const f = data.frames[index];
    if (!f) return null;
    const cell = cellAt(data.grid, at);
    if (cell < 0) return null;
    const label = f.labels[cell];
    return label > 0 ? (f.blobs.find((b) => b.label === label)?.trackId ?? null) : null;
  },
  extent: (data) => data.bounds,
  Detail: FloodDetail,
  Popup: FloodPopup,
  Options: FloodOptionsPanel,
  dispose() {
    resultCache.clear();
  },
};

