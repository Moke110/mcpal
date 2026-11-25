import assert from "node:assert/strict";
import test from "node:test";
import { SentenceStream } from "../src/sensor/sentence-stream.ts";
import type { RecognizerEvents } from "../src/sensor/voice-input.ts";

test("confirmed sentences arrive during recording and close settles the tail once", async () => {
  const messages: string[] = [];
  let asr!: RecognizerEvents;
  const stream = new SentenceStream(events => {
    asr = events;
    return { write() {}, end() { events.final("尾句"); }, cancel() {} };
  }, text => messages.push(text), () => assert.fail());
  asr.partial("草稿");
  asr.segment!("第一句");
  asr.segment!(" ");
  asr.segment!("第二句");
  assert.deepEqual(messages, ["第一句", "第二句"]);
  await Promise.all([stream.finish(), stream.finish()]);
  assert.deepEqual(messages, ["第一句", "第二句", "尾句"]);
});
