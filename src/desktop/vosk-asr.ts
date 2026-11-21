import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RecognizerEvents, StreamingRecognizer } from "./voice-input.ts";

const worker = String.raw`
import json
import re
import sys
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
recognizer = KaldiRecognizer(Model(sys.argv[1]), 16000)
segments = []

def emit(kind, words):
    text = re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])', '', ' '.join(words))
    print(json.dumps({"kind": kind, "text": text}), flush=True)

while True:
    data = sys.stdin.buffer.read(1600)
    if not data:
        break
    if recognizer.AcceptWaveform(data):
        segments.append(json.loads(recognizer.Result()).get("text", ""))
        emit("partial", segments)
    else:
        emit("partial", segments + [json.loads(recognizer.PartialResult()).get("partial", "")])
segments.append(json.loads(recognizer.FinalResult()).get("text", ""))
emit("final", segments)
`;

export function openVosk(events: RecognizerEvents, env: NodeJS.ProcessEnv): StreamingRecognizer {
  const model = env.MCPAL_ASR_MODEL;
  if (!model) {
    throw new Error("MCPAL_ASR_MODEL missing");
  }
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) =>
    ["path", "systemroot", "systemdrive", "temp", "tmp", "home", "userprofile", "appdata", "localappdata"]
      .includes(key.toLowerCase())));
  const child = spawn(env.MCPAL_ASR_PYTHON || "python", ["-u", "-c", worker, model], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...environment, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  let cancelled = false;
  let receivedFinal = false;
  function failed(): void {
    if (!cancelled && !receivedFinal) {
      events.failure("本机 Vosk 识别失败。请检查 Python、vosk 和普通话模型配置。");
    }
  }
  lines.on("line", (line) => {
    if (cancelled || receivedFinal || line.length > 6000) return;
    try {
      const value = JSON.parse(line) as { kind?: unknown; text?: unknown };
      if (typeof value.text !== "string") return;
      if (value.kind === "partial") events.partial(value.text.trim());
      if (value.kind === "final") {
        receivedFinal = true;
        events.final(value.text);
      }
    } catch {
      failed();
    }
  });
  child.once("error", failed);
  child.stdin.on("error", failed);
  child.once("close", failed);
  return {
    write: (pcm) => { if (!cancelled) child.stdin.write(pcm); },
    end: () => { if (!cancelled) child.stdin.end(); },
    cancel: () => {
      cancelled = true;
      lines.close();
      child.stdin.destroy();
      if (!receivedFinal) child.kill();
    },
  };
}

const fixtureText: Record<string, string> = {
  status: "附近有谁？", follow: "跟随小明", stop: "停止", late: "我的血量是多少？", empty: "",
};

export function openAsrFixture(events: RecognizerEvents, mode: string): StreamingRecognizer {
  const text = Object.hasOwn(fixtureText, mode) ? fixtureText[mode]! : "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    write: () => events.partial(text.slice(0, 2)),
    end: () => {
      timer = setTimeout(() => events.final(text), mode === "late" ? 1050 : 150);
      timer.unref();
    },
    cancel: () => clearTimeout(timer),
  };
}
