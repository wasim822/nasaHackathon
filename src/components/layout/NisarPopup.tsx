import { useEffect, useState } from 'react';
import type { LatLng, TimeRange } from '../../types';
import { NISAR_PRODUCTS, type NisarPass, type NisarScene } from '../../services/data/nisar';
import { fmtCoord } from '../../services/format';
import { fmtDate, fmtDateTime, fmtTime } from '../../services/time/format';

export type NisarPopupContent =
  | { kind: 'scene'; pass: NisarPass; scene: NisarScene; isCurrent: boolean }
  | {
      kind: 'none';
      at: LatLng;
      range: TimeRange;
      /** Passes in range (but not on screen now) that do cover the spot. */
      elsewhere: { pass: NisarPass; index: number }[];
    };

interface Props {
  content: NisarPopupContent;
  onClose(): void;
  /** Jump the timeline to a pass. */
  onGoTo(index: number): void;
}

/** Floating card for a clicked NISAR strip, or a clear no-data message for the spot. */
export function NisarPopup({ content, onClose, onGoTo }: Props) {
  if (content.kind === 'none') return <NoData content={content} onClose={onClose} onGoTo={onGoTo} />;
  return <SceneCard pass={content.pass} scene={content.scene} isCurrent={content.isCurrent} onClose={onClose} />;
}

function SceneCard({ pass, scene, isCurrent, onClose }: { pass: NisarPass; scene: NisarScene; isCurrent: boolean; onClose(): void }) {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  useEffect(() => setStatus('loading'), [scene.browseUrl]);
  const product = NISAR_PRODUCTS[scene.product];
  return (
    <div className="fire-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">{`NISAR ${scene.product} · ${scene.status}`}</div>
          <div className="small muted">
            {scene.product === 'GUNW' ? `${fmtDateTime(scene.start)} → ${fmtDateTime(scene.end)}` : `${fmtDateTime(scene.start)} – ${fmtTime(scene.end, true)}`}
            {isCurrent ? ' · current pass' : ' · earlier pass'}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close NISAR image">✕</button>
      </header>
      <div className="fire-img-frame nisar-img-frame">
        {status === 'loading' && <div className="fire-img-state">Loading radar image…</div>}
        {status === 'error' && <div className="fire-img-state">The browse image for this product could not be loaded.</div>}
        <img
          key={scene.browseUrl}
          src={scene.browseUrl}
          alt={`NISAR ${product.label} browse image, ${scene.direction ?? ''} track ${scene.track ?? '?'} frame ${scene.frame ?? '?'}, ${fmtDate(scene.start)}`}
          onLoad={() => setStatus('ok')}
          onError={() => setStatus('error')}
          style={{ opacity: status === 'ok' ? 1 : 0 }}
        />
      </div>
      <dl className="kv">
        <dt>Product</dt>
        <dd>{product.label}</dd>
        <dt>Orbit</dt>
        <dd>{`${scene.direction ?? '—'} · track ${scene.track ?? '?'} · frame ${scene.frame ?? '?'}`}</dd>
        <dt>This pass</dt>
        <dd>{`${pass.scenes.length} frame${pass.scenes.length > 1 ? 's' : ''} · ${pass.status}`}</dd>
        <dt>Data</dt>
        <dd>
          <a href={scene.earthdataUrl} target="_blank" rel="noreferrer">Earthdata Search ↗</a>{' '}
          <a href={product.docs} target="_blank" rel="noreferrer">Product guide ↗</a>
        </dd>
      </dl>
      <p className="small muted fire-popup-note">
        {product.description} This is the whole frame’s browse quick-look (display-stretched, not calibrated), shown north-up with no-data in black.
      </p>
    </div>
  );
}

function NoData({ content, onClose, onGoTo }: { content: Extract<NisarPopupContent, { kind: 'none' }>; onClose(): void; onGoTo(i: number): void }) {
  const { at, range, elsewhere } = content;
  const shown = elsewhere.slice(-4).reverse();
  return (
    <div className="fire-popup">
      <header className="fire-popup-head">
        <div>
          <div className="detail-id">No NISAR data available here</div>
          <div className="small muted">{fmtCoord(at[0], at[1])}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>
      {elsewhere.length ? (
        <>
          <p className="small">{`No strip is shown on this spot at the current timeline pass, but ${elsewhere.length} other pass${elsewhere.length > 1 ? 'es' : ''} in the range cover${elsewhere.length > 1 ? '' : 's'} it:`}</p>
          <div className="fire-picks">
            {shown.map(({ pass, index }) => (
              <button key={pass.id} className="chip" onClick={() => onGoTo(index)}>
                <span>{fmtDateTime(pass.time)}</span>
                <span className="muted">{`${pass.direction ?? ''} T${pass.track ?? '?'}`}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="small">{`No NISAR pass covering this spot was found between ${fmtDate(range.start)} and ${fmtDate(range.end)}.`}</p>
      )}
      <p className="small muted fire-popup-note">
        NISAR images a different strip on each pass and doesn’t cover every place on every orbit (nominal repeat ~12 days). Products are also
        published a few weeks after acquisition, so the latest dates are often empty. Try a longer date range.
      </p>
    </div>
  );
}
