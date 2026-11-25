// Receipts: canonical JSON, signed with the node's ed25519 key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const home = () => process.env.TESSERA_HOME || join(homedir(), ".tessera");

// Canonical form: keys sorted at every level, no whitespace. The signature covers everything except `sig`.
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

// The node key lives in TESSERA_HOME/node.key (0600). It is created on first use and never printed.
export function nodeKey(dir = home()) {
  const file = join(dir, "node.key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const priv = createPrivateKey(readFileSync(file));
  const pub = createPublicKey(priv).export({ type: "spki", format: "der" }).toString("base64");
  return { priv, pub, id: nodeId(pub) };
}

export const nodeId = (pub) => "0x" + createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex").slice(0, 40);

export function signReceipt(body, key) {
  const r = { ...body, node: { id: key.id, pub: key.pub } };
  delete r.sig;
  r.sig = sign(null, Buffer.from(canonical(r)), key.priv).toString("base64");
  return r;
}

// Returns { ok, reason }. Checks the signature against the public key in the receipt and that the key matches the node id.
export function verifyReceipt(r) {
  if (!r || typeof r !== "object" || !r.sig || !r.node?.pub) return { ok: false, reason: "not a receipt" };
  if (nodeId(r.node.pub) !== r.node.id) return { ok: false, reason: "node id does not match its public key" };
  const { sig, ...body } = r;
  try {
    const pub = createPublicKey({ key: Buffer.from(r.node.pub, "base64"), format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(canonical(body)), pub, Buffer.from(sig, "base64"));
    return ok ? { ok: true } : { ok: false, reason: "signature does not match the receipt" };
  } catch (e) {
    return { ok: false, reason: "bad key or signature: " + e.message };
  }
}
