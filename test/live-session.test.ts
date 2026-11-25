import assert from "node:assert/strict";
import { test } from "node:test";
import type { connect } from "../src/client.ts";
import { LiveMinecraftSession } from "../src/sensor/live-session.ts";
import type { Observation } from "../src/perception.ts";
import type { TaskResult } from "../src/tasks.ts";

test("Minecraft replies require opt-in for the originating route and world", async () => {
  let report: Parameters<typeof connect>[1] = () => {};
  let receive: NonNullable<NonNullable<Parameters<typeof connect>[3]>["onTrustedChat"]> = () => {};
  const accepted: { text: string; player: string; replyRoute: number | null }[] = [];
  const sent: string[] = [];
  const end = Promise.withResolvers<{ reason: string; requested: boolean; pendingLogin: boolean }>();
  const read = { nearby: { players: [] } } as unknown as Observation;
  const session = new LiveMinecraftSession(() => {}, (config, listener, _prompt, chat) => {
    assert.deepEqual([...config.control!.players], ["owner"]);
    report = listener;
    receive = chat!.onTrustedChat!;
    return {
      closed: end.promise,
      close: () => end.resolve({ reason: "shutdown", requested: true, pendingLogin: false }),
      io: { read: () => read, readBlock: () => null, execute: async () => assert.fail(), stop: () => {} },
      chat: { send: (text) => { sent.push(text); return true; } },
    };
  }, (message) => accepted.push(message));
  session.open({
    host: "127.0.0.1", port: "25565", auth: "offline", username: "Companion",
    offlineControl: true, authorizedPlayers: "Owner",
  });
  const ready = () => report("snapshot", { observation: read });
  ready();
  const message = { text: "!pal 生命值", player: "Owner" };
  receive({ ...message, text: "聊天闲谈" });
  receive(message);
  assert.deepEqual(accepted, [{ text: "生命值", player: "Owner", replyRoute: null }]);
  session.setChatRoute(true);
  assert.equal(session.sendChatReply(accepted[0]!.replyRoute, "Before opt-in"), false);
  receive(message);
  const originalRoute = accepted.at(-1)!.replyRoute;
  session.setChatRoute(false);
  session.setChatRoute(true);
  assert.equal(session.sendChatReply(originalRoute, "Previous route"), false);
  receive(message);
  const nextWorld = accepted.at(-1)!.replyRoute;
  report("world_unavailable");
  receive(message);
  assert.equal(accepted.length, 3);
  ready();
  assert.equal(session.sendChatReply(nextWorld, "Previous world"), false);
  receive(message);
  const activeRoute = accepted.at(-1)!.replyRoute;
  assert.equal(session.sendChatReply(activeRoute, "Current world"), true);
  session.disconnect();
  assert.equal(session.sendChatReply(activeRoute, "Disconnected"), false);
  await end.promise;
  assert.deepEqual(sent, ["Current world"]);
});

test("live controls wait for ready observations, release control before confirming stop, and reject retired world input", async () => {
  let report: Parameters<typeof connect>[1] = () => {};
  let read: Observation | null = null;
  let stops = 0;
  let executions = 0;
  const end = Promise.withResolvers<{ reason: string; requested: boolean; pendingLogin: boolean }>();
  const task = Promise.withResolvers<TaskResult>();
  const session = new LiveMinecraftSession(() => {}, (config, listener) => {
    assert.equal(config.port, 25565);
    report = listener;
    return {
      closed: end.promise,
      close: () => end.resolve({ reason: "shutdown", requested: true, pendingLogin: false }),
      chat: { send: () => false },
      io: {
        read: () => read,
        readBlock: () => null,
        execute: () => { executions++; return task.promise; },
        stop: () => { stops++; },
      },
    };
  });
  session.open({ host: "127.0.0.1", port: "25565", auth: "offline", username: "Companion", offlineControl: true });
  assert.equal(session.snapshot().phase, "connecting");
  session.follow("Host");
  assert.equal(executions, 0);
  const position = { x: 1, y: 65, z: 5 };
  read = {
    username: "Companion", connection: "spawned", schemaVersion: 1, version: "26.1",
    position, dimension: "overworld", health: 20, food: 20, inventory: null, blocks: [], currentTask: null,
    orientation: { yawRadians: 0, pitchRadians: 0 },
    nearby: { radius: 32, entities: [],
      players: [{ id: 2, username: "Host", position, distance: 0, type: "player", name: null }] },
  };
  report("snapshot", { observation: read });
  assert.equal(session.snapshot().phase, "ready");
  assert.equal(session.snapshot().observation?.inventory, null);
  session.follow("Host");
  report("task_started", { task: { id: 1, label: "follow", startedAt: "now" } });
  assert.equal(executions, 1);
  assert.equal(session.snapshot().task.phase, "following");
  session.stop();
  assert.equal(stops, 1);
  assert.equal(session.snapshot().task.phase, "stopping");
  task.resolve({ state: "cancelled", message: "Stopped by operator" });
  await task.promise;
  await Promise.resolve();
  assert.equal(session.snapshot().task.phase, "released");
  read = null;
  report("world_unavailable");
  assert.equal(session.snapshot().observation, null);
  session.follow("Host");
  assert.equal(executions, 1);
  session.disconnect();
  await end.promise;
  report("snapshot", { observation: read });
  assert.equal(session.snapshot().phase, "disconnected");
});
