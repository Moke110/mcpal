import { readConfig } from "../config.ts";
import type { connect, PlayerChat } from "../client.ts";
import type { Observation } from "../perception.ts";
import type { TaskResult } from "../tasks.ts";

type Connection = Pick<ReturnType<typeof connect>, "io" | "close" | "closed" | "chat"> &
  Partial<Pick<ReturnType<typeof connect>, "readView">>;
type OpenConnection = (...args: Parameters<typeof connect>) => Connection;
type TaskPhase = "idle" | "pending" | "following" | "stopping" | "released";

export type LiveMinecraftState = {
  phase: "disconnected" | "connecting" | "positioning" | "ready" | "disconnecting" | "failed";
  observation: Observation | null;
  authPrompt: string | null;
  reason: string | null;
  task: { phase: TaskPhase; target: string | null; result: TaskResult | null };
};
type LiveMinecraftSnapshot = LiveMinecraftState & { active: boolean; publicChat: boolean };
export type MinecraftOperatorInput = PlayerChat & { replyRoute: number | null };

const idleTask = { phase: "idle", target: null, result: null } as const;

function connectionConfig(settings: unknown, observeOnly: boolean) {
  if (typeof settings !== "object" || settings === null) throw new Error("请填写 Minecraft 连接设置。");
  const { host, port, username, auth, offlineControl } = settings as Record<string, unknown>;
  if (typeof host !== "string" || host.length > 255 || typeof port !== "string" ||
    typeof username !== "string" || username.length > 320 || (auth !== "offline" && auth !== "microsoft") ||
    typeof offlineControl !== "boolean") {
    throw new Error("Minecraft 连接设置无效。");
  }
  return readConfig({
    MC_HOST: host, MC_PORT: port, MC_USERNAME: username, MC_AUTH: auth,
    MC_CONTROL: String(!observeOnly), MC_ALLOW_OFFLINE_CONTROL: String(offlineControl),
    MC_SNAPSHOT_INTERVAL_MS: "1000",
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LiveMinecraftSession {
  #state: LiveMinecraftState = {
    phase: "disconnected", observation: null, authPrompt: null, reason: null, task: idleTask,
  };
  #connection?: Connection;
  #generation = 0;
  #chatEpoch = 0;
  #publicChat = false;
  #replacement: string | null = null;
  readonly #publish: (state: LiveMinecraftSnapshot) => void;
  readonly #openConnection: OpenConnection;
  readonly #receiveChat?: (message: MinecraftOperatorInput) => void;

  constructor(publish: (state: LiveMinecraftSnapshot) => void, openConnection: OpenConnection,
    receiveChat?: (message: MinecraftOperatorInput) => void) {
    this.#publish = publish;
    this.#openConnection = openConnection;
    this.#receiveChat = receiveChat;
  }

  snapshot(): LiveMinecraftSnapshot {
    return structuredClone({ ...this.#state, active: this.#connection !== undefined, publicChat: this.#publicChat });
  }

  readView() {
    return this.#state.phase === "ready" ? this.#connection?.readView?.() ?? null : null;
  }

  open(settings: unknown, observeOnly = false): void {
    if (this.#connection) return;
    const generation = ++this.#generation;
    this.#state = { phase: "connecting", observation: null, authPrompt: null, reason: null, task: idleTask };
    this.#emit();
    try {
      const config = connectionConfig(settings, observeOnly);
      const connection = this.#openConnection(config, (event, fields) => {
        if (generation === this.#generation) this.#report(event, fields);
      }, (prompt) => {
        if (generation !== this.#generation || this.#state.phase !== "connecting") return;
        this.#state.authPrompt = prompt;
        this.#emit();
      }, {
        onPlayerChat: ({ player, text }) => {
          if (generation !== this.#generation || this.#state.phase !== "ready") return;
          const observation = this.#connection?.io.read();
          if (!observation) return;
          this.#report("snapshot", { observation });
          this.#receiveChat?.({ player, text, replyRoute: this.chatReplyRoute() });
        },
      });
      this.#connection = connection;
      void connection.closed.then(({ reason, requested }) => {
        if (this.#connection !== connection) return;
        this.#generation++;
        this.#chatEpoch++;
        this.#publicChat = false;
        this.#connection = undefined;
        const failed = this.#state.phase === "failed" || (!requested && this.#state.phase === "connecting");
        this.#state.phase = failed ? "failed" : "disconnected";
        this.#state.observation = null;
        this.#state.authPrompt = null;
        this.#state.reason ??= requested ? null : reason;
        this.#emit();
      });
    } catch (error) {
      this.#state.phase = "failed";
      this.#state.reason = message(error);
      this.#emit();
    }
  }

  disconnect(): void {
    if (!this.#connection || this.#state.phase === "disconnecting") return;
    this.#replacement = null;
    this.#state.phase = "disconnecting";
    this.#chatEpoch++;
    this.#publicChat = false;
    this.#state.authPrompt = null;
    this.#state.observation = null;
    if (this.#state.task.phase === "following" || this.#state.task.phase === "pending") {
      this.#state.task.phase = "stopping";
    }
    this.#connection.close();
    this.#emit();
  }

  setChatRoute(enabled: boolean): void {
    if (this.#state.phase !== "ready" || this.#publicChat === enabled) return;
    this.#chatEpoch++;
    this.#publicChat = enabled;
    this.#emit();
  }

  chatReplyRoute(): number | null {
    return this.#publicChat && this.#state.phase === "ready" ? this.#chatEpoch : null;
  }

  sendChatReply(route: number | null, text: string): boolean {
    return route !== null && route === this.chatReplyRoute() && (this.#connection?.chat.send(text) ?? false);
  }

  follow(target: unknown): void {
    const connection = this.#connection;
    if (!connection || this.#state.phase !== "ready" ||
      (this.#state.task.phase !== "idle" && this.#state.task.phase !== "released")) return;
    if (typeof target !== "string" || !connection.io.read()?.nearby.players.some((player) => player.username === target)) {
      this.#state.reason = "当前游戏观测中看不到该玩家。";
      this.#emit();
      return;
    }
    this.#state.reason = null;
    this.#state.task = { phase: "pending", target, result: null };
    this.#emit();
    void connection.io.execute({ kind: "follow", player: target }).then((result) => {
      if (this.#connection !== connection) return;
      const next = this.#replacement;
      this.#replacement = null;
      this.#state.task = { phase: "released", target, result };
      this.#emit();
      if (next && result.state === "cancelled") this.follow(next);
    });
  }

  replaceFollow(target: string): void {
    if (this.#state.phase !== "ready") return;
    const task = this.#state.task;
    if (task.phase === "idle" || task.phase === "released") {
      this.follow(target);
      return;
    }
    if (task.phase !== "stopping" && task.target === target) return;
    this.stop();
    this.#replacement = target;
  }

  invalidateReplacement(): void {
    this.#replacement = null;
  }

  stop(): void {
    this.invalidateReplacement();
    if (this.#state.task.phase !== "following" && this.#state.task.phase !== "pending") return;
    this.#state.task.phase = "stopping";
    this.#connection?.io.stop();
    this.#emit();
  }

  #report(event: string, fields?: Record<string, unknown>): void {
    if (this.#state.phase === "disconnecting") return;
    switch (event) {
      case "login":
      case "world_unavailable":
        this.#chatEpoch++;
        this.invalidateReplacement();
        this.#state.phase = "positioning";
        this.#state.observation = null;
        this.#state.authPrompt = null;
        if (this.#state.task.phase === "following" || this.#state.task.phase === "pending") {
          this.#state.task.phase = "stopping";
        }
        break;
      case "snapshot":
        if (this.#state.phase === "failed" || !fields?.observation) return;
        this.#state.observation = fields.observation as Observation;
        this.#state.phase = "ready";
        break;
      case "task_started":
        if (this.#state.task.phase !== "pending") return;
        this.#state.task.phase = "following";
        break;
      case "error":
      case "kicked": {
        this.#chatEpoch++;
        this.#publicChat = false;
        this.#state.phase = "failed";
        this.#state.reason = message(fields?.message ?? fields?.reason ?? event);
        this.#state.observation = null;
        this.#state.authPrompt = null;
        break;
      }
      default:
        return;
    }
    this.#emit();
  }

  #emit(): void {
    this.#publish(this.snapshot());
  }
}
