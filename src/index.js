// Chronark SDK: open a metered session, exec commands in it, stop it to get a signed receipt.
//
//   const session = await chronark.open({ worker: "python", seconds: 600 });
//   const out = await session.exec("python main.py");
//   const receipt = await session.stop();
//
// This release runs in local mode: the worker is your own machine and the node key is a local ed25519 key.
// Seconds are metered and receipts are signed for real; no money moves (settlement is "simulated").
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeKey, signReceipt, verifyReceipt, home } from "./receipt.js";

export { verifyReceipt, canonical } from "./receipt.js";

export const DEFAULT_RATE = "0.0004"; // USDC per second
const DEC = 6; // USDC has 6 decimals; all money maths is done in integer micro-units

export function toMicro(s) {
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`not an amount: ${s}`);
  const [i, f = ""] = str.split(".");
  if (f.length > DEC) throw new Error(`more than ${DEC} decimals: ${s}`);
  return BigInt(i) * 10n ** BigInt(DEC) + BigInt(f.padEnd(DEC, "0"));
}
export function fromMicro(m, places = 4) {
  const neg = m < 0n; if (neg) m = -m;
  const s = (m / 10n ** BigInt(DEC)).toString() + "." + (m % 10n ** BigInt(DEC)).toString().padStart(DEC, "0");
  return (neg ? "-" : "") + s.slice(0, s.indexOf(".") + 1 + places);
}

// Billing is per started second: 1.2 s of wall clock is 2 seconds.
export const billedSeconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

export function quote(seconds, rate = DEFAULT_RATE) {
  return fromMicro(BigInt(seconds) * toMicro(rate), 6);
}

export async function open({ worker = "local", seconds, budget, rate = DEFAULT_RATE, dir = home(), onTick } = {}) {
  const rateM = toMicro(rate);
  if (rateM <= 0n) throw new Error("rate must be above zero");
  // A budget caps the session; `seconds` is the same cap expressed in time.
  let budgetM = budget != null ? toMicro(budget) : seconds != null ? BigInt(seconds) * rateM : toMicro("2");
  const maxSeconds = Number(budgetM / rateM);
  if (maxSeconds < 1) throw new Error("budget does not cover a single second at this rate");

  const key = nodeKey(dir);
  const id = "0x" + randomBytes(32).toString("hex");
  const opened = Date.now();
  let usedMs = 0, running = null, stopped = null, exhausted = false;
  const outHash = createHash("sha256");
  const execs = [];

  const left = () => maxSeconds * 1000 - usedMs;

  const session = {
    id, worker, rate: fromMicro(rateM, 6), budget: fromMicro(budgetM, 6), maxSeconds, node: key.id,
    get seconds() { return usedMs ? billedSeconds(usedMs) : 0; },
    get exhausted() { return exhausted; },
    cost: (s) => fromMicro(BigInt(s) * rateM, 4),

    // Runs a command (a shell string, or [cmd, ...args]) and resolves with { code, signal, stdout, stderr }.
    // stdio: "pipe" collects output, "inherit-tee" streams it to this process too.
    exec(cmd, { stdio = "pipe", onData } = {}) {
      if (stopped) return Promise.reject(new Error("session is stopped"));
      if (running) return Promise.reject(new Error("one command at a time per session"));
      if (left() <= 0) return Promise.reject(new Error("budget exhausted"));
      const [file, args, shell] = Array.isArray(cmd) ? [cmd[0], cmd.slice(1), false] : [cmd, [], true];
      const child = spawn(file, args, { shell, stdio: ["inherit", "pipe", "pipe"] });
      const t0 = Date.now(), bufs = { stdout: [], stderr: [] };
      const tick = setInterval(() => {
        const ms = usedMs + (Date.now() - t0);
        onTick?.({ seconds: billedSeconds(ms), cost: fromMicro(BigInt(billedSeconds(ms)) * rateM, 4), max: maxSeconds });
        if (ms >= maxSeconds * 1000 && !exhausted) { exhausted = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }
      }, 250);
      for (const k of ["stdout", "stderr"]) child[k].on("data", (b) => {
        outHash.update(b); if (stdio === "pipe") bufs[k].push(b); onData?.(k, b);
      });
      running = new Promise((resolve, reject) => {
        child.on("error", (e) => { clearInterval(tick); running = null; reject(e); });
        child.on("close", (code, signal) => {
          clearInterval(tick);
          usedMs = Math.min(usedMs + (Date.now() - t0), maxSeconds * 1000);
          running = null;
          const rec = { cmd: Array.isArray(cmd) ? cmd.join(" ") : cmd, code, signal, ms: Date.now() - t0 };
          execs.push(rec);
          resolve({ ...rec, stdout: Buffer.concat(bufs.stdout).toString(), stderr: Buffer.concat(bufs.stderr).toString() });
        });
      });
      return running;
    },

    // Closes the session, signs the receipt and writes it to CHRONARK_HOME/receipts/<id>.json.
    async stop() {
      if (stopped) return stopped;
      if (running) await running.catch(() => {});
      const s = usedMs ? billedSeconds(usedMs) : 0;
      const paidM = BigInt(s) * rateM > budgetM ? budgetM : BigInt(s) * rateM;
      const body = {
        v: 1, mode: "local", session: id, worker, opened: new Date(opened).toISOString(), closed: new Date().toISOString(),
        seconds: s, rate: fromMicro(rateM, 6) + " USDC/s", budget: fromMicro(budgetM, 6) + " USDC",
        paid: fromMicro(paidM, 6) + " USDC", refund: fromMicro(budgetM - paidM, 6) + " USDC",
        status: exhausted ? "budget_exhausted" : "completed", settlement: "simulated",
        execs: execs.map(({ cmd, code, signal }) => ({ cmd, code, signal })),
        output: "sha256:" + outHash.digest("hex"),
      };
      stopped = signReceipt(body, key);
      const rdir = join(dir, "receipts");
      mkdirSync(rdir, { recursive: true });
      stopped.file = join(rdir, id + ".json");
      const { file, ...out } = stopped;
      writeFileSync(stopped.file, JSON.stringify(out, null, 2) + "\n");
      return stopped;
    },
  };
  return session;
}

export function receipts(dir = home()) {
  const rdir = join(dir, "receipts");
  let names = [];
  try { names = readdirSync(rdir).filter((n) => n.endsWith(".json")); } catch {}
  return names.map((n) => { try { return { file: join(rdir, n), ...JSON.parse(readFileSync(join(rdir, n), "utf8")) }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => (a.closed < b.closed ? 1 : -1));
}

export function whoami(dir = home()) { const k = nodeKey(dir); return { id: k.id, pub: k.pub, home: dir }; }

export default { open, quote, receipts, verifyReceipt, whoami };
