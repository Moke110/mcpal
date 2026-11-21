import assert from "node:assert/strict";
import { test } from "node:test";
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
