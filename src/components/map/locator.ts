import type { CircleOverlay, GeoBounds } from '../../types';

/** Overlay id selected when the user clicks the locator; App answers by zooming to the data. */
export const LOCATOR_SELECT_ID = 'locator:fit';

/** Show the locator when the data area would be narrower than this on screen. */
export const LOCATOR_MIN_PX = 60;
/** Only for compact study areas; continent-wide extents (e.g. catalog events) don't get one. */
const MAX_SPAN_DEG = 15;

/** Width in screen pixels of a longitude span at a Web-Mercator zoom level (256 px tiles). */
export function spanPx(bounds: GeoBounds, zoom: number): number {
  return ((bounds.east - bounds.west) / 360) * 256 * 2 ** zoom;
}

/**
 * Whether to move the map to a filter's data when it loads: only for compact study areas that
 * would otherwise be off-screen or a speck. Otherwise the user's view is kept.
 */
export function shouldAutoFit(extent: GeoBounds | null, view: GeoBounds | null, zoom: number): boolean {
  if (!extent) return false;
  if (extent.east - extent.west > MAX_SPAN_DEG || extent.north - extent.south > MAX_SPAN_DEG) return false;
  if (!view) return true;
  const visible = extent.west < view.east && extent.east > view.west && extent.south < view.north && extent.north > view.south;
  return !visible || spanPx(extent, zoom) < LOCATOR_MIN_PX;
}

/**
 * A ring marking where a filter's data is when the map is zoomed out so far that the data
 * itself is too small to notice. It's a navigation aid only: it marks the processed area,
 * not a detected hazard.
 */
export function locatorOverlay(
  extent: GeoBounds | null,
  zoom: number,
  label: string,
  reducedMotion: boolean,
): CircleOverlay | null {
  if (!extent) return null;
  if (extent.east - extent.west > MAX_SPAN_DEG || extent.north - extent.south > MAX_SPAN_DEG) return null;
  if (spanPx(extent, zoom) >= LOCATOR_MIN_PX) return null;
  return {
    kind: 'circle',
    id: 'locator',
    pane: 'labels',
    center: [(extent.north + extent.south) / 2, (extent.east + extent.west) / 2],
    radiusPx: 16,
    color: '#5eead4',
    fillOpacity: 0.18,
    strokeOpacity: 0.95,
    weight: 2,
    tooltip: `${label} data here · click to zoom in`,
    tooltipPermanent: true,
    selectId: LOCATOR_SELECT_ID,
    pulse: reducedMotion ? null : 'subtle',
  };
}
