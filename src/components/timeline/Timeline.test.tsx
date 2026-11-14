import { fireEvent, render, screen } from '@testing-library/react';
import { Timeline, type TimelineProps } from './Timeline';
import type { Observation } from '../../types';

const U = (iso: string) => Date.parse(iso);
const observations: Observation[] = [
  { id: 'a', time: U('2026-03-04T23:52:22Z'), kind: 'demo-observed' },
  { id: 'b', time: U('2026-03-16T23:52:25Z'), kind: 'demo-observed' },
  { id: 'c', time: U('2026-04-21T23:52:21Z'), kind: 'demo-observed' },
];

function setup(over: Partial<TimelineProps> = {}) {
  const props: TimelineProps = {
    range: { start: U('2026-03-01T00:00:00Z'), end: U('2026-05-01T00:00:00Z') },
    now: U('2026-11-14T00:00:00Z'),
    observations,
    currentIndex: 0,
    playing: false,
    speed: 1,
    loop: false,
    loadState: 'ready',
    events: [],
    chart: null,
    cadenceMs: 12 * 864e5,
    filterActive: true,
    onRangeChange: vi.fn(),
    onIndex: vi.fn(),
    onStep: vi.fn(),
    onPlayPause: vi.fn(),
    onPause: vi.fn(),
    onSpeed: vi.fn(),
    onLoop: vi.fn(),
    ...over,
  };
  render(<Timeline {...props} />);
  return props;
}

describe('Timeline', () => {
  it('always renders exactly ten major ticks', () => {
    setup();
    expect(screen.getAllByTestId('major-tick')).toHaveLength(10);
  });

  it('renders ten ticks for a zero-duration range', () => {
    const t = U('2026-03-04T00:00:00Z');
    setup({ range: { start: t, end: t } });
    expect(screen.getAllByTestId('major-tick')).toHaveLength(10);
  });

  it('steps by observation and exposes speed choices', () => {
    const p = setup();
    fireEvent.click(screen.getByLabelText('Next observation'));
    expect(p.onStep).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByLabelText('Play'));
    expect(p.onPlayPause).toHaveBeenCalled();
    const speed = screen.getByLabelText('Playback speed') as HTMLSelectElement;
    expect([...speed.options].map((o) => o.textContent)).toEqual(['0.5×', '1×', '2×', '4×']);
    fireEvent.change(speed, { target: { value: '4' } });
    expect(p.onSpeed).toHaveBeenCalledWith(4);
  });

  it('shows the current frame as a DEMO scene, not as Observed', () => {
    setup();
    expect(screen.getByText('DEMO scene')).toBeInTheDocument();
    expect(screen.getByText(/frame 1 of 3/)).toBeInTheDocument();
  });

  it('keyboard arrows on the scrubber step observations', () => {
    const p = setup();
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(p.onStep).toHaveBeenCalledWith(1);
  });

  it('shows a truthful message when there are no observations', () => {
    setup({ observations: [], currentIndex: -1, loadState: 'empty' });
    expect(screen.getAllByText('No observations in this date range').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Play')).toBeDisabled();
  });

  it('range picker rejects end-before-start', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /Mar 1 – May 1, 2026/ }));
    const start = screen.getByLabelText('Start');
    const end = screen.getByLabelText('End');
    fireEvent.change(start, { target: { value: '2026-04-10T00:00' } });
    fireEvent.change(end, { target: { value: '2026-04-01T00:00' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/End must not be earlier/);
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.change(end, { target: { value: '2026-04-20T00:00' } });
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);
    expect(p.onRangeChange).toHaveBeenCalledWith({ start: U('2026-04-10T00:00:00Z'), end: U('2026-04-20T00:00:00Z') });
  });
});
