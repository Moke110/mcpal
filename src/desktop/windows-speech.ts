import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Synthesizer } from "./speech-output.ts";

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
$selected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$wave = New-Object System.IO.MemoryStream
try {
  $voice = $speaker.GetInstalledVoices() | Where-Object {
    $_.Enabled -and (($selected -eq 'default' -and $_.VoiceInfo.Culture.Name -eq 'zh-CN') -or $_.VoiceInfo.Name -eq $selected)
  } | Select-Object -First 1
  if ($null -eq $voice) { exit 3 }
  $speaker.SelectVoice($voice.VoiceInfo.Name)
  $speaker.SetOutputToWaveStream($wave)
  $speaker.Speak($source)
  $speaker.SetOutputToNull()
  $bytes = $wave.ToArray()
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
  $speaker.Dispose()
  $wave.Dispose()
}`;
const command = Buffer.from(script, "utf16le").toString("base64");

const listScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { [Console]::WriteLine($_.VoiceInfo.Name) }
} finally {
  $speaker.Dispose()
}`;

export async function listWindowsVoices(): Promise<string[]> {
  if (process.platform !== "win32" || !process.env.SystemRoot) return [];
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(listScript, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: 10_000,
    }, (error, stdout) => {
      if (error) reject(new Error("无法读取 Windows 语音音色"));
      else resolve(stdout.split(/\r?\n/u).filter(Boolean));
    });
  });
}

export function synthesizeWindowsSpeech(text: string, signal: AbortSignal, voice = "default"): ReturnType<Synthesizer> {
  if (process.platform !== "win32" || !process.env.SystemRoot) throw new Error("本机语音需要 Windows 普通话语音包");
  signal.throwIfAborted();
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const process = execFile(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", command], {
      encoding: "buffer", windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.code === 3 ? "未找到 Windows 普通话桌面语音（zh-CN）" :
          error.killed ? "本机语音合成超时" : "Windows 普通话语音合成失败"));
      } else if (stdout.length < 44 || stdout.toString("ascii", 0, 4) !== "RIFF") {
        reject(new Error("本机语音未返回有效的 WAV 音频"));
      } else {
        resolve(new Uint8Array(stdout));
      }
    });
    process.stdin?.on("error", () => {});
    process.stdin?.end(`${Buffer.from(text, "utf8").toString("base64")}\n${Buffer.from(voice, "utf8").toString("base64")}\n`);
  });
}

export async function synthesizeSpeechFixture(_text: string, signal: AbortSignal): Promise<Uint8Array> {
  await setTimeout(220, undefined, { signal });
  const sampleRate = 24_000;
  const bytes = 2 * sampleRate * 2;
  const wave = Buffer.alloc(44 + bytes);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(36 + bytes, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(bytes, 40);
  let seed = 42;
  for (let i = 44; i < wave.length; i += 2) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    wave.writeInt16LE(Math.round((seed / 2 ** 32 - 0.5) * 11000), i);
  }
  return new Uint8Array(wave);
}
