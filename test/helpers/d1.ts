import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A small D1 stand-in on Node's built-in SQLite, enough for the queries in this codebase:
 * prepare().bind().first/all/run, and batch(). Every migration in /migrations is applied, in order.
 */
type Value = string | number | null;
const clean = (params: unknown[]): Value[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : (p as Value)));
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: Value[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, clean(params));
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (col ? (row as Record<string, unknown>)[col] : plain(row)) as T;
  }
  async all<T = Record<string, unknown>>() {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => plain<T>(r)), success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  isQuery() {
    return /^\s*(SELECT|WITH)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
  }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    batch: async (stmts: Statement[]) => {
      // Like D1, a batch runs whole: each statement executes before anything else gets a turn.
      return Promise.all(stmts.map((s) => (s.isQuery() ? s.all() : s.run())));
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return { d1: d1 as unknown as D1Database, raw: db };
}
