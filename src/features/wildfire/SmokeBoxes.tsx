import { type CSSProperties, useSyncExternalStore } from 'react';
import type { GeoBounds, LatLng } from '../../types';
import { fmtShortDate } from '../../services/time/format';
import { type SmokeBox, type SmokeDay, fitSmokeHalf, smokeBoxesIn, smokeFor, subscribeSmoke } from './smoke';

/** NOAA HMS smoke areas for each day; re-renders when they finish loading. */
function useSmokeDays(days: number[]): SmokeDay[] {
  // A day only ever moves loading → ready/error, so its status is enough to notice the change.
  useSyncExternalStore(subscribeSmoke, () => days.map((d) => smokeFor(d).status).join());
  return days.map(smokeFor);
}

/** View half-height that shows the edges of the days' smoke around `at` (see `fitSmokeHalf`). */
export function useSmokeFit(at: LatLng | null, days: number[], half: number): number {
  const all = useSmokeDays(days);
  if (!at) return half;
  return fitSmokeHalf(all.map((sm) => (sm.status === 'ready' ? sm.areas : [])), at, half);
}

/** Approximate height on the ground of a view `half` degrees of latitude either side. */
export const viewKm = (half: number) => `~${Math.max(5, Math.round((2 * half * 111) / 5) * 5)} km`;

const MAX_LABELS = 4;

/**
 * Which outlines get a label: biggest first, skipping any whose label would overlap one already placed.
 * Label size is estimated in % of the image (~420 × 330 px popup image, 10.5 px text).
 */
function labelled(boxes: SmokeBox[], x: (lng: number) => number, y: (lat: number) => number, text: (b: SmokeBox) => string): Set<number> {
  const placed: [number, number, number, number][] = [];
  const out = new Set<number>();
  const order = boxes.map((b, k) => ({ k, size: (b.east - b.west) * (b.north - b.south) })).sort((a, b) => b.size - a.size);
  for (const { k } of order) {
    if (out.size >= MAX_LABELS) break;
    const b = boxes[k];
    const r: [number, number, number, number] = [x(b.east) - text(b).length * 1.5 - 2, y(b.south) - 7, x(b.east), y(b.south)];
    if (placed.some((q) => r[0] < q[2] && q[0] < r[2] && r[1] < q[3] && q[1] < r[3])) continue;
    placed.push(r);
    out.add(k);
  }
  return out;
}

/**
 * Outlines over a plate-carrée image covering `view` (centred on the fire), tracing where NOAA analysts
 * outlined smoke on that UTC day, cut to the image. Analyst-drawn, not a measured plume edge.
 */
export function SmokeBoxes({ day, view, style, badge = 'right' }: { day: number; view: GeoBounds; style?: CSSProperties; badge?: 'left' | 'right' }) {
  const [sm] = useSmokeDays([day]);
  if (sm.status !== 'ready') return null;
  const w = view.east - view.west;
  const h = view.north - view.south;
  const x = (lng: number) => ((lng - view.west) / w) * 100;
  const y = (lat: number) => ((view.north - lat) / h) * 100;
  const { boxes, covering } = smokeBoxesIn(sm.areas, view);
  const date = fmtShortDate(day);
  const text = (b: SmokeBox) => `${date} · ${b.density} smoke`;
  const withLabel = labelled(boxes, x, y, text);
  return (
    <div className="smoke-boxes" aria-hidden="true">
      {/* The badge stays whole; only the outlines follow `style` (e.g. the compare slider's clip). */}
      {covering && <span className={`smoke-cover-badge ${badge}`}>{`${date} · smoke fills view · ${covering}`}</span>}
      <div className="smoke-boxes" style={style}>
        <svg className="smoke-outlines" viewBox="0 0 100 100" preserveAspectRatio="none">
          {boxes.map((b, k) => (
            <polygon key={k} className={b.density} points={b.ring.map(([lat, lng]) => `${x(lng)},${y(lat)}`).join(' ')} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {boxes.map((b, k) => withLabel.has(k) && (
          <span key={k} className="smoke-box-label" style={{ right: `${100 - x(b.east)}%`, bottom: `${100 - y(b.south)}%` }}>
            {text(b)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One line under the image saying what the outlines are, or why there are none. */
export function SmokeBoxNote({ days, view, widenedFrom }: { days: number[]; view: GeoBounds; widenedFrom?: number }) {
  const all = useSmokeDays(days);
  if (all.some((sm) => sm.status === 'loading')) return <p className="small muted">Loading NOAA smoke areas…</p>;
  const err = all.find((sm) => sm.status === 'error');
  if (err?.status === 'error') return <p className="small muted">{`Smoke outlines: ${err.message}.`}</p>;
  const n = all.reduce((s, sm) => {
    if (sm.status !== 'ready') return s;
    const v = smokeBoxesIn(sm.areas, view);
    return s + v.boxes.length + (v.covering ? 1 : 0);
  }, 0);
  const dates = days.map(fmtShortDate).join(' and ');
  const widened = widenedFrom != null ? ` Zoomed out from ${viewKm(widenedFrom)} so the smoke's edges are visible.` : '';
  return (
    <p className="small muted">
      {n
        ? `Mint outlines = smoke areas drawn by NOAA analysts (HMS) for ${dates} (UTC ${days.length > 1 ? 'days' : 'day'}), cut to this view (the largest are labelled with their day; dashed = light, solid = medium, thick = heavy); where areas are nested over the fire only the densest is shown.${widened}`
        : `No NOAA-analysed smoke in this view on ${dates} (HMS covers North America; thin or cloud-hidden smoke may be missed).`}
    </p>
  );
}
