// The setup checklist, docked at the bottom of the explorer: the product
// journey in the customer's order, ticks detected from the manifest, each
// row a shortcut to where that step happens. Non-blocking by design — it
// guides, the merchant decides.

import type { SetupStep } from '../lib/setup-guide.ts';

export function SetupGuide(props: {
  steps: SetupStep[];
  collapsed: boolean;
  onToggle: () => void;
  onGo: (step: SetupStep) => void;
}) {
  const done = props.steps.filter((s) => s.done).length;
  const all = done === props.steps.length;
  return (
    <div className={`setup-guide${all ? ' is-done' : ''}`} data-testid="setup-guide">
      <button
        className="setup-guide-head" onClick={props.onToggle}
        aria-expanded={!props.collapsed} data-testid="setup-guide-toggle"
      >
        <span>{all ? 'Ready to sell' : 'Set up your product'}</span>
        <span className="setup-guide-count">{done}/{props.steps.length}</span>
      </button>
      {!props.collapsed && (
        <ol className="setup-guide-steps">
          {props.steps.map((step, i) => (
            <li key={step.id}>
              <button
                className={`setup-step${step.done ? ' is-done' : ''}`}
                data-testid={`guide-${step.id}`} title={step.hint}
                onClick={() => props.onGo(step)}
              >
                <span className="setup-step-tick" aria-hidden="true">{step.done ? '✓' : i + 1}</span>
                <span>{step.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
