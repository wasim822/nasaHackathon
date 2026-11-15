import { useEffect, useState } from 'react';
import type { DetailProps, GeoBounds } from '../../types';
import { fmtDate } from '../../services/time/format';
import { FIRE_SENSORS, boxAround, isoDay, snapshotUrl, utcDay, worldviewUrl } from './gibsSnapshots';
import type { FireData, FireOptions } from './wildfireFilter';
import { SmokeDrift } from './SmokeDrift';
import { SmokeBoxNote, SmokeBoxes, useSmokeFit, viewKm } from './SmokeBoxes';

const SENSOR = FIRE_SENSORS[0]; // VIIRS NOAA-20: 375 m hotspots
/** View sizes; close-ups separate individual 375 m detections (like Worldview zoomed in). */
export const FIRE_ZOOMS = [
  { half: 0.045, label: '~10 km' },
  { half: 0.11, label: '~25 km' },
  { half: 0.3, label: '~65 km' },
];
const DAY = 864e5;

type Status = 'loading' | 'ok' | 'error';

/**
 * Floating satellite image of a clicked fire: a before/after slider around the first report,
 * or the timeline's current day. The sidebar detail has the full controls (other days, sensors, area).
 */
export function FirePopup({ data, observations, index, selectedId, onClose }: DetailProps<FireData, FireOptions>) {
  const [view, setView] = useState<'compare' | 'day' | 'smoke'>('compare');
  const [half, setHalf] = useState(FIRE_ZOOMS[1].half);
  const [boxes, setBoxes] = useState(true);
  /** Zoom out past `half` when NOAA smoke fills the view, so its edges show (picking a size chip turns this off). */
  const [fitSmoke, setFitSmoke] = useState(true);
  useEffect(() => setFitSmoke(true), [selectedId]);
  const ev = selectedId ? data.events[selectedId] : undefined;
  const obsTime = observations[index]?.time;
  // The report on the shown day if there is one, else the latest report up to it.
  const report = ev
    ? ([...ev.reports].reverse().find((r) => obsTime == null || utcDay(r.time) <= utcDay(obsTime)) ?? ev.reports[0])
    : undefined;
  const day = utcDay(obsTime ?? report?.time ?? Date.now());
  const after = ev ? utcDay(ev.reports[0].time) : 0;
  const before = after - DAY;
  const smokeDays = view === 'compare' ? [before, after] : [day];
  // Smoke drift sizes its own view; this fits the daily images.
  const fitHalf = useSmokeFit(boxes && view !== 'smoke' && report ? report.at : null, smokeDays, half);
  const shown = fitSmoke ? fitHalf : half;
  const widened = shown !== half;
  const url = report ? snapshotUrl({ at: report.at, day, sensor: SENSOR, hotspots: true, halfLatDeg: shown, height: 360 }) : '';
  const [status, setStatus] = useState<Status>('loading');
  useEffect(() => setStatus('loading'), [url]);
  if (!ev || !report) return null;

  const shot = (d: number) => ({ day: d, url: snapshotUrl({ at: report.at, day: d, sensor: SENSOR, hotspots: true, halfLatDeg: shown, height: 360 }) });

  return (
    <div className="fire-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">{ev.title}</div>
          <div className="small muted">
            {view === 'compare' ? `${SENSOR.label} · ${isoDay(before)} vs ${isoDay(after)} (UTC days)` : view === 'smoke' ? `Smoke drift · ${isoDay(day)} (UTC day)` : `${SENSOR.label} · ${isoDay(day)} (UTC day)`}
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
        <button className={`chip ${view === 'smoke' ? 'active' : ''}`} onClick={() => setView('smoke')} aria-pressed={view === 'smoke'}>
          Smoke drift
        </button>
      </div>
      <div className="fire-picks" role="group" aria-label="View size and smoke outlines">
        {view !== 'smoke' && FIRE_ZOOMS.map((z) => {
          const on = !widened && half === z.half;
          return (
            <button key={z.half} className={`chip ${on ? 'active' : ''}`} onClick={() => (setHalf(z.half), setFitSmoke(false))} aria-pressed={on}>
              {z.label}
            </button>
          );
        })}
        {view !== 'smoke' && fitHalf !== half && (
          <button className={`chip ${widened ? 'active' : ''}`} onClick={() => setFitSmoke(true)} aria-pressed={widened} title="Zoom out until the edges of the NOAA smoke area are visible">
            {`Smoke edges ${viewKm(fitHalf)}`}
          </button>
        )}
        <button className={`chip ${boxes ? 'active' : ''}`} onClick={() => setBoxes((b) => !b)} aria-pressed={boxes} title="Outline NOAA-analysed smoke areas">
          Smoke outlines
        </button>
      </div>
      {view === 'smoke' ? (
        <SmokeDrift at={report.at} day={day} title={ev.title} boxes={boxes} />
      ) : view === 'compare' ? (
        <CompareSlider before={shot(before)} after={shot(after)} title={ev.title} boxes={boxes ? boxAround(report.at, shown) : null} />
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
          {status === 'ok' && boxes && <SmokeBoxes day={day} view={boxAround(report.at, shown)} />}
          {status === 'ok' && <span className="fire-img-pin" aria-hidden="true" />}
        </div>
      )}
      {view !== 'smoke' && boxes && <SmokeBoxNote days={smokeDays} view={boxAround(report.at, shown)} widenedFrom={widened ? half : undefined} />}
      {view !== 'smoke' && <p className="small muted fire-popup-note">
        Daily true colour via NASA GIBS. Red dots = VIIRS 375 m heat detections that day; ring = reported location. Flames are too small to see at
        this resolution, so look for smoke. Clouds can hide everything.{' '}
        <a href={worldviewUrl(report.at, view === 'compare' ? after : day, SENSOR, shown)} target="_blank" rel="noreferrer">Worldview ↗</a>
      </p>}
    </div>
  );
}

interface Shot { day: number; url: string }

/** Two images of the same area stacked; drag the divider to wipe between "before" (left) and "after" (right). */
function CompareSlider({ before, after, title, boxes }: { before: Shot; after: Shot; title: string; boxes: GeoBounds | null }) {
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
          {boxes && (
            <>
              <SmokeBoxes day={before.day} view={boxes} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} badge="left" />
              <SmokeBoxes day={after.day} view={boxes} style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
            </>
          )}
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
