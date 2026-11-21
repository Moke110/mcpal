import assert from "node:assert/strict";
import test from "node:test";
import { LocalBackend } from "../src/desktop/local-backend.ts";
import type { ApiResult } from "../src/desktop/api-backend.ts";

const output: ApiResult = { kind: "completed", output: { reply: "测试", intent: { kind: "none" } } };

test("an exact-limit warmup sample stops the process and leaves the local model unavailable", async () => {
  let stopped = false;
  let dedicatedBytes = 5_000_000_000;
  const backend = new LocalBackend({ model: "fixture.gguf", settings: "fixture", fixture: true }, async () => ({
    ready: async () => {},
    generate: async () => {
      dedicatedBytes = 6_000_000_000;
      return output;
    },
    readMemory: async () => ({ dedicatedBytes, sharedBytes: 123 }),
    stop: () => { stopped = true; },
  }));
  await backend.start();
  assert.equal(backend.snapshot().phase, "over-budget");
  assert.equal(backend.snapshot().dedicatedPeakBytes, 6_000_000_000);
  assert.equal(backend.snapshot().sharedPeakBytes, 123);
  assert.equal(stopped, true);
  assert.deepEqual(await backend.generate({ inputs: ["状态"], observation: null }, new AbortController().signal, () => {}), { kind: "invalid" });
});

test("missing Windows telemetry after warmup prevents readiness", async () => {
  let ready = false;
  const backend = new LocalBackend({ model: "fixture.gguf", settings: "fixture", fixture: true }, async () => ({
    ready: async () => { ready = true; },
    generate: async () => output,
    readMemory: async () => ready ? null : { dedicatedBytes: 4_900_000_000, sharedBytes: 100 },
    stop() {},
  }));
  await backend.start();
  assert.equal(backend.snapshot().phase, "failed");
  assert.equal(backend.snapshot().samplesBelowLimit, null);
});

test("late results are discarded when unloading and no new runtime starts before reclamation", async () => {
  let launches = 0;
  let generating: (value: ApiResult) => void;
  let reclaim: () => void;
  let warmup = true;
  const backend = new LocalBackend({ model: "fixture.gguf", settings: "fixture", fixture: true }, async () => {
    launches++;
    return {
      ready: async () => {},
      generate: async () => {
        if (warmup) {
          warmup = false;
          return output;
        }
        return new Promise<ApiResult>((resolve) => { generating = resolve; });
      },
      readMemory: async () => ({ dedicatedBytes: 5_999_999_999, sharedBytes: 2_000_000_000 }),
      stop: () => new Promise<void>((resolve) => { reclaim = resolve; }),
    };
  });
  await backend.start();
  assert.equal(backend.snapshot().phase, "ready");
  assert.equal(backend.snapshot().samplesBelowLimit, true);
  const request = backend.generate({ inputs: ["状态"], observation: null }, new AbortController().signal, () => {});
  const stopped = backend.stop();
  await backend.start();
  assert.equal(launches, 1);
  assert.equal(backend.snapshot().phase, "reclaiming");
  generating!(output);
  assert.deepEqual(await request, { kind: "cancelled" });
  reclaim!();
  await stopped;
  assert.equal(backend.snapshot().phase, "off");
});
