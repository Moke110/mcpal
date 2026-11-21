import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { SimulationSession } from "../src/desktop/sim-session.ts";
import { VoiceInput } from "../src/desktop/voice-input.ts";
import type { RecognizerEvents } from "../src/desktop/voice-input.ts";

test("only a released, current nonempty final enters its reading window once", () => {
  const results: string[] = [];
  let callbacks!: RecognizerEvents;
  let time = 200;
  const input = new VoiceInput({
    open: (events) => {
      callbacks = events;
      return { write() {}, end() {}, cancel() {} };
    },
    publish() {},
    interrupt() {},
    now: () => time,
    window: () => time < 250 ? 2 : 3,
    submit: (text) => { results.push(text); return 3; },
  });
  const first = input.start();
  assert.equal(first, null);
  input.setEnabled(true);
  const id = input.start()!;
  callbacks.partial("跟随");
  callbacks.final("停止");
  assert.deepEqual(results, []);
  input.write(id, new Uint8Array(320));
  input.release(id, 180, 190);
  time = 300;
  callbacks.final(" 跟随小明 ");
  callbacks.final("停止");
  assert.deepEqual(results, ["跟随小明"]);
  assert.equal(input.snapshot().window, 3);
  assert.equal(input.snapshot().late, true);
  assert.equal(input.snapshot().lastVoiceAt, 180);
  assert.equal(input.snapshot().releasedAt, 190);
  assert.equal(input.snapshot().finalAt, 300);
});

test("canceled and superseded captures cannot act, and empty audio returns to text", () => {
  const workers: RecognizerEvents[] = [];
  const submitted: string[] = [];
  const input = new VoiceInput({
    open: (events) => {
      workers.push(events);
      return { write() {}, end() {}, cancel() {} };
    },
    publish() {},
    interrupt() {},
    now: () => 500,
    window: () => 1,
    submit: (text) => { submitted.push(text); return 1; },
  });
  input.setEnabled(true);
  const old = input.start()!;
  input.write(old, new Uint8Array(320));
  input.release(old, null, 500);
  const current = input.start()!;
  input.cancel(old);
  workers[0]!.final("停止");
  assert.equal(input.snapshot().phase, "recording");
  input.release(current, null, 500);
  assert.equal(input.snapshot().phase, "empty");
  const disconnected = input.start()!;
  input.fail(disconnected, "设备已移除");
  workers[2]!.partial("停止");
  workers[2]!.final("停止");
  assert.equal(input.snapshot().phase, "error");
  assert.equal(input.snapshot().message, "设备已移除");
  assert.deepEqual(submitted, []);
});

test("new valid typed and trusted Minecraft input retire a pending ASR final", () => {
  const workers: RecognizerEvents[] = [];
  const session = new SimulationSession(() => {}, undefined, {
    onInputAccepted: () => voice.cancel(),
  });
  const voice = new VoiceInput({
    open: (events) => {
      workers.push(events);
      return { write() {}, end() {}, cancel() {} };
    },
    publish() {},
    interrupt() {},
    now: () => 500,
    window: () => session.nextInputWindow(),
    submit: (text) => session.submitText(text, "voice"),
  });
  voice.setEnabled(true);
  function release() {
    const id = voice.start()!;
    voice.write(id, new Uint8Array(320));
    voice.release(id, null, 500);
  }
  try {
    release();
    session.submitText(" ", "gui");
    assert.equal(voice.snapshot().phase, "processing");
    session.submitText("停止", "gui");
    workers[0]!.final("跟随小明");
    assert.equal(voice.snapshot().phase, "cancelled");

    release();
    session.updateLiveObservation({ place: "主世界", players: [] }, { phase: "idle", target: null, result: null });
    session.submitMinecraft({ text: "现在在哪？", player: "Host", replyRoute: null });
    workers[1]!.final("跟随小明");
    assert.equal(voice.snapshot().phase, "cancelled");

    release();
    workers[2]!.final("附近有谁？");
    assert.equal(voice.snapshot().phase, "final");
    assert.deepEqual(session.snapshot().messages.filter(({ role }) => role === "operator").map(({ text }) => text),
      ["停止", "现在在哪？", "附近有谁？"]);
  } finally {
    voice.cancel();
    session.dispose();
  }
});

test("a retired capture's terminal event cannot clear a rapid new key press or its status", async () => {
  const source = await readFile(new URL("../src/desktop/asr-renderer.js", import.meta.url), "utf8");
  function element() {
    const listeners = new Map<string, (event: unknown) => void>();
    const attributes = new Map<string, string>();
    return {
      attributes, checked: true, disabled: false, value: "follow", textContent: "",
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      emit: (type: string, event?: unknown) => listeners.get(type)?.(event),
    };
  }
  type Element = ReturnType<typeof element>;
  const elements = new Map<string, Element>();
  const getElementById = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id)!;
  };
  const tokens: unknown[] = [];
  let publish!: (state: unknown) => void;
  await runInNewContext(`(async () => {${source}})()`, {
    document: { getElementById },
    window: {
      addEventListener() {},
      companion: {
        asrConfig: () => ({ fixture: true, configured: false }),
        onAsr: (receive: typeof publish) => { publish = receive; },
        startAsr: (_mode: string, token: string) => { tokens.push(token); return new Promise(() => {}); },
        cancelAsr: () => Promise.resolve(),
      },
    },
    crypto, navigator: {}, performance, clearTimeout, setTimeout: () => undefined,
  });
  const button = getElementById("asr-record");
  const key = { key: " ", repeat: false, preventDefault() {} };
  button.emit("keydown", key);
  button.emit("keyup", key);
  button.emit("keydown", key);
  const state = {
    message: "", late: false, lastVoiceAt: null, releasedAt: null, finalAt: null, window: null,
  };
  publish({ ...state, token: tokens[1], phase: "recording", partial: "跟随" });
  publish({ ...state, token: tokens[0], phase: "cancelled" });
  assert.equal(button.attributes.get("aria-pressed"), "true");
  assert.equal(getElementById("asr-status").textContent, "采集中");
  assert.equal(getElementById("asr-partial").textContent, "跟随");
});
