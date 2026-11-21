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

export type SimulationState = {
  mode: "simulation";
  connection: "offline";
  backend: "simulated";
  observation: (typeof observations)[number];
  observationVersion: number;
  messages: Message[];
  reply: "idle" | "pending" | "ready" | "timeout" | "cancelled";
  task: { phase: "idle" | "following" | "cleaning" | "stopped"; target: string | null };
  playback: { phase: "idle" | "playing" | "finished" | "interrupted" };
  timeoutNext: boolean;
};

export class SimulationSession {
  #state: SimulationState = {
    mode: "simulation",
    connection: "offline",
    backend: "simulated",
    observation: observations[0]!,
    observationVersion: 1,
    messages: [],
    reply: "idle",
    task: { phase: "idle", target: null },
    playback: { phase: "idle" },
    timeoutNext: false,
  };
  #backendTimer?: ReturnType<typeof setTimeout>;
  #deadline?: ReturnType<typeof setTimeout>;
  #playbackTimer?: ReturnType<typeof setTimeout>;
  #cleanupTimer?: ReturnType<typeof setTimeout>;
  #replacement: string | null = null;
  readonly #publish: (state: SimulationState) => void;

  constructor(publish: (state: SimulationState) => void) {
    this.#publish = publish;
  }

  snapshot(): SimulationState {
    return structuredClone(this.#state);
  }

  advanceObservation(): void {
    this.#state.observationVersion++;
    const index = (this.#state.observationVersion - 1) % observations.length;
    this.#state.observation = observations[index]!;
    this.#emit();
  }

  setTimeoutNext(enabled: boolean): void {
    this.#state.timeoutNext = enabled;
    this.#emit();
  }

  submitText(text: string, source: Source): void {
    const input = text.trim();
    if (!input || input.length > 500) return;
    this.#clearPendingReply();
    this.#interruptPlayback();
    this.#replacement = null;
    this.#addMessage({ role: "operator", source, text: input });
    if (/^(?:请\s*)?停止(?:跟随)?[。！!\s]*$/u.test(input)) {
      this.stop();
      return;
    }
    this.#state.reply = "pending";
    const backendDelay = this.#state.timeoutNext ? 2600 : 450;
    this.#state.timeoutNext = false;
    this.#deadline = setTimeout(() => {
      this.#state.reply = "timeout";
      this.#emit();
    }, 1600);
    this.#backendTimer = setTimeout(() => {
      if (this.#state.reply !== "pending") return;
      clearTimeout(this.#deadline);
      this.#reply(this.#resolve(input), source);
    }, backendDelay);
    this.#emit();
  }

  stop(): void {
    this.#clearPendingReply();
    this.#interruptPlayback();
    this.#state.reply = "cancelled";
    this.#beginCleanup(null);
    this.#emit();
  }

  dispose(): void {
    this.#clearPendingReply();
    clearTimeout(this.#playbackTimer);
    clearTimeout(this.#cleanupTimer);
  }

  #resolve(input: string): string {
    const { place, players } = this.#state.observation;
    const follow = /^(?:请\s*)?(?:改成跟随|改为跟随|改跟|跟随|跟着)\s*(.+?)[。！!\s]*$/u.exec(input);
    const target = follow?.[1];
    if (target) {
      if (!players.some(({ name }) => target === name)) return `目前观测不到${target}，跟随任务保持原状。`;
      if (this.#state.task.phase === "cleaning" || (
        this.#state.task.phase === "following" && this.#state.task.target !== target
      )) {
        this.#beginCleanup(target);
        return `清理当前跟随任务后，我会跟随${target}。`;
      }
      this.#state.task = { phase: "following", target };
      return `正在跟随${target}。`;
    }
    const nearby = players.map(({ name, distance }) => `${name}（${distance} 格）`).join("、");
    return `我在${place}，附近有${nearby}。`;
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
    this.#cleanupTimer = setTimeout(() => {
      this.#state.task = this.#replacement === null
        ? { phase: "stopped", target: null }
        : { phase: "following", target: this.#replacement };
      this.#replacement = null;
      this.#emit();
    }, 800);
  }

  #reply(text: string, source: Source): void {
    this.#addMessage({ role: "companion", source, text });
    this.#state.reply = "ready";
    this.#state.playback = { phase: "playing" };
    this.#playbackTimer = setTimeout(() => {
      this.#state.playback = { phase: "finished" };
      this.#emit();
    }, 2600);
    this.#emit();
  }

  #addMessage(message: Message): void {
    this.#state.messages.push(message);
    if (this.#state.messages.length > 200) this.#state.messages.shift();
  }

  #clearPendingReply(): void {
    clearTimeout(this.#backendTimer);
    clearTimeout(this.#deadline);
  }

  #interruptPlayback(): void {
    if (this.#state.playback.phase !== "playing") return;
    clearTimeout(this.#playbackTimer);
    this.#state.playback = { phase: "interrupted" };
  }

  #emit(): void {
    this.#publish(this.snapshot());
  }
}
