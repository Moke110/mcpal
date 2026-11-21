import assert from "node:assert/strict";
import test from "node:test";
import { EchoGate } from "../src/desktop/echo-gate.js";

test("a delayed copy of speaker output stays out of open-mic speech, while double-talk survives", () => {
  const gate = new EchoGate();
  let seed = 42;
  const signal = Float32Array.from({ length: 16000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.28;
  });
  for (let offset = 0; offset < signal.length; offset += 320) {
    const echo = Float32Array.from({ length: 320 }, (_, i) => (signal[offset + i - 811] ?? 0) * 0.7);
    const isUser = offset >= 9600;
    const mic = echo.map((value, i) => value + (isUser ? Math.sin(i * 0.085) * 0.1 : 0));
    const block = gate.process(mic, signal.subarray(offset, offset + 320));
    assert.equal(block.speech, isUser, `block ${offset}`);
    if (isUser) assert.ok(Math.abs(block.clean[60]! - Math.sin(60 * 0.085) * 0.1) < 0.02);
  }
});

test("unmatched microphone noise during playback is withheld", () => {
  const gate = new EchoGate();
  const mic = Float32Array.from({ length: 320 }, (_, i) => Math.sin(i * 0.05) * 0.18);
  const output = Float32Array.from({ length: 320 }, (_, i) => Math.cos(i * 0.73) * 0.12);
  for (let i = 0; i < 12; i++) assert.equal(gate.process(mic, output).speech, false);
});

test("audio remains quarantined when playback is expected but the reference is missing", () => {
  const gate = new EchoGate();
  const mic = Float32Array.from({ length: 320 }, (_, i) => Math.sin(i * 0.05) * 0.18);
  const missing = new Float32Array(320);
  assert.equal(gate.process(mic, missing, true).speech, false);
  assert.equal(gate.process(mic, missing, false).speech, true);
});

test("echo path changes do not turn a shifted loudspeaker stream into a command", () => {
  const gate = new EchoGate();
  let seed = 31;
  const signal = Float32Array.from({ length: 16000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.28;
  });
  for (let offset = 0; offset < signal.length; offset += 320) {
    const delay = offset < 6400 ? 342 : 1301;
    const mic = Float32Array.from({ length: 320 }, (_, i) => (signal[offset + i - delay] ?? 0) * 0.8);
    assert.equal(gate.process(mic, signal.subarray(offset, offset + 320)).speech, false);
  }
});
