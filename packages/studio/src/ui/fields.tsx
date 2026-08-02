// Small controlled inputs shared by the panels.
//
// NumberField keeps its own text while focused so a merchant can type "12."
// or clear the box without the manifest snapping the cursor around; the edit
// op fires on commit (blur or Enter), and an op that throws puts the message
// inline and restores the last good value.

import { useEffect, useState, type ReactNode } from 'react';

export function NumberField(props: {
  label: ReactNode;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  suffix?: string;
  testId?: string;
}) {
  const shown = round3(props.value);
  const [text, setText] = useState(String(shown));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync the box to outside changes while idle — but never touch the error
  // here: commit() sets it in the same render that flips `focused` off, and
  // clearing it in this effect erased it before anyone could read it.
  useEffect(() => {
    if (!focused) setText(String(shown));
  }, [shown, focused]);

  const commit = () => {
    setFocused(false);
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) { setText(String(shown)); setError(null); return; }
    if (value === shown) { setError(null); return; }
    try {
      props.onCommit(value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setText(String(shown));
    }
  };

  // Stepper arrows tweak from the last committed value — a click is "one
  // step from where the manifest is", so it composes with typing and the
  // gizmo rather than fighting a half-typed draft.
  const stepBy = (dir: 1 | -1) => {
    const next = round3(shown + dir * (props.step ?? 0.1));
    try {
      props.onCommit(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <span className="field-box">
        <input
          type="number" step={props.step ?? 0.1} value={text} data-testid={props.testId}
          onFocus={() => { setFocused(true); setError(null); }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        {props.suffix && <span className="field-suffix">{props.suffix}</span>}
        <span className="field-steps">
          <button
            type="button" tabIndex={-1} aria-label="Increase"
            data-testid={props.testId ? `${props.testId}-up` : undefined}
            onClick={(e) => { e.preventDefault(); stepBy(1); }}
          >
            <svg width="7" height="5" viewBox="0 0 7 5" aria-hidden="true"><path d="M3.5 0.5 6.5 4.5 0.5 4.5z" fill="currentColor" /></svg>
          </button>
          <button
            type="button" tabIndex={-1} aria-label="Decrease"
            data-testid={props.testId ? `${props.testId}-down` : undefined}
            onClick={(e) => { e.preventDefault(); stepBy(-1); }}
          >
            <svg width="7" height="5" viewBox="0 0 7 5" aria-hidden="true"><path d="M3.5 4.5 0.5 0.5 6.5 0.5z" fill="currentColor" /></svg>
          </button>
        </span>
      </span>
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
