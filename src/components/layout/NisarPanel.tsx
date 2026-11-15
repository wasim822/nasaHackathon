import type { NisarPass, NisarProduct } from '../../services/data/nisar';
import { NISAR_PRODUCTS, missingFrames } from '../../services/data/nisar';
import { type NisarState, frameSummary, sceneDateText } from '../../hooks/useNisar';
import type { NisarMode } from '../../state/store';

export interface NisarPanelProps {
  enabled: boolean;
  product: NisarProduct;
  opacity: number;
  state: NisarState;
  error: string | null;
  passes: NisarPass[];
  currentIndex: number;
  follow: boolean;
  mode: NisarMode;
  onMode(m: NisarMode): void;
  color: 'gray' | 'color';
  onFollow(v: boolean): void;
  onColor(c: 'gray' | 'color'): void;
  truncated: boolean;
  imageStatus(id: string): 'loading' | 'ready' | 'error' | null;
  onEnabled(v: boolean): void;
  onProduct(p: NisarProduct): void;
  onOpacity(v: number): void;
  onGoTo(index: number): void;
}

/** "5" or "5/7" frames (present / present + missing in the middle). */
function frameCount(pass: NisarPass): string {
  const present = new Set(pass.scenes.map((sc) => sc.frame)).size;
  const missing = missingFrames(pass).length;
  return missing ? `${present}/${present + missing}` : String(present);
}

/** Base-map NISAR controls: every pass over the US & Canada becomes a timeline frame shown as its radar image. */
export function NisarPanel(p: NisarPanelProps) {
  const cur = p.currentIndex >= 0 ? p.passes[p.currentIndex] : undefined;
  return (
    <section className="nisar-panel" aria-label="NISAR radar imagery">
      <h2 className="section-title">
        NISAR radar imagery <span className="status status-live">Real</span>
      </h2>
      <label className="toggle">
        <input type="checkbox" checked={p.enabled} onChange={(e) => p.onEnabled(e.target.checked)} />
        Show NISAR passes on the timeline
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
          <div className="seg small-seg" role="radiogroup" aria-label="Timeline steps">
            <button role="radio" aria-checked={p.mode === 'pass'} className={p.mode === 'pass' ? 'on' : ''} onClick={() => p.onMode('pass')}>Follow passes</button>
            <button role="radio" aria-checked={p.mode === 'satellite'} className={p.mode === 'satellite' ? 'on' : ''} onClick={() => p.onMode('satellite')}>Satellite follow mode</button>
          </div>
          <div className="nisar-segs">
            <button className={`btn ${p.follow ? 'primary' : ''}`} onClick={() => p.onFollow(!p.follow)} aria-pressed={p.follow}>
              {p.follow ? 'Following satellite' : 'Follow satellite'}
            </button>
            {p.product === 'GCOV' && (
              <div className="seg small-seg" role="radiogroup" aria-label="Radar colour">
                <button role="radio" aria-checked={p.color === 'gray'} className={p.color === 'gray' ? 'on' : ''} onClick={() => p.onColor('gray')}>Grayscale</button>
                <button role="radio" aria-checked={p.color === 'color'} className={p.color === 'color' ? 'on' : ''} onClick={() => p.onColor('color')}>Colour</button>
              </div>
            )}
          </div>
          <p className="small muted">
            {`${p.mode === 'satellite'
              ? 'Satellite follow mode: each timeline step is one NISAR image (~240 km) in the order the satellite took it, about 40 s apart in reality. The camera stays zoomed in and moves image by image; the pass builds up behind it.'
              : 'Each timeline step is one real NISAR pass over the US & Canada, at its acquisition time.'} Press play and the map ${p.follow ? 'moves with' : 'can follow'} the images; dragging the map stops following. Click an image for details. Products publish about a week after acquisition, so the default week ends 14 days ago, when most passes are complete.`}
          </p>

          {p.state === 'loading' && <div className="state-msg small">Searching NASA’s catalog for passes over the US & Canada…</div>}
          {p.state === 'error' && <div className="state-msg error small" role="alert">{`NISAR search failed: ${p.error}`}</div>}
          {p.state === 'ready' && (
            <div className="small muted nisar-summary">
              {p.passes.length
                ? `${p.passes.length} pass${p.passes.length > 1 ? 'es' : ''} over the US & Canada in this date range.`
                : 'No NISAR passes over the US & Canada in this date range. Products are published a few weeks after acquisition; try an earlier or longer range.'}
              {cur && ` Now: ${sceneDateText(cur)} · ${cur.direction ?? ''} track ${cur.track ?? '?'} · ${frameSummary(cur)} · ${cur.status}.`}
              {p.truncated && <div className="notice">Too many products: only the newest are included. Shorten the date range to see older passes.</div>}
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
                      <span className="scene-meta">{`${pass.direction?.[0] ?? '?'} · T${pass.track ?? '?'} · ${frameCount(pass)}f`}</span>
                      <span className={`scene-status ${pass.status === 'Validated' ? 'ok' : 'prov'}`}>{pass.status === 'Validated' ? 'Val' : 'Prov'}</span>
                      {i === p.currentIndex && pass.scenes.some((s) => p.imageStatus(s.id) === 'loading') && <span className="spinner" aria-label="Loading image" />}
                    </button>
                  </li>
                ))}
            </ul>
          )}
          <p className="small muted">
            Source: NASA–ISRO NISAR L-band products via ASF DAAC, found with NASA CMR. Images are browse
            quick-looks placed by footprint fitting (≈1 km accuracy). Full-resolution data needs a free Earthdata login.
          </p>
        </>
      )}
    </section>
  );
}
