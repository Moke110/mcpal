import { monotonicClock, ReadWindowScheduler } from "./read-window.ts";
import type { ReadRequest, ReadResult, WindowClock } from "./read-window.ts";
import type { ApiBackend, ApiCheck, ApiResult } from "./api-backend.ts";
import type { LocalBackend, LocalView } from "./local-backend.ts";
import { authorizeModelOutput } from "./model-protocol.ts";
import type { GameIntent, ModelObservation } from "./model-protocol.ts";
import type { LiveMinecraftState, MinecraftOperatorInput } from "./live-session.ts";
import { isStopRequest } from "./stop-request.js";

const observations = [
  { place: "草地 · 主世界", players: [{ name: "小明", distance: 5.4 }] },
  {
    place: "河边 · 主世界",
    players: [{ name: "小明", distance: 3.2 }, { name: "小雨", distance: 8.5 }],
  },
];

type Source = "gui" | "voice" | "minecraft";
type Message = {
  role: "operator" | "companion";
  source: Source;
  text: string;
  player?: string;
  publicReply?: boolean;
};
type Observation = ModelObservation;
type FrozenObservation = { simulated: Observation; live: Observation | null };
type ApiStatus = { kind: "idle" | "pending" } | ApiCheck;
type SessionOptions = {
  api?: ApiBackend | null;
  local?: LocalBackend | null;
  liveAction?: (intent: GameIntent) => void;
  invalidateLiveReplacement?: () => void;
  onReply?: (text: string) => void;
  onInputAccepted?: () => void;
  onSessionChange?: () => void;
  minecraftReplyRoute?: () => number | null;
  minecraftReply?: (route: number, text: string) => boolean;
};
type Input = { text: string; source: Source; timeout: boolean; live: boolean; replyRoute: number | null };
type Intent = Pick<Input, "source" | "live" | "replyRoute"> & { text: string; follow?: string; stop?: boolean };
export const scenarios = ["normal", "fast", "slow", "jitter", "duplicate"] as const;
type Scenario = (typeof scenarios)[number];

type SimulationView = {
  mode: "simulation";
  connection: "offline";
  backend: "simulated" | "api" | "local";
  localRequest: ApiStatus;
  localCancelled: number;
  api: {
    origin: string | null;
    test: ApiStatus;
    request: ApiStatus;
    live: boolean;
    cancelled: number;
    liveTask: Pick<LiveMinecraftState["task"], "phase" | "target"> | null;
  };
  observation: Observation;
  observationVersion: number;
  messages: Message[];
  reply: "idle" | "pending" | "ready" | "timeout" | "cancelled" | "rejected";
  task: { phase: "idle" | "following" | "cleaning" | "stopped"; target: string | null };
  playback: { phase: "idle" | "playing" | "finished" | "interrupted" };
  timeoutNext: boolean;
  scenario: Scenario;
};
export type SimulationState = SimulationView & {
  window: ReturnType<ReadWindowScheduler<Input, FrozenObservation, Intent>["snapshot"]>;
  local: LocalView | null;
};

export class SimulationSession {
  #state: SimulationView = {
    mode: "simulation",
    connection: "offline",
    backend: "simulated",
    localRequest: { kind: "idle" },
    localCancelled: 0,
    api: { origin: null, test: { kind: "idle" }, request: { kind: "idle" }, live: false, cancelled: 0, liveTask: null },
    observation: observations[0]!,
    observationVersion: 1,
    messages: [],
    reply: "idle",
    task: { phase: "idle", target: null },
    playback: { phase: "idle" },
    timeoutNext: false,
    scenario: "normal",
  };
  #playbackTimer?: () => void;
  #cleanupTimer?: () => void;
  readonly #backendTimers = new Set<() => void>();
  #replacement: string | null = null;
  readonly #publish: (state: SimulationState) => void;
  readonly #clock: WindowClock;
  readonly #scheduler: ReadWindowScheduler<Input, FrozenObservation, Intent>;
  readonly #unsubscribeLocalFailure?: () => void;

  readonly #options: SessionOptions;
  #liveObservation: Observation | null = null;
  #palPlay = false;
  #apiGeneration = 0;
  #disposed = false;

  constructor(publish: (state: SimulationState) => void, clock = monotonicClock, options: SessionOptions = {}) {
    this.#options = options;
    this.#state.api.origin = options.api?.origin ?? null;
    this.#publish = publish;
    this.#clock = clock;
    this.#scheduler = new ReadWindowScheduler({
      clock,
      start: (request, result) => {
        const live = request.inputs.at(-1)?.live;
        const selected = this.#state.backend;
        if (selected === "local" || (selected === "api" && (!live || this.#state.api.live))) {
          void this.#generate(request, result, selected);
        }
        else this.#simulate(request, result);
      },
      commit: (intent) => this.#commitIntent(intent),
      changed: () => this.#updateWindow(),
      abortSuperseded: () => this.#state.backend !== "simulated",
    });
    this.#unsubscribeLocalFailure = options.local?.onRuntimeFailure(() => {
      if (this.#state.backend !== "local") return;
      const window = this.#scheduler.snapshot();
      if (window.runningWindow === null && !window.queuedInputs && window.result !== "staged") return;
      this.#state.localRequest = { kind: "cancelled" };
      this.#scheduler.cancel();
    });
    this.#observe();
  }

  snapshot(): SimulationState {
    const state = structuredClone(this.#state);
    if (state.api.live || this.#palPlay) state.observation = structuredClone(this.#liveObservation ?? { place: "实机观测未知", players: [] });
    return { ...state, window: this.#scheduler.snapshot(), local: this.#options.local?.snapshot() ?? null };
  }

  advanceObservation(): void {
    this.#state.observationVersion++;
    const index = (this.#state.observationVersion - 1) % observations.length;
    this.#state.observation = observations[index]!;
    this.#observe();
    this.#emit();
  }

  async testApi(): Promise<void> {
    const backend = this.#options.api;
    if (!backend || this.#state.api.test.kind === "pending") return;
    this.#state.api.test = { kind: "pending" };
    this.#emit();
    this.#state.api.test = await backend.check();
    if (!this.#disposed) this.#emit();
  }

  setBackend(backend: "simulated" | "api" | "local"): void {
    if (backend === this.#state.backend || (backend === "api" && !this.#options.api) ||
      (backend === "local" && !this.#options.local)) return;
    if (this.#state.backend === "local") void this.#options.local?.stop();
    this.switchSession();
    this.#apiGeneration++;
    this.#state.backend = backend;
    this.#state.api.request = { kind: "idle" };
    this.#state.localRequest = { kind: "idle" };
    this.#state.api.live = false;
    this.#observe();
    this.#emit();
  }

  startDesktopChat(backend: SimulationState["backend"]): void {
    this.#requireBackend(backend);
    this.#state.messages = [];
    if (backend === this.#state.backend) {
      this.#state.api.live = false;
      this.switchSession();
      this.#observe();
      this.#emit();
    } else {
      this.setBackend(backend);
    }
  }

  #requireBackend(backend: SimulationState["backend"]): void {
    if (backend === "api" && !this.#options.api) throw new Error("请先配置 API 模型。");
    if (backend === "local" && !this.#options.local) throw new Error("请先配置本地模型。");
  }

  startPalPlay(backend: SimulationState["backend"], allowApi: boolean): void {
    if (backend === "api" && !allowApi) throw new Error("使用 API 模型陪玩需要授权发送游戏观测和对话。");
    this.startDesktopChat(backend);
    this.#palPlay = true;
    this.setApiLive(backend === "api");
    this.#emit();
  }

  endPalPlay(): void {
    if (!this.#palPlay) return;
    this.#palPlay = false;
    this.#state.api.live = false;
    this.switchSession();
    this.#emit();
  }

  setApiLive(live: boolean): void {
    if (this.#state.backend === "simulated" || live === this.#state.api.live) return;
    this.switchSession();
    this.#state.api.live = live;
    this.#observe();
    this.#emit();
  }

  startLocal(): Promise<void> | undefined {
    if (this.#state.backend === "local") return this.#options.local?.start();
  }

  stopLocal(): Promise<void> | undefined {
    if (this.#state.backend === "local") this.switchSession();
    return this.#options.local?.stop();
  }

  updateLiveObservation(observation: Observation | null, task: LiveMinecraftState["task"]): void {
    this.#state.api.liveTask = { phase: task.phase, target: task.target };
    const available = this.#liveObservation !== null;
    this.#liveObservation = observation;
    if (this.#disposed) return;
    if (available !== (observation !== null)) {
      this.#options.invalidateLiveReplacement?.();
      this.#options.onSessionChange?.();
      this.#apiGeneration++;
      this.#scheduler.switchSession();
      this.#state.api.request = { kind: "idle" };
      this.#state.localRequest = { kind: "idle" };
    }
    this.#observe();
    this.#emit();
  }

  #observe(): void {
    this.#scheduler.observe({ live: this.#liveObservation, simulated: this.#state.observation });
  }

  setTimeoutNext(enabled: boolean): void {
    this.#state.timeoutNext = enabled;
    this.#emit();
  }

  setScenario(scenario: Scenario): void {
    this.#state.scenario = scenario;
    this.#emit();
  }

  switchSession(): void {
    this.#options.invalidateLiveReplacement?.();
    this.#options.onSessionChange?.();
    this.#interruptPlayback();
    this.#beginCleanup(null);
    this.#scheduler.switchSession();
  }

  nextInputWindow(): number {
    return this.#scheduler.nextInputWindow();
  }

  submitText(text: string, source: Exclude<Source, "minecraft">): number | null {
    const live = this.#palPlay || this.#state.api.live;
    return this.#submit(text, source, live, live ? this.#options.minecraftReplyRoute?.() ?? null : null);
  }

  submitMinecraft({ text, player, replyRoute }: MinecraftOperatorInput): void {
    if (!this.#liveObservation) return;
    this.#submit(text, "minecraft", true, replyRoute, player);
  }

  #submit(text: string, source: Source, live: boolean, replyRoute: number | null, player?: string): number | null {
    const input = text.trim();
    if (!input || input.length > 500) return null;
    this.#options.onInputAccepted?.();
    this.#options.invalidateLiveReplacement?.();
    this.#interruptPlayback();
    this.#replacement = null;
    this.#addMessage({ role: "operator", source, text: input, ...(player ? { player } : {}) });
    if (isStopRequest(input)) {
      this.stop();
      if (source === "minecraft") this.#reply("已请求停止。", source, replyRoute);
      return null;
    }
    const timeout = this.#state.timeoutNext;
    this.#state.timeoutNext = false;
    const resolved = player
      ? input.replace(/^((?:请\s*)?(?:改成跟随|改为跟随|改跟|跟随|跟着)\s*)我(?=[。！!\s]*$)/u,
        (_match, command: string) => command + player)
      : input;
    return this.#scheduler.submit({ text: resolved, source, timeout, live, replyRoute });
  }

  stop(): void {
    this.#interruptPlayback();
    // Revoking locally authorized actions does not require permission to send observations to a model.
    this.#options.liveAction?.({ kind: "stop" });
    this.#beginCleanup(null);
    this.#scheduler.cancel();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribeLocalFailure?.();
    this.#scheduler.dispose();
    this.#playbackTimer?.();
    this.#cleanupTimer?.();
    for (const cancel of this.#backendTimers) cancel();
    this.#backendTimers.clear();
  }

  async #generate(
    request: ReadRequest<Input, FrozenObservation>, result: ReadResult<Intent>, selected: "api" | "local",
  ): Promise<void> {
    const local = selected === "local";
    const backend = local ? this.#options.local : this.#options.api;
    const input = request.inputs.at(-1);
    if (!backend || !input) {
      result.reject();
      return;
    }
    const generation = ++this.#apiGeneration;
    const setStatus = (status: ApiStatus) => {
      if (local) this.#state.localRequest = status;
      else this.#state.api.request = status;
    };
    setStatus({ kind: "pending" });
    request.signal.addEventListener("abort", () => {
      if (this.#disposed) return;
      if (local) this.#state.localCancelled++;
      else this.#state.api.cancelled++;
      if (generation === this.#apiGeneration) setStatus({ kind: "cancelled" });
      this.#emit();
    }, { once: true });
    const observation = (input.live ? request.observation?.live : request.observation?.simulated) ?? null;
    const response: ApiResult = await backend.generate({
      inputs: request.inputs.filter(({ live }) => live === input.live).map(({ text }) => text), observation,
    }, request.signal, result.first);
    if (this.#disposed || request.signal.aborted || generation !== this.#apiGeneration) return;
    setStatus(response.kind === "http" ? response : { kind: response.kind });
    if (response.kind !== "completed") {
      result.reject();
      return;
    }
    const { intent, reply } = authorizeModelOutput(response.output, input.text);
    result.complete({
      source: input.source, text: reply, live: input.live, replyRoute: input.replyRoute,
      follow: intent.kind === "follow" ? intent.target : undefined, stop: intent.kind === "stop",
    });
  }

  #simulate(request: ReadRequest<Input, FrozenObservation>, result: ReadResult<Intent>): void {
    const input = request.inputs.at(-1);
    const observation = input?.live ? request.observation?.live : request.observation?.simulated;
    if (!input || !observation) {
      result.reject();
      return;
    }
    const { scenario } = this.#state;
    const delays = { normal: 450, fast: 160, slow: 525, jitter: request.window % 2 ? 540 : 175, duplicate: 190 };
    const delay = input.timeout ? 2100 : delays[scenario];
    const intent = this.#resolve(input, observation);
    this.#scheduleBackend(Math.min(100, delay), () => result.first());
    // Keep these synthetic callbacks even after abort so the GUI can demonstrate stale results.
    this.#scheduleBackend(delay, () => result.complete(intent));
    if (scenario === "duplicate") this.#scheduleBackend(delay + 950, () => result.complete(intent));
  }

  #scheduleBackend(delay: number, callback: () => void): void {
    const cancel = this.#clock.after(delay, () => {
      this.#backendTimers.delete(cancel);
      callback();
    });
    this.#backendTimers.add(cancel);
  }

  #resolve(input: Input, observation: Observation): Intent {
    const { place, players } = observation;
    const { source, live, replyRoute } = input;
    const context = { source, live, replyRoute };
    const follow = /^(?:请\s*)?(?:改成跟随|改为跟随|改跟|跟随|跟着)\s*(.+?)[。！!\s]*$/u.exec(input.text);
    const target = follow?.[1];
    if (target) {
      if (!players.some(({ name }) => target === name)) {
        return { ...context, text: `目前观测不到${target}，跟随任务保持原状。` };
      }
      return { ...context, text: `正在跟随${target}。`, follow: target };
    }
    if (live && /生命|血量|health/iu.test(input.text)) {
      const { health } = observation;
      return { ...context, text: health == null ? "当前生命值未知。" : `当前生命值为 ${health}。` };
    }
    if (live && /背包|物品|inventory/iu.test(input.text)) {
      const { inventory } = observation;
      const items = inventory?.map(({ name, count }) => `${name} × ${count}`).join("、");
      return { ...context, text: inventory == null ? "当前背包未知。" : items ? `当前背包有 ${items}。` : "当前背包为空。" };
    }
    const nearby = players.map(({ name, distance }) => `${name}（${distance} 格）`).join("、");
    return { ...context, text: nearby ? `我在${place}，附近有${nearby}。` : `我在${place}，附近没有可见玩家。` };
  }

  #commitIntent({ follow: target, text, source, stop, live, replyRoute }: Intent): void {
    if (live) {
      if (stop) this.#options.liveAction?.({ kind: "stop" });
      if (target && this.#liveObservation?.players.some(({ name }) => name === target)) {
        this.#options.liveAction?.({ kind: "follow", target });
      } else if (target) {
        text = "当前游戏观测中已看不到该玩家。";
      }
      this.#reply(text, source, replyRoute);
      return;
    }
    if (stop) this.#beginCleanup(null);
    if (target) {
      if (this.#state.task.phase === "cleaning" || (
        this.#state.task.phase === "following" && this.#state.task.target !== target
      )) {
        this.#beginCleanup(target);
        text = `清理当前跟随任务后，我会跟随${target}。`;
      } else {
        this.#state.task = { phase: "following", target };
      }
    }
    this.#reply(text, source);
  }

  #updateWindow(): void {
    const labels = {
      idle: "idle", reading: "pending", running: "pending", staged: "pending", committed: "ready", timeout: "timeout",
      cancelled: "cancelled", rejected: "rejected",
    } as const;
    this.#state.reply = labels[this.#scheduler.snapshot().result];
    this.#emit();
  }

  #beginCleanup(nextTarget: string | null): void {
    const { phase, target } = this.#state.task;
    this.#replacement = nextTarget;
    if (phase === "cleaning") return;
    if (phase !== "following") {
      this.#state.task = { phase: "stopped", target: null };
      return;
    }
    this.#state.task = { phase: "cleaning", target };
    this.#cleanupTimer = this.#clock.after(800, () => {
      this.#state.task = this.#replacement === null
        ? { phase: "stopped", target: null }
        : { phase: "following", target: this.#replacement };
      this.#replacement = null;
      this.#emit();
    });
  }

  #reply(text: string, source: Source, replyRoute: number | null = null): void {
    const publicReply = replyRoute !== null && (this.#options.minecraftReply?.(replyRoute, text) ?? false);
    this.#addMessage({ role: "companion", source, text, ...(source === "minecraft" || publicReply ? { publicReply } : {}) });
    this.#options.onReply?.(text);
    this.#state.reply = "ready";
    this.#state.playback = { phase: "playing" };
    this.#playbackTimer = this.#clock.after(2600, () => {
      this.#state.playback = { phase: "finished" };
      this.#emit();
    });
  }

  #addMessage(message: Message): void {
    this.#state.messages.push(message);
    if (this.#state.messages.length > 200) this.#state.messages.shift();
  }

  #interruptPlayback(): void {
    if (this.#state.playback.phase !== "playing") return;
    this.#playbackTimer?.();
    this.#state.playback = { phase: "interrupted" };
  }

  #emit(): void {
    this.#publish(this.snapshot());
  }
}
