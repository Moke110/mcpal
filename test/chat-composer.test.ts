import assert from "node:assert/strict";
import { test } from "node:test";
import { bindChatComposer } from "../src/gui/chat-composer.js";

test("chat composer sends on Enter and leaves line breaks and IME confirmation to the input", () => {
  const input = new EventTarget();
  let submissions = 0;
  bindChatComposer(input, { requestSubmit: () => { submissions++; } });

  function press(properties: Record<string, unknown> = {}) {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Enter" }, properties);
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }

  assert.equal(press({ shiftKey: true }), false);
  assert.equal(press({ isComposing: true }), false);
  assert.equal(press({ keyCode: 229 }), false);
  input.dispatchEvent(new Event("compositionstart"));
  assert.equal(press(), false);
  input.dispatchEvent(new Event("compositionend"));
  assert.equal(submissions, 0);
  assert.equal(press(), true);
  assert.equal(press({ repeat: true }), true);
  assert.equal(submissions, 1);
});
