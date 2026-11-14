import type { Observation } from '../../types';

/**
 * DEMO ONLY. These are NOT real NISAR acquisitions. They are synthetic scenes whose
 * timestamps mimic an irregular ~12-day repeat (including a missed acquisition and a
 * partial-coverage scene) so the full pipeline and timeline can be exercised honestly.
 */
export interface DemoScene {
  obs: Observation;
  /** Synthetic flood "level" driving the demo water classification, 0..1. */
  level: number;
  /** Fraction of the AOI (from the west) imaged; 1 = full coverage. */
  coverageWest: number;
  seed: number;
}

const t = (iso: string) => Date.parse(iso);

const SCENES: [string, number, number][] = [
  // iso time (UTC), level, coverage fraction from west
  ['2026-03-04T23:52:22Z', 0.018, 1],
  ['2026-03-16T23:52:25Z', 0.033, 1],
  ['2026-03-28T23:52:19Z', 0.06, 1],
  ['2026-04-09T23:52:23Z', 0.099, 1],
  ['2026-04-21T23:52:21Z', 0.138, 1],
  // 2026-05-03 acquisition intentionally missing (no-data gap on the timeline)
  ['2026-05-15T23:52:20Z', 0.186, 1],
  ['2026-05-27T23:52:24Z', 0.165, 0.68],
  ['2026-06-08T23:52:22Z', 0.12, 1],
  ['2026-06-20T23:52:18Z', 0.081, 1],
  ['2026-07-02T23:52:21Z', 0.048, 1],
  ['2026-07-14T23:52:26Z', 0.027, 1],
];

export const DEMO_BOUNDS = { start: t('2026-03-01T00:00:00Z'), end: t('2026-07-31T23:59:59Z') };
export const DEMO_DEFAULT_RANGE = { start: t('2026-03-01T00:00:00Z'), end: t('2026-07-20T00:00:00Z') };

export const DEMO_SCENES: DemoScene[] = SCENES.map(([iso, level, cov], i) => ({
  obs: {
    id: `demo-sar-${iso.slice(0, 10)}`,
    time: t(iso),
    kind: 'demo-observed',
    label: 'DEMO scene · simulated L-band water classification',
    quality: {
      Source: 'Synthetic demo (not a NISAR product)',
      Coverage: cov < 1 ? `Partial (${Math.round(cov * 100)}% of area imaged)` : 'Full area',
      Orbit: 'Ascending (simulated)',
    },
  },
  level,
  coverageWest: cov,
  seed: 1000 + i * 17,
}));
