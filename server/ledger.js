// Ledger: accounts, held funds and sessions in SQLite (node:sqlite). All money is integer micro-USDC.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openLedger(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, pub TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS credits (
      n INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, worker TEXT NOT NULL, rate INTEGER NOT NULL, budget INTEGER NOT NULL,
      opened INTEGER NOT NULL, closed INTEGER, seconds INTEGER, paid INTEGER, status TEXT NOT NULL, receipt TEXT);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account, status);
  `);
  const q = {
    get: db.prepare("SELECT * FROM accounts WHERE id = ?"),
    ins: db.prepare("INSERT OR IGNORE INTO accounts (id, pub, created) VALUES (?, ?, ?)"),
    credit: db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?"),
    creditLog: db.prepare("INSERT INTO credits (account, amount, note, at) VALUES (?, ?, ?, ?)"),
    hold: db.prepare("UPDATE accounts SET balance = balance - ?, held = held + ? WHERE id = ? AND balance >= ?"),
    release: db.prepare("UPDATE accounts SET balance = balance + ?, held = held - ? WHERE id = ?"),
    sIns: db.prepare("INSERT INTO sessions (id, account, worker, rate, budget, opened, status) VALUES (?, ?, ?, ?, ?, ?, 'open')"),
    sGet: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    sOpen: db.prepare("SELECT * FROM sessions WHERE status = 'open'"),
    sCount: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE account = ? AND status = 'open'"),
    sClose: db.prepare("UPDATE sessions SET closed = ?, seconds = ?, paid = ?, status = ?, receipt = ? WHERE id = ? AND status = 'open'"),
    sList: db.prepare("SELECT id, worker, opened, closed, seconds, paid, status FROM sessions WHERE account = ? ORDER BY opened DESC LIMIT ?"),
  };
  const tx = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const big = (r) => r && { ...r, balance: BigInt(r.balance), held: BigInt(r.held) };

  return {
    account: (id) => big(q.get.get(id)),
    ensure: (id, pub) => { q.ins.run(id, pub, Date.now()); return big(q.get.get(id)); },
    credit(id, amount, note = "") {
      return tx(() => {
        if (!q.get.get(id)) throw new Error("unknown account (it is created on its first request)");
        q.credit.run(amount, id); q.creditLog.run(id, amount, note, Date.now());
        return big(q.get.get(id));
      });
    },
    // Moves `budget` from balance to held and records the session, or throws if the balance is short.
    openSession({ id, account, worker, rate, budget, opened }) {
      return tx(() => {
        if (q.hold.run(budget, budget, account, budget).changes !== 1) throw Object.assign(new Error("balance too low for that budget"), { status: 402 });
        q.sIns.run(id, account, worker, rate, budget, opened);
        return q.sGet.get(id);
      });
    },
    // Releases the hold, keeps `paid`, refunds the rest. Idempotent: a closed session is returned unchanged.
    closeSession(id, { closed, seconds, paid, status, receipt }) {
      return tx(() => {
        const s = q.sGet.get(id);
        if (!s || s.status !== "open") return s;
        const budget = BigInt(s.budget);
        q.release.run(budget - paid, budget, s.account);
        q.sClose.run(closed, seconds, paid, status, receipt, id);
        return q.sGet.get(id);
      });
    },
    session: (id) => q.sGet.get(id),
    openSessions: () => q.sOpen.all(),
    countOpen: (account) => q.sCount.get(account).n,
    sessions: (account, limit = 20) => q.sList.all(account, limit),
    close: () => db.close(),
  };
}
