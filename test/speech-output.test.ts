import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { SpeechOutput, type SpeechEvent } from "../src/expressor/speech-output.ts";

test("停播撤回迟到 PCM，后续回复拥有独立的播报编号", async () => {
  const events: SpeechEvent[] = [];
  const syntheses: { resolve: (wave: Uint8Array) => void; signal: AbortSignal }[] = [];
  const output = new SpeechOutput({
    synthesize: (_text, signal) => new Promise((resolve) => syntheses.push({ resolve, signal })),
    publish: (event) => events.push(event),
    now: () => 45,
  });
  output.setEnabled(true);
  output.reply("旧回复");
  output.cancel();
  assert.equal(syntheses[0]?.signal.aborted, true);
  output.reply("新回复");
  syntheses[0]!.resolve(Uint8Array.of(1));
  syntheses[1]!.resolve(Uint8Array.of(2));
  await Promise.resolve();
  assert.deepEqual(events, [
    { type: "queued", id: 1 }, { type: "cancel", id: 1 }, { type: "queued", id: 2 },
    { type: "wave", id: 2, elapsed: 0, wave: Uint8Array.of(2) },
  ]);
  output.dispose();
});

test("播放线程清空 PCM 后只报告已输出的末帧，后续量子没有旧音频", () => {
  type OutputNode = { process(inputs: unknown, outputs: Float32Array[][]): boolean; port: { onmessage(): void } };
  let Processor: (new (options: { processorOptions: { samples: Float32Array } }) => OutputNode) | undefined;
  const messages: string[] = [];
  const worklet = {
    currentFrame: 128,
    AudioWorkletProcessor: class {
      port = { postMessage: (event: unknown) => messages.push(JSON.stringify(event)) };
    },
    registerProcessor(_name: string, processor: typeof Processor) { Processor = processor; },
  };
  runInNewContext(readFileSync(new URL("../src/gui/speech-worklet.js", import.meta.url), "utf8"), worklet);
  assert.ok(Processor);
  const player = new Processor({ processorOptions: { samples: Float32Array.of(0, 0.5, 0.5, 1) } });
  const first = new Float32Array(2);
  assert.equal(player.process([], [[first]]), true);
  assert.deepEqual([...first], [0, 0.5]);
  worklet.currentFrame += 2;
  player.port.onmessage();
  const next = new Float32Array(2);
  assert.equal(player.process([], [[next]]), false);
  assert.deepEqual([...next], [0, 0]);
  assert.deepEqual(messages.map((value) => JSON.parse(value)), [{ firstFrame: 129 }, { lastFrame: 129, cancelled: true }]);
});

test("停播撤回仍在初始化音频设备的试听，并允许再次试听", async () => {
  const clicks = new Map<string, () => void>();
  const element = (id: string) => ({
    addEventListener: (_name: string, handle: () => void) => clicks.set(id, handle),
    replaceChildren() {},
  });
  const resume = Promise.withResolvers<void>();
  let previews = 0;
  let stops = 0;
  const bridge = {
    speechFixture: async () => true,
    onSpeech() {},
    previewSpeech: async () => { previews++; },
    cancelSpeech: async () => { stops++; },
  };
  const source = readFileSync(new URL("../src/gui/speech-renderer.js", import.meta.url), "utf8")
    .replace("export { openPlaybackReference };", "");
  runInNewContext(source, {
    document: { getElementById: element },
    window: { companion: bridge },
    navigator: { mediaDevices: { addEventListener() {}, enumerateDevices: async () => [] } },
    Option: class {},
    AudioContext: class {
      audioWorklet = { addModule: async () => {} };
      createGain() { return {}; }
      resume() { return resume.promise; }
    },
  });

  clicks.get("speech-preview")!();
  clicks.get("speech-stop")!();
  resume.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(previews, 0);

  clicks.get("speech-preview")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(previews, 1);
});
