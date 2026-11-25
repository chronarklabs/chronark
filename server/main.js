#!/usr/bin/env node
// Chronark Cloud node.
//   node server/main.js                          serve the API
//   node server/main.js credit <account> <USDC>  add funds to an account (operator only, runs against the local ledger)
//   node server/main.js account <account>        show an account
// Config (env): CHRONARK_HOST 127.0.0.1, CHRONARK_PORT 8787, CHRONARK_DATA ./data, CHRONARK_RATE 0.0004,
//   CHRONARK_RUNNER docker|process, CHRONARK_NETWORK none, CHRONARK_MEMORY 512m, CHRONARK_CPUS 1,
//   CHRONARK_MAX_SESSIONS 20, CHRONARK_MAX_PER_ACCOUNT 3, CHRONARK_IDLE 300, CHRONARK_MAX_BUDGET 10, CHRONARK_CURRENCY USDC
// On-chain deposits (all four to enable): CHRONARK_CHAIN_RPC, CHRONARK_CHAIN_ID, CHRONARK_VAULT, CHRONARK_VAULT_FROM (deploy block),
//   plus CHRONARK_TOKEN (shown to depositors) and CHRONARK_CONFIRMATIONS (default 3)
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { nodeKey } from "../src/receipt.js";
import { toMicro, fromMicro } from "../src/index.js";
import { openLedger } from "./ledger.js";
import { dockerRunner, processRunner } from "./runner.js";
import { createApp } from "./app.js";
import { watchDeposits } from "./deposits.js";

const env = process.env;
const data = resolve(env.CHRONARK_DATA || "data");
const ledger = openLedger(join(data, "ledger.db"));
const [cmd, ...args] = process.argv.slice(2);
// Private mode (CHRONARK_PRIVATE=1): only accounts listed in data/allow.txt may open sessions; edit it with allow/deny.
const ALLOW = join(data, "allow.txt");
const readAllow = () => new Set((existsSync(ALLOW) ? readFileSync(ALLOW, "utf8") : "").split(/\s+/).filter((x) => /^0x[0-9a-f]{40}$/.test(x)));
if (cmd === "allow" || cmd === "deny") {
  const acct = (args[0] ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(acct)) { console.error(`usage: ${cmd} <account 0x…40 hex>`); process.exit(2); }
  const set = readAllow(); cmd === "allow" ? set.add(acct) : set.delete(acct);
  writeFileSync(ALLOW, [...set].join("\n") + "\n", { mode: 0o600 });
  console.log(`${cmd === "allow" ? "allowed" : "removed"} ${acct} · ${set.size} account(s) on the list`);
  process.exit(0);
}

if (cmd === "credit") {
  const [account, amount, ...note] = args;
  if (!/^0x[0-9a-f]{40}$/.test(account ?? "") || !amount) { console.error("usage: credit <account 0x…40 hex> <USDC> [note]"); process.exit(2); }
  const a = ledger.credit(account, toMicro(amount), note.join(" "));
  console.log(`credited ${amount} USDC · ${a.id} balance ${fromMicro(a.balance, 6)} USDC`);
  process.exit(0);
}
if (cmd === "account") {
  const a = ledger.account(args[0] ?? "");
  if (!a) { console.error("no such account"); process.exit(1); }
  console.log(`${a.id}\nbalance ${fromMicro(a.balance, 6)} USDC\nheld    ${fromMicro(a.held, 6)} USDC`);
  process.exit(0);
}
if (cmd) { console.error(`unknown command "${cmd}"`); process.exit(2); }

const host = env.CHRONARK_HOST || "127.0.0.1", port = Number(env.CHRONARK_PORT || 8787);
const kind = env.CHRONARK_RUNNER || "docker";
if (kind === "process" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  console.error("refusing to start: the process runner has no isolation and may only listen on localhost");
  process.exit(1);
}
const runner = kind === "process" ? processRunner()
  : dockerRunner({ network: env.CHRONARK_NETWORK || "none", memory: env.CHRONARK_MEMORY || "512m", cpus: env.CHRONARK_CPUS || "1" });
const key = nodeKey(data);
const currency = env.CHRONARK_CURRENCY || "USDC";
const deposit = env.CHRONARK_VAULT && env.CHRONARK_CHAIN_RPC ? {
  chainId: Number(env.CHRONARK_CHAIN_ID || 4663), vault: env.CHRONARK_VAULT, token: env.CHRONARK_TOKEN || null, currency,
  decimals: 6, confirmations: Number(env.CHRONARK_CONFIRMATIONS || 3), method: "deposit(bytes20 account, uint256 amount)",
  fundUrl: env.CHRONARK_FUND_URL || null } : null;
const app = createApp({
  ledger, runner, key, rate: env.CHRONARK_RATE || "0.0004",
  maxSessions: Number(env.CHRONARK_MAX_SESSIONS || 20), maxPerAccount: Number(env.CHRONARK_MAX_PER_ACCOUNT || 3),
  idleSeconds: Number(env.CHRONARK_IDLE || 300), maxBudget: env.CHRONARK_MAX_BUDGET || "10", currency, deposit,
  allowed: env.CHRONARK_PRIVATE === "1" ? (a) => readAllow().has(a) : null,
  log: (s) => console.log(new Date().toISOString(), s),
});
const rec = await app.recover();
if (rec.swept || rec.refunded) console.log(`recovered: removed ${rec.swept} stray sandboxes, refunded ${rec.refunded} interrupted sessions`);
let watcher = null;
if (deposit) {
  watcher = watchDeposits({ ledger, rpc: env.CHRONARK_CHAIN_RPC, vault: deposit.vault, from: Number(env.CHRONARK_VAULT_FROM || 0),
    confirmations: deposit.confirmations, log: (s) => console.log(new Date().toISOString(), s) }).start();
  console.log(`watching deposits on chain ${deposit.chainId} vault ${deposit.vault}`);
}
app.server.listen(port, host, () => console.log(`chronark node ${key.id} · ${kind} runner · ${env.CHRONARK_PRIVATE === "1" ? "private" : "public"} · http://${host}:${port}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  console.log("shutting down, closing open sessions");
  app.server.close();
  watcher?.stop();
  await app.shutdown();
  ledger.close();
  process.exit(0);
});
