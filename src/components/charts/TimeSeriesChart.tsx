import { useMemo } from 'react';
import { fmtShortDate } from '../../services/time/format';

export interface TimeSeriesChartProps {
  points: { time: number; value: number }[];
  /** Horizontal domain; defaults to the points' extent. Real timestamps, never indexes. */
  domain?: [number, number];
  cursorTime?: number | null;
  height?: number;
  unit: string;
  label: string;
  color?: string;
  compact?: boolean;
}

/** Minimal SVG line chart plotted against real timestamps. */
export function TimeSeriesChart({
  points,
  domain,
  cursorTime,
  height = 90,
  unit,
  label,
  color = 'var(--cyan)',
  compact = false,
}: TimeSeriesChartProps) {
  const W = 300;
  const H = height;
  const pad = compact ? { l: 2, r: 2, t: 4, b: 2 } : { l: 38, r: 8, t: 8, b: 18 };

  const geom = useMemo(() => {
    if (!points.length) return null;
    const t0 = domain?.[0] ?? points[0].time;
    const t1 = domain?.[1] ?? points[points.length - 1].time;
    const vmax = Math.max(...points.map((p) => p.value), 1e-9);
    const x = (t: number) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
    const y = (v: number) => H - pad.b - (v / vmax) * (H - pad.t - pad.b);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${path}L${x(points[points.length - 1].time).toFixed(1)},${H - pad.b}L${x(points[0].time).toFixed(1)},${H - pad.b}Z`;
    return { x, y, path, area, vmax, t0, t1 };
  }, [points, domain, H, pad.l, pad.r, pad.t, pad.b]);

  if (!geom) return <div className="chart-empty">No data to chart</div>;
  const cursorX = cursorTime != null && cursorTime >= geom.t0 && cursorTime <= geom.t1 ? geom.x(cursorTime) : null;

  return (
    <svg
      className="ts-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label} over time, maximum ${Math.round(geom.vmax).toLocaleString()} ${unit}`}
      style={{ height: H }}
    >
      {!compact && (
        <>
          <text x={2} y={pad.t + 8} className="ts-axis">{Math.round(geom.vmax).toLocaleString()}</text>
          <text x={2} y={H - pad.b} className="ts-axis">0</text>
          <text x={pad.l} y={H - 4} className="ts-axis">{fmtShortDate(geom.t0)}</text>
          <text x={W - pad.r} y={H - 4} className="ts-axis" textAnchor="end">{fmtShortDate(geom.t1)}</text>
          <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="ts-baseline" />
        </>
      )}
      <path d={geom.area} fill={color} opacity={0.14} />
      <path d={geom.path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {points.map((p) => (
        <circle key={p.time} cx={geom.x(p.time)} cy={geom.y(p.value)} r={compact ? 1.6 : 2.2} fill={color}>
          <title>{`${fmtShortDate(p.time)}: ${Math.round(p.value).toLocaleString()} ${unit}`}</title>
        </circle>
      ))}
      {cursorX != null && <line x1={cursorX} x2={cursorX} y1={0} y2={H} className="ts-cursor" />}
    </svg>
  );
}
