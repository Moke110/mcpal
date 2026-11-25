import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CaptureEvents } from "./application-audio.ts";

const run = promisify(execFile);
const source = fileURLToPath(new URL("./windows/ProcessAudio.cs", import.meta.url));
let building: Promise<string> | undefined;

async function locateHelper() {
  const bundled = fileURLToPath(new URL("./windows/ProcessAudio.exe", import.meta.url));
  try { await access(bundled); return bundled; } catch { /* Source checkout. */ }
  const temp = fileURLToPath(new URL("../../tmp/", import.meta.url));
  await mkdir(temp, { recursive: true });
  const directory = await mkdtemp(join(temp, "process-audio-"));
  const exe = join(directory, "ProcessAudio.exe");
  const compiler = join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await run(compiler, ["/nologo", "/platform:x64", "/out:" + exe, source], {
    windowsHide: true, env: { ...process.env, TEMP: directory, TMP: directory },
  });
  return exe;
}

function helper() {
  return building ??= locateHelper().catch(error => { building = undefined; throw error; });
}

export async function listAudioApplications() {
  const { stdout } = await run(await helper(), ["--list"], { windowsHide: true, timeout: 8000 });
  return [...new Set(stdout.split(/\r?\n/).filter(Boolean))].sort();
}

export function captureApplication(path: string, events: CaptureEvents) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let child: ReturnType<typeof spawn> | undefined;
  let done: Promise<void>;

  async function connect() {
    try {
      const executable = await helper();
      if (stopped) return;
      const process = spawn(executable, [path], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      child = process;
      let ready = false;
      process.stdin.on("error", () => {});
      process.stdout.on("data", (data: Buffer) => {
        if (!ready) {
          if (data[0] !== 1) { process.kill(); return; }
          ready = true;
          events.ready();
          data = data.subarray(1);
        }
        if (data.length) events.pcm(data);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        process.once("error", reject);
        process.once("close", resolve);
      });
      if (code !== 0 || !stopped) events.lost();
    } catch { events.lost(); }
    finally {
      child = undefined;
      if (!stopped) timer = setTimeout(() => { done = connect(); }, 2000);
    }
  }

  done = connect();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    child?.stdin?.end();
    const timeout = setTimeout(() => child?.kill(), 2500);
    try { await done; } finally { clearTimeout(timeout); }
  };
}
