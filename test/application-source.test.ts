import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationAudio } from "../src/sensor/application-audio.ts";
import { Microphone } from "../src/sensor/microphone.ts";
import { MessageCache } from "../src/sensor/message-cache.ts";
import type { RecognizerEvents } from "../src/sensor/voice-input.ts";

test("application loss discards drafts and reconnects; closing the new stream commits its tail once", async () => {
  let capture!: { ready(): void; pcm(data: Uint8Array): void; lost(): void };
  let recognition!: RecognizerEvents;
  const output: string[] = [];
  const app = new ApplicationAudio((_path, events) => {
    capture = events;
    return async () => {};
  }, events => {
    recognition = events;
    return { write() {}, cancel() {}, end() { events.final("tail"); } };
  }, () => {});
  app.start("C:\\Meeting.exe", text => output.push(text));
  capture.ready();
  recognition.partial("draft");
  capture.lost();
  recognition.final("late");
  capture.ready();
  recognition.segment?.("sentence");
  await app.stop();
  await app.stop();
  assert.deepEqual(output, ["sentence", "tail"]);
});

test("simultaneous sources keep identical sentences in final arrival order", async () => {
  const cache = new MessageCache(() => {});
  const append = cache.begin();
  const recognizers: RecognizerEvents[] = [];
  const open = (events: RecognizerEvents) => {
    recognizers.push(events);
    return { write() {}, cancel() {}, end() { events.final(""); } };
  };
  let appCapture!: { ready(): void; lost(): void };
  const app = new ApplicationAudio((_path, events) => {
    appCapture = events;
    return async () => {};
  }, open, () => {});
  const microphone = new Microphone(open, () => {});
  microphone.start({ enabled: true, deviceId: "usb", label: "USB", sender: "小明" },
    text => append("USB", "小明", text));
  microphone.ready(1);
  app.start("Meeting.exe", text => append("Meeting", "未知发言人", text));
  appCapture.ready();
  recognizers[1]!.segment!("你好");
  recognizers[0]!.segment!("你好");
  appCapture.lost();
  recognizers[0]!.segment!("继续");
  assert.deepEqual(cache.snapshot().map(m => [m.sender, m.text]),
    [["未知发言人", "你好"], ["小明", "你好"], ["小明", "继续"]]);
  await app.stop();
  const stopped = microphone.stop();
  microphone.flushed(1);
  await stopped;
  cache.end();
});

test("an active application retries a failed recognizer without restarting capture", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let capture!: { ready(): void };
  let asr!: RecognizerEvents;
  let attempts = 0;
  const app = new ApplicationAudio((_path, events) => {
    capture = events;
    return async () => {};
  }, events => {
    if (++attempts === 1) throw new Error("startup");
    asr = events;
    return { write() {}, cancel() {}, end() { events.final(""); } };
  }, () => {});
  app.start("Meeting.exe", () => {});
  capture.ready();
  t.mock.timers.tick(5000);
  assert.equal(attempts, 2);
  asr.failure("worker exited");
  t.mock.timers.tick(5000);
  assert.equal(attempts, 3);
  asr.failure("worker exited");
  await app.stop();
  t.mock.timers.tick(5000);
  assert.equal(attempts, 3);
});
