export interface MissionSection {
  heading: string;
  body: string[];
}

export interface MissionInfo {
  id: string;
  tab: string;
  title: string;
  subtitle: string;
  kind: 'Satellite mission' | 'Instrument family' | 'Non-satellite source' | 'Reference dataset';
  facts: { label: string; value: string }[];
  sections: MissionSection[];
  links: { label: string; url: string }[];
}

export const MISSIONS: MissionInfo[] = [
  {
    id: 'nisar',
    tab: 'NISAR',
    title: 'NISAR',
    subtitle: 'NASA–ISRO Synthetic Aperture Radar',
    kind: 'Satellite mission',
    facts: [
      { label: 'Partners', value: 'NASA (USA) & ISRO (India)' },
      { label: 'Launch', value: 'July 30, 2025' },
      { label: 'Radars', value: 'L-band (NASA) & S-band (ISRO)' },
      { label: 'Orbit repeat', value: '~12 days (nominal)' },
    ],
    sections: [
      {
        heading: 'How radar "sees"',
        body: [
          'NISAR sends microwave pulses toward the ground and records the echoes that bounce back. Because it supplies its own illumination, it works day or night, and its long wavelengths pass through most clouds and smoke.',
          'Smooth open water reflects the pulse away from the satellite and looks dark; rough or built surfaces send more energy back and look bright. Comparing the phase of echoes from two passes (interferometry) can reveal ground motion of centimetres.',
        ],
      },
      {
        heading: 'Real limitations',
        body: [
          'Wind-roughened water, flooded vegetation, wet soil, steep terrain (layover/shadow) and dense cities can all be misread, so a dark patch is not automatically a flood. Heavy rain can affect S-band more than L-band.',
          'Raw radar must be calibrated, geocoded and classified before it becomes a water or deformation map, and each step adds uncertainty.',
        ],
      },
      {
        heading: 'What it is used for',
        body: [
          'Ground deformation and earthquakes · flooding and water extent · glacier and ice-sheet motion · forest biomass and vegetation change · wetlands and inundation under canopy · agriculture and soil moisture.',
        ],
      },
      {
        heading: 'NISAR in this app',
        body: [
          'Zoom in (level 6+) and the app searches NASA’s Common Metadata Repository for real NISAR L2 products over the map view and date range. Their public browse images from the Alaska Satellite Facility are placed on the map, and every acquisition appears as a purple mark on the timeline at its real time.',
          'GCOV is radar backscatter (water dark, forests and towns bright). GUNW interferograms show ground motion between two passes. Browse images are display-stretched quick-looks, placed by footprint fitting to about 1 km; they are for viewing, not measuring. Each scene is labelled Validated or Provisional as NASA publishes it.',
        ],
      },
      {
        heading: 'Revisit ≠ usable data',
        body: [
          'The ~12-day repeat describes when the orbit returns over a place, not a promise of a usable scene every 12 days everywhere. Acquisition plans, downlink, processing backlogs, product availability and quality screening all affect what is actually published. This app shows real acquisition dates and leaves gaps visible.',
        ],
      },
    ],
    links: [
      { label: 'NASA NISAR mission', url: 'https://science.nasa.gov/mission/nisar/' },
      { label: 'NASA Earthdata', url: 'https://www.earthdata.nasa.gov/' },
      { label: 'Alaska Satellite Facility (ASF DAAC)', url: 'https://asf.alaska.edu/' },
    ],
  },
  {
    id: 'sentinel1',
    tab: 'Sentinel-1',
    title: 'Sentinel-1',
    subtitle: 'Copernicus C-band SAR (ESA / European Commission)',
    kind: 'Satellite mission',
    facts: [
      { label: 'Operator', value: 'ESA for the EU Copernicus programme' },
      { label: 'Radar', value: 'C-band (~5.5 cm wavelength)' },
      { label: 'Repeat', value: '12 days per satellite (6 days with two)' },
    ],
    sections: [
      {
        heading: 'Why it matters here',
        body: [
          'Sentinel-1 is the most widely used open SAR archive for flood mapping and InSAR. Its shorter C-band wavelength is more sensitive to vegetation canopy than NISAR’s L-band. It is a candidate complementary source; it is not connected in this build.',
        ],
      },
    ],
    links: [
      { label: 'Sentinel-1 at ASF', url: 'https://asf.alaska.edu/data-sets/sar-data-sets/sentinel-1/' },
    ],
  },
  {
    id: 'viirs',
    tab: 'MODIS/VIIRS',
    title: 'MODIS & VIIRS',
    subtitle: 'Optical / thermal imagers used for active-fire detection',
    kind: 'Instrument family',
    facts: [
      { label: 'Platforms', value: 'Terra & Aqua (MODIS); Suomi NPP, NOAA-20, NOAA-21 (VIIRS)' },
      { label: 'Fire product', value: 'Thermal anomalies / active fire (NASA FIRMS)' },
    ],
    sections: [
      {
        heading: 'Different sensors, different evidence',
        body: [
          'Active-fire hotspots come from thermal infrared detections by these instruments — not from radar. A hotspot is a pixel that was unusually hot at overpass time; it is not a fire perimeter.',
          'The wildfire layer currently shown in this app is neither: it is incident reports aggregated by NASA EONET (largely from the US IRWIN system). Hotspots need a free NASA FIRMS key and are not connected yet.',
        ],
      },
    ],
    links: [
      { label: 'NASA FIRMS', url: 'https://firms.modaps.eosdis.nasa.gov/' },
      { label: 'NASA EONET', url: 'https://eonet.gsfc.nasa.gov/' },
    ],
  },
  {
    id: 'usgs',
    tab: 'USGS catalog',
    title: 'USGS ComCat',
    subtitle: 'Earthquake catalog from seismic networks',
    kind: 'Non-satellite source',
    facts: [
      { label: 'Operator', value: 'U.S. Geological Survey' },
      { label: 'Measures', value: 'Origin time, epicenter, depth, magnitude' },
    ],
    sections: [
      {
        heading: 'Not a satellite product',
        body: [
          'Earthquake events come from ground-based seismometers. Event times are when the rupture began — they are never satellite acquisition times. SAR can later measure the resulting ground deformation by comparing passes before and after the event.',
          'Coverage includes Canadian events reported to ComCat; Natural Resources Canada maintains its own national catalog.',
        ],
      },
    ],
    links: [
      { label: 'USGS Earthquake Hazards', url: 'https://earthquake.usgs.gov/' },
      { label: 'Earthquakes Canada (NRCan)', url: 'https://earthquakescanada.nrcan.gc.ca/' },
    ],
  },
  {
    id: 'jrc',
    tab: 'JRC water',
    title: 'JRC Global Surface Water',
    subtitle: 'Historical water reference (Landsat 1984–2021)',
    kind: 'Reference dataset',
    facts: [
      { label: 'Producer', value: 'European Commission Joint Research Centre' },
      { label: 'Resolution', value: '30 m (resampled in this app)' },
    ],
    sections: [
      {
        heading: 'How it is used',
        body: [
          '“Occurrence” is the share of valid Landsat observations, 1984–2021, in which a pixel was water. The flood filter treats high-occurrence cells as persistent rivers and lakes, and flags new water elsewhere as potential flooding. It is a reference baseline, not a NISAR measurement.',
        ],
      },
    ],
    links: [{ label: 'Global Surface Water Explorer', url: 'https://global-surface-water.appspot.com/' }],
  },
];
