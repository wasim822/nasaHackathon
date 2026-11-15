import L from 'leaflet';
import type {
  CircleOverlay,
  GeoBounds,
  ImageOverlay,
  LatLng,
  OverlayPane,
  OverlaySpec,
  PolygonOverlay,
  PolylineOverlay,
  RectOverlay,
  TileOverlay,
} from '../../types';

export const PANE_Z: Record<OverlayPane, number> = { radar: 320, reference: 350, data: 410, effects: 440, labels: 470 };

const toLB = (b: GeoBounds) => L.latLngBounds([b.south, b.west], [b.north, b.east]);

interface Entry {
  spec: OverlaySpec;
  layer: L.Layer;
  label?: L.Marker;
  anim?: () => void;
}

/** Cancellable rAF tween; duration 0 applies immediately. */
function tween(duration: number, step: (k: number) => void, done?: () => void): () => void {
  if (duration <= 0 || typeof requestAnimationFrame === 'undefined') {
    step(1);
    done?.();
    return () => {};
  }
  let raf = 0;
  const t0 = performance.now();
  const frame = (now: number) => {
    const k = Math.min(1, (now - t0) / duration);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
    step(e);
    if (k < 1) raf = requestAnimationFrame(frame);
    else done?.();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Renders declarative overlay specs onto a Leaflet map, diffing by id. Keeps the map
 * library out of filters and keeps geometry anchored geographically during pan/zoom.
 */
export class OverlayAdapter {
  private entries = new Map<string, Entry>();
  private map: L.Map;
  private onSelect: (id: string) => void;
  private durationMs = 400;

  constructor(map: L.Map, onSelect: (id: string) => void) {
    this.map = map;
    this.onSelect = onSelect;
    map.on('zoomend moveend', this.layoutLabels, this);
  }

  get size(): number {
    return this.entries.size;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  update(specs: OverlaySpec[], durationMs: number): void {
    this.durationMs = durationMs;
    const next = new Map(specs.map((s) => [s.id, s]));
    for (const [id, entry] of this.entries) {
      if (!next.has(id)) this.remove(id, entry);
    }
    for (const spec of specs) {
      const existing = this.entries.get(spec.id);
      if (existing && existing.spec.kind === spec.kind) this.patch(existing, spec);
      else {
        if (existing) this.remove(spec.id, existing, true);
        this.add(spec);
      }
    }
    this.layoutLabels();
  }

  clear(): void {
    for (const [id, entry] of this.entries) this.remove(id, entry, true);
  }

  destroy(): void {
    this.clear();
    this.map.off('zoomend moveend', this.layoutLabels, this);
  }

  // ------------------------------------------------------------------

  private bindSelect(layer: L.Layer, id?: string) {
    if (!id) return;
    layer.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      this.onSelect(id);
    });
  }

  private add(spec: OverlaySpec) {
    const d = this.durationMs;
    switch (spec.kind) {
      case 'tile': {
        const s = spec as TileOverlay;
        const layer = s.wms
          ? L.tileLayer.wms(s.url, {
              pane: s.pane, opacity: s.opacity, attribution: s.attribution, crossOrigin: true,
              layers: s.wms.layers, format: 'image/png', transparent: true, version: '1.3.0', uppercase: true, ...s.wms.params,
            })
          : L.tileLayer(s.url, { pane: s.pane, opacity: s.opacity, attribution: s.attribution, maxNativeZoom: s.maxNativeZoom, crossOrigin: true });
        layer.addTo(this.map);
        this.entries.set(s.id, { spec, layer });
        break;
      }
      case 'image': {
        const s = spec as ImageOverlay;
        if (!s.url) return;
        const layer = L.imageOverlay(s.url, toLB(s.bounds), { pane: s.pane, opacity: 0, className: s.pixelated ? 'pixelated' : '', interactive: false });
        layer.addTo(this.map);
        const entry: Entry = { spec, layer };
        entry.anim = tween(d, (k) => layer.setOpacity(s.opacity * k));
        this.entries.set(s.id, entry);
        break;
      }
      case 'rect': {
        const s = spec as RectOverlay;
        const layer = L.rectangle(toLB(s.bounds), {
          pane: s.pane, color: s.color, weight: s.weight, opacity: 0, fill: false, className: s.glow ? 'box-glow' : 'box', interactive: !!s.selectId && s.opacity > 0,
        });
        layer.addTo(this.map);
        this.bindSelect(layer, s.selectId);
        const entry: Entry = { spec, layer };
        if (s.label) entry.label = this.makeLabel(s);
        entry.anim = tween(d, (k) => layer.setStyle({ opacity: s.opacity * k }));
        this.emphasize(layer, s.emphasis);
        this.entries.set(s.id, entry);
        break;
      }
      case 'circle': {
        const s = spec as CircleOverlay;
        const layer = L.circleMarker(s.center, {
          pane: s.pane, radius: s.radiusPx, color: s.color, fillColor: s.color, fillOpacity: s.fillOpacity, opacity: s.strokeOpacity ?? 1, weight: s.weight ?? 1, bubblingMouseEvents: false,
        });
        if (s.tooltip) {
          layer.bindTooltip(s.tooltip, {
            direction: 'top', offset: [0, -s.radiusPx], className: s.tooltipPermanent ? 'map-tip locator-tip' : 'map-tip',
            permanent: !!s.tooltipPermanent, interactive: !!(s.tooltipPermanent && s.selectId),
          });
          // A permanent label is part of the marker, so clicking it selects too.
          if (s.tooltipPermanent) this.bindSelect(layer.getTooltip()!, s.selectId);
        }
        layer.addTo(this.map);
        this.bindSelect(layer, s.selectId);
        if (s.pulse) this.pulse(s);
        this.entries.set(s.id, { spec, layer });
        break;
      }
      case 'polygon': {
        const s = spec as PolygonOverlay;
        const filled = s.fillOpacity > 0;
        const layer = L.polygon(s.rings, {
          pane: s.pane, color: s.color, weight: s.weight, opacity: s.opacity, dashArray: s.dashArray,
          fill: filled, fillColor: s.fillColor ?? s.color, fillOpacity: s.fillOpacity, interactive: !!s.selectId, bubblingMouseEvents: false,
        });
        if (s.tooltip) layer.bindTooltip(s.tooltip, { sticky: true, className: 'map-tip' });
        layer.addTo(this.map);
        this.bindSelect(layer, s.selectId);
        this.entries.set(s.id, { spec, layer });
        break;
      }
      case 'polyline': {
        const s = spec as PolylineOverlay;
        const layer = L.polyline(s.points, { pane: s.pane, color: s.color, weight: s.weight, opacity: s.opacity, lineCap: 'round', interactive: false });
        layer.addTo(this.map);
        if (s.draw && d > 0) this.drawIn(layer, d * 1.6);
        this.entries.set(s.id, { spec, layer });
        break;
      }
    }
  }

  private patch(entry: Entry, spec: OverlaySpec) {
    const prev = entry.spec;
    entry.spec = spec;
    entry.anim?.();
    const d = this.durationMs;
    switch (spec.kind) {
      case 'tile': {
        (entry.layer as L.TileLayer).setOpacity(spec.opacity);
        break;
      }
      case 'image': {
        const layer = entry.layer as L.ImageOverlay;
        if ((prev as ImageOverlay).url !== spec.url) layer.setUrl(spec.url);
        layer.setBounds(toLB(spec.bounds));
        layer.setOpacity(spec.opacity);
        break;
      }
      case 'rect': {
        const layer = entry.layer as L.Rectangle;
        const a = (prev as RectOverlay).bounds;
        const b = spec.bounds;
        const fromOpacity = (prev as RectOverlay).opacity;
        layer.setStyle({ color: spec.color, weight: spec.weight });
        const el = layer.getElement();
        if (el) el.setAttribute('class', `leaflet-interactive ${spec.glow ? 'box-glow' : 'box'}`);
        // Boxes transition between measured extents of consecutive observations.
        entry.anim = tween(d, (k) => {
          const cur = { south: lerp(a.south, b.south, k), north: lerp(a.north, b.north, k), west: lerp(a.west, b.west, k), east: lerp(a.east, b.east, k) };
          layer.setBounds(toLB(cur));
          layer.setStyle({ opacity: lerp(fromOpacity, spec.opacity, k) });
          entry.label?.setLatLng([cur.north, cur.west]);
        });
        if (spec.label && !entry.label) entry.label = this.makeLabel(spec);
        else if (!spec.label && entry.label) {
          entry.label.remove();
          entry.label = undefined;
        } else if (entry.label && spec.label !== (prev as RectOverlay).label) {
          const el2 = entry.label.getElement();
          if (el2) el2.querySelector('span')!.textContent = spec.label!;
        }
        this.emphasize(layer, spec.emphasis);
        break;
      }
      case 'circle': {
        const layer = entry.layer as L.CircleMarker;
        const from = (prev as CircleOverlay).center;
        const to = spec.center;
        layer.setStyle({ color: spec.color, fillColor: spec.color, fillOpacity: spec.fillOpacity, opacity: spec.strokeOpacity ?? 1, weight: spec.weight ?? 1 });
        layer.setRadius(spec.radiusPx);
        if (spec.tooltip) layer.setTooltipContent(spec.tooltip);
        if (from[0] !== to[0] || from[1] !== to[1]) {
          entry.anim = tween(d, (k) => layer.setLatLng([lerp(from[0], to[0], k), lerp(from[1], to[1], k)] as LatLng));
        }
        if (spec.pulse && !(prev as CircleOverlay).pulse) this.pulse(spec);
        if (spec.pane !== prev.pane) {
          // Pane changes require re-adding.
          layer.remove();
          (layer.options as L.PathOptions).pane = spec.pane;
          layer.addTo(this.map);
        }
        break;
      }
      case 'polygon': {
        const layer = entry.layer as L.Polygon;
        layer.setLatLngs(spec.rings);
        layer.setStyle({ color: spec.color, weight: spec.weight, opacity: spec.opacity, dashArray: spec.dashArray, fillColor: spec.fillColor ?? spec.color, fillOpacity: spec.fillOpacity });
        if (spec.tooltip) layer.setTooltipContent(spec.tooltip);
        break;
      }
      case 'polyline': {
        const layer = entry.layer as L.Polyline;
        layer.setLatLngs(spec.points);
        layer.setStyle({ color: spec.color, weight: spec.weight, opacity: spec.opacity });
        break;
      }
    }
  }

  private remove(id: string, entry: Entry, immediate = false) {
    entry.anim?.();
    this.entries.delete(id);
    entry.label?.remove();
    const layer = entry.layer;
    const d = immediate ? 0 : this.durationMs;
    if (entry.spec.kind === 'image' && d > 0) {
      const img = layer as L.ImageOverlay;
      const start = (entry.spec as ImageOverlay).opacity;
      tween(d, (k) => img.setOpacity(start * (1 - k)), () => img.remove());
    } else if (entry.spec.kind === 'rect' && d > 0) {
      const r = layer as L.Rectangle;
      const start = (entry.spec as RectOverlay).opacity;
      tween(d * 0.7, (k) => r.setStyle({ opacity: start * (1 - k) }), () => r.remove());
    } else {
      layer.remove();
    }
  }

  private makeLabel(s: RectOverlay): L.Marker {
    const icon = L.divIcon({ className: 'box-label', html: `<span>${escapeHtml(s.label!)}</span>`, iconSize: undefined, iconAnchor: [0, 18] });
    const m = L.marker([s.bounds.north, s.bounds.west], { icon, pane: 'labels', interactive: !!s.selectId, keyboard: false });
    if (s.selectId) {
      const id = s.selectId;
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.onSelect(id);
      });
    }
    m.addTo(this.map);
    return m;
  }

  /** Hides tiny boxes, labels on tiny boxes, and overlapping labels (higher priority wins). */
  private layoutLabels() {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const rects: { entry: Entry; spec: RectOverlay; w: number; h: number; p: L.Point }[] = [];
    for (const entry of this.entries.values()) {
      if (entry.spec.kind !== 'rect') continue;
      const s = entry.spec;
      const nw = this.map.latLngToContainerPoint([s.bounds.north, s.bounds.west]);
      const se = this.map.latLngToContainerPoint([s.bounds.south, s.bounds.east]);
      rects.push({ entry, spec: s, w: Math.abs(se.x - nw.x), h: Math.abs(se.y - nw.y), p: nw });
    }
    for (const r of rects) {
      // Deprioritise tiny regions at low zoom (selected boxes are drawn heavier and always kept).
      const el = (r.entry.layer as L.Rectangle).getElement() as SVGElement | undefined;
      const tiny = r.w < 5 && r.h < 5 && r.spec.weight < 2;
      if (el) el.style.display = tiny ? 'none' : '';
    }
    rects.sort((a, b) => (b.spec.priority ?? b.w * b.h) - (a.spec.priority ?? a.w * a.h));
    for (const r of rects) {
      const label = r.entry.label?.getElement();
      if (!label) continue;
      const lw = (r.spec.label?.length ?? 0) * 6.2 + 10;
      const box = { x0: r.p.x, y0: r.p.y - 18, x1: r.p.x + lw, y1: r.p.y };
      const tooSmall = !r.spec.labelAlways && r.w < 22 && r.spec.weight < 2;
      const overlaps = placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0);
      const hide = tooSmall || overlaps;
      label.style.visibility = hide ? 'hidden' : 'visible';
      if (!hide) placed.push(box);
    }
  }

  private emphasize(layer: L.Path, kind: RectOverlay['emphasis']) {
    if (!kind) return;
    const el = layer.getElement();
    if (!el) return;
    const cls = kind === 'appear' ? 'emph-appear' : 'emph-change';
    el.classList.remove('emph-appear', 'emph-change');
    // Force reflow so the one-shot animation restarts.
    void (el as SVGElement).getBoundingClientRect();
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1200);
  }

  /** One-shot expanding ring (never continuous flashing). */
  private pulse(s: CircleOverlay) {
    const ring = L.circleMarker(s.center, {
      pane: s.pane, radius: s.radiusPx, color: s.color, weight: s.pulse === 'strong' ? 2 : 1.2, fill: false, interactive: false, opacity: 0.9,
    });
    ring.addTo(this.map);
    const maxR = s.radiusPx * (s.pulse === 'strong' ? 4 : 2.6);
    tween(s.pulse === 'strong' ? 1400 : 1000, (k) => {
      ring.setRadius(lerp(s.radiusPx, maxR, k));
      ring.setStyle({ opacity: 0.9 * (1 - k) });
    }, () => ring.remove());
  }

  private drawIn(layer: L.Polyline, duration: number) {
    const el = layer.getElement() as SVGPathElement | undefined;
    if (!el || typeof el.getTotalLength !== 'function') return;
    const len = el.getTotalLength();
    if (!len) return;
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    tween(duration, (k) => {
      el.style.strokeDashoffset = `${len * (1 - k)}`;
    }, () => {
      el.style.strokeDasharray = '';
      el.style.strokeDashoffset = '';
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
