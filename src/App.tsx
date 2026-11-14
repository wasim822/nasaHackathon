import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView } from './components/map/MapView';
import { Timeline } from './components/timeline/Timeline';
import { FilterSidebar } from './components/layout/FilterSidebar';
import { EffectsPanel, LayerList, StatsPanel } from './components/layout/FilterPanel';
import { AboutDrawer } from './components/layout/AboutDrawer';
import { FILTERS, getFilter } from './features/registry';
import { selectReducedMotion, useAppStore } from './state/store';
import { frameDelayMs, transitionMs } from './services/playback';
import type { FrameContext, LatLng, OverlaySpec } from './types';
import { useNisar } from './hooks/useNisar';
import { NisarPanel } from './components/layout/NisarPanel';

export default function App() {
  const s = useAppStore();
  const reducedMotion = useAppStore(selectReducedMotion);
  const [now] = useState(() => Date.now());
  const filter = getFilter(s.activeFilterId);
  const options = filter ? (s.filterOptions[filter.id] ?? filter.defaultOptions) : null;
  // With no filter the timeline still shows its ten-tick ruler over a default window.
  const [idleRange, setIdleRange] = useState(() => ({ start: now - 30 * 864e5, end: now }));
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

  // Playback clock: advances one actual observation per tick.
  useEffect(() => {
    if (!s.playing) return;
    const id = window.setTimeout(() => useAppStore.getState().tick(), frameDelayMs(s.speed));
    return () => window.clearTimeout(id);
  }, [s.playing, s.speed, s.currentIndex]);

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
    [ready, s.data, s.observations, s.currentIndex, s.effects, s.layerVisibility, s.selectedId, reducedMotion, options],
  );

  const overlays: OverlaySpec[] = useMemo(() => (filter && frameCtx ? filter.overlays(frameCtx) : []), [filter, frameCtx]);
  const stats = useMemo(() => (filter && frameCtx ? filter.stats(frameCtx) : []), [filter, frameCtx]);
  const events = useMemo(
    () => (filter?.timelineEvents && ready ? filter.timelineEvents(s.data, s.observations) : []),
    [filter, ready, s.data, s.observations],
  );
  const chart = useMemo(() => (filter?.chart && ready ? filter.chart(s.data, s.observations) : null), [filter, ready, s.data, s.observations]);
  const extent = useMemo(() => (filter?.extent && s.data != null ? filter.extent(s.data) : null), [filter, s.data]);

  // Real NISAR imagery, independent of the active filter.
  const refTime =
    s.observations[s.currentIndex]?.time ?? (s.range ? s.range.end : timelineRange.end);
  const nisar = useNisar({
    enabled: s.nisarEnabled,
    product: s.nisarProduct,
    view: s.viewBounds,
    zoom: s.viewZoom,
    range: timelineRange,
    refTime,
    pinnedId: s.nisarPinnedId,
    opacity: s.nisarOpacity,
    mode: s.nisarMode,
  });
  const allOverlays = useMemo(() => [...nisar.overlays, ...overlays], [nisar.overlays, overlays]);
  const nisarMarkers = useMemo(
    () => nisar.scenes.map((sc) => ({ id: sc.id, time: sc.time, label: `${sc.product} ${sc.status} · ${sc.direction ?? ''} T${sc.track ?? '?'}`, active: nisar.visible.some((v) => v.id === sc.id) })),
    [nisar.scenes, nisar.visible],
  );
  const onOverlaySelect = useCallback((id: string) => {
    if (id.startsWith('nisar:')) {
      const sid = id.slice(6);
      useAppStore.getState().pinNisar(useAppStore.getState().nisarPinnedId === sid ? null : sid);
      useAppStore.getState().setSidebarOpen(true);
    } else useAppStore.getState().select(id);
  }, []);

  const onMapClick = useCallback(
    (at: LatLng) => {
      if (!filter?.hitTest || !frameCtx) {
        if (useAppStore.getState().selectedId) useAppStore.getState().select(null);
        return;
      }
      useAppStore.getState().select(filter.hitTest(frameCtx, at));
    },
    [filter, frameCtx],
  );

  const closeAbout = useCallback(() => useAppStore.getState().closeAbout(), []);
  const Detail = filter?.Detail;
  const Options = filter?.Options;

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
      />

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
              <Detail {...frameCtx} onClose={() => s.select(null)} />
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
        <NisarPanel
          enabled={s.nisarEnabled}
          product={s.nisarProduct}
          opacity={s.nisarOpacity}
          state={nisar.state}
          error={nisar.error}
          scenes={nisar.scenes}
          visible={nisar.visible}
          fallback={nisar.fallback}
          mode={s.nisarMode}
          color={s.nisarColor}
          onMode={s.setNisarMode}
          onColor={s.setNisarColor}
          truncated={nisar.truncated}
          pinnedId={s.nisarPinnedId}
          refTime={refTime}
          imageStatus={nisar.imageStatus}
          onEnabled={s.setNisarEnabled}
          onProduct={s.setNisarProduct}
          onOpacity={s.setNisarOpacity}
          onPin={s.pinNisar}
          onZoomTo={(sc) => {
            const lats = sc.footprint.map((p) => p[0]);
            const lngs = sc.footprint.map((p) => p[1]);
            s.requestFit({ south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) });
          }}
        />
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
        cadenceMs={filter?.expectedCadenceMs}
        filterActive={!!filter}
        secondaryMarkers={s.nisarEnabled ? nisarMarkers : []}
        onSecondaryClick={(id) => s.pinNisar(s.nisarPinnedId === id ? null : id)}
        onRangeChange={(r) => (filter ? s.setRange(r) : setIdleRange(r))}
        onIndex={s.setIndex}
        onStep={s.step}
        onPlayPause={s.togglePlaying}
        onPause={() => s.setPlaying(false)}
        onSpeed={s.setSpeed}
        onLoop={s.setLoop}
      />
    </div>
  );
}
