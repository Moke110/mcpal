import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("selecting another Pal hides the active microphone state", () => {
  const elements = new Map<string, EventTarget & { textContent?: string }>();
  let start!: (event: object) => void;
  runInNewContext(readFileSync(new URL("../src/gui/sensor-microphone.js", import.meta.url), "utf8"), {
    document: { querySelector(id: string) {
      if (!elements.has(id)) elements.set(id, new EventTarget());
      return elements.get(id);
    } },
    window: { palProfiles: { onMicrophone: (cb: typeof start) => { start = cb; } } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(() => {}), enumerateDevices: () => new Promise(() => {}) } },
  });
  const select = (id: string) => elements.get("#pal-operation")!.dispatchEvent(
    new CustomEvent("pal-operation", { detail: { profile: { id } } }));
  select("A");
  start({ action: "start", profileId: "A", token: 1, deviceId: "USB" });
  assert.equal(elements.get("#mic-state")!.textContent, "正在连接");
  select("B");
  assert.equal(elements.get("#mic-state")!.textContent, "未监听");
  select("A");
  assert.equal(elements.get("#mic-state")!.textContent, "正在连接");
});
