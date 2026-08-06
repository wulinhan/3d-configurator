// Small controlled inputs shared by the panels.
//
// NumberField keeps its own text while focused so a merchant can type "12."
// or clear the box without the manifest snapping the cursor around; the edit
// op fires on commit (blur or Enter), and an op that throws puts the message
// inline and restores the last good value.
//
// The box is also a SCRUBBER: press and drag sideways to walk the value in
// the field's own step. A press that never moves still focuses for typing,
// so the two gestures don't fight. Scrub commits ride one history entry —
// the first step records it, the rest are transient, exactly like a gizmo
// drag — so a scrub is one Ctrl+Z.

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Pixels of travel per step. Coarse enough that a normal click never
 * scrubs, fine enough that a short drag covers a useful range. */
const PX_PER_STEP = 6;

export function NumberField(props: {
  label: ReactNode;
  value: number;
  onCommit: (value: number, opts?: { transient?: boolean }) => void;
  step?: number;
  suffix?: string;
  testId?: string;
}) {
  const shown = round3(props.value);
  const [text, setText] = useState(String(shown));
  const [focused, setFocused] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Live during a scrub: the value the gesture started from, and whether the
  // history entry for this gesture has been recorded yet.
  const scrub = useRef({ active: false, startX: 0, base: 0, moved: false, recorded: false });

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

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    scrub.current = { active: true, startX: e.clientX, base: shown, moved: false, recorded: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s.active) return;
    const steps = Math.trunc((e.clientX - s.startX) / PX_PER_STEP);
    if (!s.moved) {
      if (!steps) return; // still a click, not a drag
      s.moved = true;
      setScrubbing(true);
      // Typing and scrubbing are different gestures: drop the caret so the
      // box doesn't sit in edit mode behind the moving number.
      inputRef.current?.blur();
      setFocused(false);
      inputRef.current?.setPointerCapture?.(e.pointerId);
    }
    const next = round3(s.base + steps * (props.step ?? 0.1));
    if (next === Number(text)) return;
    setText(String(next));
    try {
      // The first step of the gesture records the undo entry; every step
      // after it rides that entry, so a whole scrub rewinds in one Ctrl+Z.
      props.onCommit(next, s.recorded ? { transient: true } : undefined);
      s.recorded = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const endScrub = (e: React.PointerEvent<HTMLInputElement>) => {
    const s = scrub.current;
    if (!s.active) return;
    scrub.current = { ...s, active: false };
    if (!s.moved) return; // a plain click: leave focus/typing alone
    inputRef.current?.releasePointerCapture?.(e.pointerId);
    setScrubbing(false);
    setText(String(round3(props.value)));
  };

  return (
    <label className={`field${scrubbing ? ' is-scrubbing' : ''}`}>
      <span className="field-label">{props.label}</span>
      <span className="field-box">
        <input
          ref={inputRef}
          type="number" step={props.step ?? 0.1} value={text} data-testid={props.testId}
          title="Drag sideways to change, or type a value"
          onFocus={() => { setFocused(true); setError(null); }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
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
