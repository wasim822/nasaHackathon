# Earth Change Explorer

NASA Space Apps Challenge 2026: **Dancing with the SARs**. This interactive satellite map lets you *watch Earth change over time* across the **United States & Canada**.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest (ticks, ranges, playback, tracking, flood pipeline, UI)
npm run typecheck
npm run build
```

## What's real and what's demo

| Filter | Status | Data | Notes |
|---|---|---|---|
| Basemap | Live | Esri World Imagery | Optional "muted" style and Esri place labels |
| **NISAR passes** (base map) | **Live, real** | NASA–ISRO NISAR L2 GCOV (backscatter) and GUNW (interferogram) browse images from ASF DAAC, found via NASA CMR | Base map only (no filter selected); off by default. Each pass over the US & Canada is a timeline frame shown as its radar image; the camera follows each pass |
| **Flood** | **Live, real** (default) | Observations: water classified from **real NISAR L2 GCOV** HH/HV backscatter, prepared offline by `server/flood_prep.py`. Baseline: real JRC Global Surface Water | AOI: Mississippi–Missouri confluence near St. Louis, NISAR passes from June 2026. A **Demo** source (simulated scenes) is still selectable in Options and labeled DEMO |
| **Earthquake** | Live | USGS ComCat (FDSN event API) | Queried by US/Canada bounding boxes plus an approximate US–Mexico border filter |
| **Wildfire** | Live | NASA EONET v3 wildfire events (mostly US IRWIN incident reports). Optional map layers: VIIRS 375 m active-fire hotspots (NASA FIRMS via GIBS) and NOAA HMS smoke areas. Clicking a fire shows VIIRS true colour + hotspots (before/after slider, timeline day, ~10/25/65 km views) and a smoke-drift view (GOES loop + Open-Meteo wind) | Markers are reported incident *locations*; hotspots are satellite heat detections, not perimeters; smoke is NOAA's analyst-drawn outline; the wind arrow is modelled |
| **Wetlands** | **Live, real** | Open water and possible inundated vegetation classified from **real NISAR L2 GCOV**, prepared offline by `server/flood_prep.py --aoi atchafalaya` | AOI: Atchafalaya Basin, Louisiana; 32 passes Nov 2025 – Nov 2026 |
| Glacier, Forest, Ground Deformation | Coming soon | – | Can't be activated. A real NISAR GUNW deformation module exists (`src/features/deformation`) but is held back until its processing is validated |

The following layers are listed but disabled, with the reason shown: fire perimeters, burn scars, and InSAR deformation (Earthquake filter).

## Architecture

- `src/types`: the shared `FilterDefinition` contract: `load()` returns dated observations; `overlays()`, `stats()`, `timelineEvents()`, `chart()`, `hitTest()`, `Detail` and `Options` render the current frame; `dispose()` cleans up.
- `src/features/*`: one module per filter. `features/registry.ts` lists them.
- `src/services/time`: the exact ten-tick generator, UTC formatting, range validation and no-data gap detection.
- `src/services/geospatial`: Mercator-aligned grids, geodesic cell area, connected components, conservative IoU/containment tracking (merge/split/unobserved), and the US/Canada region filter.
- `src/components/map/overlayAdapter.ts`: the only code that touches Leaflet's drawing API. It diffs declarative overlay specs by id, tweens boxes between measured extents (250–500 ms, tied to playback speed), and handles label clutter.
- `src/state/store.ts`: a zustand store for the active filter, range, frames, playback, effects, layers and selection.

## Flood pipeline (per observation)

1. Classify water in the scene. **Real:** each 80 m NISAR sample is water if HH (and HV when it separates well) is below per-pass thresholds trained against JRC reference water and land; a ~0.55 km cell is water when at least half its samples are (see [server/README.md](server/README.md)). **Demo:** simulated.
2. Potential flood = water where JRC occurrence is below the persistent-water threshold (default 50%).
3. Remove regions smaller than the minimum size (default 16 cells, about 5 km²).
4. Label 4-connected regions and measure geodesic area, bounds and area-weighted centroid.
5. Track regions across observations. Links need IoU ≥ 0.15 or containment ≥ 0.5, plus nearness to the other region's measured extent. A region keeps its ID through a merge or split only if it holds ≥ 70% of the overlap; otherwise it gets a new ID that records its parents. Regions outside a scene's coverage are held as *unobserved*, not counted as disappeared.
6. Results are computed once per dataset and cached. Mask images are generated once per observation, not on every animation tick.

## NISAR passes on the base map

- **Where:** only when no data filter is selected. Turn on *Show NISAR passes on the timeline* in the sidebar.
- **Search:** queries NASA CMR (public, no login) over the app region (US & Canada boxes, as for the other filters) for the timeline range, newest first (pages fetched in parallel; a full week takes a few seconds), regardless of where the map is pointed. Frames that don't touch the region, or that sit across the antimeridian (western Aleutians), are dropped. Validated products are preferred over provisional ones of the same acquisition. Default range: the week ending 14 days ago, since products publish about a week after acquisition and recent passes keep filling in. Frames missing in the middle of a pass (not in NASA's catalog: not yet published or not recorded) are listed in the timeline status, e.g. *5 of 7 frames · 35, 36 not available*, along with any images that failed to load.
- **Timeline:** adjoining product frames from the same track, direction and minutes are grouped into one *pass*. Each pass is one observed frame at its real acquisition time, so play, step, scrub, speed and loop move pass by pass. Playback waits up to 8 s for a pass's images before moving on. Gaps longer than the nominal 12-day repeat are shown as no-data.
- **Map:** only radar images, no outlines: the current pass at full opacity and the previous pass faded behind it. With *Follow satellite* on (default) the camera frames each pass as the timeline moves; dragging the map turns following off until the button is pressed again. Long passes over Canada and the Arctic can span tens of degrees, so the camera zooms out for those.
- **Satellite follow mode:** a second choice next to *Follow passes*. Each timeline step is one image (frame, ~240 km) in the order NISAR took it (~35–40 s apart in reality, ~1 s per step at 1×). The camera stays zoomed in and moves image by image; the current pass builds up behind it and the previous pass fades. Thumbnails show instantly and full-resolution images (~4.7 MB each) swap in, with the next 3 prefetched, so 2–4× playback may wait on downloads. Missing frames are skipped and named in the status line.
- **Images:** ~100 px browse thumbnails while playing (fast), upgraded to the full browse images for the current pass when paused; the next 2 passes are prefetched. Interferograms use their browse KML bounds; backscatter images are fitted from the footprint to the swath's extreme pixels (residual checked), resampled to Web Mercator, with the black background made transparent.
- **Clicking:** an image opens a card with that frame's full browse image, acquisition time, orbit and Earthdata link. Clicking where no image is shown says *No NISAR data available here* and lists other passes in the range that do cover the spot. Dragging/zooming the map, clicking outside, or Escape closes the card.
- **Limitation:** browse images are display-stretched quick-looks. Measuring anything (flood extent, burn scars, displacement) needs the full HDF5 products, which require an Earthdata Login and server-side processing.

## Wildfire smoke and hotspots

- **Hotspots layer:** NASA GIBS WMS `VIIRS_NOAA20_Thermal_Anomalies_375m_All` for the shown UTC day (day and night detections). No key needed, so `VITE_FIRMS_MAP_KEY` is no longer used.
- **Smoke layer:** NOAA HMS daily smoke KML (light / medium / heavy), drawn as gray dot patterns that stay the same size at any zoom. NOAA sends no CORS header, so the app fetches `/proxy/hms/...`, which `vite.config.ts` rewrites to NOAA for `npm run dev` and `npm run preview`. **A static deployment needs the same rewrite** (e.g. a Netlify/Vercel redirect); without it the layer shows *Unavailable* in the stats.
- **Smoke drift (fire popup):** GOES-West (west of 105°W) or GOES-East GeoColor images every 30 min across local daytime via Worldview Snapshots, looped, plus Open-Meteo's 850 hPa (~1.5 km) wind near local noon as an arrow pointing where smoke would be carried. The loop is observed imagery; the arrow is a model and is labeled as such.

## Known limitations

- Real flood maps cover one area (St. Louis) and are prepared offline. Adding an area means adding it to `AOIS` in `server/flood_prep.py` and the matching grid in `baseline.ts`.
- Radar water classification misses flooded vegetation (it looks bright) and can confuse radar shadow or smooth surfaces with water. Passes image different parts of the area, so changes are measured only over area imaged by both.
- Flood regions are rendered as pixel-exact raster masks, about 0.55 km per cell. Vector polygon export isn't implemented yet.
- Earthquake and wildfire timeline frames are UTC-day aggregates. Each event's exact time appears in tooltips and the detail panel.
- The US/Canada region filter is approximate. Events right on the border or offshore may be included or excluded incorrectly.
