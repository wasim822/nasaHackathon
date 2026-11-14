import { create } from 'zustand';
import type { EffectMode, EffectSettings, GeoBounds, Observation, TimeRange } from '../types';
import type { NisarProduct } from '../services/data/nisar';
import { stepIndex, type Speed } from '../services/playback';

export type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export type BaseLayerId = 'satellite' | 'satellite-muted';

export const EFFECT_PRESETS: Record<EffectMode, EffectSettings> = {
  off: {
    mode: 'off',
    boundingBoxes: false,
    trackingIds: false,
    trails: false,
    centroids: false,
    trailLength: 4,
    highlightSelected: true,
    highlightChanges: false,
  },
  clean: {
    mode: 'clean',
    boundingBoxes: true,
    trackingIds: true,
    trails: true,
    centroids: false,
    trailLength: 4,
    highlightSelected: true,
    highlightChanges: false,
  },
  cinematic: {
    mode: 'cinematic',
    boundingBoxes: true,
    trackingIds: true,
    trails: true,
    centroids: true,
    trailLength: 5,
    highlightSelected: true,
    highlightChanges: true,
  },
};

export interface AppState {
  activeFilterId: string | null;
  range: TimeRange | null;
  filterOptions: Record<string, unknown>;

  loadState: LoadState;
  loadError: string | null;
  notices: string[];
  observations: Observation[];
  data: unknown;

  currentIndex: number;
  playing: boolean;
  speed: Speed;
  loop: boolean;

  effects: EffectSettings;
  userReduceMotion: boolean;
  systemReduceMotion: boolean;
  layerVisibility: Record<string, boolean>;
  selectedId: string | null;

  baseLayer: BaseLayerId;
  showLabels: boolean;
  aboutOpen: boolean;
  aboutMissionId: string;
  sidebarOpen: boolean;
  /** Incremented to ask the map to fit the active filter's data extent. */
  fitRequest: number;
  /** Bounds to fit on the next fit request (overrides the filter extent when set). */
  fitTarget: GeoBounds | null;

  viewBounds: GeoBounds | null;
  viewZoom: number;
  nisarEnabled: boolean;
  nisarProduct: NisarProduct;
  nisarOpacity: number;
  /** 'pass' = one clean satellite pass; 'all' = nearest pass of every track. */
  nisarMode: 'pass' | 'all';
  /** Backscatter display: grayscale (conventional) or the browse false-colour composite. */
  nisarColor: 'gray' | 'color';
  nisarPinnedId: string | null;

  // actions
  activateFilter(id: string | null, range: TimeRange | null, layers: Record<string, boolean>, options: unknown): void;
  setRange(range: TimeRange): void;
  setFilterOptions(id: string, options: unknown): void;
  beginLoad(): void;
  finishLoad(observations: Observation[], data: unknown, notices: string[]): void;
  failLoad(message: string): void;

  setIndex(index: number): void;
  step(direction: 1 | -1): void;
  /** Called by the playback clock. */
  tick(): void;
  setPlaying(playing: boolean): void;
  togglePlaying(): void;
  setSpeed(speed: Speed): void;
  setLoop(loop: boolean): void;

  setEffectMode(mode: EffectMode): void;
  setEffect<K extends keyof EffectSettings>(key: K, value: EffectSettings[K]): void;
  setUserReduceMotion(v: boolean): void;
  setSystemReduceMotion(v: boolean): void;
  setLayerVisible(id: string, visible: boolean): void;
  select(id: string | null): void;

  setBaseLayer(id: BaseLayerId): void;
  setShowLabels(v: boolean): void;
  openAbout(missionId?: string): void;
  closeAbout(): void;
  setSidebarOpen(v: boolean): void;
  requestFit(target?: GeoBounds | null): void;
  setView(bounds: GeoBounds, zoom: number): void;
  setNisarEnabled(v: boolean): void;
  setNisarProduct(p: NisarProduct): void;
  setNisarOpacity(v: number): void;
  setNisarMode(m: 'pass' | 'all'): void;
  setNisarColor(c: 'gray' | 'color'): void;
  pinNisar(id: string | null): void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeFilterId: null,
  range: null,
  filterOptions: {},
  loadState: 'idle',
  loadError: null,
  notices: [],
  observations: [],
  data: null,
  currentIndex: -1,
  playing: false,
  speed: 1,
  loop: false,
  effects: EFFECT_PRESETS.clean,
  userReduceMotion: false,
  systemReduceMotion: false,
  layerVisibility: {},
  selectedId: null,
  baseLayer: 'satellite',
  showLabels: false,
  aboutOpen: false,
  aboutMissionId: 'nisar',
  // Collapsed by default on narrow screens so the map stays visible.
  sidebarOpen: typeof window === 'undefined' || window.innerWidth > 900,
  fitRequest: 0,
  fitTarget: null,
  viewBounds: null,
  viewZoom: 3,
  nisarEnabled: true,
  nisarProduct: 'GCOV',
  nisarOpacity: 0.8,
  nisarMode: 'pass',
  nisarColor: 'gray',
  nisarPinnedId: null,

  activateFilter(id, range, layers, options) {
    const { filterOptions } = get();
    set({
      activeFilterId: id,
      range,
      // Changing filters pauses playback and releases the previous filter's data.
      playing: false,
      observations: [],
      data: null,
      currentIndex: -1,
      selectedId: null,
      loadState: id ? 'loading' : 'idle',
      loadError: null,
      notices: [],
      layerVisibility: layers,
      filterOptions: id && !(id in filterOptions) ? { ...filterOptions, [id]: options } : filterOptions,
    });
  },
  setRange(range) {
    set({ range, playing: false });
  },
  setFilterOptions(id, options) {
    set((s) => ({ filterOptions: { ...s.filterOptions, [id]: options }, playing: false }));
  },
  beginLoad() {
    set({ loadState: 'loading', loadError: null, playing: false });
  },
  finishLoad(observations, data, notices) {
    const sorted = [...observations].sort((a, b) => a.time - b.time);
    set((s) => {
      // Keep the selection only if it still exists conceptually; filters decide in Detail.
      return {
        observations: sorted,
        data,
        notices,
        loadState: sorted.length ? 'ready' : 'empty',
        currentIndex: sorted.length ? 0 : -1,
        playing: false,
        selectedId: sorted.length ? s.selectedId : null,
      };
    });
  },
  failLoad(message) {
    set({ loadState: 'error', loadError: message, observations: [], data: null, currentIndex: -1, playing: false });
  },

  setIndex(index) {
    const n = get().observations.length;
    if (!n) return;
    set({ currentIndex: Math.min(n - 1, Math.max(0, index)) });
  },
  step(direction) {
    const { currentIndex, observations } = get();
    // Manual stepping never wraps and pauses playback.
    const r = stepIndex(currentIndex, observations.length, direction, false);
    set({ currentIndex: r.index, playing: false });
  },
  tick() {
    const { currentIndex, observations, loop, playing } = get();
    if (!playing) return;
    const r = stepIndex(currentIndex, observations.length, 1, loop);
    // Without loop, playback stops as soon as the final observation is shown.
    const atEnd = !loop && r.index >= observations.length - 1;
    set({ currentIndex: r.index, playing: !r.stop && !atEnd });
  },
  setPlaying(playing) {
    const { observations, currentIndex, loop } = get();
    if (playing && observations.length < 2) return;
    // Pressing play at the final frame restarts from the first observation.
    if (playing && currentIndex >= observations.length - 1 && !loop) {
      set({ currentIndex: 0, playing: true });
      return;
    }
    set({ playing });
  },
  togglePlaying() {
    get().setPlaying(!get().playing);
  },
  setSpeed(speed) {
    set({ speed });
  },
  setLoop(loop) {
    set({ loop });
  },

  setEffectMode(mode) {
    const keepLen = get().effects.trailLength;
    set({ effects: { ...EFFECT_PRESETS[mode], trailLength: mode === 'off' ? keepLen : EFFECT_PRESETS[mode].trailLength } });
  },
  setEffect(key, value) {
    set((s) => ({ effects: { ...s.effects, [key]: value } }));
  },
  setUserReduceMotion(v) {
    set({ userReduceMotion: v });
  },
  setSystemReduceMotion(v) {
    set({ systemReduceMotion: v });
  },
  setLayerVisible(id, visible) {
    set((s) => ({ layerVisibility: { ...s.layerVisibility, [id]: visible } }));
  },
  select(id) {
    set({ selectedId: id });
  },

  setBaseLayer(id) {
    set({ baseLayer: id });
  },
  setShowLabels(v) {
    set({ showLabels: v });
  },
  openAbout(missionId) {
    set((s) => ({ aboutOpen: true, aboutMissionId: missionId ?? s.aboutMissionId }));
  },
  closeAbout() {
    set({ aboutOpen: false });
  },
  setSidebarOpen(v) {
    set({ sidebarOpen: v });
  },
  requestFit(target = null) {
    set((s) => ({ fitRequest: s.fitRequest + 1, fitTarget: target }));
  },
  setView(bounds, zoom) {
    set({ viewBounds: bounds, viewZoom: zoom });
  },
  setNisarEnabled(v) {
    set({ nisarEnabled: v });
  },
  setNisarProduct(p) {
    set({ nisarProduct: p, nisarPinnedId: null });
  },
  setNisarOpacity(v) {
    set({ nisarOpacity: v });
  },
  setNisarMode(m) {
    set({ nisarMode: m });
  },
  setNisarColor(c) {
    set({ nisarColor: c });
  },
  pinNisar(id) {
    set({ nisarPinnedId: id });
  },
}));

export const selectReducedMotion = (s: AppState) => s.userReduceMotion || s.systemReduceMotion;
