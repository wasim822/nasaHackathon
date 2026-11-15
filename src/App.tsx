import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './components/map/MapView';
import { LOCATOR_SELECT_ID, locatorOverlay, shouldAutoFit } from './components/map/locator';
import { Timeline } from './components/timeline/Timeline';
import { FilterSidebar } from './components/layout/FilterSidebar';
import { EffectsPanel, LayerList, MapLegend, StatsPanel } from './components/layout/FilterPanel';
import { AboutDrawer } from './components/layout/AboutDrawer';
import { FILTERS, getFilter } from './features/registry';
import { selectReducedMotion, useAppStore } from './state/store';
import { frameDelayMs, transitionMs } from './services/playback';
import type { FrameContext, LatLng, Observation, OverlaySpec } from './types';
import { NISAR_IMAGE_WAIT_MS, frameSummary, sceneDateText, useNisar } from './hooks/useNisar';
import { NisarPanel } from './components/layout/NisarPanel';
import { NisarPopup, type NisarPopupContent } from './components/layout/NisarPopup';
import { type NisarFrameStep, type NisarPass, missingFrames, passBounds, scenesAt } from './services/data/nisar';

/** One timeline frame per real NISAR pass. */
function passObservation(p: NisarPass): Observation {
  return {
    id: p.id,
    time: p.time,
    kind: 'observed',
    label: `NISAR ${p.product} · ${p.direction ?? ''} T${p.track ?? '?'} · ${p.scenes.length} frame${p.scenes.length > 1 ? 's' : ''}`,
    quality: { Status: p.status, Orbit: `${p.direction ?? '—'} · track ${p.track ?? '?'}`, Acquired: sceneDateText(p), Frames: String(p.scenes.length) },
  };
}

/** One timeline frame per NISAR image (satellite follow mode), at its real acquisition time. */
function frameObservation({ scene: sc }: NisarFrameStep): Observation {
  return {
    id: sc.id,
    time: sc.product === 'GUNW' ? sc.time : sc.start,
    kind: 'observed',
    label: `NISAR ${sc.product} · ${sc.direction ?? ''} T${sc.track ?? '?'} · frame ${sc.frame ?? '?'}`,
    quality: { Status: sc.status, Orbit: `${sc.direction ?? '—'} · track ${sc.track ?? '?'} · frame ${sc.frame ?? '?'}`, Acquired: sceneDateText(sc) },
  };
}

type PopupState = { kind: 'filter'; id: string } | { kind: 'nisar'; content: NisarPopupContent };

export default function App() {
  const s = useAppStore();
  const reducedMotion = useAppStore(selectReducedMotion);
  const [now] = useState(() => Date.now());
  const filter = getFilter(s.activeFilterId);
  const options = filter ? (s.filterOptions[filter.id] ?? filter.defaultOptions) : null;
  // With no filter the timeline still shows its ten-tick ruler over a default window: one week
  // ending 14 days ago: NISAR products are published about a week after acquisition and recent
  // passes keep filling in for a while after that.
  const [idleRange, setIdleRange] = useState(() => ({ start: now - 21 * 864e5, end: now - 14 * 864e5 }));
  // On the base map, NISAR passes over the view drive the shared timeline.
  const stripMode = !filter && s.nisarEnabled;
  const timelineRange = s.range ?? idleRange;

  // System reduced-motion preference.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    s.setSystemReduceMotion(mq.matches);
    const on = (e: MediaQueryListEvent) => useAppStore.getState().setSystemReduceMotion(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectFilter = useCallback(
    (id: string | null) => {
      const state = useAppStore.getState();
      if (id === state.activeFilterId) return;
      getFilter(state.activeFilterId)?.dispose?.();
      const next = getFilter(id);
      const layers = Object.fromEntries((next?.availableLayers ?? []).map((l) => [l.id, l.defaultVisible && !l.unavailableReason]));
      state.activateFilter(id, next ? next.defaultRange(now) : null, layers, next?.defaultOptions ?? null);
    },
    [now],
  );

  // Data loading: cancel stale requests when filter, range or options change.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!filter || !s.range || filter.status === 'coming-soon') return;
    const ctrl = new AbortController();
    const store = useAppStore.getState();
    store.beginLoad();
    filter
      .load({ range: s.range, options, signal: ctrl.signal })
      .then((r) => {
        if (!ctrl.signal.aborted) useAppStore.getState().finishLoad(r.observations, r.data, r.notices);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        useAppStore.getState().failLoad(/fetch|network/i.test(msg) ? `Network error contacting the data service (${msg}).` : msg);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, s.range, options, reloadKey]);


  // Filters with lazily loaded extras ask for a redraw when those arrive.
  const [extrasVersion, bumpExtras] = useState(0);
  useEffect(() => filter?.subscribe?.(() => bumpExtras((n) => n + 1)), [filter]);

  const ready = !!filter && s.loadState === 'ready' && s.data != null && s.currentIndex >= 0;
  const frameCtx: FrameContext<any, any> | null = useMemo(
    () =>
      ready
        ? {
            data: s.data,
            observations: s.observations,
            index: s.currentIndex,
            effects: s.effects,
            layers: s.layerVisibility,
            selectedId: s.selectedId,
            reducedMotion,
            options,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, s.data, s.observations, s.currentIndex, s.effects, s.layerVisibility, s.selectedId, reducedMotion, options, extrasVersion],
  );

  const overlays: OverlaySpec[] = useMemo(() => (filter && frameCtx ? filter.overlays(frameCtx) : []), [filter, frameCtx]);
  const stats = useMemo(() => (filter && frameCtx ? filter.stats(frameCtx) : []), [filter, frameCtx]);
  const events = useMemo(
    () => (filter?.timelineEvents && ready ? filter.timelineEvents(s.data, s.observations) : []),
    [filter, ready, s.data, s.observations],
  );
  const chart = useMemo(() => (filter?.chart && ready ? filter.chart(s.data, s.observations) : null), [filter, ready, s.data, s.observations]);
  const extent = useMemo(() => (filter?.extent && s.data != null ? filter.extent(s.data) : null), [filter, s.data]);
  // When a filter's (new) data area loads, go there if it would otherwise be off-screen or a speck.
  // Keyed by the area itself, so frame changes never move the map; a different area (e.g. another
  // data source) does.
  const extentKey = extent ? `${filter?.id}|${extent.south},${extent.west},${extent.north},${extent.east}` : '';
  useEffect(() => {
    if (!extentKey) return;
    const st = useAppStore.getState();
    if (shouldAutoFit(extent, st.viewBounds, st.viewZoom)) st.requestFit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extentKey]);

  // Real NISAR passes over the view (base map only): each pass is a timeline frame drawn as a strip.
  const nisar = useNisar({
    enabled: stripMode,
    product: s.nisarProduct,
    range: timelineRange,
    index: stripMode ? s.currentIndex : -1,
    opacity: s.nisarOpacity,
    playing: s.playing,
    mode: s.nisarMode,
  });
  const waitingForImages = stripMode && s.playing && !nisar.currentReady;
  // Say when the current pass has holes (frames not in NASA's catalog) or images that failed.
  const currentPass = stripMode ? nisar.current : undefined;
  const currentPassNote = currentPass && (missingFrames(currentPass).length || nisar.currentFailed)
    ? `Pass T${currentPass.track ?? '?'} · ${frameSummary(currentPass)}${nisar.currentFailed ? ` · ${nisar.currentFailed} image${nisar.currentFailed > 1 ? 's' : ''} failed to load` : ''}`
    : undefined;

  // Playback clock: advances one actual observation per tick. For NISAR passes it waits for the
  // pass's images (up to NISAR_IMAGE_WAIT_MS) so the camera never races ahead of blank map.
  useEffect(() => {
    if (!s.playing) return;
    const id = window.setTimeout(() => useAppStore.getState().tick(), waitingForImages ? NISAR_IMAGE_WAIT_MS : frameDelayMs(s.speed));
    return () => window.clearTimeout(id);
  }, [s.playing, s.speed, s.currentIndex, waitingForImages]);

  // Follow the satellite: frame each pass (or, in satellite follow mode, each image) as the timeline moves.
  useEffect(() => {
    if (!stripMode || !s.nisarFollow) return;
    const target = nisar.currentScene ? { scenes: [nisar.currentScene] } : nisar.current;
    if (target) useAppStore.getState().requestFit(passBounds(target));
  }, [stripMode, s.nisarFollow, nisar.current, nisar.currentScene]);
  // Feed passes into the shared timeline/playback state (filters own it otherwise).
  useEffect(() => {
    if (!stripMode) return;
    const st = useAppStore.getState();
    if (nisar.state === 'loading') st.beginLoad();
    else if (nisar.state === 'error') st.failLoad(`NISAR search failed: ${nisar.error}`);
    else if (nisar.state === 'ready') {
      // Keep the same moment when the view changes and the passes are re-searched.
      const keep = st.observations[st.currentIndex]?.time ?? null;
      const obs = s.nisarMode === 'satellite' ? nisar.frames.map(frameObservation) : nisar.passes.map(passObservation);
      st.finishLoad(obs, nisar.passes, [], keep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripMode, nisar.state, nisar.passes, nisar.frames, nisar.error, s.nisarMode]);
  // Turning NISAR off on the base map clears its frames.
  const wasStrip = useRef(false);
  useEffect(() => {
    if (wasStrip.current && !stripMode && !useAppStore.getState().activeFilterId) useAppStore.getState().activateFilter(null, null, {}, null);
    wasStrip.current = stripMode;
  }, [stripMode]);
  const locator = useMemo(
    () => (filter ? locatorOverlay(extent, s.viewZoom, filter.label, reducedMotion) : null),
    [filter, extent, s.viewZoom, reducedMotion],
  );
  const allOverlays = useMemo(() => [...nisar.overlays, ...overlays, ...(locator ? [locator] : [])], [nisar.overlays, overlays, locator]);
  const onOverlaySelect = useCallback((id: string) => {
    if (id === LOCATOR_SELECT_ID) {
      useAppStore.getState().requestFit(null); // null → fit the active filter's data extent
    } else {
      useAppStore.getState().select(id);
      // Opening a filter's popup pauses playback so the card and map hold still.
      if (getFilter(useAppStore.getState().activeFilterId)?.Popup) useAppStore.getState().setPlaying(false);
      setPopup({ kind: 'filter', id }); // shown only if the active filter defines a Popup
    }
  }, []);

  // Floating map popup (a fire's satellite image, a NISAR strip): closes on map drag/zoom, outside click, Escape.
  const [popup, setPopup] = useState<PopupState | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const closePopup = useCallback(() => setPopup(null), []);
  useEffect(() => {
    if (!popup) return;
    const down = (e: PointerEvent) => {
      if (!popupRef.current?.contains(e.target as Node)) setPopup(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopup(null);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [popup]);
  // Switching filters or turning NISAR off closes any popup.
  useEffect(() => setPopup(null), [s.activeFilterId, stripMode]);

  /** Show an observation (pauses playback) without closing an open popup. */
  const showFrame = useCallback((index: number) => {
    useAppStore.getState().setPlaying(false);
    useAppStore.getState().setIndex(index);
  }, []);
  const goToIndex = useCallback((index: number) => {
    useAppStore.getState().setPlaying(false);
    useAppStore.getState().setIndex(index);
    setPopup(null);
  }, []);
  /** Jump to a pass (its first image in satellite follow mode). */
  const goToPass = (passIndex: number) => goToIndex(nisar.obsIndexOfPass(passIndex));

  const onMapClick = useCallback(
    (at: LatLng) => {
      setPopup(null);
      if (stripMode) {
        // Topmost image on screen under the click: the current pass, then the faded previous one.
        if (!nisar.current) return;
        const passes = nisar.passes;
        const hit = scenesAt([...nisar.drawn].reverse(), at)[0];
        if (hit) {
          setPopup({ kind: 'nisar', content: { kind: 'scene', pass: hit.pass, scene: hit.scene, isCurrent: hit.pass.id === nisar.current.id } });
        } else {
          // Other images in the range that cover the spot, as timeline indexes to jump to.
          const drawnIds = new Set(nisar.drawn.flatMap((p) => p.scenes.map((sc) => sc.id)));
          const elsewhere = scenesAt(passes, at)
            .filter((h) => !drawnIds.has(h.scene.id))
            .map((h) => {
              const passIndex = passes.indexOf(h.pass);
              const frameIndex = s.nisarMode === 'satellite' ? nisar.frames.findIndex((f) => f.scene.id === h.scene.id) : -1;
              return { pass: h.pass, index: frameIndex >= 0 ? frameIndex : nisar.obsIndexOfPass(passIndex) };
            });
          setPopup({ kind: 'nisar', content: { kind: 'none', at, range: timelineRange, elsewhere } });
        }
        return;
      }
      if (!filter?.hitTest || !frameCtx) {
        if (useAppStore.getState().selectedId) useAppStore.getState().select(null);
        return;
      }
      const hit = filter.hitTest(frameCtx, at);
      useAppStore.getState().select(hit);
      if (hit && filter.Popup) {
        useAppStore.getState().setPlaying(false);
        setPopup({ kind: 'filter', id: hit });
      }
    },
    [filter, frameCtx, stripMode, nisar, s.nisarMode, timelineRange],
  );

  const closeAbout = useCallback(() => useAppStore.getState().closeAbout(), []);
  const Detail = filter?.Detail;
  const Options = filter?.Options;
  const Popup = filter?.Popup;

  return (
    <div className={`app ${reducedMotion ? 'reduce-motion' : ''} ${s.sidebarOpen ? 'sidebar-open' : ''} ${s.nisarProduct === 'GCOV' && s.nisarColor === 'gray' ? 'radar-gray' : ''}`}>
      <MapView
        overlays={allOverlays}
        transitionMs={transitionMs(s.speed, reducedMotion)}
        baseLayer={s.baseLayer}
        showLabels={s.showLabels}
        fitBounds={s.fitTarget ?? extent}
        fitRequest={s.fitRequest}
        reducedMotion={reducedMotion}
        onSelect={onOverlaySelect}
        onMapClick={onMapClick}
        onViewChange={(b, z) => useAppStore.getState().setView(b, z)}
        onUserMove={closePopup}
        onUserDrag={() => stripMode && useAppStore.getState().setNisarFollow(false)}
      />

      {filter && filter.status !== 'coming-soon' && <MapLegend filter={filter} visibility={s.layerVisibility} options={options} />}

      {popup?.kind === 'filter' && Popup && frameCtx && popup.id === s.selectedId && (
        <div ref={popupRef} className="map-popup" role="dialog" aria-label={`${filter!.label} satellite image`}>
          <Popup {...frameCtx} onClose={closePopup} onIndex={showFrame} />
        </div>
      )}
      {popup?.kind === 'nisar' && stripMode && (
        <div ref={popupRef} className="map-popup" role="dialog" aria-label={popup.content.kind === 'scene' ? 'NISAR radar image' : 'No NISAR data here'}>
          <NisarPopup content={popup.content} onClose={closePopup} onGoTo={goToIndex} />
        </div>
      )}

      <FilterSidebar
        filters={FILTERS}
        activeId={s.activeFilterId}
        open={s.sidebarOpen}
        onToggleOpen={() => s.setSidebarOpen(!s.sidebarOpen)}
        onSelect={selectFilter}
        loadState={s.loadState}
        footer={
          <div className="basemap">
            <span className="small muted">Basemap</span>
            <div className="seg small-seg" role="radiogroup" aria-label="Basemap style">
              <button role="radio" aria-checked={s.baseLayer === 'satellite'} className={s.baseLayer === 'satellite' ? 'on' : ''} onClick={() => s.setBaseLayer('satellite')}>Satellite</button>
              <button role="radio" aria-checked={s.baseLayer === 'satellite-muted'} className={s.baseLayer === 'satellite-muted' ? 'on' : ''} onClick={() => s.setBaseLayer('satellite-muted')}>Muted</button>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={s.showLabels} onChange={(e) => s.setShowLabels(e.target.checked)} />
              Place labels
            </label>
          </div>
        }
      >
        {!filter && (
          <div className="intro">
            <p>Pan and zoom the satellite map, then choose a data filter to watch change over time.</p>
            <p className="small muted">Every layer is labelled with its real source. Demo data is always marked <span className="status status-demo">Demo</span>.</p>
          </div>
        )}
        {filter && options !== null && (
          <div className="filter-panel">
            <p className="summary">{filter.summary}</p>
            <div className="row-actions">
              <button className="btn" onClick={() => s.requestFit(null)} disabled={!extent}>Go to data</button>
              {filter.missionId && (
                <button className="btn ghost" onClick={() => s.openAbout(filter.missionId)}>About the source</button>
              )}
            </div>

            {s.loadState === 'loading' && <div className="state-msg">Loading observations…</div>}
            {s.loadState === 'error' && (
              <div className="state-msg error" role="alert">
                <strong>Data could not be loaded.</strong>
                <div className="small">{s.loadError}</div>
                <button className="btn" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
              </div>
            )}
            {s.loadState === 'empty' && (
              <div className="state-msg">
                <strong>No observations in the selected range.</strong>
                <div className="small">Nothing is animated because nothing was observed. Change the date range from the timeline.</div>
              </div>
            )}
            {s.notices.map((n) => (
              <div key={n} className="notice">{n}</div>
            ))}

            {Detail && frameCtx && s.selectedId && (
              <Detail {...frameCtx} onClose={() => s.select(null)} onIndex={showFrame} />
            )}

            {stats.length > 0 && (
              <section>
                <h2 className="section-title">This observation</h2>
                <StatsPanel stats={stats} />
              </section>
            )}

            <section>
              <h2 className="section-title">Layers</h2>
              <LayerList layers={filter.availableLayers} visibility={s.layerVisibility} onToggle={s.setLayerVisible} />
            </section>

            {Options && (
              <section>
                <h2 className="section-title">Options</h2>
                <Options options={options} onChange={(o: unknown) => s.setFilterOptions(filter.id, o)} onRange={s.setRange} />
              </section>
            )}

            {filter.supportsTracking && (
              <section>
                <h2 className="section-title">Tracking Effect</h2>
                <EffectsPanel
                  filter={filter}
                  effects={s.effects}
                  reduceMotion={reducedMotion}
                  systemReduceMotion={s.systemReduceMotion}
                  onMode={s.setEffectMode}
                  onToggle={s.setEffect}
                  onReduceMotion={s.setUserReduceMotion}
                />
              </section>
            )}

            <section>
              <h2 className="section-title">Sources</h2>
              <ul className="sources">
                {filter.sourceAttribution.map((src) => (
                  <li key={src.name}>
                    {src.isDemo && <span className="status status-demo">Demo</span>}{' '}
                    {src.url ? <a href={src.url} target="_blank" rel="noreferrer">{src.name}</a> : <strong>{src.name}</strong>}
                    <div className="small muted">{src.type}</div>
                    {src.detail && <div className="small">{src.detail}</div>}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
        {!filter && (
          <NisarPanel
            enabled={s.nisarEnabled}
            product={s.nisarProduct}
            opacity={s.nisarOpacity}
            state={nisar.state}
            error={nisar.error}
            passes={nisar.passes}
            currentIndex={stripMode ? nisar.passIndex : -1}
            mode={s.nisarMode}
            onMode={s.setNisarMode}
            follow={s.nisarFollow}
            color={s.nisarColor}
            onFollow={s.setNisarFollow}
            onColor={s.setNisarColor}
            truncated={nisar.truncated}
            imageStatus={nisar.imageStatus}
            onEnabled={s.setNisarEnabled}
            onProduct={s.setNisarProduct}
            onOpacity={s.setNisarOpacity}
            onGoTo={goToPass}
          />
        )}
      </FilterSidebar>

      <button className="hamburger" onClick={() => (s.aboutOpen ? s.closeAbout() : s.openAbout(filter?.missionId))} aria-label="About the satellite" aria-expanded={s.aboutOpen}>
        <span />
        <span />
        <span />
      </button>

      <AboutDrawer open={s.aboutOpen} missionId={s.aboutMissionId} onMission={(id) => s.openAbout(id)} onClose={closeAbout} />

      {s.loadState === 'ready' && s.observations.some((o) => o.kind === 'demo-observed') && (
        <div className="demo-banner" role="status">DEMO observations — simulated, not real NISAR data</div>
      )}

      {filter?.timeline === false ? (
        <footer className="timeline timeline-off" aria-label="Timeline (off)">
          <div className="tl-off">{`Timeline off for ${filter.label} · pick a date in the sidebar under Options`}</div>
        </footer>
      ) : (
      <Timeline
        range={timelineRange}
        bounds={filter?.dataBounds?.(now)}
        defaultRange={filter?.defaultRange(now)}
        now={now}
        observations={s.observations}
        currentIndex={s.currentIndex}
        playing={s.playing}
        speed={s.speed}
        loop={s.loop}
        loadState={s.loadState}
        events={events}
        chart={chart}
        cadenceMs={filter ? filter.expectedCadenceMs : stripMode ? 12 * 864e5 : undefined}
        filterActive={!!filter || stripMode}
        statusNote={waitingForImages ? 'Loading NISAR images for this pass…' : currentPassNote}
        onRangeChange={(r) => (filter ? s.setRange(r) : setIdleRange(r))}
        onIndex={s.setIndex}
        onStep={s.step}
        onPlayPause={s.togglePlaying}
        onPause={() => s.setPlaying(false)}
        onSpeed={s.setSpeed}
        onLoop={s.setLoop}
      />
      )}
    </div>
  );
}
