import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const archive = process.argv[2] && resolve(process.argv[2]);
if (!archive?.endsWith(".zip")) throw new Error("用法：node scripts/smoke-windows.mjs <Windows ZIP>");
const scratch = await mkdtemp(join(dirname(archive), "smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(MCPAL_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(name)));
Object.assign(env, { TEMP: scratch, TMP: scratch, MCPAL_DESKTOP_DATA: join(scratch, "profile") });
await mkdir(env.MCPAL_DESKTOP_DATA);
// A shortcut's working directory may contain an unrelated configuration file.
await writeFile(join(scratch, ".env"), "MCPAL_ASR_FIXTURE=1\n");
const extracted = spawnSync("tar.exe", ["-xf", archive], { cwd: scratch, env, windowsHide: true, stdio: "inherit" });
if (extracted.error) throw extracted.error;
assert.equal(extracted.status, 0, "ZIP extraction failed");
const executable = join(scratch, basename(archive, ".zip"), "MC-Pal.exe");
const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], {
  cwd: scratch, env, windowsHide: true, stdio: "inherit",
});
let launchError;
child.on("error", (error) => { launchError = error; });

async function until(check, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode} before ${description}`);
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

let socket;
let id = 0;
const pending = new Map();
function protocol(method, params = {}) {
  const command = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command);
      reject(new Error(`DevTools command timed out: ${method}`));
    }, 3000);
    pending.set(command, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id: command, method, params }));
  });
}

try {
  const page = await until(async () => {
    try {
      const port = (await readFile(join(env.MCPAL_DESKTOP_DATA, "DevToolsActivePort"), "utf8")).split("\n")[0];
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      return targets.find(({ url }) => url.endsWith("/resources/app/src/desktop/index.html"));
    } catch {
      return null;
    }
  }, "packaged Electron desktop");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    delay(3000).then(() => { throw new Error("DevTools connection timed out"); }),
  ]);
  async function evaluate(expression) {
    const response = await protocol("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined, response.result.description);
    return response.result.value;
  }
  const element = (id) => `document.getElementById(${JSON.stringify(id)})`;
  const see = (id, expected) => until(() => evaluate(`${element(id)}?.textContent.includes(${JSON.stringify(expected)})`), expected);
  function submit(message) {
    return evaluate(`${element("input")}.value = ${JSON.stringify(message)}; ${element("composer")}.requestSubmit()`);
  }

  await until(() => evaluate('Boolean(window.companion && document.getElementById("model-backend"))'), "sandboxed preload");
  assert.equal(await evaluate(`${element("model-backend")}.value`), "simulated");
  assert.equal(await evaluate(`${element("minecraft-workspace")}.hidden`), true);
  assert.equal(await evaluate(`${element("speech-enable")}.checked`), false);
  assert.equal(await evaluate(`${element("asr-enable")}.checked`), false);
  assert.equal(await evaluate("window.companion.asrConfig().then(config => config.fixture)"), false);
  await submit("附近有谁？");
  await see("conversation", "我在");
  await submit("跟随小明");
  await see("task", "正在跟随");
  await evaluate(`${element("stop")}.click()`);
  await see("task", "任务已终止");
  await evaluate(`${element("acceptance")}.open = true; ${element("acceptance")}.scrollIntoView()`);
  await see("acceptance", "待现场测量");
  const { data } = await protocol("Page.captureScreenshot");
  const screenshot = join(scratch, "first-run.png");
  await writeFile(screenshot, Buffer.from(data, "base64"));
  console.log(`PASS Windows ZIP first run: ${screenshot}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await protocol("Browser.close").catch(() => {});
    socket.close();
  }
  if (child.exitCode === null && !launchError) {
    const closed = once(child, "exit");
    if (await Promise.race([closed.then(() => false), delay(5000).then(() => true)])) {
      child.kill();
      await closed;
    }
  }
}
