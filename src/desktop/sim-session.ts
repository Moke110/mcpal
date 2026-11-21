import { monotonicClock, ReadWindowScheduler } from "./read-window.ts";
import type { ReadRequest, ReadResult, WindowClock } from "./read-window.ts";
import type { ApiBackend, ApiCheck, ApiResult } from "./api-backend.ts";
import { authorizeModelOutput } from "./model-protocol.ts";
import type { GameIntent, ModelObservation } from "./model-protocol.ts";
import type { LiveMinecraftState } from "./live-session.ts";

const observations = [
  { place: "草地 · 主世界", players: [{ name: "小明", distance: 5.4 }] },
  {
    place: "河边 · 主世界",
    players: [{ name: "小明", distance: 3.2 }, { name: "小雨", distance: 8.5 }],
  },
];

type Source = "gui" | "voice";
type Message = {
  role: "operator" | "companion";
  source: Source;
  text: string;
};
type Observation = ModelObservation;
type FrozenObservation = { value: Observation | null; live: boolean };
type ApiStatus = { kind: "idle" | "pending" } | ApiCheck;
type SessionOptions = {
  api?: ApiBackend | null;
  liveAction?: (intent: GameIntent) => void;
  invalidateLiveReplacement?: () => void;
};
type Input = { text: string; source: Source; timeout: boolean };
type Intent = { source: Source; text: string; follow?: string; stop?: boolean; live?: boolean };
export const scenarios = ["normal", "fast", "slow", "jitter", "duplicate"] as const;
type Scenario = (typeof scenarios)[number];

type SimulationView = {
  mode: "simulation";
  connection: "offline";
  backend: "simulated" | "api";
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
};

export class SimulationSession {
  #state: SimulationView = {
    mode: "simulation",
    connection: "offline",
    backend: "simulated",
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

  readonly #options: SessionOptions;
  #liveObservation: Observation | null = null;
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
        if (this.#state.backend === "api") void this.#generate(request, result);
        else this.#simulate(request, result);
      },
      commit: (intent) => this.#commitIntent(intent),
      changed: () => this.#updateWindow(),
      abortSuperseded: () => this.#state.backend === "api",
    });
    this.#observe();
  }

  snapshot(): SimulationState {
    const state = structuredClone(this.#state);
    if (state.api.live) state.observation = structuredClone(this.#liveObservation ?? { place: "实机观测未知", players: [] });
    return { ...state, window: this.#scheduler.snapshot() };
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

  setBackend(backend: "simulated" | "api"): void {
    if (backend === this.#state.backend || (backend === "api" && !this.#options.api)) return;
    this.switchSession();
    this.#apiGeneration++;
    this.#state.backend = backend;
    this.#state.api.request = { kind: "idle" };
    if (backend === "simulated") this.#state.api.live = false;
    this.#observe();
    this.#emit();
  }

  setApiLive(live: boolean): void {
    if (this.#state.backend !== "api" || live === this.#state.api.live) return;
    this.switchSession();
    this.#state.api.live = live;
    this.#observe();
    this.#emit();
  }

  updateLiveObservation(observation: Observation | null, task: LiveMinecraftState["task"]): void {
    this.#state.api.liveTask = { phase: task.phase, target: task.target };
    const available = this.#liveObservation !== null;
    this.#liveObservation = observation;
    if (this.#disposed || !this.#state.api.live) return;
    if (available !== (observation !== null)) {
      this.#options.invalidateLiveReplacement?.();
      this.#apiGeneration++;
      this.#scheduler.switchSession();
      this.#state.api.request = { kind: "idle" };
    }
    this.#observe();
    this.#emit();
  }

  #observe(): void {
    const live = this.#state.api.live;
    this.#scheduler.observe({ live, value: live ? this.#liveObservation : this.#state.observation });
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
    this.#interruptPlayback();
    this.#beginCleanup(null);
    this.#scheduler.switchSession();
  }

  submitText(text: string, source: Source): void {
    const input = text.trim();
    if (!input || input.length > 500) return;
    this.#options.invalidateLiveReplacement?.();
    this.#interruptPlayback();
    this.#replacement = null;
    this.#addMessage({ role: "operator", source, text: input });
    if (/^(?:请\s*)?停止(?:跟随)?[。！!\s]*$/u.test(input)) {
      this.stop();
      return;
    }
    const timeout = this.#state.timeoutNext;
    this.#state.timeoutNext = false;
    this.#scheduler.submit({ text: input, source, timeout });
  }

  stop(): void {
    this.#interruptPlayback();
    if (this.#state.api.live) this.#options.liveAction?.({ kind: "stop" });
    this.#beginCleanup(null);
    this.#scheduler.cancel();
  }

  dispose(): void {
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#playbackTimer?.();
    this.#cleanupTimer?.();
    for (const cancel of this.#backendTimers) cancel();
    this.#backendTimers.clear();
  }

  async #generate(request: ReadRequest<Input, FrozenObservation>, result: ReadResult<Intent>): Promise<void> {
    const backend = this.#options.api;
    const input = request.inputs.at(-1);
    if (!backend || !input) {
      result.reject();
      return;
    }
    const generation = ++this.#apiGeneration;
    this.#state.api.request = { kind: "pending" };
    request.signal.addEventListener("abort", () => {
      if (this.#disposed) return;
      this.#state.api.cancelled++;
      if (generation === this.#apiGeneration) this.#state.api.request = { kind: "cancelled" };
      this.#emit();
    }, { once: true });
    const observation = request.observation?.value ?? null;
    const response: ApiResult = await backend.generate({
      inputs: request.inputs.map(({ text }) => text), observation,
    }, request.signal, result.first);
    if (this.#disposed || request.signal.aborted || generation !== this.#apiGeneration) return;
    this.#state.api.request = response.kind === "http" ? response : { kind: response.kind };
    if (response.kind !== "completed") {
      result.reject();
      return;
    }
    const { intent, reply } = authorizeModelOutput(response.output, input.text);
    result.complete({
      source: input.source, text: reply, live: request.observation?.live,
      follow: intent.kind === "follow" ? intent.target : undefined, stop: intent.kind === "stop",
    });
  }

  #simulate(request: ReadRequest<Input, FrozenObservation>, result: ReadResult<Intent>): void {
    const input = request.inputs.at(-1);
    const observation = request.observation?.value;
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
    const follow = /^(?:请\s*)?(?:改成跟随|改为跟随|改跟|跟随|跟着)\s*(.+?)[。！!\s]*$/u.exec(input.text);
    const target = follow?.[1];
    if (target) {
      if (!players.some(({ name }) => target === name)) {
        return { source: input.source, text: `目前观测不到${target}，跟随任务保持原状。` };
      }
      return { source: input.source, text: `正在跟随${target}。`, follow: target };
    }
    const nearby = players.map(({ name, distance }) => `${name}（${distance} 格）`).join("、");
    return { source: input.source, text: `我在${place}，附近有${nearby}。` };
  }

  #commitIntent({ follow: target, text, source, stop, live }: Intent): void {
    if (live) {
      if (stop) this.#options.liveAction?.({ kind: "stop" });
      if (target && this.#liveObservation?.players.some(({ name }) => name === target)) {
        this.#options.liveAction?.({ kind: "follow", target });
      } else if (target) {
        text = "当前游戏观测中已看不到该玩家。";
      }
      this.#reply(text, source);
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

  #reply(text: string, source: Source): void {
    this.#addMessage({ role: "companion", source, text });
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
