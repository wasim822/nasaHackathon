import L from 'leaflet';
import { OverlayAdapter, PANE_Z } from './overlayAdapter';
import type { CircleOverlay, OverlaySpec } from '../../types';

function makeMap() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  document.body.appendChild(el);
  const map = L.map(el, { center: [38.6, -90.2], zoom: 7 });
  for (const p of Object.keys(PANE_Z)) map.createPane(p);
  return map;
}

const specs: OverlaySpec[] = [
  { kind: 'rect', id: 'box-F-001', pane: 'effects', bounds: { south: 38, west: -91, north: 39, east: -90 }, color: '#6ee7b7', weight: 1, opacity: 0.8, label: 'F-001', selectId: 'F-001' },
  { kind: 'circle', id: 'c1', pane: 'effects', center: [38.5, -90.5], radiusPx: 4, color: '#f00', fillOpacity: 0.8 },
  { kind: 'polyline', id: 't1', pane: 'effects', points: [[38, -91], [38.5, -90.5]], color: '#fb0', weight: 1, opacity: 0.5 },
];

describe('OverlayAdapter', () => {
  it('adds, updates by id, and fully releases overlays (filter teardown)', () => {
    const map = makeMap();
    // Count overlay layers only; Leaflet keeps per-pane renderers, which are not overlays.
    const count = () => {
      let n = 0;
      map.eachLayer((l) => {
        if (!(l instanceof L.Renderer)) n++;
      });
      return n;
    };
    const before = count();
    const a = new OverlayAdapter(map, () => {});
    a.update(specs, 0);
    expect(a.ids().sort()).toEqual(['box-F-001', 'c1', 't1']);
    a.update([specs[0]], 0);
    expect(a.ids()).toEqual(['box-F-001']);
    a.update([], 0);
    expect(a.size).toBe(0);
    expect(count()).toBe(before);
    a.destroy();
    map.remove();
  });

  it('routes clicks on selectable overlays to onSelect', () => {
    const map = makeMap();
    const onSelect = vi.fn();
    const a = new OverlayAdapter(map, onSelect);
    const circle = specs[1] as CircleOverlay;
    a.update([circle, { ...circle, id: 'c2', selectId: 'EV-1' }], 0);
    let fired = false;
    map.eachLayer((l) => {
      if (l instanceof L.CircleMarker && (l.getLatLng().lat === 38.5) && !fired && l.listens('click')) {
        l.fire('click', { latlng: l.getLatLng(), originalEvent: new MouseEvent('click') });
        fired = true;
      }
    });
    expect(onSelect).toHaveBeenCalledWith('EV-1');
    a.destroy();
    map.remove();
  });
});
