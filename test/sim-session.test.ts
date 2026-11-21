import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulationSession } from "../src/desktop/sim-session.ts";

test("状态追问读取变化后的游戏观测，并独立显示回复、任务和播报", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new SimulationSession(() => {});
  session.advanceObservation();
  session.submitText("附近有谁？", "gui");
  context.mock.timers.tick(450);
  const state = session.snapshot();
  assert.equal(state.mode, "simulation");
  assert.equal(state.connection, "offline");
  assert.match(state.messages.at(-1)?.text ?? "", /小明.*3\.2.*小雨.*8\.5/);
  assert.equal(state.task.phase, "idle");
  assert.equal(state.playback.phase, "playing");
  context.mock.timers.tick(2600);
  assert.equal(session.snapshot().playback.phase, "finished");
  session.dispose();
});

test("模拟语音插话中断播报，改口等待旧任务清理，停止取消待发回复", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new SimulationSession(() => {});
  session.advanceObservation();
  session.submitText("跟随小明", "gui");
  context.mock.timers.tick(450);
  assert.deepEqual(session.snapshot().task, { phase: "following", target: "小明" });

  session.submitText("现在在哪？", "voice");
  assert.equal(session.snapshot().playback.phase, "interrupted");
  assert.equal(session.snapshot().task.phase, "following");
  assert.equal(session.snapshot().messages.at(-1)?.source, "voice");
  session.submitText("改跟小雨", "gui");
  context.mock.timers.tick(450);
  assert.deepEqual(session.snapshot().task, { phase: "cleaning", target: "小明" });
  context.mock.timers.tick(800);
  assert.deepEqual(session.snapshot().task, { phase: "following", target: "小雨" });

  session.submitText("改跟小明", "gui");
  session.stop();
  assert.equal(session.snapshot().reply, "cancelled");
  assert.deepEqual(session.snapshot().task, { phase: "cleaning", target: "小雨" });
  context.mock.timers.tick(800);
  assert.equal(session.snapshot().task.phase, "stopped");
  assert.equal(session.snapshot().playback.phase, "interrupted");
  session.dispose();
});

test("超时的跟随请求即使稍后返回也不会触发跟随或播报", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new SimulationSession(() => {});
  session.setTimeoutNext(true);
  session.submitText("跟随小明", "gui");
  context.mock.timers.tick(1600);
  assert.equal(session.snapshot().reply, "timeout");
  context.mock.timers.tick(2000);
  assert.equal(session.snapshot().reply, "timeout");
  assert.deepEqual(session.snapshot().messages.map(({ role }) => role), ["operator"]);
  assert.equal(session.snapshot().playback.phase, "idle");
  assert.equal(session.snapshot().task.phase, "idle");

  session.submitText("跟随小明", "gui");
  context.mock.timers.tick(450);
  assert.equal(session.snapshot().task.phase, "following");
  session.dispose();
});

test("清理期间的新输入使等待开始的替换任务失效", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new SimulationSession(() => {});
  session.advanceObservation();
  session.submitText("跟随小明", "gui");
  context.mock.timers.tick(450);
  session.submitText("改跟小雨", "gui");
  context.mock.timers.tick(450);
  assert.equal(session.snapshot().task.phase, "cleaning");
  session.submitText("现在在哪？", "voice");
  context.mock.timers.tick(800);
  assert.deepEqual(session.snapshot().task, { phase: "stopped", target: null });
  session.dispose();
});
