import { useEffect, useMemo, useRef, useState } from 'react';
import type { OverlaySpec, TimeRange } from '../types';
import { type NisarFrameStep, type NisarPass, type NisarProduct, type NisarScene, flattenFrames, groupPasses, missingFrames, searchNisarRegion } from '../services/data/nisar';
import type { NisarMode } from '../state/store';
import { type ProcessedImage, processSceneImage } from '../services/data/nisarImage';
import { fmtDate } from '../services/time/format';

/** The previous pass stays on the map, faded, behind the current one. */
export const NISAR_TRAIL_PASSES = 1;
/** Passes ahead of the current one whose images are loaded in advance. */
const PREFETCH_PASSES = 2;
/** Satellite follow mode: frames ahead whose full images are loaded in advance. */
const PREFETCH_FRAMES = 3;
/** Playback waits this long for a pass's images before moving on without them. */
export const NISAR_IMAGE_WAIT_MS = 8000;

export type NisarState = 'off' | 'loading' | 'ready' | 'error';
type Variant = 'thumb' | 'full';

export interface UseNisarArgs {
  enabled: boolean;
  product: NisarProduct;
  range: TimeRange;
  /** Timeline index: a pass ('pass' mode) or a single frame ('satellite' mode), or -1. */
  index: number;
  mode: NisarMode;
  opacity: number;
  /** Small thumbnails while playing; full-resolution images for the current pass when paused. */
  playing: boolean;
}

type ImageEntry = { status: 'loading' } | { status: 'ready'; image: ProcessedImage } | { status: 'error'; message: string };

const imageCache = new Map<string, ImageEntry>();
const MAX_CACHED = 150;
/** Full-resolution images are large; keep fewer of them. */
const MAX_FULL = 30;
const key = (v: Variant, s: NisarScene) => `${v}:${s.id}`;

/** Passes on the map for the current frame, oldest first (the current pass last). */
export function shownPasses(passes: NisarPass[], index: number): NisarPass[] {
  if (index < 0 || !passes[index]) return [];
  return passes.slice(Math.max(0, index - NISAR_TRAIL_PASSES), index + 1);
}

/**
 * What is on the map, oldest first (current pass last). 'pass': the current pass and the previous
 * one. 'satellite': the current pass only up to the current frame, plus the previous pass.
 */
export function drawnPasses(passes: NisarPass[], frames: NisarFrameStep[], index: number, mode: NisarMode): NisarPass[] {
  if (mode === 'pass') return shownPasses(passes, index);
  const f = frames[index];
  if (!f) return [];
  const soFar = frames.slice(0, index + 1).filter((x) => x.passIndex === f.passIndex).map((x) => x.scene);
  const cur = { ...passes[f.passIndex], scenes: soFar };
  const prev = passes[f.passIndex - 1];
  return prev ? [prev, cur] : [cur];
}

/** Real NISAR passes over the US & Canada as timeline frames, drawn as their radar images. */
export function useNisar(a: UseNisarArgs) {
  const [passes, setPasses] = useState<NisarPass[]>([]);
  const [state, setState] = useState<NisarState>('off');
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [version, bump] = useState(0);

  // Search the whole region (not the map view), so panning never re-searches.
  useEffect(() => {
    if (!a.enabled) {
      setState('off');
      setPasses([]);
      return;
    }
    const ctrl = new AbortController();
    setState('loading');
    setError(null);
    searchNisarRegion(a.product, a.range, ctrl.signal)
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
    return () => ctrl.abort();
  }, [a.enabled, a.product, a.range.start, a.range.end]);

  const sat = a.mode === 'satellite';
  const frames = useMemo(() => flattenFrames(passes), [passes]);
  const firstFrame = useMemo(() => {
    const m: number[] = [];
    frames.forEach((f, i) => {
      if (m[f.passIndex] === undefined) m[f.passIndex] = i;
    });
    return m;
  }, [frames]);
  const passIndex = sat ? (frames[a.index]?.passIndex ?? -1) : a.index;
  const current = passIndex >= 0 ? passes[passIndex] : undefined;
  const currentScene = sat ? frames[a.index]?.scene : undefined;
  const drawn = useMemo(() => drawnPasses(passes, frames, a.index, a.mode), [passes, frames, a.index, a.mode]);

  // Images to load, in priority order. 'pass': the current pass's thumbnails (full images when
  // paused), then the next passes' thumbnails. 'satellite': the current frame and the next few,
  // thumbnail first (instant) then full resolution (the camera is zoomed in).
  const wanted: { k: string; scene: NisarScene; url: string }[] = [];
  if (a.enabled && current) {
    const thumb = (s: NisarScene) => ({ k: key('thumb', s), scene: s, url: s.thumbUrl ?? s.browseUrl });
    const full = (s: NisarScene) => ({ k: key('full', s), scene: s, url: s.browseUrl });
    if (sat && currentScene) {
      wanted.push(thumb(currentScene), full(currentScene));
      for (const f of frames.slice(a.index + 1, a.index + 1 + PREFETCH_FRAMES)) wanted.push(thumb(f.scene));
      for (const f of frames.slice(a.index + 1, a.index + 1 + PREFETCH_FRAMES)) wanted.push(full(f.scene));
    } else {
      for (const s of current.scenes) wanted.push(thumb(s));
      if (!a.playing) for (const s of current.scenes) wanted.push(full(s));
      for (const p of passes.slice(passIndex + 1, passIndex + 1 + PREFETCH_PASSES)) for (const s of p.scenes) wanted.push(thumb(s));
    }
  }
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const keepRef = useRef<Set<string>>(new Set());
  keepRef.current = new Set([
    ...wanted.map((w) => w.k),
    ...drawn.flatMap((p) => p.scenes.flatMap((s) => [key('thumb', s), key('full', s)])),
  ]);
  const wantedKey = wanted.map((w) => w.k).join('|');
  const loader = useRef<{ inflight: Map<string, AbortController> }>({ inflight: new Map() });
  useEffect(() => {
    const L = loader.current;
    const want = new Set(wantedRef.current.map((w) => w.k));
    for (const [k, ctrl] of L.inflight) {
      if (!want.has(k)) {
        ctrl.abort();
        L.inflight.delete(k);
        imageCache.delete(k);
      }
    }
    const pump = () => {
      for (const w of wantedRef.current) {
        if (L.inflight.size >= 4) break;
        if (imageCache.has(w.k)) continue;
        const ctrl = new AbortController();
        L.inflight.set(w.k, ctrl);
        imageCache.set(w.k, { status: 'loading' });
        processSceneImage(w.scene, ctrl.signal, w.url)
          .then((image) => {
            if (!ctrl.signal.aborted) imageCache.set(w.k, { status: 'ready', image });
            else URL.revokeObjectURL(image.url);
          })
          .catch((e: unknown) => {
            if (ctrl.signal.aborted) imageCache.delete(w.k);
            else imageCache.set(w.k, { status: 'error', message: e instanceof Error ? e.message : String(e) });
          })
          .finally(() => {
            if (L.inflight.get(w.k) === ctrl) L.inflight.delete(w.k);
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

  /** Best loaded image of a scene: full resolution if available, else the thumbnail. */
  const best = (s: NisarScene) => {
    const f = imageCache.get(key('full', s));
    if (f?.status === 'ready') return f.image;
    const t = imageCache.get(key('thumb', s));
    return t?.status === 'ready' ? t.image : null;
  };

  const overlays: OverlaySpec[] = useMemo(() => {
    if (!a.enabled || !current) return [];
    const out: OverlaySpec[] = [];
    for (const p of drawn) {
      const isCurrent = p.id === current.id;
      for (const s of p.scenes) {
        const img = best(s);
        if (img) out.push({ kind: 'image', id: `nisar-img-${s.id}`, pane: 'radar', url: img.url, bounds: img.bounds, opacity: isCurrent ? a.opacity : a.opacity * 0.35 });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.enabled, a.opacity, drawn, current, version]);

  // Ready once the thumbnails of the current step (pass, or single frame) have loaded or failed.
  const settled = (s: NisarScene) => {
    const st = imageCache.get(key('thumb', s))?.status;
    return st === 'ready' || st === 'error';
  };
  const currentReady = !current || (currentScene ? settled(currentScene) : current.scenes.every(settled));
  const drawnCurrent = drawn[drawn.length - 1];
  const currentFailed = drawnCurrent ? drawnCurrent.scenes.filter((s) => imageCache.get(key('thumb', s))?.status === 'error').length : 0;
  const imageStatus = (id: string) => imageCache.get(`thumb:${id}`)?.status ?? null;
  /** Timeline index of a pass's first step. */
  const obsIndexOfPass = (i: number) => (sat ? (firstFrame[i] ?? 0) : i);

  return { state, error, passes, frames, passIndex, current, currentScene, drawn, obsIndexOfPass, truncated, overlays, imageStatus, currentReady, currentFailed };
}

/** Drops the oldest cached images, never ones on screen or about to be. */
function evict(keep: Set<string>) {
  let full = 0;
  for (const k of imageCache.keys()) if (k.startsWith('full:')) full++;
  for (const [k, e] of imageCache) {
    if (full <= MAX_FULL) break;
    if (!k.startsWith('full:') || e.status === 'loading' || keep.has(k)) continue;
    if (e.status === 'ready') URL.revokeObjectURL(e.image.url);
    imageCache.delete(k);
    full--;
  }
  if (imageCache.size <= MAX_CACHED) return;
  for (const [k, e] of imageCache) {
    if (imageCache.size <= MAX_CACHED) break;
    if (e.status === 'loading' || keep.has(k)) continue;
    if (e.status === 'ready') URL.revokeObjectURL(e.image.url);
    imageCache.delete(k);
  }
}

/** e.g. "5 of 7 frames · 35, 36 not available": frames missing between a pass's ends aren't in NASA's catalog. */
export function frameSummary(pass: NisarPass): string {
  const present = new Set(pass.scenes.map((s) => s.frame)).size;
  const missing = missingFrames(pass);
  if (!missing.length) return `${present} frame${present > 1 ? 's' : ''}`;
  return `${present} of ${present + missing.length} frames · ${missing.join(', ')} not available`;
}

export function sceneDateText(s: { product: NisarProduct; start: number; end: number }): string {
  return s.product === 'GUNW' ? `${fmtDate(s.start)} → ${fmtDate(s.end)}` : fmtDate(s.start);
}
