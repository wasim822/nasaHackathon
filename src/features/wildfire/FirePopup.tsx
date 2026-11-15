import { useEffect, useState } from 'react';
import type { DetailProps } from '../../types';
import { fmtDate } from '../../services/time/format';
import { FIRE_SENSORS, isoDay, snapshotUrl, utcDay, worldviewUrl } from './gibsSnapshots';
import type { FireData, FireOptions } from './wildfireFilter';

const SENSOR = FIRE_SENSORS[0]; // VIIRS NOAA-20: 375 m hotspots
const HALF_LAT_DEG = 0.3; // ~65 km tall view around the fire
const DAY = 864e5;

type Status = 'loading' | 'ok' | 'error';

/**
 * Floating satellite image of a clicked fire: a before/after slider around the first report,
 * or the timeline's current day. The sidebar detail has the full controls (other days, sensors, area).
 */
export function FirePopup({ data, observations, index, selectedId, onClose }: DetailProps<FireData, FireOptions>) {
  const [view, setView] = useState<'compare' | 'day'>('compare');
  const ev = selectedId ? data.events[selectedId] : undefined;
  const obsTime = observations[index]?.time;
  // The report on the shown day if there is one, else the latest report up to it.
  const report = ev
    ? ([...ev.reports].reverse().find((r) => obsTime == null || utcDay(r.time) <= utcDay(obsTime)) ?? ev.reports[0])
    : undefined;
  const day = utcDay(obsTime ?? report?.time ?? Date.now());
  const url = report ? snapshotUrl({ at: report.at, day, sensor: SENSOR, hotspots: true, halfLatDeg: HALF_LAT_DEG, height: 360 }) : '';
  const [status, setStatus] = useState<Status>('loading');
  useEffect(() => setStatus('loading'), [url]);
  if (!ev || !report) return null;

  const after = utcDay(ev.reports[0].time);
  const before = after - DAY;
  const shot = (d: number) => ({ day: d, url: snapshotUrl({ at: report.at, day: d, sensor: SENSOR, hotspots: true, halfLatDeg: HALF_LAT_DEG, height: 360 }) });

  return (
    <div className="fire-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">{ev.title}</div>
          <div className="small muted">
            {view === 'compare' ? `${SENSOR.label} · ${isoDay(before)} vs ${isoDay(after)} (UTC days)` : `${SENSOR.label} · ${isoDay(day)} (UTC day)`}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close satellite image">✕</button>
      </header>
      <div className="fire-picks" role="group" aria-label="Image view">
        <button className={`chip ${view === 'compare' ? 'active' : ''}`} onClick={() => setView('compare')} aria-pressed={view === 'compare'}>
          Before / after first report
        </button>
        <button className={`chip ${view === 'day' ? 'active' : ''}`} onClick={() => setView('day')} aria-pressed={view === 'day'}>
          Timeline day
        </button>
      </div>
      {view === 'compare' ? (
        <CompareSlider before={shot(before)} after={shot(after)} title={ev.title} />
      ) : (
        <div className="fire-img-frame">
          {status === 'loading' && <div className="fire-img-state">Loading satellite image…</div>}
          {status === 'error' && <div className="fire-img-state">No image available for this day.</div>}
          <img
            key={url}
            src={url}
            alt={`${SENSOR.label} true-colour satellite image with thermal hotspots around ${ev.title} on ${isoDay(day)}`}
            onLoad={() => setStatus('ok')}
            onError={() => setStatus('error')}
            style={{ opacity: status === 'ok' ? 1 : 0 }}
          />
          {status === 'ok' && <span className="fire-img-pin" aria-hidden="true" />}
        </div>
      )}
      <p className="small muted fire-popup-note">
        Daily true colour via NASA GIBS. Red dots = VIIRS 375 m heat detections that day; ring = reported location. Flames are too small to see at
        this resolution, so look for smoke. Clouds can hide everything.{' '}
        <a href={worldviewUrl(report.at, view === 'compare' ? after : day, SENSOR, HALF_LAT_DEG)} target="_blank" rel="noreferrer">Worldview ↗</a>
      </p>
    </div>
  );
}

interface Shot { day: number; url: string }

/** Two images of the same area stacked; drag the divider to wipe between "before" (left) and "after" (right). */
function CompareSlider({ before, after, title }: { before: Shot; after: Shot; title: string }) {
  const [pos, setPos] = useState(35);
  const [beforeStatus, setBeforeStatus] = useState<Status>('loading');
  const [afterStatus, setAfterStatus] = useState<Status>('loading');
  useEffect(() => setBeforeStatus('loading'), [before.url]);
  useEffect(() => setAfterStatus('loading'), [after.url]);
  const ready = beforeStatus === 'ok' && afterStatus === 'ok';
  const failedDay = beforeStatus === 'error' ? before.day : afterStatus === 'error' ? after.day : null;

  return (
    <div className="fire-img-frame fire-compare">
      {!ready && failedDay == null && <div className="fire-img-state">Loading satellite images…</div>}
      {failedDay != null && <div className="fire-img-state">No image available for {isoDay(failedDay)}.</div>}
      <img
        key={before.url}
        src={before.url}
        alt={`${SENSOR.label} image around ${title} on ${isoDay(before.day)}, the day before the first report`}
        onLoad={() => setBeforeStatus('ok')}
        onError={() => setBeforeStatus('error')}
        style={{ opacity: ready ? 1 : 0 }}
      />
      <img
        key={after.url}
        className="fire-compare-after"
        src={after.url}
        alt={`${SENSOR.label} image around ${title} on ${isoDay(after.day)}, the day of the first report`}
        onLoad={() => setAfterStatus('ok')}
        onError={() => setAfterStatus('error')}
        style={{ opacity: ready ? 1 : 0, clipPath: `inset(0 0 0 ${pos}%)` }}
      />
      {ready && (
        <>
          <span className="fire-img-pin" aria-hidden="true" />
          <span className="fire-compare-tag left">Before · {fmtDate(before.day)}</span>
          <span className="fire-compare-tag right">After · {fmtDate(after.day)}</span>
          <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Compare before and after" />
          <span className="fire-compare-divider" style={{ left: `${pos}%` }} aria-hidden="true" />
        </>
      )}
    </div>
  );
}
