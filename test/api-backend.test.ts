import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createApiBackend } from "../src/desktop/api-backend.ts";
import type { ApiResult } from "../src/desktop/api-backend.ts";
import { SimulationSession } from "../src/desktop/sim-session.ts";
import { fakeClock } from "./fake-clock.ts";

async function fixture(t: { after: (cleanup: () => void) => void }, mode: "valid" | "truncated" | "http" | "slow" | "invalid") {
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
    const output = JSON.stringify({ reply: "正在跟随小明。", intent: { kind: "follow", target: mode === "invalid" ? "陌生人" : "小明" } });
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
