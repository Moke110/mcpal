import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { LocalBackend } from "../src/processor/local-backend.ts";
import { SimulationSession } from "../src/processor/sim-session.ts";
import type { ApiResult } from "../src/processor/api-backend.ts";
import { fakeClock } from "./fake-clock.ts";

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

test("automatic retirement withdraws a staged local follow without stopping committed work", async () => {
  for (const fail of ["over-budget", "telemetry"] as const) {
    const { clock, advance } = fakeClock();
    const retired = Promise.withResolvers<void>();
    let fault = false;
    const backend = new LocalBackend({ model: "fixture.gguf", settings: "fixture", fixture: true }, async () => ({
      ready: async () => {},
      generate: async ({ inputs }): Promise<ApiResult> => {
        const command = inputs.at(-1) ?? "";
        const target = command === "跟随小明" ? "小明" : command === "跟随小雨" ? "小雨" : null;
        return target ? { kind: "completed", output: { reply: `准备跟随${target}`, intent: { kind: "follow", target } } } : output;
      },
      readMemory: async () => {
        if (fault && fail === "telemetry") throw new Error("fixture lost telemetry");
        return { dedicatedBytes: fault ? 6_000_000_000 : 5_000_000_000, sharedBytes: 0 };
      },
      stop: () => retired.resolve(),
    }));
    const session = new SimulationSession(() => {}, clock, { local: backend });
    try {
      session.setBackend("local");
      await session.startLocal();
      session.advanceObservation();
      session.submitText("跟随小明", "gui");
      advance(400);
      await tick();
      advance(800);
      assert.equal(session.snapshot().task.target, "小明");

      session.submitText("跟随小雨", "gui");
      advance(1450);
      await tick();
      assert.equal(session.snapshot().window.result, "staged");
      fault = true;
      const timeout = new AbortController();
      try {
        await Promise.race([retired.promise, delay(2000, undefined, { signal: timeout.signal }).then(() => {
          throw new Error("fixture did not retire");
        })]);
      } finally {
        timeout.abort();
      }
      advance(1600);
      assert.equal(session.snapshot().window.result, "cancelled");
      assert.equal(session.snapshot().task.target, "小明");
      assert(!session.snapshot().messages.some(({ text }) => text === "准备跟随小雨"));
    } finally {
      session.dispose();
      await backend.stop();
    }
  }
});
