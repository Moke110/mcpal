import { setTimeout as delay } from "node:timers/promises";
import { LocalBackend } from "./local-backend.ts";
import { parseModelOutput } from "./model-protocol.ts";

export function openLocalFixture(publish: () => void, overBudget: boolean): LocalBackend {
  let count = 0;
  return new LocalBackend({ model: "模拟 GGUF", settings: "模拟推理和显存遥测", fixture: true }, async () => ({
    async ready(signal) { await delay(100, undefined, { signal }); },
    async generate(input, signal, first) {
      count++;
      await delay(30, undefined, { signal });
      first();
      await delay(input.inputs.at(-1)?.includes("慢速") ? 1800 : 130, undefined, { signal });
      const text = input.inputs.at(-1) ?? "";
      const target = input.observation?.players.find(({ name }) => text.endsWith(name))?.name;
      const raw = text.startsWith("跟随") && target
        ? { reply: `准备跟随${target}。`, intent: { kind: "follow", target } }
        : { reply: /状态|在哪/u.test(text) ? `当前位置：${input.observation?.place ?? "未知"}。` : "请明确说出请求。",
          intent: { kind: "none" } };
      const output = parseModelOutput(JSON.stringify(raw), input.observation);
      return output ? { kind: "completed", output } : { kind: "invalid" };
    },
    async readMemory() {
      return { dedicatedBytes: overBudget && count ? 6_000_000_000 : 3_450_000_000, sharedBytes: 451_000_000 };
    },
    stop() {},
  }), publish);
}
