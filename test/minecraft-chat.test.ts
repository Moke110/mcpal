import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:net";
import { test } from "node:test";
import minecraftData from "minecraft-data";
import protocol from "minecraft-protocol";
import { connect } from "../src/client.ts";

for (const control of [true, false]) test(`player chat and system observations with controls ${control ? "enabled" : "disabled"}`, { timeout: 10_000 }, async (t) => {
  const version = "26.1";
  const data = minecraftData(version);
  const host = "127.0.0.1";
  const server = protocol.createServer({ host, port: 0, version, "online-mode": false });
  t.after(() => server.close());
  await once(server, "listening");
  const address = (server as typeof server & { socketServer: Server }).socketServer.address();
  assert.ok(address && typeof address !== "string");

  const ready = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const messages: unknown[] = [];
  const client = connect({
    host, port: address.port, username: "Companion", auth: "offline", version, snapshotIntervalMs: 1000,
    ...(control ? { control: true as const } : {}),
  }, (event) => { if (event === "snapshot") ready.resolve(); }, () => assert.fail("unexpected authentication"), {
    onPlayerChat: (message) => { messages.push(message); if (message.player === "Owner") accepted.resolve(); },
  });
  t.after(() => client.close());
  assert.equal(client.chat.send("Too early"), false);

  const [peer] = await once(server, "playerJoin") as [protocol.ServerClient];
  const owner = randomUUID();
  const other = randomUUID();
  peer.write("login", { ...data.loginPacket, entityId: peer.id });
  peer.write("update_health", { health: 17, food: 20, foodSaturation: 3 });
  peer.write("player_info", { action: { add_player: true }, data: [
    { uuid: owner, player: { name: "Owner", properties: [] } },
    { uuid: other, player: { name: "Bystander", properties: [] } },
    { uuid: peer.uuid, player: { name: "Companion", properties: [] } },
  ] });
  peer.write("position", { x: 3.5, y: 64, z: 5.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 });
  await ready.promise;
  for (const notice of ["Server announcement", "Bystander fell from a high place"]) {
    peer.write("system_chat", { content: { type: "string", value: notice }, isActionBar: false });
  }
  let index = 0;
  for (const senderUuid of [other, peer.uuid, owner]) {
    peer.write("player_chat", {
      globalIndex: index++, index, plainMessage: "!pal 生命值", type: { chatType: 1 }, senderUuid,
      timestamp: BigInt(Date.now()), salt: 0n, previousMessages: [], filterType: 0,
      networkName: { type: "compound", value: { text: { type: "string", value: "Spoofed" } } },
    });
  }
  await accepted.promise;
  assert.deepEqual(messages, [{ player: "Bystander", text: "!pal 生命值" }, { player: "Owner", text: "!pal 生命值" }]);

  assert.deepEqual(client.io.read()?.systemMessages, ["Server announcement", "Bystander fell from a high place"]);
  if (control) {
    const sent = once(peer, "chat_message");
    assert.equal(client.chat.send("/me hello\nnext line"), true);
    const [packet] = await sent;
    assert.equal(packet.message, "[Companion] /me hello next line");
  } else {
    assert.equal(client.chat.send("Observation only"), false);
  }
  client.close();
  assert.equal(client.chat.send("Old reply"), false);
  await client.closed;
});
