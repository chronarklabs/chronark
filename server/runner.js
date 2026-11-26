// Sandboxes. "docker" is the real one: one locked-down container per session.
// "process" runs commands as plain local processes in a temp dir with NO isolation; it exists for tests only
// and refuses to start unless the server is bound to localhost.
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export const DEFAULT_IMAGES = { python: "python:3.12-slim", node: "node:22-slim", shell: "alpine:3.20" };

export function dockerRunner({ images = DEFAULT_IMAGES, memory = "512m", cpus = "1", pids = 256, network = "none", docker = "docker", runtime = "" } = {}) {
  // runtime: an extra OCI runtime registered with dockerd, e.g. "runsc" (gVisor) for a user-space kernel between sessions and the host.
  const rt = runtime ? ["--runtime", runtime] : [];
  return {
    kind: "docker",
    runtime: runtime || "runc",
    images,
    async create(id, worker) {
      const image = images[worker];
      if (!image) throw Object.assign(new Error(`unknown worker "${worker}" (have: ${Object.keys(images).join(", ")})`), { status: 400 });
      const name = "chronark-" + id.slice(2, 18);
      await run(docker, ["run", "-d", "--rm", ...rt, "--name", name, "--label", "chronark.session=" + id,
        "--network", network, "--memory", memory, "--memory-swap", memory, "--cpus", cpus, "--pids-limit", String(pids),
        "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=256m", "--tmpfs", "/work:rw,exec,nosuid,size=512m,uid=1000,gid=1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "-w", "/work",
        "--env", "HOME=/work", image, "sleep", "infinity"], { timeout: 120_000 });
      return { ref: name, image };
    },
    exec(box, cmd, { onData, signal }) {
      const child = spawn(docker, ["exec", "-w", "/work", box.ref, "sh", "-c", cmd], { stdio: ["ignore", "pipe", "pipe"], signal });
      return wire(child, onData);
    },
    async destroy(box) { await run(docker, ["rm", "-f", box.ref], { timeout: 60_000 }).catch(() => {}); },
    // Removes containers left behind by a crash.
    async sweep() {
      const { stdout } = await run(docker, ["ps", "-aq", "--filter", "label=chronark.session"]).catch(() => ({ stdout: "" }));
      const ids = stdout.split(/\s+/).filter(Boolean);
      if (ids.length) await run(docker, ["rm", "-f", ...ids]).catch(() => {});
      return ids.length;
    },
  };
}

export function processRunner({ workers = ["shell", "node", "python"] } = {}) {
  return {
    kind: "process",
    images: Object.fromEntries(workers.map((w) => [w, "local"])),
    async create(id, worker) {
      if (!workers.includes(worker)) throw Object.assign(new Error(`unknown worker "${worker}"`), { status: 400 });
      return { ref: mkdtempSync(join(tmpdir(), "chronark-box-")), image: "local" };
    },
    exec(box, cmd, { onData, signal }) {
      const child = spawn("sh", ["-c", cmd], { cwd: box.ref, stdio: ["ignore", "pipe", "pipe"], signal, detached: true });
      return wire(child, onData);
    },
    async destroy(box) { rmSync(box.ref, { recursive: true, force: true }); },
    async sweep() { return 0; },
  };
}

function wire(child, onData) {
  child.stdout.on("data", (b) => onData("stdout", b));
  child.stderr.on("data", (b) => onData("stderr", b));
  return {
    done: new Promise((resolve) => {
      child.on("error", (e) => resolve({ code: 127, signal: null, error: e.code === "ABORT_ERR" ? "aborted" : e.message }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    }),
    kill: () => { try { child.pid && process.kill(-child.pid, "SIGKILL"); } catch {} try { child.kill("SIGKILL"); } catch {} },
  };
}
