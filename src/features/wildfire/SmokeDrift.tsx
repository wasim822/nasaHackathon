import { useEffect, useMemo, useState } from 'react';
import type { LatLng } from '../../types';
import { type Wind, compass, fetchWind, goesLayer, goesTimes, goesUrl } from './smokeDriftData';

const HALF_LAT_DEG = 0.45; // ~100 km tall: wide enough to see a plume's direction
const STEP_MS = 450;

interface Props {
  at: LatLng;
  day: number;
  title: string;
}

/** A daylight loop of GOES images around the fire, plus the model wind arrow, to show which way the smoke goes. */
export function SmokeDrift({ at, day, title }: Props) {
  const times = useMemo(() => goesTimes(at[1], day), [at, day]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [wind, setWind] = useState<Wind | null>(null);
  const [windError, setWindError] = useState<string | null>(null);

  useEffect(() => {
    setI(0);
    setLoaded(new Set());
  }, [times]);

  useEffect(() => {
    const ctrl = new AbortController();
    setWind(null);
    setWindError(null);
    fetchWind(at, day, ctrl.signal)
      .then(setWind)
      .catch((e: unknown) => !ctrl.signal.aborted && setWindError(e instanceof Error ? e.message : String(e)));
    return () => ctrl.abort();
  }, [at, day]);

  // Loop only once every frame has loaded (or failed), so the animation doesn't stutter.
  const allLoaded = loaded.size >= times.length;
  useEffect(() => {
    if (!playing || !allLoaded) return;
    const id = window.setTimeout(() => setI((n) => (n + 1) % times.length), STEP_MS);
    return () => window.clearTimeout(id);
  }, [playing, allLoaded, i, times.length]);

  const mark = (k: number) => setLoaded((s) => (s.has(k) ? s : new Set(s).add(k)));
  const sat = goesLayer(at[1]).startsWith('GOES-West') ? 'GOES-West' : 'GOES-East';
  const utc = (t: number) => new Date(t).toISOString().slice(11, 16);

  return (
    <div className="smoke-drift">
      <div className="fire-img-frame smoke-frame">
        {!allLoaded && <div className="fire-img-state">{`Loading ${sat} images ${loaded.size}/${times.length}…`}</div>}
        {times.map((t, k) => (
          <img
            key={t}
            src={goesUrl(at, t, HALF_LAT_DEG, 300)}
            alt={k === i ? `${sat} GeoColor image around ${title} at ${utc(t)} UTC` : ''}
            onLoad={() => mark(k)}
            onError={() => mark(k)}
            style={{ opacity: allLoaded && k === i ? 1 : 0 }}
          />
        ))}
        {allLoaded && <span className="fire-img-pin" aria-hidden="true" />}
        {allLoaded && <span className="smoke-time">{`${utc(times[i])} UTC`}</span>}
        {wind && (
          <span className="wind-arrow" style={{ transform: `rotate(${wind.towardDeg}deg)` }} title={`Model wind toward ${compass(wind.towardDeg)}`} aria-hidden="true">
            ↑
          </span>
        )}
      </div>
      <div className="fire-img-nav">
        <button className="btn small" onClick={() => setPlaying((p) => !p)} aria-pressed={playing} disabled={!allLoaded}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range" min={0} max={times.length - 1} value={i} aria-label="Image time"
          onChange={(e) => (setPlaying(false), setI(Number(e.target.value)))} disabled={!allLoaded}
        />
      </div>
      <p className="small">
        {wind
          ? `Model wind at ~1.5 km (850 hPa), ${utc(wind.time)} UTC: from ${compass(wind.fromDeg)} at ${Math.round(wind.speedKmh)} km/h, so smoke would be carried toward the ${compass(wind.towardDeg)} (arrow).`
          : windError
            ? `Wind: ${windError}.`
            : 'Loading model wind…'}
      </p>
      <p className="small muted fire-popup-note">
        {`${sat} GeoColor images every 30 min across the local daytime (observed, ~1–2 km pixels) via NASA GIBS: watch the haze move to see the drift. The arrow is modelled wind from Open-Meteo, not a measurement of the smoke; plumes at other heights can drift differently.`}
      </p>
    </div>
  );
}
