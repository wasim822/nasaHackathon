import { useEffect, useMemo, useState } from 'react';
import type { DetailProps } from '../../types';
import { fmtKm2, fmtSignedKm2 } from '../../services/format';
import { fmtDate } from '../../services/time/format';
import { spanBounds } from '../../services/geospatial/grid';
import { TimeSeriesChart } from '../../components/charts/TimeSeriesChart';
import type { FloodData, FloodOptions } from './pipeline';
import { trackFrameOverlay, trackWindow, windowCoverage } from './render';

export const SOURCE_TEXT: Record<FloodData['source'], string> = {
  opera: 'Sentinel-1 · NASA OPERA',
  nisar: 'NISAR L-band',
  demo: 'DEMO data (simulated)',
};

/** Frames where the satellite imaged less than this share of the region's area are left out. */
export const MIN_WINDOW_COVERAGE = 0.5;
const STEP_MS = 900;
const SIZE = 360;

export interface VideoFrame {
  index: number;
  time: number;
  areaKm2: number;
  /** Change since the previous frame shown (null on the first). */
  deltaKm2: number | null;
}

export interface VideoFrames {
  frames: VideoFrame[];
  /** Observations left out because they didn't image the region's area. */
  notImaged: number;
  /** Observations left out because the area was imaged but the region wasn't detected. */
  notDetected: number;
}

/** Observations to play for a tracked region: only those that imaged its area and detected it. */
export function videoFrames(data: FloodData, trackId: string): VideoFrames {
  const win = trackWindow(data, trackId);
  const out: VideoFrames = { frames: [], notImaged: 0, notDetected: 0 };
  if (!win) return out;
  let prev: number | null = null;
  data.frames.forEach((f, index) => {
    if (windowCoverage(data, index, win) < MIN_WINDOW_COVERAGE || f.unobserved.includes(trackId)) {
      out.notImaged++;
      return;
    }
    const area = f.blobs.find((b) => b.trackId === trackId)?.areaKm2;
    if (area == null) {
      out.notDetected++;
      return;
    }
    out.frames.push({ index, time: f.obs.time, areaKm2: area, deltaKm2: prev != null ? area - prev : null });
    prev = area;
  });
  return out;
}

/** Real satellite picture of the region's area (Esri World Imagery, Web Mercator) as the video backdrop. */
function backdropUrl(data: FloodData, trackId: string): string | null {
  const win = trackWindow(data, trackId);
  if (!win) return null;
  const b = spanBounds(data.grid, win.r0, win.r0 + win.rows - 1, win.c0, win.c0 + win.cols - 1);
  const p = new URLSearchParams({
    bbox: [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(','),
    bboxSR: '4326', imageSR: '3857', size: `${SIZE},${SIZE}`, format: 'jpg', f: 'image',
  });
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?${p}`;
}

/**
 * Floating card for a clicked flood region: a looping "video" of the region's area across the
 * observations that imaged it, over a real satellite backdrop, plus its area over time.
 */
export function FloodPopup({ data, index, selectedId, onClose, onIndex }: DetailProps<FloodData, FloodOptions>) {
  const track = selectedId ? data.tracks[selectedId] : undefined;
  const { frames, notImaged, notDetected } = useMemo(() => (track ? videoFrames(data, track.id) : { frames: [], notImaged: 0, notDetected: 0 }), [data, track]);
  const win = track ? trackWindow(data, track.id) : null;
  const backdrop = useMemo(() => (track ? backdropUrl(data, track.id) : null), [data, track]);
  // Start on the frame nearest the timeline's current observation.
  const startAt = () => Math.max(0, frames.findIndex((f) => f.index >= index));
  const [k, setK] = useState(startAt);
  const [playing, setPlaying] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => setK(startAt()), [frames]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const id = window.setTimeout(() => setK((n) => (n + 1) % frames.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [playing, k, frames.length]);

  if (!track || !win) return null;
  const first = track.history[0];
  const last = track.history[track.history.length - 1];
  const domain: [number, number] = [data.frames[0].obs.time, data.frames[data.frames.length - 1].obs.time];
  const cur = frames[Math.min(k, frames.length - 1)];

  return (
    <div className="fire-popup flood-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">{`${track.id} · potential flood region`}</div>
          <div className="small muted">
            {`${SOURCE_TEXT[data.source]} · seen ${fmtDate(first.time)} → ${fmtDate(last.time)} · peak ${fmtKm2(Math.max(...track.history.map((h) => h.areaKm2)))}`}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close flood region history">✕</button>
      </header>

      {cur ? (
        <>
          <div className="fire-img-frame flood-video" role="img" aria-label={`${track.id} on ${fmtDate(cur.time)}: ${fmtKm2(cur.areaKm2)}`}>
            {backdrop && <img className="flood-video-bg" src={backdrop} alt="" />}
            {frames.map((f, j) => (
              <img key={f.index} className="flood-video-layer" src={trackFrameOverlay(data, f.index, track.id, win)} alt="" style={{ opacity: j === k ? 1 : 0 }} />
            ))}
            <span className="flood-video-label">
              <strong>{fmtDate(cur.time)}</strong>
              {` · ${fmtKm2(cur.areaKm2)}`}
              {cur.deltaKm2 != null && <span className={cur.deltaKm2 > 0 ? 'up' : cur.deltaKm2 < 0 ? 'down' : ''}>{` · ${fmtSignedKm2(cur.deltaKm2)}`}</span>}
            </span>
            <span className="flood-video-count">{`${k + 1}/${frames.length}`}</span>
          </div>
          <div className="fire-img-nav">
            <button className="btn small" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} disabled={frames.length < 2}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input type="range" min={0} max={frames.length - 1} value={k} aria-label="Observation" onChange={(e) => (setPlaying(false), setK(Number(e.target.value)))} />
            <button className="btn small" onClick={() => onIndex?.(cur.index)} disabled={cur.index === index}>Show on map</button>
          </div>
          <div className="small muted">
            {`${frames.length} observation${frames.length > 1 ? 's' : ''} with this region${notImaged || notDetected ? ` · skipped ${[notImaged ? `${notImaged} not imaged here` : '', notDetected ? `${notDetected} not detected` : ''].filter(Boolean).join(', ')}` : ''}. Gaps between dates are real.`}
          </div>
        </>
      ) : (
        <div className="state-msg small">No observation imaged this region’s area well enough to show it.</div>
      )}

      <div className="detail-chart">
        <div className="small muted">Area at each observation where it was detected (km²)</div>
        <TimeSeriesChart
          points={track.history.map((h) => ({ time: h.time, value: h.areaKm2 }))}
          domain={domain}
          cursorTime={cur?.time ?? data.frames[index]?.obs.time}
          unit="km²"
          label={`${track.id} area`}
          color="var(--mint)"
        />
      </div>
      <p className="small muted fire-popup-note">
        Over Esri World Imagery: bright cyan with a white edge = this region · faint cyan = other potential flooding · dark blue = permanent
        rivers and lakes · light hatching = partly not imaged. Frames are real observations; nothing is interpolated between them.
      </p>
    </div>
  );
}
