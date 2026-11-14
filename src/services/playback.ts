export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** Base dwell time per observation at 1×. */
export const BASE_FRAME_MS = 1600;

export function frameDelayMs(speed: Speed): number {
  return BASE_FRAME_MS / speed;
}

/** Overlay transition duration, roughly 250–500 ms and tied to speed. */
export function transitionMs(speed: Speed, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return Math.round(Math.min(500, Math.max(250, 500 / Math.max(1, speed / 1.2))));
}

export interface StepResult {
  index: number;
  /** True when playback should stop (end reached without loop). */
  stop: boolean;
}

/** Moves exactly one available observation. */
export function stepIndex(index: number, count: number, direction: 1 | -1, loop: boolean): StepResult {
  if (count <= 0) return { index: -1, stop: true };
  const next = index + direction;
  if (next >= count) return loop ? { index: 0, stop: false } : { index: count - 1, stop: true };
  if (next < 0) return loop ? { index: count - 1, stop: false } : { index: 0, stop: true };
  return { index: next, stop: false };
}
