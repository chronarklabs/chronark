import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../server/ledger.js";
import { processRunner, dockerRunner } from "../server/runner.js";
import { createApp } from "../server/app.js";
import { nodeKey, verifyReceipt } from "../src/receipt.js";
import { signRequest } from "../src/auth.js";
import { cloud, toMicro } from "../src/index.js";

const fresh = () => mkdtempSync(join(tmpdir(), "chronark-"));
let app, url, ledger;

async function start(runner, extra = {}) {
  const l = openLedger(":memory:");
  const a = createApp({ ledger: l, runner, key: nodeKey(fresh()), idleSeconds: 30, ...extra });
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
  return { app: a, ledger: l, url: `http://127.0.0.1:${a.server.address().port}` };
}
before(async () => ({ app, url, ledger } = await start(processRunner())));
after(async () => { await app.shutdown(); app.server.close(); });

const funded = async (amount = "1") => {
  const c = cloud(url, { dir: fresh() });
  await c.balance(); // first signed request creates the account
  ledger.credit(c.account, toMicro(amount), "test");
  return c;
};

test("node info is public", async () => {
  const n = await (await fetch(url + "/v1/node")).json();
  assert.equal(n.rate, "0.000400");
  assert.match(n.node.id, /^0x[0-9a-f]{40}$/);
});

test("open, exec, stop: pays the seconds, refunds the rest, signs a receipt", async () => {
  const c = await funded("1");
  const s = await c.open({ worker: "shell", budget: "0.5" });
  assert.equal((await c.balance()).held, "0.500000");
  const out = await s.exec(["sh", "-c", "echo hi; echo oops >&2; exit 3"]);
  assert.equal(out.stdout, "hi\n"); assert.equal(out.stderr, "oops\n"); assert.equal(out.code, 3);
  const r = await s.stop();
  assert.equal(verifyReceipt(r).ok, true);
  assert.equal(r.mode, "cloud"); assert.equal(r.settlement, "ledger"); assert.equal(r.account, c.account);
  assert.equal(r.execs[0].code, 3);
  const paid = toMicro(r.paid.split(" ")[0]);
  assert.equal(paid, BigInt(r.seconds) * 400n);
  const a = await c.balance();
  assert.equal(a.held, "0.000000");
  assert.equal(toMicro(a.balance), toMicro("1") - paid);
  const pub = await (await fetch(`${url}/v1/receipts/${r.session}`)).json();
  assert.equal(pub.sig, r.sig);
});

test("no balance, no session", async () => {
  const c = cloud(url, { dir: fresh() });
  await assert.rejects(c.open({ budget: "0.1" }), (e) => e.status === 402);
});

test("budget limits are enforced", async () => {
  const c = await funded("50");
  await assert.rejects(c.open({ budget: "11" }), /maximum/);
  await assert.rejects(c.open({ budget: "0.0001" }), /minimum/);
  await assert.rejects(c.open({ worker: "cobol", budget: "0.1" }), /unknown worker/);
});

test("someone else's key cannot touch your session", async () => {
  const a = await funded(), b = await funded();
  const s = await a.open({ budget: "0.1" });
  const bad = await fetch(`${url}/v1/sessions/${s.id}/exec`, { method: "POST", body: '{"cmd":"id"}',
    headers: { "content-type": "application/json", ...signRequest(nodeKey(fresh()), "POST", `/v1/sessions/${s.id}/exec`, '{"cmd":"id"}') } });
  assert.equal(bad.status, 404);
  await s.stop();
  void b;
});

test("unsigned, tampered and replayed requests are refused", async () => {
  assert.equal((await fetch(url + "/v1/account")).status, 401);
  const key = nodeKey(fresh());
  const h = signRequest(key, "GET", "/v1/account");
  assert.equal((await fetch(url + "/v1/account", { headers: h })).status, 200);
  assert.equal((await fetch(url + "/v1/account", { headers: h })).status, 401, "replay");
  const h2 = signRequest(key, "POST", "/v1/sessions", '{"budget":"0.1"}');
  const r = await fetch(url + "/v1/sessions", { method: "POST", headers: { ...h2, "content-type": "application/json" }, body: '{"budget":"9"}' });
  assert.equal(r.status, 401, "body swapped after signing");
  const old = { ...signRequest(key, "GET", "/v1/account"), "x-chronark-ts": String(Date.now() - 120_000) };
  assert.equal((await fetch(url + "/v1/account", { headers: old })).status, 401, "stale");
});

test("the budget stops a long command and the sandbox", async () => {
  const c = await funded();
  const s = await c.open({ budget: "0.0008" }); // 2 seconds
  const t = Date.now();
  const out = await s.exec("sleep 30");
  assert.ok(Date.now() - t < 6000);
  assert.equal(out.closed, true);
  const r = await s.stop();
  assert.equal(r.status, "budget_exhausted");
  assert.equal(r.seconds, 2);
  assert.equal(r.refund, "0.000000 USDC");
});

test("crash recovery refunds open sessions", async () => {
  const l = openLedger(":memory:");
  const k = nodeKey(fresh());
  l.ensure("0x" + "a".repeat(40), "x"); l.credit("0x" + "a".repeat(40), toMicro("1"));
  l.openSession({ id: "0x" + "b".repeat(64), account: "0x" + "a".repeat(40), worker: "shell", rate: 400n, budget: toMicro("0.5"), opened: Date.now() - 5000 });
  const a = createApp({ ledger: l, runner: processRunner(), key: k });
  const rec = await a.recover();
  assert.equal(rec.refunded, 1);
  assert.equal(l.account("0x" + "a".repeat(40)).balance, toMicro("1"));
  assert.equal(JSON.parse(l.session("0x" + "b".repeat(64)).receipt).status, "interrupted");
});

test("docker sandbox is locked down", { skip: !process.env.CHRONARK_TEST_DOCKER && "set CHRONARK_TEST_DOCKER=1 to run" }, async () => {
  const d = await start(dockerRunner());
  try {
    const c = cloud(d.url, { dir: fresh() });
    await c.balance(); d.ledger.credit(c.account, toMicro("1"));
    const s = await c.open({ worker: "python", budget: "0.2" });
    const py = await s.exec(["python", "-c", "print(6*7)"]);
    assert.equal(py.stdout.trim(), "42");
    const who = await s.exec("id -u; touch /etc/x 2>&1 || echo ro; wget -q -T 2 -O- http://1.1.1.1 2>&1 || echo nonet; cat /proc/1/cmdline | tr '\\0' ' '");
    assert.match(who.stdout, /^1000\n/);
    assert.match(who.stdout, /ro/);
    assert.match(who.stdout, /nonet/);
    const r = await s.stop();
    assert.equal(r.image, "python:3.12-slim");
    assert.equal(verifyReceipt(r).ok, true);
  } finally { await d.app.shutdown(); d.app.server.close(); }
});
