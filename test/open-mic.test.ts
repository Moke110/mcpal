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

test("a strong second reflection does not become speech after the first echo path is learned", () => {
  const gate = new EchoGate();
  let seed = 67;
  const signal = Float32Array.from({ length: 16000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.28;
  });
  for (let offset = 0; offset < signal.length; offset += 320) {
    const mic = Float32Array.from({ length: 320 }, (_, i) => {
      const reflected = offset < 6400 ? 0 : (signal[offset + i - 1600] ?? 0) * 0.7;
      const nearEnd = offset < 12800 ? 0 : Math.sin(i * 0.085) * 0.13;
      return (signal[offset + i - 800] ?? 0) * 0.65 + reflected + nearEnd;
    });
    assert.equal(gate.process(mic, signal.subarray(offset, offset + 320), true).speech,
      offset >= 12800, `block ${offset}`);
  }
});

test("five overlapping playback paths are still echo, including after rapid room-path changes", () => {
  const gate = new EchoGate();
  let seed = 128;
  const signal = Float32Array.from({ length: 32000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.28;
  });
  let run = 0;
  let longestRun = 0;
  let accepted = 0;
  for (let offset = 0; offset < signal.length; offset += 320) {
    const mic = Float32Array.from({ length: 320 }, (_, i) => {
      const at = (delay: number) => signal[offset + i - delay] ?? 0;
      const rooms = offset < 6400 ? 0 : at(1200) * 0.31 + at(1600) * 0.34 + at(2000) * 0.33 + at(2400) * 0.33;
      const nearEnd = offset >= 24000 ? Math.sin(i * 0.075) * 0.19 : 0;
      return at(800) * 0.45 + rooms + nearEnd;
    });
    const { speech } = gate.process(mic, signal.subarray(offset, offset + 320), true);
    if (offset < 24000) assert.equal(speech, false, `echo-only block ${offset}`);
    else {
      run = speech ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
      accepted += Number(speech);
    }
  }
  assert.ok(longestRun >= 5, "the worklet can confirm a run of near-end speech");
  assert.ok(accepted >= 20, "most of the overlapping near-end waveform survives");
});
