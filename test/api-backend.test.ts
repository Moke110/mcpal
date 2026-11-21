import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createApiBackend } from "../src/desktop/api-backend.ts";
import type { ApiResult } from "../src/desktop/api-backend.ts";
import { SimulationSession } from "../src/desktop/sim-session.ts";
import { LiveMinecraftSession } from "../src/desktop/live-session.ts";
import type { connect } from "../src/client.ts";
import type { Observation } from "../src/perception.ts";
import type { TaskResult } from "../src/tasks.ts";
import { fakeClock } from "./fake-clock.ts";

async function fixture(t: { after: (cleanup: () => void) => void }, mode: "valid" | "truncated" | "http" | "slow" | "invalid" | "secret-reply" | "secret-target") {
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer local-fixture-key");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "fixture" }] }));
      return;
    }
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.match(body, /跟随小明/u);
    assert.doesNotMatch(body, /local-fixture-key/u);
    if (mode === "http") {
      response.writeHead(429).end("local-fixture-key");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const reply = mode === "secret-reply" ? "echo local-fixture-key" : "正在跟随小明。";
    const target = mode === "invalid" ? "陌生人" : mode === "secret-target" ? "local-fixture-key" : "小明";
    const output = JSON.stringify({ reply, intent: { kind: "follow", target } })
      .replace("local-fixture-key", "\\u006cocal-fixture-key");
    const frame = (delta: object, reason: string | null = null) =>
      "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + "\r\n\r\n";
    const bytes = Buffer.from(frame({ content: output }));
    const split = bytes.indexOf(Buffer.from("正")) + 1;
    response.write(bytes.subarray(0, split));
    response.write(bytes.subarray(split));
    if (mode === "slow") return;
    response.end(mode === "truncated" ? frame({}, "length") : frame({}, "stop") + "data: [DONE]\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== "string");
  return createApiBackend({
    MCPAL_API_BASE_URL: "http://127.0.0.1:" + address.port + "/v1",
    MCPAL_API_KEY: "local-fixture-key",
    MCPAL_API_MODEL: "fixture",
  });
}

const input = { inputs: ["跟随小明"], observation: { place: "草地", players: [{ name: "小明", distance: 5 }] } };
test("API connection test and streamed Chinese intent", async (t) => {
  const backend = await fixture(t, "valid");
  assert(backend);
  assert.deepEqual(await backend.check(), { kind: "completed" });
  let first = 0;
  const result = await backend.generate(input, new AbortController().signal, () => { first++; });
  assert.equal(first, 1);
  assert.deepEqual(result, { kind: "completed", output: { reply: "正在跟随小明。", intent: { kind: "follow", target: "小明" } } });
});
test("truncated and invalid streams cannot contribute actions", async (t) => {
  const truncated = await fixture(t, "truncated");
  const invalid = await fixture(t, "invalid");
  assert(truncated && invalid);
  const signal = new AbortController().signal;
  assert.deepEqual(await truncated.generate(input, signal, () => {}), { kind: "truncated" });
  assert.deepEqual(await invalid.generate(input, signal, () => {}), { kind: "invalid" });
});

test("HTTP failure does not report provider body or trigger alternate routing", async (t) => {
  const backend = await fixture(t, "http");
  assert(backend);
  assert.deepEqual(await backend.generate(input, new AbortController().signal, () => {}), { kind: "http", status: 429 });
});

test("abort abandons a partially delivered result", async (t) => {
  const backend = await fixture(t, "slow");
  assert(backend);
  const controller = new AbortController();
  assert.deepEqual(await backend.generate(input, controller.signal, () => { controller.abort(); }), { kind: "cancelled" });
});
test("switching and expiring a backend revoke its ability to commit even if it ignores abort", async () => {
  const { clock, advance } = fakeClock();
  const attempts: { signal: AbortSignal; complete: (result: ApiResult) => void }[] = [];
  const session = new SimulationSession(() => {}, clock, {
    api: {
      origin: "http://127.0.0.1",
      check: async () => ({ kind: "completed" }),
      generate: (_input, signal) => new Promise((complete) => { attempts.push({ signal, complete }); }),
    },
  });
  const follow: ApiResult = { kind: "completed", output: { reply: "跟随小明", intent: { kind: "follow", target: "小明" } } };
  session.setBackend("api");
  session.submitText("跟随小明", "gui");
  advance(400);
  assert.equal(attempts.length, 1);
  session.setBackend("simulated");
  assert.equal(attempts[0]?.signal.aborted, true);
  attempts[0]?.complete(follow);
  await Promise.resolve();
  advance(1200);
  assert.equal(session.snapshot().task.target, null);
  assert.equal(session.snapshot().messages.filter(({ role }) => role === "companion").length, 0);

  session.setBackend("api");
  session.submitText("跟随小明", "gui");
  advance(2800);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.signal.aborted, true);
  assert.equal(session.snapshot().window.result, "timeout");
  attempts[1]?.complete(follow);
  await Promise.resolve();
  assert.equal(session.snapshot().task.target, null);
  assert.equal(session.snapshot().api.cancelled, 2);
  session.dispose();
});
test("live mode commits only an explicit target that remains observable, even if the backend proposes action", async () => {
  const { clock, advance } = fakeClock();
  const actions: string[] = [];
  const target = { name: "Host", distance: 4 };
  const task = { phase: "idle", target: null, result: null } as const;
  const session = new SimulationSession(() => {}, clock, {
    api: {
      origin: "http://127.0.0.1",
      check: async () => ({ kind: "completed" }),
      generate: async () => ({ kind: "completed", output: { reply: "跟随 Host", intent: { kind: "follow", target: "Host" } } }),
    },
    liveAction: (intent) => actions.push(intent.kind === "follow" ? intent.target : intent.kind),
  });
  session.setBackend("api");
  session.setApiLive(true);
  session.updateLiveObservation({ place: "主世界", players: [target] }, task);
  session.submitText("随便做点什么", "gui");
  advance(400);
  await Promise.resolve();
  advance(800);
  assert.deepEqual(actions, []);
  assert.match(session.snapshot().messages.at(-1)?.text ?? "", /明确/);

  session.submitText("跟随 Host", "gui");
  advance(1450);
  await Promise.resolve();
  session.updateLiveObservation({ place: "主世界", players: [] }, task);
  advance(1600);
  assert.deepEqual(actions, []);
  assert.match(session.snapshot().messages.at(-1)?.text ?? "", /已看不到/);

  session.updateLiveObservation({ place: "主世界", players: [target] }, task);
  session.submitText("跟随 Host", "gui");
  advance(2250);
  await Promise.resolve();
  assert.deepEqual(actions, []);
  advance(2400);
  assert.deepEqual(actions, ["Host"]);
  session.dispose();
});
test("credentials escaped in either decoded output field are rejected", async (t) => {
  for (const mode of ["secret-reply", "secret-target"] as const) {
    const backend = await fixture(t, mode);
    assert(backend);
    const observation = mode === "secret-target"
      ? { ...input.observation, players: [...input.observation.players, { name: "local-fixture-key", distance: 5 }] }
      : input.observation;
    assert.deepEqual(await backend.generate({ ...input, observation }, new AbortController().signal, () => {}), {
      kind: "invalid",
    });
  }
});

test("new input or a session change discards a live replacement without stopping the cleanup", async () => {
  for (const change of ["status", "backend", "source", "session"] as const) {
    const { clock, advance } = fakeClock();
    const attempts: string[] = [];
    const released = Promise.withResolvers<TaskResult>();
    let stops = 0;
    let report: Parameters<typeof connect>[1] = () => {};
    const pos = { x: 0, y: 64, z: 0 };
    const players = [{ name: "Host", distance: 2 }, { name: "Other", distance: 4 }];
    const observation: Observation = {
      schemaVersion: 1, username: "Companion", connection: "spawned", version: "26.1",
      dimension: "overworld", position: pos, orientation: { yawRadians: 0, pitchRadians: 0 },
      health: 20, food: 20, currentTask: null, inventory: null, blocks: [],
      nearby: { radius: 32, entities: [], players: players.map(({ name, distance }, id) => ({
        id, distance, type: "player", name: null, username: name, position: pos,
      })) },
    };
    const live = new LiveMinecraftSession(() => {}, (_config, listener) => {
      report = listener;
      return {
        closed: new Promise(() => {}), close: () => {},
        chat: { send: () => false },
        io: {
          read: () => observation, readBlock: () => null,
          execute: (action) => {
            if (action.kind === "follow") attempts.push(action.player);
            return released.promise;
          },
          stop: () => { stops++; },
        },
      };
    });
    const session = new SimulationSession(() => {}, clock, {
      api: {
        origin: "http://127.0.0.1",
        check: async () => ({ kind: "completed" }),
        generate: async () => ({ kind: "completed", output: { reply: "跟随 Other", intent: { kind: "follow", target: "Other" } } }),
      },
      liveAction: (intent) => {
        if (intent.kind === "follow") live.replaceFollow(intent.target);
        if (intent.kind === "stop") live.stop();
      },
      invalidateLiveReplacement: () => live.invalidateReplacement(),
    });
    live.open({ host: "127.0.0.1", port: "25565", auth: "offline", username: "Companion", offlineControl: true });
    report("snapshot", { observation });
    session.setBackend("api");
    session.setApiLive(true);
    session.updateLiveObservation({ place: "主世界", players }, live.snapshot().task);
    live.follow("Host");
    session.submitText("改跟 Other", "gui");
    advance(400);
    await Promise.resolve();
    advance(800);
    assert.equal(stops, 1);
    assert.equal(live.snapshot().task.phase, "stopping");
    if (change === "status") session.submitText("附近有谁？", "gui");
    if (change === "backend") session.setBackend("simulated");
    if (change === "source") session.setApiLive(false);
    if (change === "session") session.switchSession();
    assert.equal(stops, 1);
    released.resolve({ state: "cancelled", message: "stopped" });
    await released.promise;
    await Promise.resolve();
    assert.deepEqual(attempts, ["Host"], change);
    assert.equal(live.snapshot().task.phase, "released");
    session.dispose();
  }
});
