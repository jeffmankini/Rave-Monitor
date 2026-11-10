// A stand-in for Cloudflare D1 in tests: the same prepare/bind/first/all/run/batch calls, on Node's
// built-in SQLite (node:sqlite, Node 22.5+). The migrations in worker/api/migrations build the schema.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (err) { sqlite = null; }
export const hasSqlite = !!sqlite;

export function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(ROOT, 'worker', 'api', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  const plain = r => (r ? { ...r } : null);
  const isRead = sql => /^\s*(select|with|pragma)\b/i.test(sql);
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, p),
    first: async col => { const r = plain(db.prepare(sql).get(...params)); return r && col ? r[col] : r; },
    all: async () => ({ success: true, results: db.prepare(sql).all(...params).map(plain), meta: {} }),
    run: async () => { const r = db.prepare(sql).run(...params); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    exec() {
      const s = db.prepare(sql);
      if (isRead(sql)) return { success: true, results: s.all(...params).map(plain), meta: {} };
      const r = s.run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  });
  return {
    db,
    prepare: sql => stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s.exec()); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    rows: (sql, ...p) => db.prepare(sql).all(...p).map(plain)
  };
}
