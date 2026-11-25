// chronarkcloud.com: serves web/ (the landing page), /studio (owner panel) and the token API.
//   GET  /api/token                  public: the CA once set, dead-address balance, finished burns
//   *    /api/studio/*               owner only (x-studio-key): token, buyback wallet, buyback and burn, supply burn
// The studio key is generated on first start in data/burn/secrets.json (0600), or STUDIO_KEY in the environment.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as T from "./burn.mjs";

const PORT = Number(process.env.PORT || 5820), HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.resolve(new URL("../web/", import.meta.url).pathname);
const STUDIO = new URL("./studio.html", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8" };

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((ok, bad) => {
  let n = 0; const parts = [];
  req.on("data", (b) => { n += b.length; if (n > 16_384) { bad(Object.assign(new Error("Body too large."), { status: 413 })); req.destroy(); } else parts.push(b); });
  req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { bad(Object.assign(new Error("Body must be JSON."), { status: 400 })); } });
});
const ipOf = (req) => (req.headers["x-real-ip"] || req.socket.remoteAddress || "").toString();

// wrong keys lock an address out for 10 minutes after 10 tries
const digest = (x) => crypto.createHash("sha256").update(String(x)).digest(), misses = new Map();
function studioOk(req) {
  const ip = ipOf(req), now = Date.now(), m = (misses.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (m.length >= 10) return "locked";
  if (crypto.timingSafeEqual(digest(req.headers["x-studio-key"] || ""), digest(T.STUDIO_KEY))) return "ok";
  misses.set(ip, [...m, now]); if (misses.size > 5000) misses.clear(); return "bad";
}
async function studio(req, res, p) {
  const a = studioOk(req);
  if (a !== "ok") return send(res, a === "locked" ? 429 : 401, { error: a === "locked" ? "Too many wrong keys. Wait 10 minutes." : "Wrong studio key." });
  const k = `${req.method} ${p.slice("/api/studio".length)}`;
  if (k === "GET /status") return send(res, 200, await T.status());
  if (k === "POST /token") return send(res, 200, await T.saveToken(await body(req)));
  if (k === "POST /wallet") return send(res, 200, T.saveKey((await body(req)).privateKey || ""));
  if (k === "DELETE /wallet") return send(res, 200, T.removeKey());
  if (k === "POST /buyback") return send(res, 200, await T.buyback((await body(req)).usd));
  if (k === "POST /supply") return send(res, 200, await T.burnSupply((await body(req)).usd));
  if (k === "POST /burn-held") return send(res, 200, await T.burnHeld());
  return send(res, 404, { error: "Not found." });
}

function file(req, res, p) {
  let f = p === "/studio" ? STUDIO : path.join(ROOT, decodeURIComponent(p));
  if (f !== STUDIO && f !== ROOT && !f.startsWith(ROOT + path.sep)) return notFound(res);
  try { if (fs.statSync(f).isDirectory()) f = path.join(f, "index.html"); } catch { return notFound(res); }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(f), headers = { "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=604800", "x-content-type-options": "nosniff" };
    if (f === STUDIO) Object.assign(headers, { "x-robots-tag": "noindex", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
    // ranges, so the hero video can seek and Safari will play it
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (ext === ".mp4" || ext === ".webm")) {
      const start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "accept-ranges": "bytes", "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(f).pipe(res);
  });
}
const notFound = (res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); };

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  try {
    if (p === "/api/token" && req.method === "GET") return send(res, 200, await T.publicView());
    if (p.startsWith("/api/studio/")) return await studio(req, res, p);
    if (p.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
    return file(req, res, p);
  } catch (e) {
    if (res.headersSent) return res.end();
    send(res, e.status || 400, { error: e.shortMessage || e.message });
  }
}).listen(PORT, HOST, () => console.log(`chronarkcloud.com site on http://${HOST}:${PORT}`));
