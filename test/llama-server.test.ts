import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { localReasoningOptions, localServerHealthy } from "../src/processor/llama-server.ts";

test("local llama-server disables thinking with the option advertised by the executable", () => {
  const legacyHelp = "--reasoning-format FORMAT  instead controls response formatting\n" +
    "   --reasoning-budget N  0 disables reasoning\n";
  assert.deepEqual(localReasoningOptions(legacyHelp), ["--reasoning-budget", "0"]);
  assert.deepEqual(localReasoningOptions("--reasoning [on|off|auto]\n" + legacyHelp), ["--reasoning", "off"]);
  assert.throws(() => localReasoningOptions("--reasoning-format FORMAT"), /无法禁用/u);
});

test("model health rejects loading responses and accepts a ready server", async (t) => {
  let loaded = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/health");
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    response.writeHead(loaded ? 200 : 503).end();
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const signal = AbortSignal.timeout(1000);
  assert.equal(await localServerHealthy(address.port, "fixture-key", signal), false);
  loaded = true;
  assert.equal(await localServerHealthy(address.port, "fixture-key", signal), true);
});
