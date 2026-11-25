import { createTextSensor } from "../src/sensor/text-sensor.ts";
import { createStateExpressor } from "../src/expressor/state-expressor.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulationSession } from "../src/processor/sim-session.ts";
import type { ModelInput } from "../src/processor/model-protocol.ts";
import { fakeClock } from "./fake-clock.ts";

test("Minecraft input and live observations reach the API only with explicit live permission", async () => {
  const observation = { place: "overworld", health: 13, players: [] };
  for (const useLiveApi of [false, true]) {
    const { clock, advance } = fakeClock();
    const requests: ModelInput[] = [];
    const session = new SimulationSession(() => {}, clock, {
      api: {
        origin: "http://127.0.0.1",
        check: async () => ({ kind: "completed" }),
        generate: async (input) => {
          requests.push(input);
          return { kind: "completed", output: { reply: "API 回复", intent: { kind: "none" } } };
        },
      },
    });
    session.setBackend("api");
    session.setApiLive(useLiveApi);
    session.updateLiveObservation(observation, { phase: "idle", target: null, result: null });
    session.submitMinecraft({ player: "Owner", text: "生命值", replyRoute: null });
    advance(400);
    await Promise.resolve();
    advance(850);
    assert.deepEqual(requests, useLiveApi ? [{ inputs: ["生命值"], observation }] : []);
    assert.equal(session.snapshot().messages.at(-1)?.text, useLiveApi ? "API 回复" : "当前生命值为 13。");
    session.dispose();
  }
});

test("trusted Minecraft input shares conversation scheduling with game observation and follows the originating reply route", () => {
  const { clock, advance } = fakeClock();
  const actions: unknown[] = [];
  const sent: { route: number | null; text: string }[] = [];
  const session = new SimulationSession(() => {}, clock, {
    liveAction: (intent) => actions.push(intent),
    minecraftReply: (route, text) => { sent.push({ route, text }); return route !== null; },
  });
  const task = { phase: "idle", target: null, result: null } as const;
  const live = { place: "overworld", health: 13, inventory: [], players: [{ name: "Owner", distance: 8 }] };
  session.updateLiveObservation(live, task);
  const submit = (text: string, replyRoute: number | null = 1) => {
    session.submitMinecraft({ player: "Owner", text, replyRoute });
  };
  submit("生命值", null);
  advance(850);
  assert.deepEqual(session.snapshot().messages.slice(-2), [
    { role: "operator", source: "minecraft", player: "Owner", text: "生命值" },
    { role: "companion", source: "minecraft", text: "当前生命值为 13。", publicReply: false },
  ]);
  submit("跟随我");
  advance(1650);
  assert.deepEqual(actions, [{ kind: "follow", target: "Owner" }]);
  assert.equal(session.snapshot().messages.at(-2)?.text, "跟随我");
  assert.deepEqual(sent.at(-1), { route: 1, text: "正在跟随Owner。" });
  submit("停止");
  assert.deepEqual(actions.at(-1), { kind: "stop" });
  assert.match(sent.at(-1)?.text ?? "", /停止/u);
  submit("背包");
  session.updateLiveObservation(null, task);
  session.updateLiveObservation(live, task);
  advance(3250);
  assert.doesNotMatch(sent.at(-1)?.text ?? "", /背包/u);
  session.dispose();
});

test("an explicit stop from the GUI or ASR releases a Minecraft chat follow without API live permission", () => {
  for (const stop of [
    (session: SimulationSession) => session.stop(),
    (session: SimulationSession) => session.submitText("停止", "gui"),
    (session: SimulationSession) => session.submitText("停止", "voice"),
  ]) {
    const { clock, advance } = fakeClock();
    const actions: unknown[] = [];
    const session = new SimulationSession(() => {}, clock, {
      liveAction: (intent) => actions.push(intent),
      api: {
        origin: "http://127.0.0.1",
        check: async () => ({ kind: "completed" }),
        generate: async () => assert.fail("Stopping must not call the external backend"),
      },
    });
    session.setBackend("api");
    session.updateLiveObservation({ place: "overworld", players: [{ name: "Owner", distance: 8 }] },
      { phase: "idle", target: null, result: null });
    session.submitMinecraft({ text: "跟随 Owner", player: "Owner", replyRoute: null });
    advance(850);
    assert.deepEqual(actions, [{ kind: "follow", target: "Owner" }]);
    stop(session);
    assert.deepEqual(actions, [{ kind: "follow", target: "Owner" }, { kind: "stop" }]);
    session.dispose();
  }
});

test("状态追问读取变化后的游戏观测，并独立显示回复、任务和播报", () => {
  const { clock, advance } = fakeClock();
  const session = new SimulationSession(() => {}, clock);
  session.advanceObservation();
  session.submitText("附近有谁？", "gui");
  advance(850);
  const state = session.snapshot();
  assert.equal(state.mode, "simulation");
  assert.equal(state.connection, "offline");
  assert.match(state.messages.at(-1)?.text ?? "", /小明.*3\.2.*小雨.*8\.5/);
  assert.equal(state.task.phase, "idle");
  assert.equal(state.playback.phase, "playing");
  advance(3450);
  assert.equal(session.snapshot().playback.phase, "finished");
  session.dispose();
});

test("模拟语音插话中断播报，改口等待旧任务清理，停止取消待发回复", () => {
  const { clock, advance } = fakeClock();
  const session = new SimulationSession(() => {}, clock);
  session.advanceObservation();
  session.submitText("跟随小明", "gui");
  advance(850);
  assert.deepEqual(session.snapshot().task, { phase: "following", target: "小明" });

  session.submitText("现在在哪？", "voice");
  assert.equal(session.snapshot().playback.phase, "interrupted");
  assert.equal(session.snapshot().task.phase, "following");
  assert.equal(session.snapshot().messages.at(-1)?.source, "voice");
  session.submitText("改跟小雨", "gui");
  advance(1650);
  assert.deepEqual(session.snapshot().task, { phase: "cleaning", target: "小明" });
  advance(2450);
  assert.deepEqual(session.snapshot().task, { phase: "following", target: "小雨" });

  session.submitText("改跟小明", "gui");
  session.stop();
  assert.equal(session.snapshot().reply, "cancelled");
  assert.deepEqual(session.snapshot().task, { phase: "cleaning", target: "小雨" });
  advance(3250);
  assert.equal(session.snapshot().task.phase, "stopped");
  assert.equal(session.snapshot().playback.phase, "interrupted");
  session.dispose();
});

test("超时的跟随请求即使稍后返回也不会触发跟随或播报", () => {
  const { clock, advance } = fakeClock();
  const session = new SimulationSession(() => {}, clock);
  session.setTimeoutNext(true);
  session.submitText("跟随小明", "gui");
  advance(1200);
  assert.equal(session.snapshot().reply, "timeout");
  advance(3200);
  assert.equal(session.snapshot().reply, "timeout");
  assert.deepEqual(session.snapshot().messages.map(({ role }) => role), ["operator"]);
  assert.equal(session.snapshot().playback.phase, "idle");
  assert.equal(session.snapshot().task.phase, "idle");

  session.submitText("跟随小明", "gui");
  advance(4050);
  assert.equal(session.snapshot().task.phase, "following");
  session.dispose();
});

test("清理期间的新输入使等待开始的替换任务失效", () => {
  const { clock, advance } = fakeClock();
  const session = new SimulationSession(() => {}, clock);
  session.advanceObservation();
  session.submitText("跟随小明", "gui");
  advance(850);
  session.submitText("改跟小雨", "gui");
  advance(1650);
  assert.equal(session.snapshot().task.phase, "cleaning");
  session.submitText("现在在哪？", "voice");
  advance(2450);
  assert.deepEqual(session.snapshot().task, { phase: "stopped", target: null });
  session.dispose();
});

test("starting desktop chat selects the Pal model and opens a clean conversation without live Minecraft", async () => {
  const { clock, advance } = fakeClock();
  const liveRoutes: string[] = [];
  const session = new SimulationSession(() => {}, clock, {
    api: {
      origin: "http://127.0.0.1",
      check: async () => ({ kind: "completed" }),
      generate: async () => ({ kind: "completed", output: { reply: "你好，桌面伙伴。", intent: { kind: "none" } } }),
    },
    minecraftReply: (_route, text) => { liveRoutes.push(text); return true; },
  });
  session.setBackend("api");
  session.setApiLive(true);
  session.submitText("上一场会话", "gui");
  session.startDesktopChat("api");
  assert.deepEqual(session.snapshot().messages, []);
  assert.equal(session.snapshot().api.live, false);
  session.submitText("你好", "gui");
  advance(400);
  await Promise.resolve();
  advance(850);
  assert.equal(session.snapshot().messages.at(-1)?.text, "你好，桌面伙伴。");
  assert.deepEqual(liveRoutes, []);
  session.dispose();
});

test("Pal play desktop inputs use live observations and require consent for the API model", async () => {
  const { clock, advance } = fakeClock();
  const observation = { place: "受控世界", health: 13, players: [] };
  const requests: ModelInput[] = [];
  const session = new SimulationSession(() => {}, clock, {
    api: {
      origin: "http://127.0.0.1",
      check: async () => ({ kind: "completed" }),
      generate: async (input) => {
        requests.push(input);
        return { kind: "completed", output: { reply: "API 回复", intent: { kind: "none" } } };
      },
    },
  });
  assert.throws(() => session.startPalPlay("api", false), /授权/u);
  session.startPalPlay("api", true);
  session.updateLiveObservation(observation, { phase: "idle", target: null, result: null });
  session.submitText("生命值", "gui");
  advance(400);
  await Promise.resolve();
  advance(850);
  assert.deepEqual(requests, [{ inputs: ["生命值"], observation }]);
  session.endPalPlay();
  assert.equal(session.snapshot().api.live, false);
  session.dispose();
});

test("a desktop chat sends multiline text through a sensor and publishes a simulated Pal reply", () => {
  const { clock, advance } = fakeClock();
  const published: ReturnType<SimulationSession["snapshot"]>[] = [];
  const express = createStateExpressor((state: ReturnType<SimulationSession["snapshot"]>) => published.push(state));
  const session = new SimulationSession(express, clock);
  const sense = createTextSensor((text, source) => session.submitText(text, source));
  try {
    session.startDesktopChat("simulated");
    sense("你好\n请回复", "gui");
    advance(1250);
    const messages = published.at(-1)?.messages ?? [];
    assert.equal(messages[0]?.role, "operator");
    assert.equal(messages[0]?.text, "你好\n请回复");
    assert.equal(messages.at(-1)?.role, "companion");
    assert.ok(messages.at(-1)?.text);
  } finally {
    session.dispose();
  }
});
