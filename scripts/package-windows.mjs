import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("此打包命令需要 Windows x64。");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const executable = "MC-Pal.exe";
const runtime = resolve(process.env.MCPAL_ELECTRON_RUNTIME || join(root, "node_modules", "electron", "dist"));
const runtimeVersion = readFileSync(join(runtime, "version"), "utf8").trim().replace(/^v/, "");
if (runtimeVersion !== manifest.devDependencies.electron || !isX64(join(runtime, "electron.exe"))) {
  throw new Error("请提供与 package.json 锁定版本一致的 Windows x64 Electron 运行时。");
}

function isX64(exe) {
  const descriptor = openSync(exe, "r");
  try {
    const header = Buffer.alloc(64);
    if (readSync(descriptor, header, 0, 64, 0) !== 64 || header.toString("ascii", 0, 2) !== "MZ") return false;
    const signature = Buffer.alloc(6);
    return readSync(descriptor, signature, 0, 6, header.readUInt32LE(60)) === 6 &&
      signature.readUInt32LE(0) === 0x4550 && signature.readUInt16LE(4) === 0x8664;
  } finally {
    closeSync(descriptor);
  }
}

const temp = join(root, "tmp");
mkdirSync(temp, { recursive: true });
const output = mkdtempSync(join(temp, "windows-release-"));
const bundleName = `MC-Pal-${manifest.version}-windows-x64`;
const bundle = join(output, bundleName);
const app = join(bundle, "resources", "app");
const zip = join(output, `${bundleName}.zip`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env, TEMP: temp, TMP: temp,
      npm_config_cache: process.env.npm_config_cache || join(temp, "npm-cache"),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} 退出码 ${result.status}`);
}

cpSync(runtime, bundle, {
  recursive: true,
  filter: (path) => path !== join(runtime, "resources", "default_app.asar"),
});
renameSync(join(bundle, "electron.exe"), join(bundle, executable));
mkdirSync(app, { recursive: true });
for (const name of ["package.json", "package-lock.json", "LICENSE"]) {
  copyFileSync(join(root, name), join(app, name));
}
cpSync(join(root, "src"), join(app, "src"), { recursive: true });
const compiler = join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const helper = join(app, "src/sensor/windows/ProcessAudio.exe");
run(compiler, ["/nologo", "/platform:x64", "/out:" + helper, join(root, "src/sensor/windows/ProcessAudio.cs")], root);
copyFileSync(join(root, "docs", "windows-acceptance.md"), join(bundle, "快速开始.md"));
copyFileSync(join(root, ".env.example"), join(bundle, "settings.example.env"));

if (!process.env.npm_execpath) throw new Error("请使用 npm run package:windows。");
run(process.execPath, [process.env.npm_execpath, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], app);
run("tar.exe", ["-a", "-c", "-f", zip, bundleName], output);
if (statSync(zip).size === 0) throw new Error("生成的 ZIP 为空。");
console.log(zip);
