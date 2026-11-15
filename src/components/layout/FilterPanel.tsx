import type { EffectMode, EffectSettings, FilterDefinition, LayerDefinition, Provenance, StatItem } from '../../types';

const PROV_TEXT: Record<Provenance, string> = {
  observed: 'Observed',
  derived: 'Derived',
  reference: 'Reference',
  catalog: 'Catalog',
  report: 'Report',
  demo: 'Demo',
  estimated: 'Estimated',
};

export function LayerList({
  layers,
  visibility,
  onToggle,
}: {
  layers: LayerDefinition[];
  visibility: Record<string, boolean>;
  onToggle(id: string, v: boolean): void;
}) {
  return (
    <ul className="layer-list">
      {layers.map((l) => {
        const disabled = !!l.unavailableReason;
        return (
          <li key={l.id} className={disabled ? 'disabled' : ''}>
            <label title={l.unavailableReason ?? l.description}>
              <input
                type="checkbox"
                checked={!disabled && !!visibility[l.id]}
                disabled={disabled}
                onChange={(e) => onToggle(l.id, e.target.checked)}
              />
              <span className={`swatch ${l.swatch === 'hatch' ? 'hatch' : ''}`} style={l.swatch && l.swatch !== 'hatch' ? { background: l.swatch } : undefined} aria-hidden />
              <span className="layer-name">{l.label}</span>
              <span className={`prov prov-${l.provenance}`}>{PROV_TEXT[l.provenance]}</span>
            </label>
            <p className="layer-desc">{l.unavailableReason ?? l.description}</p>
          </li>
        );
      })}
    </ul>
  );
}

function Swatch({ bg }: { bg?: string }) {
  return <span className={`swatch ${bg === 'hatch' ? 'hatch' : ''}`} style={bg && bg !== 'hatch' ? { background: bg } : undefined} aria-hidden />;
}

/** Floating map key for the active filter's visible layers. */
export function MapLegend({ filter, visibility, options }: { filter: FilterDefinition<any, any>; visibility: Record<string, boolean>; options: unknown }) {
  const shown = filter.availableLayers.filter((l) => visibility[l.id] && !l.unavailableReason);
  if (!shown.length) return null;
  return (
    <aside className="map-legend" aria-label={`${filter.label} legend`}>
      {shown.map((l) => {
        const lg = typeof l.legend === 'function' ? l.legend(options) : l.legend;
        return (
          <div key={l.id} className="lg-layer">
            {!lg && (
              <div className="lg-row">
                <Swatch bg={l.swatch} />
                {l.label}
              </div>
            )}
            {lg && <div className="lg-title">{l.label}</div>}
            {lg && 'ramp' in lg && (
              <>
                <div className="lg-ramp" style={{ background: lg.ramp }} />
                <div className="lg-ramp-labels">
                  {lg.labels.map((t) => <span key={t}>{t}</span>)}
                </div>
              </>
            )}
            {lg && 'items' in lg && lg.items.map((it) => (
              <div key={it.label} className="lg-row">
                <Swatch bg={it.color} />
                {it.label}
              </div>
            ))}
          </div>
        );
      })}
    </aside>
  );
}

const TOGGLE_TEXT: Partial<Record<keyof EffectSettings, string>> = {
  boundingBoxes: 'Bounding Boxes',
  trackingIds: 'Tracking IDs',
  trails: 'Tracking Trails',
  centroids: 'Centroids',
  highlightSelected: 'Highlight Selected',
  highlightChanges: 'Highlight Changes',
};

export function EffectsPanel({
  filter,
  effects,
  reduceMotion,
  systemReduceMotion,
  onMode,
  onToggle,
  onReduceMotion,
}: {
  filter: FilterDefinition<any, any>;
  effects: EffectSettings;
  reduceMotion: boolean;
  systemReduceMotion: boolean;
  onMode(m: EffectMode): void;
  onToggle<K extends keyof EffectSettings>(k: K, v: EffectSettings[K]): void;
  onReduceMotion(v: boolean): void;
}) {
  const controls = filter.effectControls ?? [];
  return (
    <div className="effects">
      <div className="seg" role="radiogroup" aria-label="Tracking Effect">
        {(['off', 'clean', 'cinematic'] as EffectMode[]).map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={effects.mode === m}
            className={effects.mode === m ? 'on' : ''}
            onClick={() => onMode(m)}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      <p className="small muted">Effects only change presentation — measurements and data layers stay the same.</p>
      <div className="toggles">
        {controls
          .filter((k) => k !== 'trailLength')
          .map((k) => (
            <label key={k} className="toggle">
              <input type="checkbox" checked={!!effects[k]} onChange={(e) => onToggle(k, e.target.checked as never)} />
              {TOGGLE_TEXT[k]}
            </label>
          ))}
        {controls.includes('trailLength') && (
          <label className="toggle range">
            {`Trail length: ${effects.trailLength} obs.`}
            <input
              type="range"
              min={2}
              max={8}
              value={effects.trailLength}
              onChange={(e) => onToggle('trailLength', Number(e.target.value))}
              aria-label="Trail length in observations"
            />
          </label>
        )}
        <label className="toggle">
          <input type="checkbox" checked={reduceMotion} onChange={(e) => onReduceMotion(e.target.checked)} disabled={systemReduceMotion} />
          {systemReduceMotion ? 'Reduce Motion (system setting)' : 'Reduce Motion'}
        </label>
      </div>
    </div>
  );
}

export function StatsPanel({ stats }: { stats: StatItem[] }) {
  if (!stats.length) return null;
  return (
    <dl className="stats">
      {stats.map((s) => (
        <div key={s.id} className="stat" title={s.hint}>
          <dt>{s.label}</dt>
          <dd className={s.tone ? `tone-${s.tone}` : ''}>{s.value}</dd>
          {s.hint && <dd className="stat-hint">{s.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}
