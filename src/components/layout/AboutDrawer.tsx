import { useEffect, useRef } from 'react';
import { MISSIONS } from '../../content/missions';

export interface AboutDrawerProps {
  open: boolean;
  missionId: string;
  onMission(id: string): void;
  onClose(): void;
}

/** Independent right-hand drawer. Opening it never changes the active filter or playback. */
export function AboutDrawer({ open, missionId, onMission, onClose }: AboutDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  // Keep the closed drawer out of the tab order and accessibility tree.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    if (open) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [open]);
  const mission = MISSIONS.find((m) => m.id === missionId) ?? MISSIONS[0];

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      lastFocus.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={onClose} aria-hidden data-testid="about-scrim" />
      <aside ref={asideRef} className={`about ${open ? 'open' : ''}`} aria-label="About the satellite" aria-hidden={!open}>
        <header className="about-head">
          <div>
            <div className="eyebrow">{mission.kind}</div>
            <h2>{mission.title}</h2>
            <div className="muted">{mission.subtitle}</div>
          </div>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close about panel">✕</button>
        </header>
        <nav className="about-tabs" aria-label="Missions and sources">
          {MISSIONS.map((m) => (
            <button key={m.id} className={m.id === mission.id ? 'on' : ''} aria-current={m.id === mission.id} onClick={() => onMission(m.id)}>
              {m.tab}
            </button>
          ))}
        </nav>
        <div className="about-body">
          <dl className="facts">
            {mission.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {mission.sections.map((s) => (
            <section key={s.heading}>
              <h3>{s.heading}</h3>
              {s.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </section>
          ))}
          <section>
            <h3>Sources</h3>
            <ul className="links">
              {mission.links.map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noreferrer">{`${l.label} ↗`}</a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
