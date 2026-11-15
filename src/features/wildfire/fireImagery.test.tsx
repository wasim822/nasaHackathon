import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FIRE_SENSORS, boxAround, snapshotUrl, worldviewUrl } from './gibsSnapshots';
import { FireImagery } from './FireImagery';

const at: [number, number] = [37.6, -119.6];
const day = Date.UTC(2026, 8, 16, 18, 30); // mid-day; must snap to the UTC day

describe('GIBS snapshot URLs', () => {
  it('requests the right day, layers and lat,lon bbox', () => {
    const u = new URL(snapshotUrl({ at, day, sensor: FIRE_SENSORS[0], hotspots: true, halfLatDeg: 0.4, height: 300 }));
    expect(u.searchParams.get('TIME')).toBe('2026-09-16');
    expect(u.searchParams.get('LAYERS')).toBe('VIIRS_NOAA20_CorrectedReflectance_TrueColor,VIIRS_NOAA20_Thermal_Anomalies_375m_All');
    const [s, w, n, e] = u.searchParams.get('BBOX')!.split(',').map(Number);
    expect(s).toBeCloseTo(37.2);
    expect(n).toBeCloseTo(38.0);
    expect(w).toBeLessThan(-119.6);
    expect(e).toBeGreaterThan(-119.6);
    // Box is widened in longitude so it is roughly square on the ground; image keeps that aspect.
    expect(Number(u.searchParams.get('WIDTH'))).toBeGreaterThan(300);
  });

  it('omits hotspots when turned off and links Worldview for the same day', () => {
    const u = new URL(snapshotUrl({ at, day, sensor: FIRE_SENSORS[3], hotspots: false, halfLatDeg: 0.2, height: 200 }));
    expect(u.searchParams.get('LAYERS')).toBe('MODIS_Terra_CorrectedReflectance_TrueColor');
    expect(worldviewUrl(at, day, FIRE_SENSORS[0], 0.2)).toContain('t=2026-09-16');
    const b = boxAround(at, 0.2);
    expect(b.east - b.west).toBeGreaterThan(b.north - b.south);
  });
});

describe('FireImagery panel', () => {
  it('shows real-day picks around the reports and steps by one day', () => {
    const first = Date.UTC(2026, 8, 10, 4);
    const last = Date.UTC(2026, 8, 15, 22);
    render(<FireImagery at={at} firstReport={first} lastReport={last} timelineDay={last} />);
    expect(screen.getByRole('button', { name: /Day before first report/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /First report/ })).toBeInTheDocument();
    const img = () => new URL(screen.getByRole('img').getAttribute('src')!);
    expect(img().searchParams.get('TIME')).toBe('2026-09-15');
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(img().searchParams.get('TIME')).toBe('2026-09-14');
    fireEvent.click(screen.getByRole('button', { name: /Day before first report/ }));
    expect(img().searchParams.get('TIME')).toBe('2026-09-09');
    fireEvent.click(screen.getByRole('checkbox', { name: /Thermal hotspots/ }));
    expect(img().searchParams.get('LAYERS')).not.toContain('Thermal');
  });
});

describe('FirePopup', async () => {
  const { FirePopup } = await import('./FirePopup');
  const r1 = { eventId: 'E1', time: Date.UTC(2026, 8, 10, 4), at: [37.5, -119.5] as [number, number], size: 100, sizeUnit: 'acres' };
  const r2 = { eventId: 'E1', time: Date.UTC(2026, 8, 14, 20), at: [37.6, -119.6] as [number, number], size: 900, sizeUnit: 'acres' };
  const data = { events: { E1: { id: 'E1', title: 'Wildfire DOME', sources: [], closed: null, link: '', reports: [r1, r2] } }, reports: [r1, r2], days: [] };
  const effects = { mode: 'clean', boundingBoxes: true, trackingIds: true, trails: true, centroids: false, trailLength: 4, highlightSelected: true, highlightChanges: false } as const;
  const props = (dayTime: number) => ({
    data, observations: [{ id: 'd', time: dayTime, kind: 'report' as const }], index: 0, effects, layers: {}, selectedId: 'E1',
    reducedMotion: false, options: { trailingDays: 7 },
  });

  it('shows the timeline day at the latest report up to that day, and closes via ✕', () => {
    let closed = false;
    render(<FirePopup {...props(Date.UTC(2026, 8, 12))} onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Timeline day' }));
    const u = new URL(screen.getByRole('img').getAttribute('src')!);
    expect(u.searchParams.get('TIME')).toBe('2026-09-12');
    // Centred on the 09-10 report (the 09-14 one hadn't happened yet on 09-12).
    const [s, , n] = u.searchParams.get('BBOX')!.split(',').map(Number);
    expect((s + n) / 2).toBeCloseTo(37.5);
    expect(u.searchParams.get('LAYERS')).toContain('Thermal_Anomalies');
    fireEvent.click(screen.getByRole('button', { name: 'Close satellite image' }));
    expect(closed).toBe(true);
  });

  it('opens on a before/after slider around the first report', () => {
    render(<FirePopup {...props(Date.UTC(2026, 8, 12))} onClose={() => {}} />);
    const imgs = screen.getAllByRole('img');
    expect(imgs.map((i) => new URL(i.getAttribute('src')!).searchParams.get('TIME'))).toEqual(['2026-09-09', '2026-09-10']);
    imgs.forEach((i) => fireEvent.load(i));
    const slider = screen.getByRole('slider', { name: 'Compare before and after' });
    fireEvent.change(slider, { target: { value: '20' } });
    expect(imgs[1].style.clipPath).toBe('inset(0 0 0 20%)');
  });

  it('renders nothing for an unknown selection', () => {
    const { container } = render(<FirePopup {...props(Date.UTC(2026, 8, 12))} selectedId="nope" onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
