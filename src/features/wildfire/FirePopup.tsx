import { useEffect, useState } from 'react';
import type { DetailProps } from '../../types';
import { FIRE_SENSORS, isoDay, snapshotUrl, utcDay, worldviewUrl } from './gibsSnapshots';
import type { FireData, FireOptions } from './wildfireFilter';

const SENSOR = FIRE_SENSORS[0]; // VIIRS NOAA-20: 375 m hotspots
const HALF_LAT_DEG = 0.3; // ~65 km tall view around the fire

/**
 * Floating satellite image of a clicked fire on the timeline's current day.
 * The sidebar detail has the full controls (other days, sensors, area).
 */
export function FirePopup({ data, observations, index, selectedId, onClose }: DetailProps<FireData, FireOptions>) {
  const ev = selectedId ? data.events[selectedId] : undefined;
  const obsTime = observations[index]?.time;
  // The report on the shown day if there is one, else the latest report up to it.
  const report = ev
    ? ([...ev.reports].reverse().find((r) => obsTime == null || utcDay(r.time) <= utcDay(obsTime)) ?? ev.reports[0])
    : undefined;
  const day = utcDay(obsTime ?? report?.time ?? Date.now());
  const url = report ? snapshotUrl({ at: report.at, day, sensor: SENSOR, hotspots: true, halfLatDeg: HALF_LAT_DEG, height: 360 }) : '';
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  useEffect(() => setStatus('loading'), [url]);
  if (!ev || !report) return null;

  return (
    <div className="fire-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">{ev.title}</div>
          <div className="small muted">{`${SENSOR.label} · ${isoDay(day)} (UTC day)`}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close satellite image">✕</button>
      </header>
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
      <p className="small muted fire-popup-note">
        Daily true colour via NASA GIBS. Red dots = VIIRS 375 m heat detections that day; ring = reported location. Flames are too small to see at
        this resolution, so look for smoke. Clouds can hide everything.{' '}
        <a href={worldviewUrl(report.at, day, SENSOR, HALF_LAT_DEG)} target="_blank" rel="noreferrer">Worldview ↗</a>
      </p>
    </div>
  );
}
