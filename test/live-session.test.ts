import assert from "node:assert/strict";
import { test } from "node:test";
import type { connect } from "../src/client.ts";
import { LiveMinecraftSession } from "../src/desktop/live-session.ts";
import type { Observation } from "../src/perception.ts";
import type { TaskResult } from "../src/tasks.ts";

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
