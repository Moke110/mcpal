import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { basename, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createApiBackend } from "./api-backend.ts";
import { LocalBackend, memoryIntervalMs } from "./local-backend.ts";
import type { LocalRuntime, MemorySample } from "./local-backend.ts";

export function createLocalBackend(env: NodeJS.ProcessEnv, publish: () => void): LocalBackend | null {
  const executable = env.MCPAL_LOCAL_SERVER?.trim();
  const weights = env.MCPAL_LOCAL_MODEL?.trim();
  if (process.platform !== "win32" || !executable || !weights ||
    !isAbsolute(executable) || !isAbsolute(weights) ||
    !executable.toLowerCase().endsWith(".exe") || !weights.toLowerCase().endsWith(".gguf")) return null;
  const context = Number(env.MCPAL_LOCAL_CONTEXT ?? 2048);
  const layers = Number(env.MCPAL_LOCAL_GPU_LAYERS ?? 99);
  if (!Number.isInteger(context) || context < 512 || context > 8192 ||
    !Number.isInteger(layers) || layers < 1 || layers > 200) return null;
  return new LocalBackend({
    model: basename(weights), settings: `llama.cpp · CUDA · 上下文 ${context} · GPU 层 ${layers} · 并发 1 · 输出 ≤ 256 token`,
    fixture: false,
  }, (signal) => launch(executable, weights, context, layers, signal), publish);
}

const run = promisify(execFile);

export function localReasoningOptions(help: string): string[] {
  if (/^\s*--reasoning(?=[ \t=]|$)/mu.test(help)) return ["--reasoning", "off"];
  if (/^\s*--reasoning-budget(?=[ \t=]|$)/mu.test(help)) return ["--reasoning-budget", "0"];
  throw new Error("当前 llama-server 版本无法禁用推理模式。");
}

async function reasoningOptions(executable: string, signal: AbortSignal): Promise<string[]> {
  let help: string;
  try {
    const { stdout, stderr } = await run(executable, ["--help"], { windowsHide: true, timeout: 10_000, signal });
    help = stdout + "\n" + stderr;
  } catch {
    signal.throwIfAborted();
    throw new Error("无法读取 llama-server 支持的启动参数。");
  }
  return localReasoningOptions(help);
}

export async function localServerHealthy(port: number, key: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal,
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function launch(
  executable: string, weights: string, context: number, layers: number, signal: AbortSignal,
): Promise<LocalRuntime> {
  try {
    if (!(await stat(executable)).isFile() || !(await stat(weights)).isFile()) throw new Error();
  } catch {
    throw new Error("找不到配置的 llama-server.exe 或 GGUF 文件");
  }
  const reasoning = await reasoningOptions(executable, signal);
  const port = await freeLoopbackPort();
  signal.throwIfAborted();
  const key = randomBytes(32).toString("hex");
  const client = createApiBackend({
    MCPAL_API_BASE_URL: `http://127.0.0.1:${port}/v1`, MCPAL_API_KEY: key, MCPAL_API_MODEL: "mcpal-local",
  }, { maxTokens: 256 })!;
  const server = spawn(executable, [
    "--model", weights, "--alias", "mcpal-local", "--host", "127.0.0.1", "--port", String(port),
    "--api-key", key, "--ctx-size", String(context), "--gpu-layers", String(layers),
    "--parallel", "1", "--device", "CUDA0", "--no-warmup", ...reasoning, "--offline",
  ], { shell: false, stdio: "ignore", windowsHide: true });
  const done = new Promise<void>((resolve) => server.once("close", () => resolve()));
  let memory: ReturnType<typeof openMemorySampler> | undefined;
  try {
    await once(server, "spawn");
    signal.throwIfAborted();
    memory = openMemorySampler(server.pid!);
  } catch {
    await reclaim(server, done);
    throw new Error("无法启动 llama-server 或显存采样");
  }
  return {
    async ready(startup) {
      while (true) {
        startup.throwIfAborted();
        if (server.exitCode !== null || server.signalCode !== null) throw new Error("llama-server 在启动期间退出");
        if (await localServerHealthy(port, key, startup) &&
          (await client.check(startup)).kind === "completed") return;
        await delay(150, undefined, { signal: startup });
      }
    },
    generate: client.generate,
    readMemory: async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error("模型进程已退出");
      return memory.read();
    },
    async stop() {
      memory.stop();
      await reclaim(server, done);
    },
  };
}

async function reclaim(process: ChildProcess, done: Promise<void>): Promise<void> {
  if (process.exitCode === null && process.signalCode === null) process.kill();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([done, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("模型进程未退出")), 4_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function freeLoopbackPort(): Promise<number> {
  const socket = createServer();
  const listening = once(socket, "listening");
  socket.listen(0, "127.0.0.1");
  await listening;
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("无法分配本地端口");
  return address.port;
}

function openMemorySampler(pid: number) {
  // Raw WDDM process counters are in bytes; each PID can own allocations on multiple adapters.
  const command = `
$ErrorActionPreference = 'Stop'
while ($true) {
  $rows = @(Get-CimInstance -ClassName Win32_PerfRawData_GPUPerformanceCounters_GPUProcessMemory -Filter "Name LIKE 'pid_${pid}_%'")
  [uint64]$dedicated = 0
  [uint64]$shared = 0
  foreach ($row in $rows) {
    if ($null -eq $row.DedicatedUsage -or $null -eq $row.SharedUsage) { throw 'Missing WDDM counters' }
    $dedicated += $row.DedicatedUsage
    $shared += $row.SharedUsage
  }
  [Console]::WriteLine("$($rows.Count),$dedicated,$shared")
  Start-Sleep -Milliseconds ${memoryIntervalMs}
}
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let closed = false;
  let pending: { resolve: (value: MemorySample | null) => void; reject: (error: Error) => void } | undefined;
  const close = () => {
    closed = true;
    pending?.reject(new Error("显存采样进程已退出"));
  };
  child.on("error", close);
  lines.on("close", close);
  lines.on("line", (line) => {
    const match = /^(\d+),(\d+),(\d+)$/u.exec(line);
    if (!match) pending?.reject(new Error("无效显存样本"));
    else pending?.resolve(match[1] === "0" ? null : { dedicatedBytes: Number(match[2]), sharedBytes: Number(match[3]) });
  });
  return {
    async read(): Promise<MemorySample | null> {
      if (closed) throw new Error("显存采样进程已退出");
      let timer: NodeJS.Timeout | undefined;
      try {
        return await new Promise<MemorySample | null>((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => reject(new Error("显存采样超时")), 4_000);
        });
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    },
    stop() {
      lines.close();
      child.kill();
    },
  };
}
