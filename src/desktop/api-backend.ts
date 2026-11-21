import { modelInstructions, parseModelOutput } from "./model-protocol.ts";
import type { ModelInput, ModelOutput } from "./model-protocol.ts";

type ApiFailure = { kind: "http"; status: number } |
  { kind: "network" | "cancelled" | "invalid" | "truncated" | "missing-model" };
export type ApiCheck = { kind: "completed" } | ApiFailure;
export type ApiResult = { kind: "completed"; output: ModelOutput } | ApiFailure;

export type ApiBackend = {
  origin: string;
  check(): Promise<ApiCheck>;
  generate(input: ModelInput, signal: AbortSignal, first: () => void): Promise<ApiResult>;
};

export function createApiBackend(env: NodeJS.ProcessEnv): ApiBackend | null {
  const key = env.MCPAL_API_KEY?.trim();
  const model = env.MCPAL_API_MODEL?.trim();
  const baseUrl = env.MCPAL_API_BASE_URL?.trim();
  if (!key || !model || !baseUrl) return null;
  let base: URL;
  try {
    base = new URL(baseUrl.replace(/\/+$/u, "") + "/");
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(loopback && base.protocol === "http:")) ||
    base.username || base.password || base.search || base.hash) return null;
  const headers = { authorization: "Bearer " + key };
  return {
    origin: base.origin,
    async check() {
      try {
        const response = await fetch(new URL("models", base), {
          headers, redirect: "error", signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return { kind: "http", status: response.status };
        }
        const payload = await response.json() as { data?: { id?: string }[] };
        return Array.isArray(payload?.data) && payload.data.some((item) => item?.id === model)
          ? { kind: "completed" } : { kind: "missing-model" };
      } catch {
        return { kind: "network" };
      }
    },
    async generate(input, signal, first) {
      try {
        const response = await fetch(new URL("chat/completions", base), {
          method: "POST", redirect: "error", signal,
          headers: { ...headers, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            model, stream: true,
            messages: [
              { role: "system", content: modelInstructions },
              { role: "user", content: JSON.stringify(input, (_field, value: unknown) =>
                typeof value === "string" ? value.replaceAll(key, "[redacted]") : value) },
            ],
          }),
        });
        if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
          void response.body?.cancel().catch(() => {});
          return response.ok ? { kind: "invalid" } : { kind: "http", status: response.status };
        }
        return await readCompletion(response.body, input, signal, first, key);
      } catch {
        return { kind: signal.aborted ? "cancelled" : "network" };
      }
    },
  };
}

async function readCompletion(
  body: ReadableStream<Uint8Array>, input: ModelInput, signal: AbortSignal, first: () => void, key: string,
): Promise<ApiResult> {
  let pending = "";
  let content = "";
  let finished = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of body) {
    signal.throwIfAborted();
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 64_000) return { kind: "invalid" };
    let boundary = /\r?\n\r?\n/u.exec(pending);
    while (boundary) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/u.exec(pending);
      const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, "")).join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        if (!finished) return { kind: "truncated" };
        signal.throwIfAborted();
        const output = parseModelOutput(content, input.observation);
        if (!output || output.reply.includes(key) ||
          (output.intent.kind === "follow" && output.intent.target.includes(key))) return { kind: "invalid" };
        return { kind: "completed", output };
      }
      let event: { error?: unknown; choices?: { index: number; delta?: { content?: string; tool_calls?: unknown; refusal?: string }; finish_reason?: string | null }[] };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        return { kind: "invalid" };
      }
      if (!event || event.error || !Array.isArray(event.choices)) return { kind: "invalid" };
      if (!event.choices.length) continue;
      const choice = event.choices[0];
      if (finished || event.choices.length !== 1 || choice?.index !== 0 ||
        choice.delta?.tool_calls || choice.delta?.refusal) return { kind: "invalid" };
      if (choice.delta?.content != null) {
        if (typeof choice.delta.content !== "string") return { kind: "invalid" };
        if (!content && choice.delta.content) first();
        content += choice.delta.content;
        if (content.length > 8000) return { kind: "invalid" };
      }
      if (choice.finish_reason) {
        if (choice.finish_reason !== "stop") return { kind: "truncated" };
        finished = true;
      }
    }
  }
  return { kind: "truncated" };
}
