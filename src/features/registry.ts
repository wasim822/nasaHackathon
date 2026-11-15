import type { FilterDefinition } from '../types';
import type { IconName } from '../components/Icon';
import { floodFilter } from './flood/floodFilter';
import { wildfireFilter } from './wildfire/wildfireFilter';
import { earthquakeFilter } from './earthquake/earthquakeFilter';
import { wetlandFilter } from './wetlands/wetlandFilter';

/** Placeholder for categories without valid data + analysis yet. Cannot be activated. */
function comingSoon(id: string, label: string, icon: IconName, summary: string, missionId = 'nisar'): FilterDefinition {
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
  comingSoon('glacier', 'Glacier Movement', 'snowflake', 'Ice-velocity / displacement from SAR feature tracking (e.g. Alaska, Canadian Arctic). Needs a measured velocity product with uncertainty.'),
  wetlandFilter,
  comingSoon('vegetation', 'Forest & Vegetation', 'tree', 'Biomass and disturbance change from L-band backscatter.'),
  // Real-data module exists (features/deformation) but is held back: the processed SJV pairs show
  // implausibly large single-pair motion (p95 34–122 mm per 12 days), likely an unwrapping /
  // connected-component referencing problem in server/nisar_prep.py. Re-enable once validated.
  comingSoon('deformation', 'Ground Deformation', 'ruler', 'InSAR surface displacement (subsidence, volcanoes, post-seismic). Real NISAR GUNW pipeline is built but held back until its processing is validated.'),
];

export function getFilter(id: string | null): FilterDefinition<any, any> | null {
  return FILTERS.find((f) => f.id === id) ?? null;
}
