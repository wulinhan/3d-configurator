// Collapsible panel sections with an icon in the header.
//
// The properties panel stacks a dozen sections; most merchants work in one
// or two at a time, so each one folds. Collapsed titles are remembered for
// the session (module-level, not per-component) so switching between parts
// doesn't reopen everything the merchant just tidied away.
//
// The icons are drawn inline in the Lucide geometry the 21st.dev components
// use (MIT): 24-unit box, stroke-based, currentColor, round caps. Inline
// SVG rather than an icon package or downloaded assets — the Studio ships
// no icon dependency, and a stroke that inherits currentColor tracks the
// panel's own ink colour for free.

import { useState, type ReactNode } from 'react';

export type SectionIcon =
  | 'size' | 'position' | 'rotation' | 'colour' | 'addon'
  | 'text' | 'image' | 'repeat' | 'assembly' | 'variant' | 'finish';

const PATHS: Record<SectionIcon, ReactNode> = {
  // maximize: a frame with corner ticks — bounding box, i.e. size
  size: <><path d="M4 8V4h4" /><path d="M16 4h4v4" /><path d="M20 16v4h-4" /><path d="M8 20H4v-4" /></>,
  // move: four-way arrows
  position: <><path d="M12 3v18M3 12h18" /><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>,
  // rotate-cw
  rotation: <><path d="M21 12a9 9 0 1 1-3.2-6.9" /><path d="M21 4v5h-5" /></>,
  // palette
  colour: <><circle cx="12" cy="12" r="9" /><circle cx="9" cy="9" r="1.3" /><circle cx="15" cy="9" r="1.3" /><circle cx="9.5" cy="15" r="1.3" /></>,
  // square-check: an optional extra the customer ticks
  addon: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12.5l2.6 2.6L16 9.5" /></>,
  // type: the classic serif T
  text: <><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></>,
  // image: framed picture with a sun and a hill
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-7 7" /></>,
  // copy: stacked frames
  repeat: <><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></>,
  // layers: parts bundled into one thing
  assembly: <><path d="M12 3l9 5-9 5-9-5 9-5Z" /><path d="M3 13l9 5 9-5" /></>,
  // git-branch-style fork: one slot, several choices
  variant: <><circle cx="7" cy="6" r="2.4" /><circle cx="7" cy="18" r="2.4" /><circle cx="17" cy="12" r="2.4" /><path d="M7 8.4v7.2" /><path d="M9.4 6H13a2 2 0 0 1 2 2v1.8" /></>,
  // sparkles: surface finish
  finish: <><path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z" /><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9L18 16Z" /></>,
};

function Icon(props: { name: SectionIcon }) {
  return (
    <svg
      className="section-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      {PATHS[props.name]}
    </svg>
  );
}

/** Titles the merchant has folded away, kept for the session so switching
 * parts doesn't undo the tidying. */
const collapsed = new Set<string>();

export function Section(props: {
  title: string;
  icon: SectionIcon;
  children: ReactNode;
  /** Controls that live on the header row (a lock, a toggle) — they stay
   * reachable while the body is folded away. */
  aside?: ReactNode;
  /** Fold this one by default the first time it is seen. */
  defaultCollapsed?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(() => !(collapsed.has(props.title) || props.defaultCollapsed));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) collapsed.delete(props.title); else collapsed.add(props.title);
  };
  return (
    <section className={`panel-section${open ? '' : ' is-collapsed'}`} data-testid={props.testId}>
      <div className="section-head">
        <button
          type="button" className="section-toggle" onClick={toggle}
          aria-expanded={open} data-testid={props.testId ? `${props.testId}-toggle` : undefined}
        >
          <svg
            className="section-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"
            fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M3.5 2 6.5 5 3.5 8" />
          </svg>
          <Icon name={props.icon} />
          <h4>{props.title}</h4>
        </button>
        {props.aside}
      </div>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}
