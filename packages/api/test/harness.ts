// A real Postgres for every test, in-process.
//
// PGlite is Postgres compiled to WASM, so `on delete cascade`, `unique`,
// `returning`, jsonb and transactions all behave as they will in production.
// A hand-written fake store would have passed every test in this directory
// while proving nothing about the schema, which is where most of the
// service's guarantees actually live.

import { PGlite } from '@electric-sql/pglite';
import type { Sql } from '../src/sql.ts';
import { migrate } from '../src/sql.ts';
import { fixedClock } from '../src/ids.ts';
import { memoryStore } from '../src/storage.ts';

/** PGlite reports `affectedRows`; `pg` reports `rowCount`. One adapter, so
 * nothing above sql.ts has to know which it is talking to. */
export function adapt(db: PGlite): Sql {
  return {
    async query(text, params) {
      const out = await db.query(text, params as never[]);
      return { rows: out.rows as never[], rowCount: out.affectedRows ?? out.rows.length };
    },
  };
}

export interface Harness {
  sql: Sql;
  store: ReturnType<typeof memoryStore>;
  clock: ReturnType<typeof fixedClock>;
  close(): Promise<void>;
}

/** A clean database, a clean object store, and a clock the test drives. */
export async function harness(): Promise<Harness> {
  const db = new PGlite();
  const sql = adapt(db);
  await migrate(sql);
  return {
    sql,
    store: memoryStore(),
    clock: fixedClock(new Date('2026-03-01T09:00:00Z')),
    close: () => db.close(),
  };
}
