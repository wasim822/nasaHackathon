import type { LatLng } from '../../types';

/**
 * Daily satellite imagery around a fire, from NASA GIBS via the Worldview Snapshots service
 * (public, no key). True colour is a corrected-reflectance daily composite; hotspots are the
 * matching sensor's active-fire / thermal-anomaly detections for that UTC day.
 */
export const SNAPSHOT_URL = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot';

export interface FireSensor {
  id: string;
  label: string;
  trueColor: string;
  hotspots: string;
  /** Approximate local equator crossing time (daytime pass). */
  overpass: string;
  resolution: string;
}

export const FIRE_SENSORS: FireSensor[] = [
  { id: 'noaa20', label: 'VIIRS · NOAA-20', trueColor: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', hotspots: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All', overpass: '~13:30 local', resolution: '375 m hotspots · 250 m imagery' },
  { id: 'snpp', label: 'VIIRS · Suomi NPP', trueColor: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', hotspots: 'VIIRS_SNPP_Thermal_Anomalies_375m_All', overpass: '~13:30 local', resolution: '375 m hotspots · 250 m imagery' },
  { id: 'noaa21', label: 'VIIRS · NOAA-21', trueColor: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor', hotspots: 'VIIRS_NOAA21_Thermal_Anomalies_375m_All', overpass: '~13:30 local', resolution: '375 m hotspots · 250 m imagery' },
  { id: 'terra', label: 'MODIS · Terra', trueColor: 'MODIS_Terra_CorrectedReflectance_TrueColor', hotspots: 'MODIS_Terra_Thermal_Anomalies_All', overpass: '~10:30 local', resolution: '1 km hotspots · 250 m imagery' },
  { id: 'aqua', label: 'MODIS · Aqua', trueColor: 'MODIS_Aqua_CorrectedReflectance_TrueColor', hotspots: 'MODIS_Aqua_Thermal_Anomalies_All', overpass: '~13:30 local', resolution: '1 km hotspots · 250 m imagery' },
];

const DAY = 864e5;
export const utcDay = (t: number) => Math.floor(t / DAY) * DAY;
export const isoDay = (t: number) => new Date(utcDay(t)).toISOString().slice(0, 10);

/** Square-on-the-ground box around a point: `halfLatDeg` north/south, widened east/west for latitude. */
export function boxAround([lat, lng]: LatLng, halfLatDeg: number) {
  const k = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return { south: lat - halfLatDeg, north: lat + halfLatDeg, west: lng - halfLatDeg / k, east: lng + halfLatDeg / k };
}

export function snapshotUrl(opts: { at: LatLng; day: number; sensor: FireSensor; hotspots: boolean; halfLatDeg: number; height: number }): string {
  const b = boxAround(opts.at, opts.halfLatDeg);
  // Plate carrée image: keep the pixel aspect equal to the box's degree aspect.
  const width = Math.round((opts.height * (b.east - b.west)) / (b.north - b.south));
  const layers = opts.hotspots ? `${opts.sensor.trueColor},${opts.sensor.hotspots}` : opts.sensor.trueColor;
  const p = new URLSearchParams({
    REQUEST: 'GetSnapshot',
    LAYERS: layers,
    CRS: 'EPSG:4326',
    TIME: isoDay(opts.day),
    // EPSG:4326 WMS axis order: lat,lon.
    BBOX: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(4)).join(','),
    FORMAT: 'image/jpeg',
    WIDTH: String(width),
    HEIGHT: String(opts.height),
  });
  return `${SNAPSHOT_URL}?${p}`;
}

/** Worldview link for the same day, place and layers, for full-resolution browsing. */
export function worldviewUrl(at: LatLng, day: number, sensor: FireSensor, halfLatDeg: number): string {
  const b = boxAround(at, halfLatDeg);
  return `https://worldview.earthdata.nasa.gov/?v=${b.west.toFixed(3)},${b.south.toFixed(3)},${b.east.toFixed(3)},${b.north.toFixed(3)}&l=${sensor.hotspots},${sensor.trueColor},Coastlines_15m&t=${isoDay(day)}`;
}
