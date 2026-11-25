// Request signing. Every API call is signed by the caller's ed25519 key; the key is the account, no API keys.
//   message = METHOD \n PATH \n TS \n NONCE \n sha256(body)
//   headers: x-chronark-key (spki, base64), x-chronark-ts (ms), x-chronark-nonce (hex), x-chronark-sig (base64)
import { createPublicKey, verify, sign, createHash, randomBytes } from "node:crypto";
import { nodeId } from "./receipt.js";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const message = (method, path, ts, nonce, body) => [method.toUpperCase(), path, ts, nonce, sha256(body ?? "")].join("\n");

export function signRequest(key, method, path, body = "") {
  const ts = String(Date.now()), nonce = randomBytes(12).toString("hex");
  const sig = sign(null, Buffer.from(message(method, path, ts, nonce, body)), key.priv).toString("base64");
  return { "x-chronark-key": key.pub, "x-chronark-ts": ts, "x-chronark-nonce": nonce, "x-chronark-sig": sig };
}

export function makeVerifier({ windowMs = 60_000 } = {}) {
  const seen = new Map(); // nonce -> expiry
  setInterval(() => { const now = Date.now(); for (const [k, t] of seen) if (t < now) seen.delete(k); }, windowMs).unref();
  return function check(req, body) {
    const h = req.headers, pub = h["x-chronark-key"], ts = h["x-chronark-ts"], nonce = h["x-chronark-nonce"], sig = h["x-chronark-sig"];
    if (!pub || !ts || !nonce || !sig) return { error: "unsigned request" };
    if (!/^\d{10,16}$/.test(ts) || Math.abs(Date.now() - Number(ts)) > windowMs) return { error: "request timestamp is too old or in the future" };
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { error: "bad nonce" };
    if (seen.has(nonce)) return { error: "replayed request" };
    let key;
    try {
      key = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519") return { error: "account key must be ed25519" };
    } catch { return { error: "bad account key" }; }
    const ok = verify(null, Buffer.from(message(req.method, req.url, ts, nonce, body)), key, Buffer.from(sig, "base64"));
    if (!ok) return { error: "bad signature" };
    seen.set(nonce, Date.now() + windowMs * 2);
    return { account: nodeId(pub), pub };
  };
}
