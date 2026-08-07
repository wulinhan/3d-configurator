// The Studio's side of the service, minus the browser: which screen a URL
// means, what the merchant pastes into their store, and — the part worth
// most of this file — autosave.
//
// Autosave is where a merchant's work is actually at risk, so its awkward
// cases are driven by hand here rather than by waiting: a burst of edits
// must become one write, two writes must never overlap, a failed write must
// not drop what it was carrying, and a conflict must stop the loop dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOf, embedSnippet } from '../src/lib/api.ts';
import { Autosave, saveLabel, type SaveState } from '../src/lib/autosave.ts';
import { relativeTime } from '../src/lib/format.ts';

// ── routing ───────────────────────────────────────────────────────────────

test('with no service configured there is exactly one screen', () => {
  // The standalone Studio is not a routed app pretending to be one — and
  // this is what keeps every existing browser check opening / and getting
  // the editor.
  for (const path of ['/', '/signin', '/p/prj_123', '/anything']) {
    assert.deepEqual(routeOf(path, '', false), { name: 'editor', projectId: null });
  }
});

test('a URL says which product, and a sign-in token rides the fragment', () => {
  assert.deepEqual(routeOf('/', '', true), { name: 'projects' });
  assert.deepEqual(routeOf('/nonsense', '', true), { name: 'projects' });
  assert.deepEqual(routeOf('/p/prj_abc123', '', true), { name: 'editor', projectId: 'prj_abc123' });
  assert.deepEqual(routeOf('/p/prj_abc123/', '', true), { name: 'editor', projectId: 'prj_abc123' });

  // The token is in the FRAGMENT, which browsers never send to a server —
  // so it stays out of access logs and out of the Referer header.
  assert.deepEqual(routeOf('/signin', '#tok_secret', true), { name: 'signin', token: 'tok_secret' });
  assert.deepEqual(routeOf('/signin', '', true), { name: 'signin', token: null });
});

test('the snippet a merchant pastes is the LIVE address', () => {
  const snippet = embedSnippet('https://api.example.com/e/prj_1/manifest.json', 'https://cdn.example.com/');
  assert.match(snippet, /data-configurator="https:\/\/api\.example\.com\/e\/prj_1\/manifest\.json"/);
  // Live, not versioned: publishing an update must not mean editing the
  // storefront again.
  assert.ok(!snippet.includes('/p/'));
  assert.match(snippet, /https:\/\/cdn\.example\.com\/embed\.js/);
  assert.match(snippet, /https:\/\/cdn\.example\.com\/embed\.css/);
  assert.ok(!snippet.includes('.com//'), 'a trailing slash on the base does not double up');
});

// ── autosave ──────────────────────────────────────────────────────────────

/** A scheduler the test drives: nothing fires until `tick()` says so. A
 * cancelled timer is REMOVED, so `depth` answers "what would still fire". */
function manual() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (fn: () => void) => { const id = next++; pending.set(id, fn); return id; },
    cancel: (handle: unknown) => { pending.delete(handle as number); },
    tick() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
    get depth() { return pending.size; },
  };
}

/** Let every already-resolved promise settle. Autosave's internals are a
 * chain of awaits, so one microtask turn is not enough to see the end of a
 * write — and a test that checks too early reads a half-finished state. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

function rig(save: (payload: string, base: number) => Promise<{ revision: number }>, revision = 1) {
  const clock = manual();
  const states: SaveState[] = [];
  const messages: string[] = [];
  const saver = new Autosave<string>({
    revision,
    save,
    onState: (state, extra) => { states.push(state); if (extra?.message) messages.push(extra.message); },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { saver, clock, states, messages };
}

test('a burst of edits becomes one write, carrying the newest copy', async () => {
  const writes: Array<{ payload: string; base: number }> = [];
  const { saver, clock } = rig(async (payload, base) => {
    writes.push({ payload, base });
    return { revision: base + 1 };
  });

  // A gizmo drag is dozens of edits. None of the intermediate states is
  // worth a request, and the last one is the only one that is true.
  saver.push('a'); saver.push('b'); saver.push('c');
  clock.tick();
  await settle();

  assert.deepEqual(writes, [{ payload: 'c', base: 1 }]);
  assert.equal(saver.revision, 2, 'the revision moves on, so the next write is not a conflict');
});

test('a second edit mid-write waits rather than racing the first', async () => {
  let release: (() => void) | null = null;
  const writes: string[] = [];
  const { saver, clock } = rig(async (payload, base) => {
    writes.push(payload);
    await new Promise<void>((r) => { release = r; });
    return { revision: base + 1 };
  });

  saver.push('first');
  clock.tick();
  await settle();
  assert.deepEqual(writes, ['first']);

  // Edited again while the first write is still in the air. Sending it now
  // would race for the same revision and lose — to our OWN 409.
  saver.push('second');
  clock.tick();
  await settle();
  assert.deepEqual(writes, ['first'], 'still just the one');

  // Let the first finish. The queued edit goes out behind it, on the
  // revision the first write returned — not the one it started from.
  release!();
  await settle();
  clock.tick();
  await settle();
  assert.deepEqual(writes, ['first', 'second']);

  release!();
  await settle();
  assert.equal(saver.revision, 3, 'each write built on the last, so neither is a conflict');
});

test('a failed write keeps what it was carrying', async () => {
  let fail = true;
  const writes: string[] = [];
  const { saver, clock, states, messages } = rig(async (payload, base) => {
    writes.push(payload);
    if (fail) throw new Error('network down');
    return { revision: base + 1 };
  });

  saver.push('work');
  clock.tick();
  await settle();
  assert.ok(states.includes('error'));
  assert.ok(messages.some((m) => m.includes('network down')));

  // The payload was put back, not dropped: the retry writes the same work.
  fail = false;
  clock.tick();
  await settle();
  assert.deepEqual(writes, ['work', 'work']);
  assert.equal(saver.revision, 2);
  assert.ok(!saver.isStopped, 'a network blip is not a conflict');
});

test('a conflict stops the loop dead rather than overwriting the other tab', async () => {
  const writes: string[] = [];
  const { saver, clock, states, messages } = rig(async (payload) => {
    writes.push(payload);
    throw Object.assign(new Error('changed'), { status: 409, detail: { revision: 9 } });
  });

  saver.push('mine');
  clock.tick();
  await settle();
  assert.equal(states.at(-1), 'conflict');
  assert.ok(messages.some((m) => /changed somewhere else/i.test(m)));
  assert.ok(saver.isStopped);

  // Everything after this is refused. The local copy is no longer a valid
  // successor to what the service holds, and writing anyway is exactly how
  // the other tab's afternoon disappears.
  saver.push('mine again');
  clock.tick();
  await settle();
  await saver.flush();
  assert.deepEqual(writes, ['mine']);
});

test('flush writes now — for Publish, and for a closing tab', async () => {
  const writes: string[] = [];
  const { saver, clock } = rig(async (payload, base) => { writes.push(payload); return { revision: base + 1 }; });
  saver.push('unsaved');
  assert.equal(writes.length, 0, 'the timer has not fired');
  await saver.flush();
  assert.deepEqual(writes, ['unsaved']);
  assert.equal(clock.depth, 0, 'and the pending timer was cancelled, not left to fire twice');
});

test('the topbar never says something alarming about work in progress', () => {
  assert.equal(saveLabel('clean'), '');
  assert.equal(saveLabel('pending'), 'Saving…');
  assert.equal(saveLabel('saving'), 'Saving…');
  assert.equal(saveLabel('saved'), 'Saved');
  assert.match(saveLabel('error'), /retrying/);
  assert.match(saveLabel('conflict'), /elsewhere/);
});

// ── the dashboard ─────────────────────────────────────────────────────────

test('a product says when it was last touched, not when it was made', () => {
  const now = Date.parse('2026-03-01T12:00:00Z');
  const at = (iso: string) => relativeTime(iso, now);
  assert.equal(at('2026-03-01T11:59:40Z'), 'just now');
  assert.equal(at('2026-03-01T11:59:00Z'), '1 minute ago');
  assert.equal(at('2026-03-01T11:20:00Z'), '40 minutes ago');
  assert.equal(at('2026-03-01T09:00:00Z'), '3 hours ago');
  assert.equal(at('2026-02-27T12:00:00Z'), '2 days ago');
  assert.equal(at('2026-02-01T12:00:00Z'), '4 weeks ago');
  assert.equal(at('nonsense'), '', 'a bad timestamp shows nothing rather than "NaN days ago"');
});
