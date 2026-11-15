/**
 * Pixel recolouring for tile layers that the app draws itself (see overlayAdapter).
 *
 * 'bare-pink': NASA GIBS NDVI tiles use one ramp from brown (no vegetation) through tan and
 * off-white (sparse) to greens (dense). Every colour where red outweighs green is the low-vegetation
 * end; those become pink, deeper for the browner (barer) colours. Greens and transparency are kept.
 */
export type Recolor = 'bare-pink';

const DEEP: readonly [number, number, number] = [219, 39, 119];
const LIGHT: readonly [number, number, number] = [251, 207, 232];
/** r − g of the darkest brown in the GIBS NDVI ramp. */
const DARKEST = 60;

export function barePink(r: number, g: number, b: number): [number, number, number] | null {
  if (r <= g) return null; // vegetation: keep NASA's colour
  const s = Math.min(1, (r - g) / DARKEST);
  const mix = (i: number) => Math.round(LIGHT[i] + (DEEP[i] - LIGHT[i]) * s);
  void b;
  return [mix(0), mix(1), mix(2)];
}

/** Recolours RGBA pixels in place. */
export function recolorPixels(px: Uint8ClampedArray, mode: Recolor): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const out = mode === 'bare-pink' ? barePink(px[i], px[i + 1], px[i + 2]) : null;
    if (out) {
      px[i] = out[0];
      px[i + 1] = out[1];
      px[i + 2] = out[2];
    }
  }
}
