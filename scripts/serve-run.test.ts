import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

// Starts scripts/serve-run.ts against a temporary run directory and checks what it exposes.

let workDir = "";
let runDir = "";
let proc: ReturnType<typeof Bun.spawn>;
const port = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "layoutlens-serve-"));
  runDir = join(workDir, "run");
  await Bun.write(join(runDir, "de", "375.png"), "png-bytes");
  await writeFile(join(workDir, "secret.txt"), "top secret");
  await writeFile(
    join(runDir, "manifest.json"),
    JSON.stringify({ id: "1", shots: [{ locale: "de", breakpoint: 375, path: join(runDir, "de", "375.png") }] })
  );
  const env = { ...process.env };
  delete env.LAYOUTLENS_SERVE_HOST;
  proc = Bun.spawn(["bun", join(import.meta.dir, "serve-run.ts"), runDir, String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${base}/`);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("serve-run did not start");
});

afterAll(async () => {
  proc?.kill();
  await rm(workDir, { recursive: true, force: true });
});

describe("serve-run", () => {
  test("serves the manifest and files inside the run directory", async () => {
    const manifest = (await (await fetch(`${base}/manifest`)).json()) as { shots: Array<{ path: string }> };
    const res = await fetch(`${base}${manifest.shots[0]!.path}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png-bytes");
  });

  test("refuses files outside the run directory", async () => {
    const outside = encodeURIComponent(join(runDir, "..", "secret.txt"));
    const res = await fetch(`${base}/file?abs=${outside}`);
    expect(res.status).toBe(403);
  });

  test("answers 400 instead of crashing on a malformed abs parameter", async () => {
    const res = await fetch(`${base}/file?abs=${encodeURIComponent(join(runDir, "%zz"))}`);
    expect(res.status).toBe(400);
  });

  test("is not reachable on non-loopback interfaces", async () => {
    const lanAddress = Object.values(networkInterfaces())
      .flat()
      .find((info) => info && info.family === "IPv4" && !info.internal)?.address;
    if (!lanAddress) {
      console.warn("no non-loopback IPv4 interface available; skipping LAN reachability check");
      return;
    }
    let reachable = true;
    try {
      await fetch(`http://${lanAddress}:${port}/`, { signal: AbortSignal.timeout(1500) });
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
  });
});
