import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { open, quote, verifyReceipt, toMicro, fromMicro, billedSeconds } from "../src/index.js";

const fresh = () => mkdtempSync(join(tmpdir(), "chronark-"));
const bin = new URL("../bin/chronark.js", import.meta.url).pathname;
const cli = (args, home) => spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, CHRONARK_HOME: home, NO_COLOR: "1" }, encoding: "utf8" });

test("money maths stays exact", () => {
  assert.equal(quote(412), "0.164800");
  assert.equal(fromMicro(toMicro("2") - toMicro("0.1648")), "1.8352");
  assert.equal(billedSeconds(1200), 2);
  assert.equal(billedSeconds(0), 1);
  assert.throws(() => toMicro("1.1234567"));
});

test("a session meters, signs and verifies", async () => {
  const dir = fresh();
  const s = await open({ worker: "node", budget: "1", dir });
  const out = await s.exec([process.execPath, "-e", "console.log('hi')"]);
  assert.equal(out.code, 0);
  assert.equal(out.stdout.trim(), "hi");
  const r = await s.stop();
  assert.equal(r.status, "completed");
  assert.ok(r.seconds >= 1);
  assert.equal(verifyReceipt(JSON.parse(readFileSync(r.file, "utf8"))).ok, true);
});

test("a tampered receipt fails verification", async () => {
  const dir = fresh();
  const s = await open({ budget: "1", dir });
  await s.exec([process.execPath, "-e", ""]);
  const r = JSON.parse(readFileSync((await s.stop()).file, "utf8"));
  r.paid = "0.000000 USDC";
  assert.equal(verifyReceipt(r).ok, false);
});

test("the budget stops a long command", async () => {
  const dir = fresh();
  const s = await open({ budget: "0.0008", dir }); // 2 seconds
  const t = Date.now();
  await s.exec([process.execPath, "-e", "setTimeout(()=>{}, 20000)"]);
  const r = await s.stop();
  assert.equal(r.status, "budget_exhausted");
  assert.equal(r.seconds, 2);
  assert.equal(r.refund, "0.000000 USDC");
  assert.ok(Date.now() - t < 6000);
});

test("cli run, receipts and verify", () => {
  const home = fresh();
  const run = cli(["run", "--budget", "0.5", "--", process.execPath, "-e", "console.log('done')"], home);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /done/);
  assert.match(run.stderr, /receipt signed/);
  const id = run.stderr.match(/session opened\s+(0x[0-9a-f]{4})/)[1];
  const list = cli(["receipts", "--json"], home);
  const [r] = JSON.parse(list.stdout);
  assert.ok(r.session.startsWith(id));
  assert.equal(cli(["verify", r.file], home).status, 0);
  const bad = join(home, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...r, paid: "0.000000 USDC" }));
  const v = cli(["verify", bad], home);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /invalid/);
});

test("cli fails cleanly without a command", () => {
  const r = cli(["run"], fresh());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing to run/);
});
