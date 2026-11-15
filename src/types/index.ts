import type { ComponentType } from 'react';

/** Milliseconds since the Unix epoch (UTC). */
export type EpochMs = number;

export interface TimeRange {
  start: EpochMs;
  end: EpochMs;
}

export type LatLng = [lat: number, lng: number];

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * How a frame came to exist. Only `observed` frames are satellite acquisitions.
 * `estimated` is reserved for future modelled frames and must always be labelled as such.
 */
export type FrameKind = 'observed' | 'demo-observed' | 'catalog' | 'report' | 'estimated';

/** One real (or explicitly demo) dated item the timeline can step through. */
export interface Observation {
  id: string;
  /** Actual acquisition / event timestamp (UTC ms). Never a tick position. */
  time: EpochMs;
  kind: FrameKind;
  /** Short human label, e.g. "NISAR L-band, ascending" or "12 catalog events". */
  label?: string;
  /** Quality metadata, shown only when the source supplies it. */
  quality?: Record<string, string>;
}

/** Where a layer's content comes from. Drives legend badges. */
export type Provenance = 'observed' | 'derived' | 'reference' | 'catalog' | 'report' | 'demo' | 'estimated';

export interface LayerDefinition {
  id: string;
  label: string;
  description: string;
  provenance: Provenance;
  defaultVisible: boolean;
  /** CSS colour or pattern key for the legend swatch. */
  swatch?: string;
  /** If set, layer is shown disabled with this explanation. */
  unavailableReason?: string;
}

export interface SourceInfo {
  name: string;
  url?: string;
  /** e.g. "Satellite SAR", "Earthquake catalog", "Historical reference". */
  type: string;
  detail?: string;
  isDemo?: boolean;
}

export type EffectMode = 'off' | 'clean' | 'cinematic';

export interface EffectSettings {
  mode: EffectMode;
  boundingBoxes: boolean;
  trackingIds: boolean;
  trails: boolean;
  centroids: boolean;
  /** Number of actual observations a trail spans. */
  trailLength: number;
  highlightSelected: boolean;
  highlightChanges: boolean;
}

export interface StatItem {
  id: string;
  label: string;
  value: string;
  hint?: string;
  tone?: 'up' | 'down' | 'neutral';
}

export type TimelineEventType =
  | 'appeared'
  | 'expansion'
  | 'max-extent'
  | 'recession'
  | 'merged'
  | 'split'
  | 'major-event';

export interface TimelineEvent {
  time: EpochMs;
  type: TimelineEventType;
  label: string;
}

export interface ChartSeries {
  label: string;
  unit: string;
  points: { time: EpochMs; value: number }[];
}

// ----- Declarative map overlays (rendered by the map adapter, not by filters) -----

export type OverlayPane = 'radar' | 'reference' | 'data' | 'effects' | 'labels';

interface OverlayBase {
  id: string;
  pane: OverlayPane;
}

export interface TileOverlay extends OverlayBase {
  kind: 'tile';
  url: string;
  attribution: string;
  opacity: number;
  maxNativeZoom?: number;
}

export interface ImageOverlay extends OverlayBase {
  kind: 'image';
  /** Usually a data URL produced once per observation and cached. */
  url: string;
  bounds: GeoBounds;
  opacity: number;
  pixelated?: boolean;
}

export interface RectOverlay extends OverlayBase {
  kind: 'rect';
  bounds: GeoBounds;
  color: string;
  weight: number;
  opacity: number;
  glow?: boolean;
  label?: string;
  /** Selecting this overlay selects this id. */
  selectId?: string;
  emphasis?: 'appear' | 'change' | null;
  /** Show the label even when the box is tiny on screen (label-only markers). */
  labelAlways?: boolean;
  /** Label priority for collision handling (higher wins). Defaults to box size. */
  priority?: number;
}

export interface CircleOverlay extends OverlayBase {
  kind: 'circle';
  center: LatLng;
  radiusPx: number;
  color: string;
  fillOpacity: number;
  strokeOpacity?: number;
  weight?: number;
  tooltip?: string;
  /** Keep the tooltip open as a label (used for locator markers). */
  tooltipPermanent?: boolean;
  selectId?: string;
  pulse?: 'subtle' | 'strong' | null;
}

export interface PolylineOverlay extends OverlayBase {
  kind: 'polyline';
  points: LatLng[];
  color: string;
  weight: number;
  opacity: number;
  /** Progressive line-draw animation when first added (cinematic). */
  draw?: boolean;
}

export interface PolygonOverlay extends OverlayBase {
  kind: 'polygon';
  /** Outer ring(s); each ring is a list of [lat, lng]. */
  rings: LatLng[][];
  color: string;
  weight: number;
  opacity: number;
  fillColor?: string;
  /** 0 = outline only (outline-only polygons don't block map clicks inside them). */
  fillOpacity: number;
  dashArray?: string;
  tooltip?: string;
  selectId?: string;
}

export type OverlaySpec = TileOverlay | ImageOverlay | RectOverlay | CircleOverlay | PolylineOverlay | PolygonOverlay;

// ----- Filter contract -----

export type FilterStatus = 'live' | 'demo' | 'coming-soon';

export interface LoadContext<TOptions> {
  range: TimeRange;
  options: TOptions;
  signal: AbortSignal;
}

export interface LoadResult<TData> {
  observations: Observation[];
  data: TData;
  /** Plain-language notes, e.g. "Result truncated at 2000 events". */
  notices: string[];
}

export interface FrameContext<TData, TOptions> {
  data: TData;
  observations: Observation[];
  index: number;
  effects: EffectSettings;
  layers: Record<string, boolean>;
  selectedId: string | null;
  reducedMotion: boolean;
  options: TOptions;
}

export interface DetailProps<TData, TOptions> extends FrameContext<TData, TOptions> {
  onClose: () => void;
}

export interface OptionsProps<TOptions> {
  options: TOptions;
  onChange: (next: TOptions) => void;
  /** Lets an options panel move the shared time range (e.g. when switching data source). */
  onRange?: (range: TimeRange) => void;
}

export interface FilterDefinition<TData = unknown, TOptions = unknown> {
  id: string;
  label: string;
  status: FilterStatus;
  /** One-line plain-language description. */
  summary: string;
  icon: string;
  availableLayers: LayerDefinition[];
  sourceAttribution: SourceInfo[];
  /** Whether the Off/Clean/Cinematic Tracking Effect selector applies. */
  supportsTracking: boolean;
  /** Fine-grained effect toggles that actually affect this filter (others are hidden). */
  effectControls?: (keyof EffectSettings)[];
  /** Mission id for the About drawer. */
  missionId?: string;
  /** Nominal acquisition cadence; enables visible no-data gaps on the timeline. */
  expectedCadenceMs?: number;
  defaultOptions: TOptions;
  defaultRange(now: EpochMs): TimeRange;
  /** Time span where the dataset can have data. */
  dataBounds?(now: EpochMs): TimeRange;
  load(ctx: LoadContext<TOptions>): Promise<LoadResult<TData>>;
  overlays(ctx: FrameContext<TData, TOptions>): OverlaySpec[];
  stats(ctx: FrameContext<TData, TOptions>): StatItem[];
  timelineEvents?(data: TData, observations: Observation[]): TimelineEvent[];
  chart?(data: TData, observations: Observation[]): ChartSeries | null;
  /** Map click → id of the selected item (or null). */
  hitTest?(ctx: FrameContext<TData, TOptions>, at: LatLng): string | null;
  extent?(data: TData): GeoBounds | null;
  Detail?: ComponentType<DetailProps<TData, TOptions>>;
  /** Optional floating card over the map, opened by clicking a map item; closes on map drag/zoom or outside click. */
  Popup?: ComponentType<DetailProps<TData, TOptions>>;
  Options?: ComponentType<OptionsProps<TOptions>>;
  /** Release caches / object URLs when deactivated. */
  dispose?(): void;
}
