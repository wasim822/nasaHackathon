import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { aoiGrid, syntheticOccurrence, type WaterBaseline } from './baseline';
import { DEMO_SCENES } from './demoScenario';
import { DEFAULT_FLOOD_OPTIONS, demoWaterScenes, runFloodPipeline } from './pipeline';
import { FloodPopup, MIN_WINDOW_COVERAGE, videoFrames } from './FloodPopup';
import { trackWindow, windowCoverage } from './render';
import { EFFECT_PRESETS } from '../../state/store';

const g = aoiGrid();
const baseline: WaterBaseline = { grid: g, occurrence: syntheticOccurrence(g.cols, g.rows), source: 'synthetic', note: 'test' };
const options = { ...DEFAULT_FLOOD_OPTIONS, source: 'demo' as const };
const data = runFloodPipeline(baseline, demoWaterScenes(baseline, DEMO_SCENES), options);
// The longest-lived region in the demo flood.
const track = Object.values(data.tracks).sort((a, b) => b.history.length - a.history.length)[0];
const props = (index: number, onIndex = vi.fn()) => ({
  data, observations: data.frames.map((f) => f.obs), index, effects: EFFECT_PRESETS.clean, layers: {}, selectedId: track.id,
  reducedMotion: false, options, onClose: () => {}, onIndex,
});

describe('flood region video frames', () => {
  const { frames, notImaged, notDetected } = videoFrames(data, track.id);
  const win = trackWindow(data, track.id)!;

  it('keeps only observations that imaged the region’s area and detected it, in time order', () => {
    expect(frames.length + notImaged + notDetected).toBe(data.frames.length);
    for (const f of frames) expect(windowCoverage(data, f.index, win)).toBeGreaterThanOrEqual(MIN_WINDOW_COVERAGE);
    for (let i = 1; i < frames.length; i++) expect(frames[i].time).toBeGreaterThan(frames[i - 1].time);
  });

  it('every frame shows the region, with its real area and the change since the previous frame', () => {
    frames.forEach((f, i) => {
      const blob = data.frames[f.index].blobs.find((b) => b.trackId === track.id);
      expect(blob).toBeDefined();
      expect(f.areaKm2).toBe(blob!.areaKm2);
      expect(f.deltaKm2).toBe(i === 0 ? null : f.areaKm2 - frames[i - 1].areaKm2);
    });
  });
});

describe('FloodPopup (flood region video)', () => {
  it('shows the region on the current frame with its date and area, and the skipped count', () => {
    const at = videoFrames(data, track.id).frames[0];
    render(<FloodPopup {...props(at.index)} />);
    expect(screen.getByText(new RegExp(`${track.id} · potential flood region`))).toBeInTheDocument();
    expect(screen.getByText(/DEMO data/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: new RegExp(`${track.id} on`) })).toBeInTheDocument();
    expect(screen.getByText(/observations? with this region/)).toBeInTheDocument();
  });

  it('scrubs the video and moves the main timeline only on "Show on map"', () => {
    const onIndex = vi.fn();
    render(<FloodPopup {...props(0, onIndex)} />);
    const { frames } = videoFrames(data, track.id);
    fireEvent.change(screen.getByRole('slider', { name: 'Observation' }), { target: { value: String(frames.length - 1) } });
    expect(onIndex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show on map' }));
    expect(onIndex).toHaveBeenCalledWith(frames[frames.length - 1].index);
  });
});
