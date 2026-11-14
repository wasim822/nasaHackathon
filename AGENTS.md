# AGENTS.md — Earth Change Explorer

## Mission
Build an interactive, scientifically honest Earth-observation web app for NASA Space Apps Challenge 2026, **Dancing with the SARs**: https://www.spaceappschallenge.org/2026/challenges/dancing-with-the-sars/?tab=details.

The experience should let people **watch Earth change over time**, not just inspect static satellite images. Start with an interactive satellite basemap, then let users activate specialized filters (floods, wildfires, earthquakes, glacier movement, etc.) without leaving the map. Smooth, compelling animation is a deliberate product goal, but never misrepresent measurements.

## Agent operating rules
- Treat this document as product requirements and implementation guidance, not as a claim that any data or APIs already exist.
- Before major changes, inspect the existing codebase, identify the framework and conventions, and make an incremental plan. Reuse existing components, hooks, types, styles, and test infrastructure.
- Implement end-to-end working slices rather than attractive but inert controls. Every visible playback, layer, date, and tracking control must have an actual effect.
- Prefer small typed, testable components. Avoid tightly coupling science/data transformation logic to map rendering.
- Do not invent satellite observations, data precision, tracking identity, hazard classifications, or confidence values. Clearly mark demos, estimated data, and unavailable datasets.
- Preserve pan/zoom and user context when switching filters. Pause playback when changing filters, and release the old filter's overlays.
- Provide clear loading, empty, no-data, and error states. Never silently substitute synthetic records for real observations.
- Validate date ranges and interval calculations rigorously. Use real acquisition timestamps in charts, tooltips, and playback.
- Respect reduced-motion preferences, keyboard interaction, legibility, responsive layouts, and attribution/licensing requirements.
- When a requested dataset, service, or algorithm is unavailable, implement an explicit adapter or feature flag with a clearly identified demo mode; do not pretend it is production data.

## Technology direction
- **Frontend:** React + TypeScript.
- **Mapping:** Leaflet or Mapbox; choose based on the existing project. Use vector or WebGL layers when needed for fluid animation and large polygon sets.
- **Primary observations:** available NASA NISAR SAR products. Other reliable datasets are allowed where needed; every layer must identify its actual source.
- Keep the map library behind reusable components/adapters, and keep expensive geospatial preprocessing out of React render loops.
- Suggested modules (adapt to existing structure): `components/map`, `components/timeline`, `components/layout`, `features/flood`, `features/wildfire`, `features/earthquake`, `services/data`, `services/geospatial`, `types`.

## Main interface
### Satellite basemap
- Open to a clean, pan/zoomable **satellite map with no analysis filter selected**.
- Keep this basemap as the primary canvas in all modes.
- Provide sensible base-layer and attribution controls.

### Left sidebar: data filters
- Selectable categories: **Flood**, **Wildfire**, **Earthquake**, **Glacier Movement**, with extensibility for wetlands, vegetation, ground deformation, and other Earth-observation phenomena.
- Selecting a category changes only that category's overlays, relevant options, observation list, metrics, and timeline data. Do not navigate to a different page.
- Filters must plug into a common contract instead of duplicating map/playback components.
- Do not call a category implemented merely because its selector appears: label incomplete filters as coming soon or demo.

### Right sidebar: About the Satellite
- Place a three-line hamburger button in the **top-right**.
- Clicking it slides an independent About drawer in from the right; desktop width ~30–35%, responsive on mobile.
- Include a close X; support Escape and clicking outside. Keep the map visible when feasible.
- Do **not** change the active data filter or needlessly pause playback when opening this panel.
- For NISAR, cover:
  - Full name: **NASA–ISRO Synthetic Aperture Radar**; partners NASA and ISRO; launch July 30, 2025.
  - Plain-language SAR operation: radar pulses and reflections; observation in darkness and through clouds, with real limitations.
  - Applications: deformation/earthquakes, flooding, glacier/ice movement, forests/vegetation, wetlands.
  - L-band and S-band instruments, nominal ~12-day orbital repeat, and differences between revisit cadence and actual usable scene availability.
  - Source links: https://science.nasa.gov/mission/nisar/ , https://www.earthdata.nasa.gov/ , https://asf.alaska.edu/ .
- Make the drawer reusable for other missions such as Sentinel-1 or MODIS/VIIRS. Distinguish satellite data from earthquake catalogs, modeled products, historical water baselines, and other sources.

## Shared timeline — a defining feature
Place a **compact, persistent playback strip along the bottom** of the website. It must work with whichever filter is active.

### Timeline layout and exact ten-tick rule
- Render **exactly 10 visible major tick marks** on the selected date/time range at every zoom/scale and for every range length.
- Ticks span the selected interval **inclusively**: tick 1 represents the start; tick 10 represents the end. Their positions are evenly spaced in elapsed time, with 9 intervals between them. Labels should adapt to scale (months, dates, hours, minutes). An approximately Jan–Oct ten-month range should show a useful Jan-through-Oct progression when its actual endpoints align with those months; do not replace actual endpoints with fabricated dates.
- The **ten ticks are visual scale ticks, not a claim that there are ten satellite frames**. Real observation dates can be irregular and should appear as separate event/frame markers.
- At the left, show the active range compactly (for example, `Jan – Jun`), with sufficiently detailed dates available via tooltip/dialog. Clicking that label opens a **start/end date-time range popup**.
- Validate: start must be <= end; end must not precede start; dates must be valid; respect the chosen dataset's bounds or explain out-of-bounds selection. A zero-duration range needs an explicit single-time display strategy rather than division by zero.
- At the right, show playback controls and speed: **Previous Frame, Play/Pause, Next Frame (fast-forward/step), speed selection**, and loop toggle as appropriate. Available speeds: **0.5×, 1×, 2×, 4×**.
- Include a scrubber/current-time indicator. Scrubbing selects the applicable observation, updates all visible data and measurements, and pauses playback when appropriate.
- Format small ranges accurately (days/hours/minutes); handle timezone and daylight-saving boundaries consistently. Avoid relying on fixed month lengths.

### Playback behavior
- Default to **observed frames** sorted by their real acquisition timestamps.
- Play advances one available observation at a time, animating overlays, tracking shapes, and metrics together; pause stops immediately and preserves the current frame.
- Previous/Next moves exactly one available observation, never merely one visual tick.
- When reaching the end, stop unless loop is enabled. Filter changes reset the appropriate frame sequence and pause playback.
- If no observations occur within the chosen range, show a truthful no-data message, not a fake animation.
- Display observation dates, quality metadata when present, and important detected changes on the timeline. An optional small chart immediately above the bar should share its time cursor.
- **No-data gaps must be visible**. If a future mode estimates intermediate frames, explicitly mark them `Estimated`, visualize uncertainty and distinguish them from measured scenes. Smooth transitions between real frames are visual interpolation only, not measured continuous change.

## Shared filter architecture
Define a consistent TypeScript interface (names may be adapted) with:
- `id`, `label`, `availableLayers`, `sourceAttribution`
- retrieval of actual dated observations for a region and selected interval
- per-frame overlays and annotations
- optional tracked regions/events and their histories
- statistics and charts tied to current frame
- cleanup on deactivation
- loading/no-data/error state

Prefer a shared state owner for active filter, map extent, time range, current observation, playback status/speed/loop, selected tracked region, overlay visibility, and reduced-motion settings. Avoid relying on frame indexes as dates. Cache processed geospatial data, and cancel stale requests when filters, regions, or date ranges change.

## Flood filter — detailed priority feature
### Data and classification
- Render **permanent water** separately from **potential newly flooded land** and from **receded floodwater**.
- Candidate baselines: JRC Global Surface Water, HydroRIVERS, HydroLAKES. These are reference layers, not NISAR measurements.
- Detect water from an available SAR-derived product, or derive an appropriately qualified classification from radar observations where feasible. Compare against historical water occurrence to identify **potential flooding**.
- Suggested visual legend:
  - Permanent rivers/lakes: dark blue
  - Potential newly flooded land: translucent cyan/teal
  - Receded water: muted orange
  - Normal land: underlying map
  - No data: transparent or hatched
- Each layer gets a working visibility toggle. Do not call a wet surface or dark radar return a confirmed flood without appropriate validation. Flag uncertain classifications arising from vegetation, terrain, urban surfaces, rough water, or wet soils.

### Connected flood blobs
For each actual observation, when adequate raster/classification data exists:
1. Align and preprocess the SAR-derived water classification and historical baseline.
2. Produce a potential-flood mask; remove configurable small-pixel noise.
3. Identify connected components representing distinct flood regions.
4. Extract geographic polygon, centroid, geographic bounding box, geodesic area, date, and quality metadata for each blob.
5. Track components across dates using spatial overlap/IoU, centroid proximity, shape and geographic constraints, with conservative matching thresholds.
6. Assign stable identifiers such as `F-001` **only when tracking is reliable**. Record events `appeared`, `expanded`, `contracted`, `stable`, `merged`, `split`, `disappeared`, including parent/child identities after merge/split.
7. Persist or cache per-observation results; do not re-run blob detection on every visual animation tick.

Avoid equating centroid shifts with floodwater flow velocity. Unmatched regions should remain unmatched rather than being forcibly assigned an existing ID.

### Optional tracking effects
Support a control named **Tracking Effect** with three modes:
- **Off:** pure map, permanent water, flood layer, statistics; no boxes, IDs, or trails.
- **Clean (default):** thin mint-green boxes, sparse small IDs, short faint amber trails, restrained animations.
- **Cinematic:** brighter numbered boxes, orange/amber animated centroid-history trails, progressive line drawing, brief appearance/change highlights and stronger (still readable) transitions.

Fine-grained toggles: **Bounding Boxes, Tracking IDs, Tracking Trails, Centroids, Trail Length, Highlight Selected Blob, Reduce Motion**. Turning effects off must not change actual science calculations or suppress core flood polygons. Effects are optional, not preconditions for seeing data.

Visual guidance:
- Boxes should match measured polygon bounds; roughly 1–1.5px mint outlines, transparent fill, subtle glow/corner brackets where appropriate.
- Trails connect **historical centroids only**, fade older segments and usually show the last **3–5 actual observations**. Selected blobs may expose full history.
- Transition boxes and centroid markers smoothly (roughly **250–500ms**, tied to speed); fade entry/exit; crossfade complex polygons rather than morphing through misleading shapes.
- Animate expansion/contraction via measured before/after extents; never imply physically measured continuous movement between acquisitions.
- Control clutter by hiding overlapping labels, deprioritizing tiny regions at low zoom, and emphasizing selected/large regions.
- In both Clean and Cinematic mode the underlying map and scientific overlays must remain readable.

### Flood analytics and interactions
- Stats should update on every selected **observation**, including total detected water, potentially flooded area (km²), change from previous observation (% and area), change from selected baseline, number of active blobs, largest blob, and maximum observed extent.
- Clicking a flood polygon/box opens blob detail: ID, observation date, area, gained/lost area, first/last seen, tracking state, bounds, area-vs-time graph, confidence/quality **only if supported**.
- Plot real timestamps on the horizontal axis, not equally spaced fake days.
- **Highlight Changes** toggle: newly flooded brighter cyan, recession muted orange, unchanged water normal, brief restrained emphasis on major new regions.
- Timeline event indicators: first appearances, sudden expansion, maximum flooded extent, recession, merges, splits.
- Optional later comparison: baseline date vs current date using draggable swipe divider, differences, extent and percentage changes, optional box comparison.

## Wildfire filter
- Use the same basemap, sidebar, ten-tick timeline, playback, statistics, and **Off / Clean / Cinematic** effect modes.
- Provide distinct layers as supported by the actual source: **active hotspots**, **mapped fire perimeters**, **burned area/burn scars**, tracked regions, and changes between observations.
- Wildfire blobs represent connected **regions of a clearly stated data type** (e.g., clustered hotspots, perimeter, or burned area). Never imply a thermal hotspot cluster is a measured fire perimeter.
- Track region appearance, growth, contraction, merger, split, and disappearance with IDs, polygons/boxes, centroids, areas, and observation history where scientifically reasonable.
- Playback updates wildfire overlays, boxes, trails, and area/count metrics together. In **Off** mode, preserve map-based wildfire data without tracking effects.
- NISAR may be relevant to landscape-change analysis, but **active hotspot detection commonly relies on separate sensors, such as MODIS/VIIRS**. Attribute these separately and accurately; do not label every wildfire layer as NISAR-derived.

## Other filters: extensible, evidence-based
- **Earthquake:** offer epicenter/event markers and optional pulses tied to documented earthquake catalogs; if SAR interferometric displacement is available, show ground deformation separately with observation dates. Do not present catalog event times as NISAR acquisitions.
- **Glacier Movement:** visualize measured ice displacement/change across observations with source, unit, temporal baseline, and uncertainty.
- **Wetlands/vegetation/other:** add as independent modules using applicable source-specific processing.
- Provide a functional shell/disabled state for filters that do not yet have valid data and analysis logic.

## Scientific accuracy and provenance — non-negotiable
- Record dataset, instrument, product type, spatial/temporal resolution, acquisition time, geographic coverage, processing method, and uncertainty when available.
- A nominal NISAR orbital repeat of ~12 days is **not** a promise of an observation every 12 days everywhere.
- No synthetic or interpolated scene should be labeled `Observed`. Default mode must use real observations; missing data must remain missing.
- Differences between before/after radar observations can support change detection but are not automatically verified causes or hazard extents.
- Give users plain-language legends and tooltips distinguishing observed, derived, estimated, and external reference layers.
- Do not render fabricated metrics in production. Use explicitly labeled fixture/demo data while developing interactions.

## Design, performance, and accessibility
- Visual identity: modern satellite analysis, clean dark/translucent controls, legible typography, muted basemap, cyan water overlays, mint boxes, subtle orange trails, polished animations.
- Provide a responsive desktop/mobile layout; drawers and playback bar must not block necessary map controls.
- Use appropriate layer-ordering and geographic projection handling; keep boxes and trails geographically anchored as users pan and zoom.
- Optimize large data using tiles, geometry simplification by zoom, memoization, worker/server processing where appropriate, and precomputed tracking.
- Add accessible control names, focus handling, keyboard operability, contrast, and a reduced-motion path. Avoid continuous flashing.
- Preserve map responsiveness during playback and while changing controls.

## Delivery order
1. **Application shell:** React/TypeScript, satellite map, independent left filter navigation and right About-NISAR drawer, sources/attribution.
2. **Shared timeline:** compact bottom strip, exact ten major ticks, click-to-edit valid start/end range, observed-frame navigation, play/pause/speed/loop, date display, empty states.
3. **Flood MVP:** real/clearly demo-labeled observation pipeline; permanent-water reference; potential flood polygons; connected blobs; stable tracking IDs where possible; basic statistics, selection details, and Clean/Off effects.
4. **Flood animation:** synchronized box transitions, short centroid trails, highlight changes, meaningful timeline events; Cinematic mode.
5. **Wildfire MVP:** distinct credible data-source adapter and layers, optional tracked blobs, synchronized timeline and effects.
6. **Other filters and advanced tools:** earthquake/glacier modules, before-after comparisons, exports, alerting, modeled estimated frames only with evidence/uncertainty.

## Acceptance checklist
- [ ] App opens on interactive satellite basemap without any analysis filter activated.
- [ ] Left filter selection changes layers without navigating or recreating the shared app shell.
- [ ] Right hamburger About drawer works independently on mobile and desktop.
- [ ] Bottom timeline always shows **exactly ten major ticks**, with start/end accurately positioned; ticks adapt from months down to hours/minutes.
- [ ] Clicking the visible date-range label opens a range picker that rejects end-before-start.
- [ ] Playback controls operate on **actual available observation frames**, not on the ten visual ticks.
- [ ] Play/pause, step forward/back, speed, scrub, loop, and date/stat/map synchronization work.
- [ ] Missing observations are not fabricated; estimates are explicitly labeled.
- [ ] Flood filter separates permanent water from potentially flooded land, with effective layer toggles.
- [ ] Flood blobs use true detected boundaries and conservative persistent tracking IDs.
- [ ] Off / Clean / Cinematic modes independently control overlay effects without altering measurements.
- [ ] Selected flood blobs expose history, extent, change, and quality where available.
- [ ] Wildfire mode distinguishes hotspots from mapped extents and does not misattribute sources.
- [ ] Animations look polished while preserving geographic and scientific meaning.
- [ ] No inert UI, uncaught data failures, broken responsive layouts, or major playback lag.
- [ ] Relevant tests pass, particularly ten-tick generation, interval validation, irregular timestamps, playback bounds, filter teardown, and effect toggles.

## Definition of done for agent changes
Before declaring a feature complete, exercise its main user flow, run the repository's lint/typecheck/test/build commands where present, and report exactly what was implemented, which real data sources were connected, what remains demo/placeholder, and any known limitations. Do not claim acceptance requirements pass without verification.
