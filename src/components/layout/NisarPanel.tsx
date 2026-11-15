import type { NisarPass, NisarProduct } from '../../services/data/nisar';
import { NISAR_PRODUCTS } from '../../services/data/nisar';
import { NISAR_IMAGE_MIN_ZOOM, type NisarState, sceneDateText } from '../../hooks/useNisar';
import type { NisarStripMode } from '../../state/store';

export interface NisarPanelProps {
  enabled: boolean;
  product: NisarProduct;
  opacity: number;
  state: NisarState;
  error: string | null;
  passes: NisarPass[];
  currentIndex: number;
  mode: NisarStripMode;
  color: 'gray' | 'color';
  onMode(m: NisarStripMode): void;
  onColor(c: 'gray' | 'color'): void;
  truncated: boolean;
  zoomedIn: boolean;
  imageStatus(id: string): 'loading' | 'ready' | 'error' | null;
  onEnabled(v: boolean): void;
  onProduct(p: NisarProduct): void;
  onOpacity(v: number): void;
  onGoTo(index: number): void;
}

/** Base-map NISAR controls: every pass over the view becomes a timeline frame drawn as a strip. */
export function NisarPanel(p: NisarPanelProps) {
  const cur = p.currentIndex >= 0 ? p.passes[p.currentIndex] : undefined;
  return (
    <section className="nisar-panel" aria-label="NISAR radar imagery">
      <h2 className="section-title">
        NISAR radar imagery <span className="status status-live">Real</span>
      </h2>
      <label className="toggle">
        <input type="checkbox" checked={p.enabled} onChange={(e) => p.onEnabled(e.target.checked)} />
        Follow NISAR passes on the timeline
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
              {`Image opacity ${Math.round(p.opacity * 100)}%`}
              <input type="range" min={0.2} max={1} step={0.05} value={p.opacity} onChange={(e) => p.onOpacity(Number(e.target.value))} aria-label="NISAR image opacity" />
            </label>
          </div>
          <div className="nisar-segs">
            <div className="seg small-seg" role="radiogroup" aria-label="Strips to show">
              <button role="radio" aria-checked={p.mode === 'build'} className={p.mode === 'build' ? 'on' : ''} onClick={() => p.onMode('build')}>Build up coverage</button>
              <button role="radio" aria-checked={p.mode === 'single'} className={p.mode === 'single' ? 'on' : ''} onClick={() => p.onMode('single')}>Single strip</button>
            </div>
            {p.product === 'GCOV' && (
              <div className="seg small-seg" role="radiogroup" aria-label="Radar colour">
                <button role="radio" aria-checked={p.color === 'gray'} className={p.color === 'gray' ? 'on' : ''} onClick={() => p.onColor('gray')}>Grayscale</button>
                <button role="radio" aria-checked={p.color === 'color'} className={p.color === 'color' ? 'on' : ''} onClick={() => p.onColor('color')}>Colour</button>
              </div>
            )}
          </div>
          <p className="small muted">
            {`Each timeline frame is one real NISAR pass over the map view, at its acquisition time. Play to watch the strips ${p.mode === 'build' ? 'fill in coverage' : 'appear one by one'}. Click a strip to see its image.`}
          </p>

          {p.state === 'loading' && <div className="state-msg small">Searching NASA’s catalog for passes in this view…</div>}
          {p.state === 'error' && <div className="state-msg error small" role="alert">{`NISAR search failed: ${p.error}`}</div>}
          {p.state === 'ready' && (
            <div className="small muted nisar-summary">
              {p.passes.length
                ? `${p.passes.length} pass${p.passes.length > 1 ? 'es' : ''} in view and date range.`
                : 'No NISAR passes in this view and date range. Products are published a few weeks after acquisition; try an earlier or longer range.'}
              {cur && ` Now: ${sceneDateText(cur)} · ${cur.direction ?? ''} track ${cur.track ?? '?'} · ${cur.scenes.length} frame${cur.scenes.length > 1 ? 's' : ''} · ${cur.status}.`}
              {p.truncated && <div className="notice">Too many products to list: only the newest are included. Zoom in or shorten the range to see older passes.</div>}
              {!p.zoomedIn && p.passes.length > 0 && <div>{`Zoom in to level ${NISAR_IMAGE_MIN_ZOOM}+ to see the radar images inside the strips.`}</div>}
            </div>
          )}

          {p.passes.length > 0 && (
            <ul className="scene-list" aria-label="NISAR passes">
              {p.passes
                .map((pass, i) => ({ pass, i }))
                .reverse()
                .slice(0, 40)
                .map(({ pass, i }) => (
                  <li key={pass.id} className={i === p.currentIndex ? 'pinned' : ''}>
                    <button onClick={() => p.onGoTo(i)} aria-pressed={i === p.currentIndex} title={pass.scenes.map((s) => s.id).join('\n')}>
                      <span className="scene-date">{sceneDateText(pass)}</span>
                      <span className="scene-meta">{`${pass.direction?.[0] ?? '?'} · T${pass.track ?? '?'} · ${pass.scenes.length}f`}</span>
                      <span className={`scene-status ${pass.status === 'Validated' ? 'ok' : 'prov'}`}>{pass.status === 'Validated' ? 'Val' : 'Prov'}</span>
                      {i === p.currentIndex && pass.scenes.some((s) => p.imageStatus(s.id) === 'loading') && <span className="spinner" aria-label="Loading image" />}
                    </button>
                  </li>
                ))}
            </ul>
          )}
          <p className="small muted">
            Source: NASA–ISRO NISAR L-band products via ASF DAAC, found with NASA CMR. Strips are product footprints; images are browse
            quick-looks placed by footprint fitting (≈1 km accuracy). Full-resolution data needs a free Earthdata login.
          </p>
        </>
      )}
    </section>
  );
}
