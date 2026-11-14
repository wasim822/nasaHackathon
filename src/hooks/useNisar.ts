import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoBounds, OverlaySpec, TimeRange } from '../types';
import { type NisarProduct, type NisarScene, searchNisar, selectPass, selectScenes } from '../services/data/nisar';
import { type ProcessedImage, processSceneImage } from '../services/data/nisarImage';
import { DAY, fmtDate } from '../services/time/format';

export const NISAR_MIN_ZOOM = 6;
/** Nominal repeat is ~12 days, so ±7 days usually finds the nearest pass of each stack. */
export const NISAR_WINDOW_MS = 7 * DAY;
export const NISAR_FALLBACK_MS = 60 * DAY;

export type NisarState = 'off' | 'zoom-in' | 'loading' | 'ready' | 'error';

export interface UseNisarArgs {
  enabled: boolean;
  product: NisarProduct;
  view: GeoBounds | null;
  zoom: number;
  range: TimeRange;
  refTime: number;
  pinnedId: string | null;
  opacity: number;
  mode: 'pass' | 'all';
}

type ImageEntry = { status: 'loading' } | { status: 'ready'; image: ProcessedImage } | { status: 'error'; message: string };

const imageCache = new Map<string, ImageEntry>();
const MAX_CACHED = 40;

function rounded(b: GeoBounds): GeoBounds {
  // Snap the search box so small pans don't trigger new searches.
  const r = (v: number, f: (x: number) => number) => f(v * 4) / 4;
  return { west: r(b.west, Math.floor), south: r(b.south, Math.floor), east: r(b.east, Math.ceil), north: r(b.north, Math.ceil) };
}

export function useNisar(a: UseNisarArgs) {
  const [scenes, setScenes] = useState<NisarScene[]>([]);
  const [state, setState] = useState<NisarState>('off');
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [version, bump] = useState(0);

  const active = a.enabled && !!a.view && a.zoom >= NISAR_MIN_ZOOM;
  const box = a.view && active ? rounded(a.view) : null;
  const boxKey = box ? `${box.west},${box.south},${box.east},${box.north}` : '';

  // Search (debounced; stale requests cancelled).
  useEffect(() => {
    if (!a.enabled) {
      setState('off');
      return;
    }
    if (!box) {
      setState('zoom-in');
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setState('loading');
      setError(null);
      searchNisar(a.product, box, a.range, ctrl.signal)
        .then((r) => {
          setScenes(r.scenes);
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

  // Nearest pass per track within ±7 days; if none (e.g. today, since products publish
  // with a delay), fall back to the nearest passes within 60 days and say so.
  const selection = useMemo(() => {
    if (state !== 'ready' && state !== 'loading') return { scenes: [] as NisarScene[], fallback: false };
    const pick = a.mode === 'pass' ? selectPass : selectScenes;
    const near = pick(scenes, a.refTime, NISAR_WINDOW_MS, a.pinnedId);
    if (near.length || !scenes.length) return { scenes: near, fallback: false };
    return { scenes: pick(scenes, a.refTime, NISAR_FALLBACK_MS, a.pinnedId), fallback: true };
  }, [scenes, a.refTime, a.pinnedId, state, a.mode]);
  const visible = selection.scenes;

  // Browse-image loader: one persistent queue (max 3 concurrent). Downloads for scenes
  // that are no longer wanted are cancelled; finished images are cached.
  const wantedRef = useRef<NisarScene[]>([]);
  wantedRef.current = active ? visible : [];
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
            evict(new Set(wantedRef.current.map((v) => v.id)));
            bump((n) => n + 1);
            pump();
          });
      }
    };
    pump();
  }, [visible, active]);

  // Cancel everything on unmount.
  useEffect(() => () => {
    for (const ctrl of loader.current.inflight.values()) ctrl.abort();
  }, []);

  const overlays: OverlaySpec[] = useMemo(() => {
    if (!active) return [];
    const out: OverlaySpec[] = [];
    for (const s of visible) {
      const entry = imageCache.get(s.id);
      if (entry?.status === 'ready') {
        out.push({ kind: 'image', id: `nisar-img-${s.id}`, pane: 'radar', url: entry.image.url, bounds: entry.image.bounds, opacity: a.opacity });
      }
      const pinned = s.id === a.pinnedId;
      // Outlines only where they carry information: the pinned scene, or an image that
      // is still loading / failed. Loaded images speak for themselves.
      if (!pinned && entry?.status === 'ready') continue;
      out.push({
        kind: 'polygon',
        id: `nisar-fp-${s.id}`,
        pane: 'radar',
        rings: [s.footprint],
        color: pinned ? '#f5d0fe' : '#c084fc',
        weight: pinned ? 1.5 : 1,
        opacity: pinned ? 0.9 : 0.5,
        dashArray: pinned ? undefined : '3 5',
        fillOpacity: 0,
        tooltip: `NISAR ${s.product} · ${s.status} · ${sceneDateText(s)} · ${s.direction ?? ''} track ${s.track ?? '?'}${entry?.status === 'error' ? ` · image unavailable: ${entry.message}` : entry?.status === 'loading' ? ' · loading image…' : ''}`,
        selectId: `nisar:${s.id}`,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, a.opacity, a.pinnedId, version]);

  const imageStatus = (id: string) => imageCache.get(id)?.status ?? null;

  return { state, error, scenes, visible, fallback: selection.fallback, truncated, overlays, imageStatus };
}

/** Drops the oldest cached images, never ones currently on screen. */
function evict(keep: Set<string>) {
  if (imageCache.size <= MAX_CACHED) return;
  for (const [id, e] of imageCache) {
    if (imageCache.size <= MAX_CACHED) break;
    if (e.status === 'loading' || keep.has(id)) continue;
    if (e.status === 'ready') URL.revokeObjectURL(e.image.url);
    imageCache.delete(id);
  }
}

export function sceneDateText(s: NisarScene): string {
  return s.product === 'GUNW' ? `${fmtDate(s.start)} → ${fmtDate(s.end)}` : fmtDate(s.start);
}
