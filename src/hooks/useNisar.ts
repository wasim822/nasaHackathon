import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoBounds, OverlaySpec, TimeRange } from '../types';
import { type NisarPass, type NisarProduct, type NisarScene, groupPasses, searchNisar } from '../services/data/nisar';
import { type ProcessedImage, processSceneImage } from '../services/data/nisarImage';
import { fmtDate } from '../services/time/format';
import type { NisarStripMode } from '../state/store';

/** Radar images are downloaded and processed in the browser, so only when zoomed in. */
export const NISAR_IMAGE_MIN_ZOOM = 6;
/** CMR pages per collection (150 each). Newest first, so a cut drops the oldest passes. */
const MAX_PAGES = 4;
/** Earlier passes drawn in build-up mode (older ones are left out to keep the map responsive). */
const MAX_TRAIL_SCENES = 600;
/** Earlier passes whose already-loaded images stay on the map in build-up mode. */
const IMAGE_TRAIL_PASSES = 6;

export type NisarState = 'off' | 'loading' | 'ready' | 'error';

export interface UseNisarArgs {
  enabled: boolean;
  product: NisarProduct;
  view: GeoBounds | null;
  zoom: number;
  range: TimeRange;
  /** Index of the current pass (the timeline frame), or -1. */
  index: number;
  mode: NisarStripMode;
  opacity: number;
}

type ImageEntry = { status: 'loading' } | { status: 'ready'; image: ProcessedImage } | { status: 'error'; message: string };

const imageCache = new Map<string, ImageEntry>();
const MAX_CACHED = 40;

function rounded(b: GeoBounds, zoom: number): GeoBounds {
  // Snap the search box (coarser when zoomed out) so small pans don't trigger new searches.
  const step = zoom >= 6 ? 0.25 : zoom >= 4 ? 1 : 5;
  const r = (v: number, f: (x: number) => number) => f(v / step) * step;
  return { west: r(b.west, Math.floor), south: r(b.south, Math.floor), east: r(b.east, Math.ceil), north: r(b.north, Math.ceil) };
}

/** Real NISAR passes over the map view, as timeline frames, drawn as strips. */
export function useNisar(a: UseNisarArgs) {
  const [passes, setPasses] = useState<NisarPass[]>([]);
  const [state, setState] = useState<NisarState>('off');
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [version, bump] = useState(0);

  const box = a.enabled && a.view ? rounded(a.view, a.zoom) : null;
  const boxKey = box ? `${box.west},${box.south},${box.east},${box.north}` : '';

  // Search (debounced; stale requests cancelled).
  useEffect(() => {
    if (!a.enabled || !box) {
      setState('off');
      setPasses([]);
      return;
    }
    const ctrl = new AbortController();
    setState('loading');
    const timer = window.setTimeout(() => {
      setError(null);
      searchNisar(a.product, box, a.range, ctrl.signal, MAX_PAGES)
        .then((r) => {
          setPasses(groupPasses(r.scenes));
          setTruncated(r.truncated);
          setState('ready');
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.enabled, a.product, boxKey, a.range.start, a.range.end]);

  const current = a.index >= 0 ? passes[a.index] : undefined;
  const zoomedIn = a.zoom >= NISAR_IMAGE_MIN_ZOOM;

  // Images to load: the current pass, plus the next one so playback doesn't wait.
  const wantedRef = useRef<NisarScene[]>([]);
  const keepRef = useRef<Set<string>>(new Set());
  wantedRef.current = a.enabled && zoomedIn && current ? [...current.scenes, ...(passes[a.index + 1]?.scenes ?? [])] : [];
  keepRef.current = new Set([
    ...wantedRef.current.map((s) => s.id),
    ...passes.slice(Math.max(0, a.index - IMAGE_TRAIL_PASSES), a.index).flatMap((p) => p.scenes.map((s) => s.id)),
  ]);
  const wantedKey = wantedRef.current.map((s) => s.id).join('|');
  const loader = useRef<{ inflight: Map<string, AbortController> }>({ inflight: new Map() });
  useEffect(() => {
    const L = loader.current;
    const wanted = new Set(wantedRef.current.map((s) => s.id));
    for (const [id, ctrl] of L.inflight) {
      if (!wanted.has(id)) {
        ctrl.abort();
        L.inflight.delete(id);
        imageCache.delete(id);
      }
    }
    const pump = () => {
      for (const s of wantedRef.current) {
        if (L.inflight.size >= 3) break;
        if (imageCache.has(s.id)) continue;
        const ctrl = new AbortController();
        L.inflight.set(s.id, ctrl);
        imageCache.set(s.id, { status: 'loading' });
        processSceneImage(s, ctrl.signal)
          .then((image) => {
            if (!ctrl.signal.aborted) imageCache.set(s.id, { status: 'ready', image });
            else URL.revokeObjectURL(image.url);
          })
          .catch((e: unknown) => {
            if (ctrl.signal.aborted) imageCache.delete(s.id);
            else imageCache.set(s.id, { status: 'error', message: e instanceof Error ? e.message : String(e) });
          })
          .finally(() => {
            if (L.inflight.get(s.id) === ctrl) L.inflight.delete(s.id);
            evict(keepRef.current);
            bump((n) => n + 1);
            pump();
          });
      }
    };
    pump();
  }, [wantedKey]);

  // Cancel everything on unmount.
  useEffect(() => () => {
    for (const ctrl of loader.current.inflight.values()) ctrl.abort();
  }, []);

  const overlays: OverlaySpec[] = useMemo(() => {
    if (!a.enabled || !current) return [];
    const out: OverlaySpec[] = [];
    // Earlier passes (build-up): dim strips, newest last so they draw on top.
    if (a.mode === 'build') {
      const earlier = passes.slice(0, a.index);
      let budget = MAX_TRAIL_SCENES;
      const trail: NisarScene[] = [];
      for (let k = earlier.length - 1; k >= 0 && budget > 0; k--) {
        for (const s of earlier[k].scenes) {
          if (budget-- <= 0) break;
          trail.push(s);
        }
      }
      for (const s of trail.reverse()) {
        out.push({ kind: 'polygon', id: `nisar-fp-${s.id}`, pane: 'radar', rings: [s.footprint], color: '#a78bfa', weight: 0.8, opacity: 0.45, fillColor: '#7c3aed', fillOpacity: 0.08 });
      }
      if (zoomedIn) {
        for (const p of passes.slice(Math.max(0, a.index - IMAGE_TRAIL_PASSES), a.index)) {
          for (const s of p.scenes) {
            const e = imageCache.get(s.id);
            if (e?.status === 'ready') out.push({ kind: 'image', id: `nisar-img-${s.id}`, pane: 'radar', url: e.image.url, bounds: e.image.bounds, opacity: a.opacity * 0.55 });
          }
        }
      }
    }
    // Current pass: bright strip, with its radar image when zoomed in.
    for (const s of current.scenes) {
      const e = zoomedIn ? imageCache.get(s.id) : undefined;
      if (e?.status === 'ready') out.push({ kind: 'image', id: `nisar-img-${s.id}`, pane: 'radar', url: e.image.url, bounds: e.image.bounds, opacity: a.opacity });
      out.push({
        kind: 'polygon', id: `nisar-fp-${s.id}`, pane: 'radar', rings: [s.footprint], color: '#f0abfc', weight: 1.6, opacity: 0.95,
        fillColor: '#c084fc', fillOpacity: e?.status === 'ready' ? 0 : 0.22,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.enabled, a.mode, a.index, a.opacity, passes, zoomedIn, version]);

  const imageStatus = (id: string) => imageCache.get(id)?.status ?? null;

  return { state, error, passes, truncated, overlays, imageStatus, zoomedIn };
}

/** Drops the oldest cached images, never ones on screen or about to be. */
function evict(keep: Set<string>) {
  if (imageCache.size <= MAX_CACHED) return;
  for (const [id, e] of imageCache) {
    if (imageCache.size <= MAX_CACHED) break;
    if (e.status === 'loading' || keep.has(id)) continue;
    if (e.status === 'ready') URL.revokeObjectURL(e.image.url);
    imageCache.delete(id);
  }
}

export function sceneDateText(s: { product: NisarProduct; start: number; end: number }): string {
  return s.product === 'GUNW' ? `${fmtDate(s.start)} → ${fmtDate(s.end)}` : fmtDate(s.start);
}
