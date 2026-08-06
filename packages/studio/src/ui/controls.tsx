// Shared UI controls, replacing browser-default widgets whose popups can't
// be styled (a native <select> opens the OS menu — dark on a dark-mode
// machine, jarring inside the Studio's light UI).
//
// The interaction patterns follow the 21st.dev reference components: Select
// is modelled on the react-aria ListBox (roles combobox/listbox/option,
// arrow-key navigation, Home/End, Escape, click-outside) and ConfirmDialog
// on the shadcn Alert Dialog (backdrop, role="alertdialog", focus lands on
// the safe action, destructive action visually loudest). Implemented
// natively — the Studio carries no component-library dependency.

import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional colour chip shown before the label (swatch pickers). */
  chip?: string;
  /** Colour the label TEXT itself (axis pickers) — no chip. */
  tint?: string;
}

export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  /** Shown when value matches no option (e.g. "follows another part"). */
  placeholder?: string;
  compact?: boolean;
  /** Greys the control out — used when there is nothing to choose from. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = props.options.find((o) => o.value === props.value);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const at = Math.max(0, props.options.findIndex((o) => o.value === props.value));
    setActive(at);
    // Keep the active option in view as the list opens or the cursor moves.
    requestAnimationFrame(() => {
      listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' });
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (value: string) => {
    setOpen(false);
    if (value !== props.value) props.onChange(value);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    const move = (to: number) => {
      const at = Math.max(0, Math.min(props.options.length - 1, to));
      setActive(at);
      listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') { e.preventDefault(); move(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(props.options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = props.options[active]; if (o) choose(o.value); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (/^[a-z0-9]$/i.test(e.key)) {
      const at = props.options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (at >= 0) move(at);
    }
  };

  return (
    // preventDefault stops an enclosing <label> from forwarding the click
    // back to the combobox button: choosing an option used to close the
    // popup and have the label's activation behaviour immediately re-toggle
    // it open. Our own handlers run before the default action, so nothing
    // else changes.
    <div className={`ui-select${props.compact ? ' compact' : ''}`} ref={rootRef} onClick={(e) => e.preventDefault()}>
      <button
        type="button" className="ui-select-btn" data-testid={props.testId} disabled={props.disabled}
        role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-label={props.ariaLabel}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKey}
      >
        {current?.chip !== undefined && <span className="chip small" style={{ background: current.chip }} />}
        <span
          className="ui-select-label"
          style={current?.tint ? { color: current.tint, fontWeight: 700 } : undefined}
        >{current?.label ?? props.placeholder ?? ''}</span>
        <svg className="ui-select-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && !props.disabled && (
        <div className="ui-select-pop" role="listbox" aria-label={props.ariaLabel} ref={listRef}>
          {props.options.map((o, i) => (
            <button
              key={o.value} type="button" role="option" aria-selected={o.value === props.value}
              data-testid={props.testId ? `${props.testId}-opt-${o.value}` : undefined}
              className={`ui-select-opt${o.value === props.value ? ' is-selected' : ''}${i === active ? ' is-active' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(o.value)}
            >
              {o.chip !== undefined && <span className="chip small" style={{ background: o.chip }} />}
              <span
                className="ui-select-label"
                style={o.tint ? { color: o.tint, fontWeight: 700 } : undefined}
              >{o.label}</span>
              {o.value === props.value && <span className="ui-select-tick">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}>
      <div className="dialog-card" role="alertdialog" aria-modal="true" aria-label={props.title} data-testid={props.testId}>
        <h3>{props.title}</h3>
        <div className="dialog-body">{props.body}</div>
        <div className="dialog-actions">
          <button className="ghost" ref={cancelRef} onClick={props.onCancel} data-testid={props.testId ? `${props.testId}-cancel` : undefined}>
            Cancel
          </button>
          <button className="danger-btn" onClick={props.onConfirm} data-testid={props.testId ? `${props.testId}-confirm` : undefined}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
