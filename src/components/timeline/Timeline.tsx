import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChartSeries, Observation, TimeRange, TimelineEvent } from '../../types';
import { generateTicks, positionOf } from '../../services/time/ticks';
import { findGaps, nearestObservationIndex } from '../../services/time/range';
import { fmtDateTime, fmtIso, fmtRangeCompact, fmtDuration } from '../../services/time/format';
import { SPEEDS, type Speed } from '../../services/playback';
import type { LoadState } from '../../state/store';
import { RangePicker } from './RangePicker';
import { TimeSeriesChart } from '../charts/TimeSeriesChart';

export interface TimelineProps {
  range: TimeRange | null;
  bounds?: TimeRange;
  defaultRange?: TimeRange;
  now: number;
  observations: Observation[];
  currentIndex: number;
  playing: boolean;
  speed: Speed;
  loop: boolean;
  loadState: LoadState;
  events: TimelineEvent[];
  chart: ChartSeries | null;
  cadenceMs?: number;
  filterActive: boolean;
  /** Extra real acquisitions (e.g. NISAR scenes) shown as markers; not playback frames. */
  secondaryMarkers?: { id: string; time: number; label: string; active: boolean }[];
  onSecondaryClick?(id: string): void;
  onRangeChange(r: TimeRange): void;
  onIndex(i: number): void;
  onStep(dir: 1 | -1): void;
  onPlayPause(): void;
  onPause(): void;
  onSpeed(s: Speed): void;
  onLoop(v: boolean): void;
}

const KIND_TEXT: Record<Observation['kind'], string> = {
  observed: 'Observed',
  'demo-observed': 'DEMO scene',
  catalog: 'Catalog day',
  report: 'Report day',
  estimated: 'Estimated',
};

const EVENT_ICON: Record<TimelineEvent['type'], string> = {
  appeared: '◆',
  expansion: '▲',
  'max-extent': '★',
  recession: '▼',
  merged: '⧉',
  split: '⑂',
  'major-event': '●',
};

const EVENT_RANK: TimelineEvent['type'][] = ['max-extent', 'major-event', 'expansion', 'recession', 'merged', 'split', 'appeared'];

export function Timeline(p: TimelineProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const ticks = useMemo(() => (p.range ? generateTicks(p.range.start, p.range.end) : null), [p.range]);
  const gaps = useMemo(
    () => (p.range && p.cadenceMs && p.loadState === 'ready' ? findGaps(p.observations, p.range, p.cadenceMs) : []),
    [p.range, p.cadenceMs, p.observations, p.loadState],
  );
  // One marker per time; the most significant event type is shown, all are in the tooltip.
  const eventGroups = useMemo(() => {
    const map = new Map<number, TimelineEvent[]>();
    for (const e of p.events) {
      if (!p.range || e.time < p.range.start || e.time > p.range.end) continue;
      if (!map.has(e.time)) map.set(e.time, []);
      map.get(e.time)!.push(e);
    }
    return [...map.entries()].map(([time, events]) => ({
      time,
      events,
      top: [...events].sort((a, b) => EVENT_RANK.indexOf(a.type) - EVENT_RANK.indexOf(b.type))[0],
    }));
  }, [p.events, p.range]);
  const current = p.observations[p.currentIndex];
  const n = p.observations.length;

  const indexAtClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !p.range || !n) return -1;
      const rect = el.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      const t = p.range.start + k * (p.range.end - p.range.start);
      return nearestObservationIndex(p.observations, t);
    },
    [p.range, p.observations, n],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!n) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    p.onPause();
    const i = indexAtClientX(e.clientX);
    if (i >= 0) p.onIndex(i);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const i = indexAtClientX(e.clientX);
    if (i >= 0 && i !== p.currentIndex) p.onIndex(i);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight') p.onStep(1);
    else if (e.key === 'ArrowLeft') p.onStep(-1);
    else if (e.key === 'Home') (p.onPause(), p.onIndex(0));
    else if (e.key === 'End') (p.onPause(), p.onIndex(n - 1));
    else if (e.key === ' ') p.onPlayPause();
    else return;
    e.preventDefault();
  };

  const pos = (t: number) => (p.range ? positionOf(t, p.range.start, p.range.end) * 100 : 0);
  const inRange = (t: number) => !!p.range && t >= p.range.start && t <= p.range.end;

  let statusText = '';
  if (!p.filterActive) statusText = 'Select a data filter to load observations';
  else if (p.loadState === 'loading') statusText = 'Loading observations…';
  else if (p.loadState === 'error') statusText = 'Could not load observations';
  else if (p.loadState === 'empty') statusText = 'No observations in this date range';

  return (
    <footer className="timeline" aria-label="Timeline and playback">
      {p.chart && p.chart.points.length > 1 && p.range && (
        <div className="tl-chart" aria-hidden="false">
          <span className="tl-chart-label">{`${p.chart.label} (${p.chart.unit})`}</span>
          <div className="tl-chart-plot">
            <TimeSeriesChart
              points={p.chart.points.filter((x) => inRange(x.time))}
              domain={[p.range.start, p.range.end]}
              cursorTime={current?.time}
              height={34}
              unit={p.chart.unit}
              label={p.chart.label}
              compact
            />
          </div>
        </div>
      )}
      <div className="tl-row">
        <div className="tl-range">
          <button
            className="range-btn"
            disabled={!p.range}
            onClick={() => setPickerOpen((v) => !v)}
            title={p.range ? `${fmtIso(p.range.start)} → ${fmtIso(p.range.end)} — click to change` : 'Select a filter first'}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
          >
            <span className="range-icon" aria-hidden>📅</span>
            {p.range ? fmtRangeCompact(p.range.start, p.range.end) : 'No range'}
          </button>
          <span className="utc-badge" title="All times are UTC">UTC</span>
          {pickerOpen && p.range && (
            <RangePicker
              range={p.range}
              bounds={p.bounds}
              defaultRange={p.defaultRange}
              now={p.now}
              onClose={() => setPickerOpen(false)}
              onApply={(r) => {
                setPickerOpen(false);
                p.onRangeChange(r);
              }}
            />
          )}
        </div>

        <div className="tl-track-wrap">
          <div
            ref={trackRef}
            className={`tl-track ${n ? '' : 'empty'}`}
            role="slider"
            tabIndex={n ? 0 : -1}
            aria-label="Observation scrubber"
            aria-valuemin={n ? 1 : 0}
            aria-valuemax={n}
            aria-valuenow={n ? p.currentIndex + 1 : 0}
            aria-valuetext={current ? `${fmtDateTime(current.time)}, observation ${p.currentIndex + 1} of ${n}` : statusText}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            {gaps.map((g) => (
              <div
                key={`${g.start}-${g.end}`}
                className="tl-gap"
                style={{ left: `${pos(g.start)}%`, width: `${Math.max(0.4, pos(g.end) - pos(g.start))}%` }}
                title={`No observation for ${fmtDuration(g.end - g.start)} (nominal repeat ${fmtDuration(p.cadenceMs ?? 0)})`}
              />
            ))}
            <div className="tl-axis" />
            {ticks?.ticks.map((t) => (
              <div key={t.index} className="tl-tick" style={{ left: `${t.position * 100}%` }} title={t.title} data-testid="major-tick">
                <span className={`tl-tick-label ${t.index === 0 ? 'first' : t.index === 9 ? 'last' : [1, 3, 5, 7, 8].includes(t.index) ? 'minor' : ''}`}>{t.label}</span>
              </div>
            ))}
            {p.observations.map((o, i) =>
              inRange(o.time) ? (
                <div
                  key={o.id}
                  className={`tl-obs ${i === p.currentIndex ? 'current' : ''} ${o.kind === 'estimated' ? 'estimated' : ''}`}
                  style={{ left: `${pos(o.time)}%` }}
                  title={`${KIND_TEXT[o.kind]} · ${fmtIso(o.time)}${o.label ? ` · ${o.label}` : ''}`}
                />
              ) : null,
            )}
            {eventGroups.map((g) => (
              <div
                key={g.time}
                className={`tl-event ev-${g.top.type}`}
                style={{ left: `${pos(g.time)}%` }}
                title={[fmtIso(g.time), ...g.events.map((e) => `${EVENT_ICON[e.type]} ${e.label}`)].join('\n')}
              >
                {EVENT_ICON[g.top.type]}
                {g.events.length > 1 && <sup>{g.events.length}</sup>}
              </div>
            ))}
            {(p.secondaryMarkers ?? []).filter((m) => inRange(m.time)).map((m) => (
              <button
                key={m.id}
                className={`tl-nisar ${m.active ? 'active' : ''}`}
                style={{ left: `${pos(m.time)}%` }}
                title={`NISAR acquisition · ${fmtIso(m.time)} · ${m.label}`}
                aria-label={`NISAR scene ${fmtIso(m.time)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onSecondaryClick?.(m.id);
                }}
              />
            ))}
            {current && inRange(current.time) && <div className="tl-cursor" style={{ left: `${pos(current.time)}%` }} />}
            {statusText && <div className="tl-status">{statusText}</div>}
          </div>
        </div>

        <div className="tl-controls">
          <button className="ctl" onClick={() => p.onStep(-1)} disabled={!n || p.currentIndex <= 0} aria-label="Previous observation" title="Previous observation (←)">⏮</button>
          <button className="ctl play" onClick={p.onPlayPause} disabled={n < 2} aria-label={p.playing ? 'Pause' : 'Play'} title={p.playing ? 'Pause (Space)' : 'Play (Space)'}>
            {p.playing ? '⏸' : '▶'}
          </button>
          <button className="ctl" onClick={() => p.onStep(1)} disabled={!n || p.currentIndex >= n - 1} aria-label="Next observation" title="Next observation (→)">⏭</button>
          <select className="speed" value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value) as Speed)} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>{`${s}×`}</option>
            ))}
          </select>
          <button className={`ctl loop ${p.loop ? 'on' : ''}`} onClick={() => p.onLoop(!p.loop)} aria-pressed={p.loop} aria-label="Loop playback" title="Loop">🔁</button>
        </div>
      </div>
      <div className="tl-frame" aria-live="polite">
        {current ? (
          <>
            <span className={`kind-badge kind-${current.kind}`}>{KIND_TEXT[current.kind]}</span>
            <strong>{fmtDateTime(current.time)}</strong>
            <span className="muted">{`· frame ${p.currentIndex + 1} of ${n}`}</span>
            {current.label && <span className="muted hide-sm">{`· ${current.label}`}</span>}
          </>
        ) : (
          <span className="muted">{p.loadState === 'error' ? 'See the sidebar for details and retry.' : ' '}</span>
        )}
      </div>
    </footer>
  );
}
