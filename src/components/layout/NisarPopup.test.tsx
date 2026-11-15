import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NisarPopup } from './NisarPopup';
import { groupPasses, type NisarScene } from '../../services/data/nisar';

const scene = (id: string, t: number): NisarScene => ({
  id, stack: `76-Ascending-21`, time: t, start: t, end: t + 38_000, product: 'GCOV', status: 'Validated', footprint: [[38, -91], [39, -91], [39, -90], [38, -90]],
  track: 76, frame: 21, direction: 'Ascending', browseUrl: `https://example.test/${id}_LATLON.png`, thumbUrl: null, kmlUrl: null, earthdataUrl: 'https://search.earthdata.nasa.gov/x',
});
const passes = groupPasses([scene('a', Date.UTC(2026, 9, 17, 11, 4)), scene('b', Date.UTC(2026, 9, 29, 11, 4))]);

describe('NisarPopup', () => {
  it('shows the clicked strip’s browse image and acquisition details', () => {
    render(<NisarPopup content={{ kind: 'scene', pass: passes[1], scene: passes[1].scenes[0], isCurrent: true }} onClose={() => {}} onGoTo={() => {}} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://example.test/b_LATLON.png');
    expect(screen.getByText(/NISAR GCOV · Validated/)).toBeInTheDocument();
    expect(screen.getByText(/Ascending · track 76 · frame 21/)).toBeInTheDocument();
  });

  it('says there is no data, and offers real passes that do cover the spot', () => {
    const onGoTo = vi.fn();
    render(
      <NisarPopup
        content={{ kind: 'none', at: [38.5, -90.5], range: { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 14) }, elsewhere: [{ pass: passes[0], index: 0 }] }}
        onClose={() => {}}
        onGoTo={onGoTo}
      />,
    );
    expect(screen.getByText('No NISAR data available here')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /2026-10-17|Oct 17/ }));
    expect(onGoTo).toHaveBeenCalledWith(0);
  });

  it('says plainly when nothing covers the spot in the range', () => {
    render(<NisarPopup content={{ kind: 'none', at: [60, 10], range: { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 14) }, elsewhere: [] }} onClose={() => {}} onGoTo={() => {}} />);
    expect(screen.getByText(/No NISAR pass covering this spot was found between/)).toBeInTheDocument();
  });
});
