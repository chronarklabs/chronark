// Chronark Cloud API.
//   GET  /v1/node                    who this node is, its rate and workers (public)
//   GET  /v1/account                 your balance and recent sessions (signed)
//   POST /v1/sessions                open a sandbox; the budget is held from your balance (signed)
//   POST /v1/sessions/:id/exec       run a command in it, output streamed as NDJSON (signed, owner)
//   POST /v1/sessions/:id/stop       close it: pay the seconds used, refund the rest, get the receipt (signed, owner)
//   GET  /v1/sessions/:id            status, and the receipt once closed (signed, owner)
//   GET  /v1/receipts/:id            a closed session's signed receipt (public: receipts are made to be checked)
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { signReceipt } from "../src/receipt.js";
import { toMicro, fromMicro, billedSeconds } from "../src/index.js";
import { makeVerifier } from "../src/auth.js";

const MAX_BODY = 64 * 1024;

export function createApp({ ledger, runner, key, rate = "0.0004", maxSessions = 20, maxPerAccount = 3, idleSeconds = 300,
  maxBudget = "10", minBudget = "0.0004", currency = "USDC", deposit = null, log = () => {} }) {
  const rateM = toMicro(rate), maxBudgetM = toMicro(maxBudget), minBudgetM = toMicro(minBudget);
  const check = makeVerifier();
  const live = new Map(); // session id -> { row, box, execs, hash, running, timers, maxSeconds }

  async function close(id, status) {
    const s = live.get(id);
    if (!s || s.closing) return s?.closing;
    s.closing = (async () => {
      clearTimeout(s.expiry); clearTimeout(s.idle);
      s.running?.kill();
      if (s.running) await s.running.done.catch(() => {});
      const closed = Date.now();
      const seconds = Math.min(billedSeconds(closed - s.row.opened), s.maxSeconds);
      const budget = BigInt(s.row.budget), paid = BigInt(seconds) * rateM > budget ? budget : BigInt(seconds) * rateM;
      const receipt = signReceipt({
        v: 1, mode: "cloud", session: id, account: s.row.account, worker: s.row.worker, image: s.box?.image ?? null,
        opened: new Date(s.row.opened).toISOString(), closed: new Date(closed).toISOString(), seconds,
        rate: fromMicro(rateM, 6) + ` ${currency}/s`, budget: fromMicro(budget, 6) + ` ${currency}`,
        paid: fromMicro(paid, 6) + ` ${currency}`, refund: fromMicro(budget - paid, 6) + ` ${currency}`,
        status, settlement: "ledger", execs: s.execs, output: "sha256:" + s.hash.digest("hex"),
      }, key);
      ledger.closeSession(id, { closed, seconds, paid, status, receipt: JSON.stringify(receipt) });
      if (s.box) await runner.destroy(s.box);
      live.delete(id);
      log(`close ${id.slice(0, 10)} ${status} ${seconds}s paid ${fromMicro(paid, 6)}`);
      return receipt;
    })();
    return s.closing;
  }
  const touch = (s) => { clearTimeout(s.idle); s.idle = setTimeout(() => close(s.row.id, "idle_timeout"), idleSeconds * 1000); s.idle.unref?.(); };

  // Sessions left open by a crash are closed without charge: the node can't prove how long they ran.
  async function recover() {
    const swept = await runner.sweep();
    let n = 0;
    for (const row of ledger.openSessions()) {
      const receipt = signReceipt({ v: 1, mode: "cloud", session: row.id, account: row.account, worker: row.worker, image: null,
        opened: new Date(row.opened).toISOString(), closed: new Date().toISOString(), seconds: 0,
        rate: fromMicro(BigInt(row.rate), 6) + ` ${currency}/s`, budget: fromMicro(BigInt(row.budget), 6) + ` ${currency}`,
        paid: `0.000000 ${currency}`, refund: fromMicro(BigInt(row.budget), 6) + ` ${currency}`, status: "interrupted", settlement: "ledger",
        execs: [], output: null }, key);
      ledger.closeSession(row.id, { closed: Date.now(), seconds: 0, paid: 0n, status: "interrupted", receipt: JSON.stringify(receipt) });
      n++;
    }
    return { swept, refunded: n };
  }

  const routes = [
    ["GET", /^\/v1\/node$/, false, async () => ({ node: { id: key.id, pub: key.pub }, rate: fromMicro(rateM, 6), currency, deposit,
      unit: "second", workers: Object.keys(runner.images), runner: runner.kind, minBudget: fromMicro(minBudgetM, 6), maxBudget: fromMicro(maxBudgetM, 6),
      idleSeconds, settlement: "ledger" })],

    ["GET", /^\/v1\/account$/, true, async ({ who }) => {
      const a = ledger.ensure(who.account, who.pub);
      return { account: a.id, currency, balance: fromMicro(a.balance, 6), held: fromMicro(a.held, 6),
        deposits: ledger.deposits(a.id, 10).map((d) => ({ amount: fromMicro(BigInt(d.amount), 6), tx: d.tx, block: d.block, at: new Date(d.at).toISOString() })), sessions: ledger.sessions(a.id, 10)
        .map((s) => ({ ...s, paid: s.paid == null ? null : fromMicro(BigInt(s.paid), 6) })) };
    }],

    ["POST", /^\/v1\/sessions$/, true, async ({ who, body }) => {
      const worker = String(body.worker ?? "shell");
      let budget;
      try { budget = body.budget != null ? toMicro(body.budget) : body.seconds != null ? BigInt(Math.floor(Number(body.seconds))) * rateM : toMicro("0.24"); }
      catch (e) { throw http(400, e.message); }
      if (budget < minBudgetM) throw http(400, `budget is below the minimum of ${fromMicro(minBudgetM, 6)} ${currency}`);
      if (budget > maxBudgetM) throw http(400, `budget is above the maximum of ${fromMicro(maxBudgetM, 6)} ${currency} per session`);
      if (!runner.images[worker]) throw http(400, `unknown worker "${worker}" (have: ${Object.keys(runner.images).join(", ")})`);
      if (live.size >= maxSessions) throw http(503, "this node is full, try again shortly");
      const acct = ledger.ensure(who.account, who.pub);
      if (ledger.countOpen(acct.id) >= maxPerAccount) throw http(429, `at most ${maxPerAccount} open sessions per account`);
      const id = "0x" + randomBytes(32).toString("hex");
      const maxSeconds = Number(budget / rateM);
      const row = ledger.openSession({ id, account: acct.id, worker, rate: rateM, budget, opened: Date.now() });
      const s = { row, box: null, execs: [], hash: createHash("sha256"), running: null, maxSeconds };
      live.set(id, s);
      try { s.box = await runner.create(id, worker); }
      catch (e) { await close(id, "failed"); throw http(e.status ?? 500, "could not start the sandbox: " + e.message); }
      // the clock started when the funds were held; the sandbox start-up is billed like any other second
      s.expiry = setTimeout(() => close(id, "budget_exhausted"), Math.max(0, row.opened + maxSeconds * 1000 - Date.now())); s.expiry.unref?.();
      touch(s);
      log(`open ${id.slice(0, 10)} ${worker} budget ${fromMicro(budget, 6)} acct ${acct.id.slice(0, 10)}`);
      return { session: id, currency, worker, image: s.box.image, rate: fromMicro(rateM, 6), budget: fromMicro(budget, 6), maxSeconds,
        opened: new Date(row.opened).toISOString(), node: key.id };
    }],

    ["POST", /^\/v1\/sessions\/(0x[0-9a-f]{64})\/exec$/, true, async ({ who, body, m, res }) => {
      const s = owned(m[1], who);
      if (s.running) throw http(409, "a command is already running in this session");
      const cmd = String(body.cmd ?? "");
      if (!cmd || cmd.length > 8192) throw http(400, "cmd must be a non-empty string of at most 8192 characters");
      touch(s);
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
      const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n"); };
      const t0 = Date.now();
      s.running = runner.exec(s.box, cmd, { onData: (k, b) => { s.hash.update(b); send({ t: k, d: b.toString("base64") }); } });
      res.on("close", () => { if (!res.writableFinished) s.running?.kill(); });
      const r = await s.running.done;
      s.running = null;
      s.execs.push({ cmd, code: r.code, signal: r.signal });
      touch(s);
      send({ t: "exit", code: r.code, signal: r.signal, ms: Date.now() - t0, ...(s.closing || !live.has(m[1]) ? { closed: true } : {}) });
      res.end();
      return STREAMED;
    }],

    ["POST", /^\/v1\/sessions\/(0x[0-9a-f]{64})\/stop$/, true, async ({ who, m }) => {
      const row = ledger.session(m[1]);
      if (!row || row.account !== who.account) throw http(404, "no such session");
      if (row.status !== "open") return { receipt: JSON.parse(row.receipt) };
      return { receipt: await close(m[1], "completed") };
    }],

    ["GET", /^\/v1\/sessions\/(0x[0-9a-f]{64})$/, true, async ({ who, m }) => {
      const row = ledger.session(m[1]);
      if (!row || row.account !== who.account) throw http(404, "no such session");
      const s = live.get(m[1]);
      return { session: row.id, status: row.status, worker: row.worker, opened: new Date(row.opened).toISOString(),
        elapsed: s ? Math.floor((Date.now() - row.opened) / 1000) : row.seconds, maxSeconds: s?.maxSeconds ?? null,
        receipt: row.receipt ? JSON.parse(row.receipt) : null };
    }],

    ["GET", /^\/v1\/receipts\/(0x[0-9a-f]{64})$/, false, async ({ m }) => {
      const row = ledger.session(m[1]);
      if (!row?.receipt) throw http(404, "no receipt for that session (it may still be open)");
      return JSON.parse(row.receipt);
    }],
  ];

  function owned(id, who) {
    const s = live.get(id);
    if (!s || s.row.account !== who.account) {
      const row = ledger.session(id);
      if (row && row.account === who.account) throw http(409, `session is ${row.status}`);
      throw http(404, "no such session");
    }
    if (s.closing) throw http(409, "session is closing");
    return s;
  }

  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    let matched;
    for (const r of routes) { const m = r[0] === req.method && path.match(r[1]); if (m) { matched = [r, m]; break; } }
    try {
      if (!matched) throw http(404, "not found");
      const raw = await readBody(req);
      const [[, , signed, fn], m] = matched;
      let who = null;
      if (signed) { who = check(req, raw); if (who.error) throw http(401, who.error); }
      let body = {};
      if (raw.length) { try { body = JSON.parse(raw); } catch { throw http(400, "body must be JSON"); } }
      const out = await fn({ who, body, m, req, res });
      if (out !== STREAMED) json(res, 200, out);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (!e.status) log("error " + (e.stack || e.message));
      json(res, e.status ?? 500, { error: e.status ? e.message : "internal error" });
    }
  });
  server.requestTimeout = 0; // exec streams can run as long as the session's budget allows
  server.headersTimeout = 15_000;

  return { server, recover, close, live, async shutdown() { for (const id of [...live.keys()]) await close(id, "node_shutdown"); } };
}

const STREAMED = Symbol("streamed");
const http = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, o) => { const b = JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)); res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(b); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (b) => { n += b.length; if (n > MAX_BODY) { reject(http(413, "body too large")); req.destroy(); } else parts.push(b); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
