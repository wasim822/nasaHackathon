import type { NisarProduct, NisarScene } from '../../services/data/nisar';
import { NISAR_PRODUCTS } from '../../services/data/nisar';
import { NISAR_MIN_ZOOM, type NisarState, sceneDateText } from '../../hooks/useNisar';
import { fmtDateTime, fmtTime } from '../../services/time/format';

export interface NisarPanelProps {
  enabled: boolean;
  product: NisarProduct;
  opacity: number;
  state: NisarState;
  error: string | null;
  scenes: NisarScene[];
  visible: NisarScene[];
  fallback: boolean;
  mode: 'pass' | 'all';
  color: 'gray' | 'color';
  onMode(m: 'pass' | 'all'): void;
  onColor(c: 'gray' | 'color'): void;
  truncated: boolean;
  pinnedId: string | null;
  refTime: number;
  imageStatus(id: string): 'loading' | 'ready' | 'error' | null;
  onEnabled(v: boolean): void;
  onProduct(p: NisarProduct): void;
  onOpacity(v: number): void;
  onPin(id: string | null): void;
  onZoomTo(s: NisarScene): void;
}

export function NisarPanel(p: NisarPanelProps) {
  const pinned = p.pinnedId ? p.scenes.find((s) => s.id === p.pinnedId) : undefined;
  const visibleIds = new Set(p.visible.map((v) => v.id));
  return (
    <section className="nisar-panel" aria-label="NISAR radar imagery">
      <h2 className="section-title">
        NISAR radar imagery <span className="status status-live">Real</span>
      </h2>
      <label className="toggle">
        <input type="checkbox" checked={p.enabled} onChange={(e) => p.onEnabled(e.target.checked)} />
        Show NISAR scenes on the map
      </label>
      {p.enabled && (
        <>
          <div className="options-grid nisar-options">
            <label>
              Product
              <select value={p.product} onChange={(e) => p.onProduct(e.target.value as NisarProduct)}>
                {(Object.keys(NISAR_PRODUCTS) as NisarProduct[]).map((k) => (
                  <option key={k} value={k}>{NISAR_PRODUCTS[k].label}</option>
                ))}
              </select>
            </label>
            <label>
              {`Opacity ${Math.round(p.opacity * 100)}%`}
              <input type="range" min={0.2} max={1} step={0.05} value={p.opacity} onChange={(e) => p.onOpacity(Number(e.target.value))} aria-label="NISAR image opacity" />
            </label>
          </div>
          <div className="nisar-segs">
            <div className="seg small-seg" role="radiogroup" aria-label="Scenes to show">
              <button role="radio" aria-checked={p.mode === 'pass'} className={p.mode === 'pass' ? 'on' : ''} onClick={() => p.onMode('pass')}>One pass</button>
              <button role="radio" aria-checked={p.mode === 'all'} className={p.mode === 'all' ? 'on' : ''} onClick={() => p.onMode('all')}>All nearby</button>
            </div>
            {p.product === 'GCOV' && (
              <div className="seg small-seg" role="radiogroup" aria-label="Radar colour">
                <button role="radio" aria-checked={p.color === 'gray'} className={p.color === 'gray' ? 'on' : ''} onClick={() => p.onColor('gray')}>Grayscale</button>
                <button role="radio" aria-checked={p.color === 'color'} className={p.color === 'color' ? 'on' : ''} onClick={() => p.onColor('color')}>Colour</button>
              </div>
            )}
          </div>
          <p className="small muted">{NISAR_PRODUCTS[p.product].description}</p>

          {p.state === 'zoom-in' && <div className="state-msg small">{`Zoom in (level ${NISAR_MIN_ZOOM}+) to search NISAR scenes for the map view.`}</div>}
          {p.state === 'loading' && <div className="state-msg small">Searching NASA’s catalog…</div>}
          {p.state === 'error' && (
            <div className="state-msg error small" role="alert">{`NISAR search failed: ${p.error}`}</div>
          )}
          {p.state === 'ready' && (
            <div className="small muted nisar-summary">
              {p.scenes.length
                ? p.mode === 'pass' && p.visible.length
                  ? `Showing one pass: ${sceneDateText(p.visible[0])} · ${p.visible[0].direction ?? ''} track ${p.visible[0].track ?? '?'} · ${p.visible.length} frame${p.visible.length > 1 ? 's' : ''}. ${p.scenes.length} scenes in view and range — pick another below or on the timeline.`
                  : `${p.scenes.length} scene${p.scenes.length > 1 ? 's' : ''} in view and date range · showing the pass nearest ${fmtDateTime(p.refTime)} for each track${p.fallback ? '' : ' (±7 days)'}`
                : 'No NISAR scenes in this view and date range. NISAR does not image every place on every pass.'}
              {p.truncated && ' · List truncated: zoom in or shorten the range.'}
              {p.fallback && p.visible.length > 0 && (
                <div className="notice">
                  {`No NISAR pass within ±7 days of this time (products are published with a delay). Showing the nearest available passes instead — up to ${Math.round(
                    Math.max(...p.visible.map((v) => Math.abs(v.time - p.refTime))) / 864e5,
                  )} days away. Check each scene's date.`}
                </div>
              )}
            </div>
          )}

          {pinned && (
            <div className="detail nisar-detail">
              <header className="detail-head">
                <div>
                  <div className="detail-id">{`NISAR ${pinned.product}`}</div>
                  <div className="muted small">{sceneDateText(pinned)}</div>
                </div>
                <button className="icon-btn" onClick={() => p.onPin(null)} aria-label="Unpin NISAR scene">✕</button>
              </header>
              <dl className="kv">
                <dt>Acquired</dt>
                <dd>{pinned.product === 'GUNW' ? `${fmtDateTime(pinned.start)} → ${fmtDateTime(pinned.end)}` : `${fmtDateTime(pinned.start)} – ${fmtTime(pinned.end, true)}`}</dd>
                <dt>Status</dt>
                <dd>{pinned.status}</dd>
                <dt>Orbit</dt>
                <dd>{`${pinned.direction ?? '—'} · track ${pinned.track ?? '?'} · frame ${pinned.frame ?? '?'}`}</dd>
                <dt>Image</dt>
                <dd>{p.imageStatus(pinned.id) === 'ready' ? 'Browse preview (display-stretched)' : p.imageStatus(pinned.id) ?? '—'}</dd>
                <dt>Data</dt>
                <dd>
                  <a href={pinned.earthdataUrl} target="_blank" rel="noreferrer">Earthdata Search ↗</a>{' '}
                  <a href={NISAR_PRODUCTS[pinned.product].docs} target="_blank" rel="noreferrer">Product guide ↗</a>
                </dd>
              </dl>
              <p className="small muted">{`Product: ${pinned.id}`}</p>
            </div>
          )}

          {p.scenes.length > 0 && (
            <ul className="scene-list" aria-label="NISAR scenes">
              {[...p.scenes].reverse().slice(0, 40).map((s) => (
                <li key={s.id} className={`${visibleIds.has(s.id) ? 'shown' : ''} ${s.id === p.pinnedId ? 'pinned' : ''}`}>
                  <button
                    onClick={() => {
                      p.onPin(s.id === p.pinnedId ? null : s.id);
                      if (s.id !== p.pinnedId) p.onZoomTo(s);
                    }}
                    aria-pressed={s.id === p.pinnedId}
                    title={s.id}
                  >
                    <span className="scene-date">{sceneDateText(s)}</span>
                    <span className="scene-meta">{`${s.direction?.[0] ?? '?'} · T${s.track ?? '?'}`}</span>
                    <span className={`scene-status ${s.status === 'Validated' ? 'ok' : 'prov'}`}>{s.status === 'Validated' ? 'Val' : 'Prov'}</span>
                    {p.imageStatus(s.id) === 'loading' && <span className="spinner" aria-label="Loading image" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">
            Source: NASA–ISRO NISAR L-band products via ASF DAAC, found with NASA CMR. Images are browse quick-looks
            placed by footprint fitting (≈1 km accuracy); full-resolution data needs a free Earthdata login.
          </p>
        </>
      )}
    </section>
  );
}
