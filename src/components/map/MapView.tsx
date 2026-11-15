import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoBounds, LatLng, OverlaySpec } from '../../types';
import { OverlayAdapter, PANE_Z } from './overlayAdapter';
import { REGION_VIEW } from '../../services/geospatial/region';
import type { BaseLayerId } from '../../state/store';

const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export interface MapViewProps {
  overlays: OverlaySpec[];
  transitionMs: number;
  baseLayer: BaseLayerId;
  showLabels: boolean;
  fitBounds: GeoBounds | null;
  fitRequest: number;
  reducedMotion: boolean;
  onSelect(id: string): void;
  onMapClick(at: LatLng): void;
  onViewChange?(bounds: GeoBounds, zoom: number): void;
  /** The user started dragging or zooming (not programmatic resize/pan). */
  onUserMove?(): void;
}

export function MapView(props: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const adapterRef = useRef<OverlayAdapter | null>(null);
  const labelsRef = useRef<L.TileLayer | null>(null);
  // Latest callbacks without re-creating the map.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, {
      center: REGION_VIEW.center,
      zoom: REGION_VIEW.zoom,
      minZoom: 2,
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: true,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>');
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ position: 'bottomright', imperial: true }).addTo(map);
    for (const [name, z] of Object.entries(PANE_Z)) {
      const pane = map.createPane(name);
      pane.style.zIndex = String(z);
    }
    L.tileLayer(ESRI_IMAGERY, { attribution: ESRI_ATTRIBUTION, maxZoom: 19, maxNativeZoom: 18 }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => cb.current.onMapClick([e.latlng.lat, e.latlng.lng]));
    const reportView = () => {
      const b = map.getBounds();
      cb.current.onViewChange?.({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, map.getZoom());
    };
    map.on('moveend', reportView);
    // Not 'movestart': container resizes (drawers opening) also fire it.
    map.on('dragstart zoomstart', () => cb.current.onUserMove?.());
    map.whenReady(reportView);
    mapRef.current = map;
    adapterRef.current = new OverlayAdapter(map, (id) => cb.current.onSelect(id));
    // Expose for debugging / automated checks.
    (window as unknown as { __ecMap?: L.Map }).__ecMap = map;
    return () => {
      adapterRef.current?.destroy();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    adapterRef.current?.update(props.overlays, props.transitionMs);
  }, [props.overlays, props.transitionMs]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getContainer().classList.toggle('muted-base', props.baseLayer === 'satellite-muted');
  }, [props.baseLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (props.showLabels && !labelsRef.current) {
      labelsRef.current = L.tileLayer(ESRI_LABELS, { pane: 'labels', attribution: 'Labels © Esri', maxNativeZoom: 18 }).addTo(map);
    } else if (!props.showLabels && labelsRef.current) {
      labelsRef.current.remove();
      labelsRef.current = null;
    }
  }, [props.showLabels]);

  useEffect(() => {
    const map = mapRef.current;
    const b = props.fitBounds;
    if (!map || !b || props.fitRequest === 0) return;
    map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [40, 40], animate: !props.reducedMotion, maxZoom: 10 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitRequest]);

  // Leaflet must know when the container resizes (drawers, mobile rotation).
  useEffect(() => {
    if (!el.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => mapRef.current?.invalidateSize({ pan: false }));
    ro.observe(el.current);
    return () => ro.disconnect();
  }, []);

  return <div ref={el} className="map" role="region" aria-label="Satellite map" />;
}
