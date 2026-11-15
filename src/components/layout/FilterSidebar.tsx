import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import type { FilterDefinition } from '../../types';
import type { LoadState } from '../../state/store';
import logo from '../../orbit.png';
import { REGION_NAME } from '../../services/geospatial/region';

export interface FilterSidebarProps {
  filters: FilterDefinition<any, any>[];
  activeId: string | null;
  open: boolean;
  onToggleOpen(): void;
  onSelect(id: string | null): void;
  loadState: LoadState;
  children?: ReactNode;
  footer?: ReactNode;
}

const STATUS_TEXT = { live: 'Live', demo: 'Demo', 'coming-soon': 'Soon' } as const;

export function FilterSidebar({ filters, activeId, open, onToggleOpen, onSelect, loadState, children, footer }: FilterSidebarProps) {
  return (
    <>
      <button className="sidebar-toggle" onClick={onToggleOpen} aria-expanded={open} aria-controls="filter-sidebar" aria-label={open ? 'Hide data filters' : 'Show data filters'}>
        {open ? '‹' : <><Icon name="menu" /> Filters</>}
      </button>
      <nav id="filter-sidebar" className={`sidebar ${open ? 'open' : ''}`} aria-label="Data filters">
        <header className="brand">
          <img className="brand-mark" src={logo} alt="" aria-hidden />
          <div>
            <h1>Orb-it</h1>
            <div className="muted small">{`Watch Earth change · ${REGION_NAME}`}</div>
          </div>
        </header>
        <div className="filter-list" role="radiogroup" aria-label="Data filter">
          <button
            role="radio"
            aria-checked={activeId === null}
            className={`filter-item ${activeId === null ? 'active' : ''}`}
            onClick={() => onSelect(null)}
          >
            <span className="fi-icon" aria-hidden><Icon name="satellite" /></span>
            <span className="fi-label">Basemap only</span>
          </button>
          {filters.map((f) => {
            const soon = f.status === 'coming-soon';
            return (
              <button
                key={f.id}
                role="radio"
                aria-checked={activeId === f.id}
                aria-disabled={soon}
                className={`filter-item ${activeId === f.id ? 'active' : ''} ${soon ? 'soon' : ''}`}
                onClick={() => !soon && onSelect(f.id)}
                title={f.summary}
              >
                <span className="fi-icon" aria-hidden><Icon name={f.icon} /></span>
                <span className="fi-label">{f.label}</span>
                <span className={`status status-${f.status}`}>{STATUS_TEXT[f.status]}</span>
                {activeId === f.id && loadState === 'loading' && <span className="spinner" aria-label="Loading" />}
              </button>
            );
          })}
        </div>
        <div className="sidebar-body">{children}</div>
        {footer && <div className="sidebar-footer">{footer}</div>}
      </nav>
    </>
  );
}
