import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server as TcpServer } from "node:net";
import { test } from "node:test";
import minecraftData from "minecraft-data";
import protocol from "minecraft-protocol";
import { connect } from "../src/client.ts";
import { LiveMinecraftSession } from "../src/desktop/live-session.ts";
import { offlinePlaySettings } from "../src/desktop/pal-play.ts";

test("a saved offline Pal joins and ends the session on request or server disconnect", { timeout: 12000 }, async (t) => {
  const version = "1.21.11";
  const host = "127.0.0.1";
  const data = minecraftData(version);
  const server = protocol.createServer({ host, port: 0, version, "online-mode": false });
  t.after(() => server.close());
  await once(server, "listening");
  const address = (server as typeof server & { socketServer: TcpServer }).socketServer.address();
  assert.ok(address && typeof address !== "string");
  const profile = { id: "pal", login: "offline", nickname: "SavedPal", backend: "sim", voice: "default", skin: "slim" } as const;
  const settings = offlinePlaySettings(profile, { host, port: String(address.port) });
  let onPhase: ((state: ReturnType<LiveMinecraftSession["snapshot"]>) => void) | undefined;
  const live = new LiveMinecraftSession((state) => onPhase?.(state), connect);
  t.after(() => live.disconnect());

  async function join() {
    const joining = once(server, "playerJoin");
    const ready = Promise.withResolvers<void>();
    onPhase = (state) => {
      if (state.phase === "ready") ready.resolve();
    };
    live.open(settings, true);
    assert.equal(live.snapshot().phase, "connecting", live.snapshot().reason ?? undefined);
    const [peer] = await joining as [protocol.ServerClient];
    assert.equal(peer.username, "SavedPal");
    assert.notEqual(live.snapshot().phase, "ready");
    peer.write("login", { ...data.loginPacket, entityId: peer.id });
    peer.write("update_health", { health: 20, food: 20, foodSaturation: 3 });
    peer.write("position", { x: 10, y: 72, z: 0, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 });
    await ready.promise;
    return peer;
  }

  const manual = await join();
  const closed = once(manual, "end");
  const ended = Promise.withResolvers<ReturnType<LiveMinecraftSession["snapshot"]>>();
  onPhase = (state) => {
    if (state.phase === "disconnected") ended.resolve(state);
  };
  live.disconnect();
  await closed;
  assert.equal((await ended.promise).active, false);

  const kicked = await join();
  const lost = Promise.withResolvers<ReturnType<LiveMinecraftSession["snapshot"]>>();
  onPhase = (state) => {
    if (!state.active && (state.phase === "disconnected" || state.phase === "failed")) lost.resolve(state);
  };
  kicked.end("测试服务器关闭");
  const state = await lost.promise;
  assert.equal(state.active, false);
  assert.ok(state.reason);
});

