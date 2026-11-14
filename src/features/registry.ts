import type { FilterDefinition } from '../types';
import { floodFilter } from './flood/floodFilter';
import { wildfireFilter } from './wildfire/wildfireFilter';
import { earthquakeFilter } from './earthquake/earthquakeFilter';
import { wetlandFilter } from './wetlands/wetlandFilter';

/** Placeholder for categories without valid data + analysis yet. Cannot be activated. */
function comingSoon(id: string, label: string, icon: string, summary: string, missionId = 'nisar'): FilterDefinition {
  return {
    id,
    label,
    icon,
    status: 'coming-soon',
    summary,
    missionId,
    availableLayers: [],
    sourceAttribution: [],
    supportsTracking: false,
    defaultOptions: {},
    defaultRange: (now) => ({ start: now - 30 * 864e5, end: now }),
    load: () => Promise.reject(new Error(`${label} is not implemented yet`)),
    overlays: () => [],
    stats: () => [],
  };
}

// Heterogeneous filter types share one contract; the registry erases their data generics.
export const FILTERS: FilterDefinition<any, any>[] = [
  floodFilter,
  wildfireFilter,
  earthquakeFilter,
  comingSoon('glacier', 'Glacier Movement', '🧊', 'Ice-velocity / displacement from SAR feature tracking (e.g. Alaska, Canadian Arctic). Needs a measured velocity product with uncertainty.'),
  wetlandFilter,
  comingSoon('vegetation', 'Forest & Vegetation', '🌲', 'Biomass and disturbance change from L-band backscatter.'),
  comingSoon('deformation', 'Ground Deformation', '📐', 'InSAR surface displacement (subsidence, volcanoes, post-seismic).'),
];

export function getFilter(id: string | null): FilterDefinition<any, any> | null {
  return FILTERS.find((f) => f.id === id) ?? null;
}
