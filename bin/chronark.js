#!/usr/bin/env node
// chronark: wrap any command, meter it by the second, get a signed receipt.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { open, quote, receipts, verifyReceipt, whoami, cloud, DEFAULT_RATE } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tty = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c("90"), ok = c("36"), warm = c("33"), bold = c("1"), red = c("31");
const short = (h) => h.slice(0, 6) + "…" + h.slice(-4);
const err = (...a) => process.stderr.write(a.join(" ") + "\n");

const HELP = `${bold("chronark")} ${pkg.version} · per-second compute with signed receipts

${bold("Usage")}
  chronark run [--budget 2.00] [--rate ${DEFAULT_RATE}] [--worker name] -- <command> [args...]
  chronark run --cloud <url> [--budget 0.24] [--worker shell|python|node] -- <command> [args...]
  chronark account [--cloud <url>]
  chronark quote <seconds> [--rate ${DEFAULT_RATE}]
  chronark receipts [--json]
  chronark verify <receipt.json | session id>
  chronark whoami

${bold("Examples")}
  chronark run --budget 2.00 -- python scraper.py
  chronark run --budget 0.01 -- sleep 60        ${dim("# stopped at 25 s when the budget runs out")}
  chronark verify ~/.chronark/receipts/0x….json

Money is in USDC, billed per started second.
Local mode (default): your machine is the worker, receipts are signed by a
local key and no funds move (settlement: simulated).
Cloud mode (--cloud <url> or CHRONARK_CLOUD): the command runs in a sandbox
on a Chronark node, paid from your balance there (settlement: ledger). Your
account is your local key; \`chronark account\` prints its id for funding.
State lives in ~/.chronark (CHRONARK_HOME).`;

function flags(argv) {
  const f = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { rest.push(...argv.slice(i + 1)); f["--"] = true; break; }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (["json", "help", "version", "local"].includes(k)) f[k] = true;
      else f[k] = v ?? argv[++i];
    } else rest.push(a);
  }
  return { f, rest };
}

async function run(f, cmd) {
  if (!cmd.length) { err(red("✗"), "nothing to run. Put the command after --, e.g. chronark run -- python main.py"); return 2; }
  const url = f.local ? null : (f.cloud ?? process.env.CHRONARK_CLOUD);
  if (url) return runCloud(f, cmd, url);
  const worker = f.worker || basename(cmd[0]);
  const bar = (n, max) => { const w = 12, k = Math.min(w, Math.round((n / max) * w)); return ok("█".repeat(k)) + dim("░".repeat(w - k)); };
  let line = "", last = { seconds: 0, cost: "0.0000" };
  const draw = () => { if (tty) process.stderr.write("\r\x1b[2K" + line); };
  const clear = () => { if (tty && line) process.stderr.write("\r\x1b[2K"); };

  const s = await open({ worker, budget: f.budget ?? "2.00", rate: f.rate ?? DEFAULT_RATE, onTick: (t) => {
    last = t;
    line = `${warm("⧗")} metering  ${String(t.seconds).padStart(4)}s  ${bar(t.seconds, t.max)}  ${t.cost} USDC`;
    draw();
  } });
  err(`${ok("✓")} session opened   ${dim(short(s.id))}`);
  err(`  rate ${s.rate.replace(/0+$/, "")} USDC/s · budget ${s.budget.replace(/0{1,4}$/, "")} USDC · worker ${worker} · ${dim("local node " + short(s.node))}`);

  const onSig = () => {}; // let the child receive Ctrl-C; we still sign what was used
  process.on("SIGINT", onSig);
  let res;
  try {
    res = await s.exec(cmd, { stdio: "tee", onData: (k, b) => { clear(); (k === "stdout" ? process.stdout : process.stderr).write(b); draw(); } });
  } catch (e) {
    clear(); err(red("✗"), `could not start ${cmd[0]}: ${e.message}`);
    res = { code: 127 };
  }
  process.off("SIGINT", onSig);
  const r = await s.stop();
  clear();
  err(`${warm("⧗")} metered  ${String(r.seconds).padStart(4)}s  ${bar(r.seconds, s.maxSeconds)}  ${s.cost(r.seconds)} USDC`);
  if (r.status === "budget_exhausted") err(`${red("■")} budget exhausted, command stopped after ${r.seconds}s`);
  err(`${ok("✓")} receipt signed   ${dim(r.file.replace(process.env.HOME || "~", "~"))}`);
  err(`${ok("✓")} settled ${warm(r.paid.replace(/(\.\d{4})\d+/, "$1"))} · refund ${r.refund.replace(/(\.\d{4})\d+/, "$1")} ${dim("(simulated)")}`);
  if (r.status === "budget_exhausted") return 124;
  return res.code ?? (res.signal ? 128 : 1);
}

async function runCloud(f, cmd, url) {
  const c = cloud(url);
  const bar = (n, max) => { const w = 12, k = Math.min(w, Math.round((n / max) * w)); return ok("█".repeat(k)) + dim("░".repeat(w - k)); };
  let line = "";
  const draw = () => { if (tty) process.stderr.write("\r\x1b[2K" + line); };
  const clear = () => { if (tty && line) process.stderr.write("\r\x1b[2K"); };
  const worker = f.worker || "shell";
  let s;
  try {
    s = await c.open({ worker, budget: f.budget ?? "0.24", onTick: (t) => { line = `${warm("⧗")} metering  ${String(t.seconds).padStart(4)}s  ${bar(t.seconds, t.max)}  ${t.cost}`; draw(); } });
  } catch (e) {
    err(red("✗"), e.message);
    if (e.status === 402) err(dim(`  fund your account first: chronark account --cloud ${c.url}`));
    return e.status === 402 ? 3 : 1;
  }
  err(`${ok("✓")} session opened   ${dim(short(s.id))}  ${dim(c.url)}`);
  const cur = s.currency || "USDC";
  err(`  rate ${s.rate.replace(/0+$/, "")} ${cur}/s · budget ${s.budget.replace(/0{1,4}$/, "")} ${cur} · worker ${worker} (${s.image}) · ${dim("node " + short(s.node))}`);
  let res = { code: 1 };
  const onSig = () => { s.stop().catch(() => {}); };
  process.once("SIGINT", onSig);
  try { res = await s.exec(cmd, { onData: (k, b) => { clear(); (k === "stdout" ? process.stdout : process.stderr).write(b); draw(); } }); }
  catch (e) { clear(); err(red("✗"), e.message); }
  process.off("SIGINT", onSig);
  const r = await s.stop();
  clear();
  err(`${warm("⧗")} metered  ${String(r.seconds).padStart(4)}s  ${bar(r.seconds, s.maxSeconds)}  ${r.paid.replace(/(\.\d{4})\d+/, "$1")}`);
  if (r.status === "budget_exhausted") err(`${red("■")} budget exhausted, the sandbox was stopped after ${r.seconds}s`);
  err(`${ok("✓")} receipt signed   ${dim(r.file.replace(process.env.HOME || "~", "~"))}`);
  err(`${ok("✓")} settled ${warm(r.paid.replace(/(\.\d{4})\d+/, "$1"))} · refund ${r.refund.replace(/(\.\d{4})\d+/, "$1")} ${dim("(ledger)")}`);
  if (r.status === "budget_exhausted") return 124;
  return res.code ?? (res.signal ? 128 : 1);
}

function load(arg) {
  if (/^0x[0-9a-f]{6,}$/i.test(arg) && !arg.endsWith(".json")) {
    const hit = receipts().filter((r) => r.session.startsWith(arg.replace(/…$/, "")));
    if (hit.length !== 1) throw new Error(hit.length ? "more than one receipt matches that id" : "no receipt with that session id");
    const { file, ...r } = hit[0]; return r;
  }
  return JSON.parse(readFileSync(arg, "utf8"));
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { f, rest } = flags(argv);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || f.help) { console.log(HELP); return 0; }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") { console.log(pkg.version); return 0; }

  if (cmd === "run") return run(f, rest);

  if (cmd === "quote") {
    const n = Number(rest[0]);
    if (!Number.isInteger(n) || n < 1) { err(red("✗"), "give a whole number of seconds, e.g. chronark quote 600"); return 2; }
    console.log(`${n}s at ${f.rate ?? DEFAULT_RATE} USDC/s = ${quote(n, f.rate ?? DEFAULT_RATE)} USDC`);
    return 0;
  }

  if (cmd === "receipts") {
    const list = receipts();
    if (f.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log("No receipts yet. Run something: chronark run -- echo hello"); return 0; }
    for (const r of list)
      console.log(`${dim(r.closed.slice(0, 19).replace("T", " "))}  ${short(r.session)}  ${String(r.seconds).padStart(5)}s  ${r.paid.padStart(14)}  ${r.worker}${r.status === "completed" ? "" : "  " + red(r.status)}`);
    return 0;
  }

  if (cmd === "verify") {
    if (!rest[0]) { err(red("✗"), "give a receipt file or a session id"); return 2; }
    let r;
    try { r = load(rest[0]); } catch (e) { err(red("✗"), e.message); return 2; }
    const v = verifyReceipt(r);
    if (v.ok) console.log(`${ok("✓")} valid · session ${short(r.session)} · ${r.seconds}s · paid ${r.paid} · signed by node ${short(r.node.id)}`);
    else console.log(`${red("✗")} invalid · ${v.reason}`);
    return v.ok ? 0 : 1;
  }

  if (cmd === "account") {
    const url = f.cloud ?? process.env.CHRONARK_CLOUD;
    const w = whoami();
    if (!url) { console.log(`account ${w.id}\n${dim("add --cloud <url> to see your balance on a node")}`); return 0; }
    const c = cloud(url);
    const [a, n] = await Promise.all([c.balance(), c.node()]);
    if (f.json) { console.log(JSON.stringify({ ...a, node: n }, null, 2)); return 0; }
    const cur = a.currency || "USDC";
    console.log(`account ${a.account}\nnode    ${n.node.id} · ${c.url}\nbalance ${a.balance} ${cur}${a.held !== "0.000000" ? `  (${a.held} held by open sessions)` : ""}\nrate    ${n.rate} ${cur}/s · workers ${n.workers.join(", ")}`);
    if (n.deposit) console.log(`fund    send ${cur} to vault ${n.deposit.vault} on chain ${n.deposit.chainId}: ${n.deposit.method} with account ${a.account}` + (n.deposit.fundUrl ? `\n        or open ${n.deposit.fundUrl}?account=${a.account}` : ""));
    for (const d of a.deposits || []) console.log(dim(`  + ${d.amount} ${cur}  ${d.at.slice(0, 19).replace("T", " ")}  tx ${short(d.tx)}`));
    for (const x of a.sessions) console.log(dim(`  ${new Date(x.opened).toISOString().slice(0, 19).replace("T", " ")}  ${short(x.id)}  ${String(x.seconds ?? "-").padStart(5)}s  ${(x.paid ?? "-").padStart(9)}  ${x.worker}  ${x.status}`));
    return 0;
  }

  if (cmd === "whoami") {
    const w = whoami();
    console.log(`node ${w.id}\npub  ${w.pub}\nhome ${w.home}`);
    return 0;
  }

  err(red("✗"), `unknown command "${cmd}". Run chronark --help`);
  return 2;
}

main().then((code) => process.exit(code), (e) => { err(red("✗"), e.message); process.exit(1); });
