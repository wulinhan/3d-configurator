// Small formatting helpers shared by the screens outside the editor.
//
// In lib/ rather than beside the component that uses them: the unit suites
// run under Node's type stripping, which loads .ts but not .tsx, so anything
// worth testing has to live on this side of the line.

/**
 * "3 minutes ago".
 *
 * The dashboard asks one question — which of these was I last working on —
 * and a wall-clock timestamp makes the reader do the arithmetic. `now` is a
 * parameter so this is testable without freezing the clock.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const steps: Array<[number, string]> = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week']];
  for (let i = steps.length - 1; i >= 0; i--) {
    const [size, unit] = steps[i];
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}
