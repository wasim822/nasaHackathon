import type { FilterDefinition, OptionsProps, OverlaySpec, StatItem } from '../../types';
import { REGION_BOXES, REGION_NAME } from '../../services/geospatial/region';
import { fmtDate } from '../../services/time/format';
import {
  L3_FIRST, LANDCOVER_LAYER, MAX_LOOKBACK_DAYS, type VegLayer,
  gibsTileUrl, isoDay, landCoverYear, vegLayersFor,
} from './vegLayers';

export interface VegOptions {
  /** Chosen day (YYYY-MM-DD, UTC). */
  date: string;
  opacity: number;
  /** Recolour the low-vegetation end of NASA's NDVI scale in pink. */
  barePink: boolean;
}

interface VegData {
  date: number;
  layers: VegLayer[];
  landCoverYear: number;
}

const DAY = 864e5;
const LEGEND = 'https://worldview.earthdata.nasa.gov/?l=VIIRS_NOAA20_L3_NDVI_16Day,MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual(hidden)';
/** Products publish with a delay; default to two days ago. */
const defaultDate = () => isoDay(Date.now() - 2 * DAY);
const sensorName = (l: VegLayer) => (l.layer.includes('L3') ? 'VIIRS NOAA-20 16-day composite' : 'VIIRS NOAA-20 8-day composite (near real time)');

function VegOptionsPanel({ options, onChange }: OptionsProps<VegOptions>) {
  return (
    <div className="options-grid">
      <label>
        Date
        <input
          type="date" value={options.date} min={isoDay(L3_FIRST)} max={isoDay(Date.now())}
          onChange={(e) => e.target.value && onChange({ ...options, date: e.target.value })}
        />
      </label>
      <label>
        {`Vegetation colour opacity ${Math.round(options.opacity * 100)}%`}
        <input type="range" min={0.2} max={1} step={0.05} value={options.opacity} onChange={(e) => onChange({ ...options, opacity: Number(e.target.value) })} aria-label="Vegetation colour opacity" />
      </label>
      <label className="check">
        <input type="checkbox" checked={options.barePink} onChange={(e) => onChange({ ...options, barePink: e.target.checked })} />
        Highlight bare land in pink
      </label>
    </div>
  );
}

export const vegetationFilter: FilterDefinition<VegData, VegOptions> = {
  id: 'vegetation',
  label: 'Vegetation',
  icon: 'tree',
  status: 'live',
  summary: `Where plants are growing across the ${REGION_NAME} on a date you choose: green = vegetation, pink = bare land / little or no vegetation. Built from the newest NASA VIIRS vegetation maps on or before that date, with older maps filling cloud and snow gaps.`,
  missionId: 'viirs',
  supportsTracking: false,
  timeline: false,
  defaultOptions: { date: defaultDate(), opacity: 0.85, barePink: true },
  availableLayers: [
    { id: 'ndvi', label: 'Vegetation (NDVI)', description: 'Normalized Difference Vegetation Index from VIIRS: dark green = dense vegetation, light yellow-green = sparse vegetation, pink = bare land / little or no vegetation (deeper pink = barer: bare soil, rock, sand, cities, but also dry or dormant fields and winter landscapes). With the pink highlight off, that end shows in NASA’s original tan/brown. Water and remaining gaps are blank.', provenance: 'derived', defaultVisible: true, swatch: 'linear-gradient(90deg,#db2777,#fbcfe8,#e6efa0,#6fbf3a,#0b5d1e)',
      legend: (o: VegOptions) => ({
        ramp: o.barePink ? 'linear-gradient(90deg,#db2777,#fbcfe8,#e6efa0,#6fbf3a,#0b5d1e)' : 'linear-gradient(90deg,#8c5a2b,#d8c39a,#f2f0d8,#6fbf3a,#0b5d1e)',
        labels: ['Bare land', 'Sparse', 'Dense'],
      }) },
    { id: 'landcover', label: 'Land cover (yearly)', description: 'MODIS land-cover classes (IGBP), yearly 2001–2024 (the year nearest your date): dark green = forest, yellows/oranges = grassland and cropland, red = cities, light blue = water. Full class legend via the Worldview link in Sources.', provenance: 'derived', defaultVisible: false, swatch: 'linear-gradient(90deg,#1b7a1b,#f5e26b,#eaa45c,#e0241b,#8fc8e8)',
      legend: { items: [
        { color: '#1b7a1b', label: 'Forest' },
        { color: 'linear-gradient(90deg,#f5e26b,#eaa45c)', label: 'Grassland / cropland' },
        { color: '#e0241b', label: 'Cities' },
        { color: '#8fc8e8', label: 'Water' },
      ] } },
  ],
  sourceAttribution: [
    { name: 'NASA GIBS — VIIRS NOAA-20 NDVI (16-day L3 and 8-day near real time)', url: LEGEND, type: 'Satellite vegetation index composites (~1 km)', detail: 'Each composite combines many cloud-screened passes. Stacked newest on top so older composites fill gaps. Open in Worldview for the colour legend.' },
    { name: 'NASA GIBS — MODIS Combined Land Cover Type (IGBP), yearly', url: LEGEND, type: 'Satellite land-cover classification (~500 m)' },
  ],
  // The timeline is off for this filter; the range only satisfies the shared contract.
  defaultRange: (now) => ({ start: now - DAY, end: now }),

  async load({ options }) {
    const date = Date.parse(`${options.date}T00:00:00Z`);
    if (!Number.isFinite(date)) throw new Error('Choose a valid date.');
    if (date < L3_FIRST) throw new Error(`Vegetation maps start on ${fmtDate(L3_FIRST)}. Choose a later date.`);
    const layers = vegLayersFor(date);
    const data: VegData = { date, layers, landCoverYear: landCoverYear(date) };
    const notices = layers.length
      ? [`Map for ${fmtDate(date)}: top layer is the ${fmtDate(layers[0].from)}–${fmtDate(layers[0].to - DAY)} composite; gaps filled from older composites back to ${fmtDate(layers[layers.length - 1].from)}. Some areas may be up to ${MAX_LOOKBACK_DAYS} days older than the date you chose. VIIRS (NASA/NOAA), not NISAR.`]
      : ['No vegetation maps cover this date.'];
    return { observations: [{ id: `veg-${options.date}`, time: date, kind: 'observed', label: 'VIIRS NDVI composites (stacked)' }], data, notices };
  },

  overlays({ data, layers, options }): OverlaySpec[] {
    const out: OverlaySpec[] = [];
    if (layers.ndvi) {
      // Oldest first with the lowest zIndex, so the newest map always draws on top.
      [...data.layers].reverse().forEach((l, k) => out.push({
        kind: 'tile', id: `ndvi-${l.layer}-${l.date}${options.barePink ? '-pink' : ''}`, pane: 'reference', url: gibsTileUrl(l.layer, l.date),
        attribution: 'Vegetation: NASA GIBS, VIIRS NOAA-20 NDVI', opacity: options.opacity, maxNativeZoom: 8, zIndex: 10 + k,
        ...(options.barePink ? { recolor: 'bare-pink' as const } : {}),
      }));
    }
    if (layers.landcover) {
      out.push({
        kind: 'tile', id: `landcover-${data.landCoverYear}`, pane: 'reference', url: gibsTileUrl(LANDCOVER_LAYER, `${data.landCoverYear}-01-01`),
        attribution: 'Land cover: NASA GIBS, MODIS MCD12Q1 (IGBP)', opacity: options.opacity, maxNativeZoom: 8, zIndex: 50,
      });
    }
    return out;
  },

  stats({ data }): StatItem[] {
    if (!data.layers.length) return [{ id: 'none', label: 'Vegetation maps', value: 'None for this date' }];
    const newest = data.layers[0];
    const oldest = data.layers[data.layers.length - 1];
    return [
      { id: 'date', label: 'Chosen date', value: fmtDate(data.date) },
      { id: 'top', label: 'Newest data (top layer)', value: `${fmtDate(newest.from)} – ${fmtDate(newest.to - DAY)}`, hint: sensorName(newest) },
      { id: 'oldest', label: 'Oldest data used to fill gaps', value: fmtDate(oldest.from), hint: `${data.layers.length} composites stacked, newest on top` },
      { id: 'lc', label: 'Land-cover year', value: String(data.landCoverYear), hint: 'Yearly MODIS classes (2001–2024)' },
    ];
  },

  extent: () => REGION_BOXES[0],
  Options: VegOptionsPanel,
};
