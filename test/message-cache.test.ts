import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageCache } from "../src/sensor/message-cache.ts";
import { fakeClock } from "./fake-clock.ts";

test("final text expires at five minutes while idle and old session writers stay disconnected", () => {
  const time = fakeClock();
  let visible = -1;
  const cache = new MessageCache(messages => { visible = messages.length; }, time.clock);
  const first = cache.begin();
  first("GUI", "桌面操作者", "hello");
  assert.deepEqual(cache.snapshot(), [{ source: "GUI", sender: "桌面操作者", text: "hello", arrivedAt: 0 }]);
  time.advance(299999);
  assert.equal(visible, 1);
  time.advance(300000);
  assert.equal(visible, 0);
  const next = cache.begin();
  first("GUI", "old", "late");
  next("GUI", "new", "hello");
  assert.deepEqual(cache.snapshot().map(m => m.sender), ["new"]);
});
