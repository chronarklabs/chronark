// Chronark Cloud client: every request is signed with your local ed25519 key (~/.chronark/node.key).
// That key is your account; there are no API keys. Fund it by giving the node operator your account id.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeKey, home, verifyReceipt } from "./receipt.js";
import { signRequest } from "./auth.js";

// There is deliberately no built-in default: you name the node you trust with your commands.
export const DEFAULT_CLOUD = null;

export function client(url = process.env.CHRONARK_CLOUD, { dir = home() } = {}) {
  if (!url) throw new Error("no cloud node given: pass --cloud <url> or set CHRONARK_CLOUD");
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("cloud nodes must use https (plain http is allowed for localhost only)");
  const base = u.origin;
  const key = nodeKey(dir);
  async function call(method, path, body) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const res = await fetch(base + path, {
      method, body: raw || undefined,
      headers: { ...(raw ? { "content-type": "application/json" } : {}), ...signRequest(key, method, path, raw) },
    }).catch((e) => { throw new Error(`cannot reach ${base}: ${e.cause?.code || e.message}`); });
    return res;
  }
  async function jsonCall(method, path, body) {
    const res = await call(method, path, body);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || `HTTP ${res.status}`), { status: res.status });
    return out;
  }
  return {
    url: base, account: key.id,
    node: async () => (await fetch(base + "/v1/node")).json(),
    balance: () => jsonCall("GET", "/v1/account"),
    async open({ worker = "shell", budget, seconds, onTick } = {}) {
      const s = await jsonCall("POST", "/v1/sessions", { worker, ...(budget != null ? { budget: String(budget) } : {}), ...(seconds != null ? { seconds } : {}) });
      const opened = Date.parse(s.opened);
      const tick = onTick && setInterval(() => {
        const sec = Math.min(Math.max(1, Math.ceil((Date.now() - opened) / 1000)), s.maxSeconds);
        onTick({ seconds: sec, max: s.maxSeconds, cost: (sec * Number(s.rate)).toFixed(4) });
      }, 250);
      let receipt = null;
      return {
        ...s, id: s.session,
        // Resolves with { code, signal, stdout, stderr }. onData(stream, Buffer) sees output as it arrives.
        async exec(cmd, { onData } = {}) {
          const command = Array.isArray(cmd) ? cmd.map(shq).join(" ") : cmd;
          const res = await call("POST", `/v1/sessions/${s.session}/exec`, { cmd: command });
          if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
          const out = { stdout: [], stderr: [] }; let exit = { code: null, signal: null }, buf = "";
          const dec = new TextDecoder();
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              if (!line) continue;
              const m = JSON.parse(line);
              if (m.t === "exit") exit = m;
              else { const b = Buffer.from(m.d, "base64"); out[m.t]?.push(b); onData?.(m.t, b); }
            }
          }
          return { code: exit.code, signal: exit.signal, closed: !!exit.closed, stdout: Buffer.concat(out.stdout).toString(), stderr: Buffer.concat(out.stderr).toString() };
        },
        async stop() {
          if (receipt) return receipt;
          clearInterval(tick);
          const { receipt: r } = await jsonCall("POST", `/v1/sessions/${s.session}/stop`);
          if (!verifyReceipt(r).ok) throw new Error("the node returned a receipt that does not verify");
          if (r.node.id !== s.node) throw new Error("the receipt was signed by a different node than the one that opened the session");
          const rdir = join(dir, "receipts"); mkdirSync(rdir, { recursive: true });
          const file = join(rdir, r.session + ".json");
          writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
          receipt = { ...r, file };
          return receipt;
        },
      };
    },
  };
}

const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'");
