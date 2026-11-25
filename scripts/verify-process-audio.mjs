import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

mkdirSync("tmp", { recursive: true });
const dir = mkdtempSync(resolve("tmp/audio-isolation-"));
const env = { ...process.env, TEMP: dir, TMP: dir };
const opts = { env, windowsHide: true };
const csc = join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const helper = join(dir, "ProcessAudio.exe");
const selected = join(dir, "Selected.exe");
const other = join(dir, "Other.exe");
for (const [out, input] of [[helper, "src/sensor/windows/ProcessAudio.cs"], [selected, "test/windows-audio/Tone.cs"]]) {
  execFileSync(csc, ["/nologo", "/platform:x64", "/out:" + out, resolve(input)], opts);
}
copyFileSync(selected, other);
const tones = [spawn(selected, ["500"], opts), spawn(other, ["1000"], opts)];
try {
  await delay(600);
  for (const [target, expected, excluded] of [[selected, 500, 1000], [other, 1000, 500]]) {
    const child = spawn(helper, [target], opts);
    const audio = [];
    let error = "";
    child.stdout.on("data", chunk => audio.push(chunk));
    child.stderr.on("data", chunk => { error += chunk; });
    const closed = new Promise(resolve => child.once("close", resolve));
    const stop = setTimeout(() => child.stdin.end(), 2100);
    const kill = setTimeout(() => child.kill(), 10000);
    const code = await closed;
    clearTimeout(stop); clearTimeout(kill);
    assert.equal(code, 0, error);
    const pcm = Buffer.concat(audio);
    assert.equal(pcm[0], 1);
    const data = pcm.subarray(1);
    assert.ok(data.length >= 16000, "At least 0.5s PCM required");
    function amplitude(hz) {
      let peak = 0;
      for (let offset = 0; offset + 3200 <= data.length; offset += 3200) {
        let re = 0, im = 0;
        for (let i = 0; i < 1600; ++i) {
          const angle = 2 * Math.PI * i * hz / 16000;
          const sample = data.readInt16LE(offset + 2*i);
          re += sample * Math.cos(angle); im += sample * Math.sin(angle);
        }
        peak = Math.max(peak, 2 * Math.hypot(re, im) / 1600);
      }
      return peak;
    }
    const wanted = amplitude(expected), leak = amplitude(excluded);
    console.log({ expected, wanted, excluded, leak, frames: data.length / 2 });
    assert.ok(wanted > 10 && leak < wanted * 0.1, "Selected tone must dominate excluded tone by 20 dB");
  }
} finally { for (const child of tones) child.kill(); }
