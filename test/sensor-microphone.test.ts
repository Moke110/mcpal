import assert from "node:assert/strict";
import test from "node:test";
import { Microphone } from "../src/sensor/microphone.ts";
import type { RecognizerEvents } from "../src/sensor/voice-input.ts";

test("unplugging discards unfinished audio, recovery accepts two sentences and one final tail", async () => {
  const messages: string[] = [];
  const commands: object[] = [];
  let worker!: RecognizerEvents;
  const mic = new Microphone(events => {
    worker = events;
    return { write() {}, cancel() {}, end() { events.final("收尾"); } };
  }, command => commands.push(command));
  mic.start({ enabled: true, deviceId: "usb-1", label: "USB", sender: "小明" }, text => messages.push(text));
  const { token } = commands[0] as { token: number };
  assert.equal(mic.ready(token), true);
  worker.segment!("一句");
  worker.partial("丢弃");
  mic.lost(token);
  worker.final("迟到");
  assert.equal(mic.ready(token), true);
  worker.segment!("二句");
  const stopped = mic.stop();
  mic.flushed(token);
  await stopped;
  assert.deepEqual(messages, ["一句", "二句", "收尾"]);
  assert.equal(mic.ready(token), false);
});
