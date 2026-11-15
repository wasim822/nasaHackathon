import { describe, expect, it } from 'vitest';
import { LOCATOR_MIN_PX, LOCATOR_SELECT_ID, locatorOverlay, spanPx } from './locator';

// ~2.1° wide study area, like the flood AOI (three zoom-9 tiles).
const aoi = { south: 38.0, west: -91.4, north: 39.6, east: -89.3 };

describe('zoomed-out locator', () => {
  it('appears when the data area is too small to see, centred on it, and zooms on click', () => {
    const o = locatorOverlay(aoi, 3, 'Flood', false)!;
    expect(o).not.toBeNull();
    expect(o.center[0]).toBeCloseTo(38.8);
    expect(o.center[1]).toBeCloseTo(-90.35);
    expect(o.selectId).toBe(LOCATOR_SELECT_ID);
    expect(o.tooltip).toContain('Flood');
    expect(o.tooltipPermanent).toBe(true);
  });

  it('disappears once the data is large enough on screen', () => {
    const z = [3, 4, 5, 6, 7, 8].find((zoom) => spanPx(aoi, zoom) >= LOCATOR_MIN_PX)!;
    expect(locatorOverlay(aoi, z - 1, 'Flood', false)).not.toBeNull();
    expect(locatorOverlay(aoi, z, 'Flood', false)).toBeNull();
  });

  it('is skipped for wide extents and missing data, and does not pulse with reduced motion', () => {
    expect(locatorOverlay({ south: 25, west: -125, north: 60, east: -60 }, 3, 'Earthquake', false)).toBeNull();
    expect(locatorOverlay(null, 3, 'Flood', false)).toBeNull();
    expect(locatorOverlay(aoi, 3, 'Flood', true)!.pulse).toBeNull();
  });
});

describe('auto-fit on load', async () => {
  const { shouldAutoFit } = await import('./locator');
  const continent = { south: 15, west: -140, north: 70, east: -50 };
  it('moves to a compact area that is a speck or off-screen', () => {
    expect(shouldAutoFit(aoi, continent, 3)).toBe(true); // visible but tiny
    expect(shouldAutoFit(aoi, { south: 45, west: -125, north: 49, east: -120 }, 9)).toBe(true); // off-screen
    expect(shouldAutoFit(aoi, null, 3)).toBe(true);
  });
  it('keeps the user’s view when the area is already visible, and never jumps for wide extents', () => {
    expect(shouldAutoFit(aoi, { south: 37, west: -92, north: 40, east: -88 }, 8)).toBe(false);
    expect(shouldAutoFit({ south: 25, west: -125, north: 60, east: -60 }, { south: 0, west: 0, north: 1, east: 1 }, 3)).toBe(false);
    expect(shouldAutoFit(null, continent, 3)).toBe(false);
  });
});
