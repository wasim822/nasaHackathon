import { useEffect, useMemo, useState } from 'react';
import type { LatLng } from '../../types';
import { fmtDate } from '../../services/time/format';
import { FIRE_SENSORS, isoDay, snapshotUrl, utcDay, worldviewUrl } from './gibsSnapshots';

const DAY = 864e5;
const SPANS = [
  { half: 0.2, label: '~45 km' },
  { half: 0.4, label: '~90 km' },
  { half: 0.9, label: '~200 km' },
];

interface Props {
  at: LatLng;
  firstReport: number;
  lastReport: number;
  /** The day currently shown on the timeline. */
  timelineDay: number | null;
}

type Status = 'loading' | 'ok' | 'error';

/** Satellite images of a fire's location on real days, with quick picks around its reports. */
export function FireImagery({ at, firstReport, lastReport, timelineDay }: Props) {
  const today = utcDay(Date.now());
  const picks = useMemo(() => {
    const raw = [
      { label: 'Day before first report', day: utcDay(firstReport) - DAY },
      { label: 'First report', day: utcDay(firstReport) },
      ...(timelineDay != null ? [{ label: 'Timeline day', day: utcDay(timelineDay) }] : []),
      { label: 'Latest report', day: utcDay(lastReport) },
    ];
    const seen = new Set<number>();
    return raw.filter((p) => p.day <= today && !seen.has(p.day) && (seen.add(p.day), true));
  }, [firstReport, lastReport, timelineDay, today]);

  const [day, setDay] = useState(() => utcDay(timelineDay ?? lastReport));
  const [sensorId, setSensorId] = useState('noaa20');
  const [hotspots, setHotspots] = useState(true);
  const [spanIdx, setSpanIdx] = useState(1);
  const [status, setStatus] = useState<Status>('loading');
  const sensor = FIRE_SENSORS.find((s) => s.id === sensorId) ?? FIRE_SENSORS[0];
  const half = SPANS[spanIdx].half;

  // A different fire selected → start on its timeline/latest day again.
  useEffect(() => setDay(utcDay(timelineDay ?? lastReport)), [at[0], at[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  const url = snapshotUrl({ at, day, sensor, hotspots, halfLatDeg: half, height: 300 });
  useEffect(() => setStatus('loading'), [url]);

  return (
    <div className="fire-imagery">
      <div className="fire-img-head">
        <strong className="small">Satellite images</strong>
        <a className="small" href={worldviewUrl(at, day, sensor, half)} target="_blank" rel="noreferrer">Open in Worldview ↗</a>
      </div>

      <div className="fire-picks" role="group" aria-label="Jump to a day">
        {picks.map((p) => (
          <button key={p.day} className={`chip ${p.day === day ? 'active' : ''}`} onClick={() => setDay(p.day)} aria-pressed={p.day === day}>
            <span>{p.label}</span>
            <span className="muted">{fmtDate(p.day)}</span>
          </button>
        ))}
      </div>

      <div className="fire-img-frame">
        {status === 'loading' && <div className="fire-img-state">Loading {isoDay(day)}…</div>}
        {status === 'error' && <div className="fire-img-state">No image available for {isoDay(day)}.</div>}
        <img
          key={url}
          src={url}
          alt={`${sensor.label} true-colour image${hotspots ? ' with thermal hotspots' : ''} around the reported fire location on ${isoDay(day)}`}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          style={{ opacity: status === 'ok' ? 1 : 0 }}
        />
        {status === 'ok' && <span className="fire-img-pin" aria-hidden="true" title="Reported incident location" />}
      </div>

      <div className="fire-img-nav">
        <button className="btn small" onClick={() => setDay(day - DAY)} aria-label="Previous day">◀ Day</button>
        <span className="small">{`${isoDay(day)} (UTC day)`}</span>
        <button className="btn small" onClick={() => setDay(day + DAY)} disabled={day + DAY > today} aria-label="Next day">Day ▶</button>
      </div>

      <div className="options-grid fire-img-opts">
        <label>
          Sensor
          <select value={sensorId} onChange={(e) => setSensorId(e.target.value)}>
            {FIRE_SENSORS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label>
          Area
          <select value={spanIdx} onChange={(e) => setSpanIdx(Number(e.target.value))}>
            {SPANS.map((s, i) => (
              <option key={s.half} value={i}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={hotspots} onChange={(e) => setHotspots(e.target.checked)} />
          Thermal hotspots (red)
        </label>
      </div>

      <p className="small muted">
        {`${sensor.label} daily true-colour composite (${sensor.overpass} pass; ${sensor.resolution}) via NASA GIBS. `}
        Red dots are the same sensor’s active-fire detections for that UTC day, day and night. The ring marks the reported incident location.
        Clouds, smoke and gaps between orbits can hide the ground; black or blank areas are missing data, not unburned land.
      </p>
    </div>
  );
}
