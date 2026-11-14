import { useEffect, useId, useRef, useState } from 'react';
import type { TimeRange } from '../../types';
import { DAY, fromInputValue, toInputValue } from '../../services/time/format';
import { validateRange } from '../../services/time/range';

export interface RangePickerProps {
  range: TimeRange;
  bounds?: TimeRange;
  defaultRange?: TimeRange;
  now: number;
  onApply(range: TimeRange): void;
  onClose(): void;
}

export function RangePicker({ range, bounds, defaultRange, now, onApply, onClose }: RangePickerProps) {
  const [start, setStart] = useState(toInputValue(range.start));
  const [end, setEnd] = useState(toInputValue(range.end));
  const firstRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const s = fromInputValue(start);
  const e = fromInputValue(end);
  const v = validateRange(s, e, bounds);

  const preset = (r: TimeRange) => {
    setStart(toInputValue(r.start));
    setEnd(toInputValue(r.end));
  };

  return (
    <div className="range-picker" role="dialog" aria-modal="false" aria-labelledby={`${id}-title`}>
      <div className="rp-head">
        <h3 id={`${id}-title`}>Date range (UTC)</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close date range picker">✕</button>
      </div>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.ok) onApply({ start: s, end: e });
        }}
      >
        <label>
          Start
          <input ref={firstRef} type="datetime-local" value={start} onChange={(ev) => setStart(ev.target.value)} aria-invalid={!Number.isFinite(s)} />
        </label>
        <label>
          End
          <input type="datetime-local" value={end} min={start} onChange={(ev) => setEnd(ev.target.value)} aria-invalid={!Number.isFinite(e) || e < s} />
        </label>
        <div className="rp-presets" aria-label="Presets">
          {[7, 30, 90].map((d) => (
            <button type="button" key={d} className="chip" onClick={() => preset({ start: now - d * DAY, end: now })}>{`Last ${d} days`}</button>
          ))}
          {defaultRange && (
            <button type="button" className="chip" onClick={() => preset(defaultRange)}>Dataset default</button>
          )}
        </div>
        {v.errors.map((m) => (
          <p key={m} className="rp-error" role="alert">{m}</p>
        ))}
        {v.warnings.map((m) => (
          <p key={m} className="rp-warn">{m}</p>
        ))}
        <div className="rp-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!v.ok}>Apply</button>
        </div>
      </form>
    </div>
  );
}
