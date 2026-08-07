// The only thing the service asks of a database: run parameterised SQL.
//
// Production hands it a `pg` pool; the tests hand it PGlite, which is real
// Postgres compiled to WASM. That means the schema, the constraints and the
// transactions under test are the ones that ship — a fake repository layer
// would have let every `on delete cascade` and `unique` in 001_init.sql go
// unexercised, and those ARE the guarantees.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface Rows<T> {
  rows: T[];
  /** Rows the statement touched — inserted, updated or deleted. */
  rowCount: number;
}

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Rows<T>>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Recover the connection string from whatever was actually pasted.
 *
 * The real first deploy failed three times on this secret: once with stray
 * label text, then with an `.env`-style `DATABASE_URL=` prefix, each time
 * surfacing as pg's baffling `getaddrinfo ENOTFOUND base` (its URL parser
 * falls back to a placeholder host literally named "base"). A postgres URL
 * cannot contain whitespace or quotes, so anything around it — a prefix,
 * console label text, surrounding quotes, a trailing newline — is paste
 * debris, and finding the URL inside the noise is unambiguous. The caller
 * logs when cleaning changed anything: a mangled secret should be fixed,
 * not merely survived.
 */
export function cleanConnectionString(raw: string): { url: string; cleaned: boolean } {
  const match = raw.match(/postgres(?:ql)?:\/\/[^\s'"]+/);
  const url = match ? match[0] : raw.trim();
  return { url, cleaned: url !== raw };
}

/**
 * Split a SQL file into statements.
 *
 * Not a plain `split(';')`: the schema is heavily commented and a prose
 * semicolon inside a `--` comment would cut a CREATE TABLE in half — which
 * it did, and the error ("syntax error at end of input") pointed at the top
 * of the file rather than at the comment. So this walks the text, skipping
 * over line comments and quoted strings, and splits only on semicolons that
 * are really statement terminators. Dollar-quoted bodies are not handled
 * because the schema has none; add them here before adding a function.
 */
export function statements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === "'") {
      // '' inside a string is an escaped quote, and closing-then-reopening
      // lands on the same character either way.
      for (i++; i < text.length && text[i] !== "'"; i++);
    } else if (c === ';') {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim());
}

/** Apply the schema. Every statement is `if not exists`, so this is safe to
 * run on every boot — which is how a small service should migrate. */
export async function migrate(sql: Sql): Promise<void> {
  const text = await readFile(join(HERE, '..', 'sql', '001_init.sql'), 'utf8');
  for (const statement of statements(text)) await sql.query(statement);
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Callers that must not interleave — claiming a version number, moving the
 * live pointer — go through here. Note the caller receives the SAME handle:
 * a pool would hand out a different connection per query and the BEGIN would
 * apply to nothing, so production passes a dedicated client (see db.ts).
 */
export async function transact<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  await sql.query('begin');
  try {
    const out = await fn(sql);
    await sql.query('commit');
    return out;
  } catch (err) {
    await sql.query('rollback');
    throw err;
  }
}
