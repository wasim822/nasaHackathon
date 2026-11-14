import '@testing-library/jest-dom/vitest';

// jsdom lacks canvas; image generation degrades to empty strings in tests.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];

if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Leaflet decides SVG support at import time; jsdom lacks createSVGRect.
(SVGElement.prototype as unknown as { createSVGRect: () => object }).createSVGRect = () => ({});
(SVGElement.prototype as unknown as { getBBox: () => object }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
