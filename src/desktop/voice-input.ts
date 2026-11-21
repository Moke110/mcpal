export type RecognizerEvents = {
  partial(text: string): void;
  final(text: string): void;
  failure(message: string): void;
};

export type StreamingRecognizer = {
  write(pcm: Uint8Array): void;
  end(): void;
  cancel(): void;
};

type State = {
  enabled: boolean;
  phase: "idle" | "recording" | "processing" | "final" | "empty" | "cancelled" | "error";
  partial: string;
  final: string;
  message: string;
  lastVoiceAt: number | null;
  releasedAt: number | null;
  finalAt: number | null;
  window: number | null;
  late: boolean;
};

type Options = {
  open: (events: RecognizerEvents, fixture: string) => StreamingRecognizer;
  publish: (state: State) => void;
  interrupt: () => void;
  now: () => number;
  window: () => number;
  submit: (text: string) => number | null;
};

const initial: State = {
  enabled: false, phase: "idle", partial: "", final: "", message: "",
  lastVoiceAt: null, releasedAt: null, finalAt: null, window: null, late: false,
};

export class VoiceInput {
  readonly #options: Options;
  #state = { ...initial };
  #nextId = 0;
  #active?: {
    id: number;
    stream?: StreamingRecognizer;
    bytes: number;
    releaseWindow: number | null;
    deadline?: ReturnType<typeof setTimeout>;
  };

  constructor(options: Options) {
    this.#options = options;
  }

  snapshot(): State {
    return { ...this.#state };
  }

  setEnabled(enabled: boolean): void {
    this.#state.enabled = enabled;
    if (!enabled) this.cancel();
    this.#publish();
  }

  start(fixture = ""): number | null {
    if (!this.#state.enabled) return null;
    this.#retire();
    const id = ++this.#nextId;
    this.#active = { id, bytes: 0, releaseWindow: null };
    this.#state = { ...initial, enabled: true, phase: "recording" };
    this.#options.interrupt();
    this.#publish();
    try {
      const stream = this.#options.open({
        partial: (text) => {
          if (this.#active?.id !== id || this.#state.phase !== "recording") return;
          this.#state.partial = text.slice(0, 500);
          this.#publish();
        },
        final: (text) => this.#finish(id, text),
        failure: (message) => this.fail(id, message),
      }, fixture);
      if (this.#active?.id === id) this.#active.stream = stream;
      else stream.cancel();
    } catch {
      this.fail(id, "本机识别器启动失败。");
    }
    return this.#active?.id === id ? id : null;
  }

  write(id: number, pcm: Uint8Array): void {
    const active = this.#active;
    if (!active || active.id !== id || this.#state.phase !== "recording") return;
    if (!pcm.byteLength || pcm.byteLength > 8192 || pcm.byteLength % 2) return;
    active.bytes += pcm.byteLength;
    if (active.bytes > 32_000 * 30) {
      this.fail(id, "单次录音最长 30 秒，请重新按住说话。");
      return;
    }
    active.stream?.write(pcm);
  }

  release(id: number, lastVoiceAt: number | null, releasedAt: number): void {
    const active = this.#active;
    if (!active || active.id !== id || this.#state.phase !== "recording") return;
    const now = this.#options.now();
    this.#state.releasedAt = Number.isFinite(releasedAt) && releasedAt >= now - 5000 && releasedAt <= now + 100
      ? releasedAt : now;
    this.#state.lastVoiceAt = lastVoiceAt !== null && Number.isFinite(lastVoiceAt) &&
      lastVoiceAt <= this.#state.releasedAt && lastVoiceAt >= now - 31_000 ? lastVoiceAt : null;
    this.#state.phase = "processing";
    active.releaseWindow = this.#options.window();
    if (active.bytes === 0) {
      this.#finish(id, "");
      return;
    }
    active.deadline = setTimeout(() => this.fail(id, "ASR 最终文字逾期，已丢弃。"), 5000);
    active.deadline.unref();
    this.#publish();
    active.stream?.end();
  }

  cancel(id?: number): void {
    if (!this.#active || (id !== undefined && id !== this.#active.id)) return;
    this.#retire();
    this.#state.phase = "cancelled";
    this.#state.partial = "";
    this.#publish();
  }

  fail(id: number, message: string): void {
    if (this.#active?.id !== id) return;
    this.#retire();
    this.#state.phase = "error";
    this.#state.partial = "";
    this.#state.message = message;
    this.#publish();
  }

  #finish(id: number, value: string): void {
    const active = this.#active;
    if (!active || active.id !== id || this.#state.phase !== "processing") return;
    this.#retire();
    const final = value.trim();
    this.#state.finalAt = this.#options.now();
    this.#state.partial = "";
    if (!final || final.length > 500) {
      this.#state.phase = final ? "error" : "empty";
      this.#state.message = final ? "识别文字超出长度限制。" : "";
    } else {
      this.#state.phase = "final";
      this.#state.final = final;
      this.#state.window = this.#options.submit(final);
      this.#state.late = this.#state.window !== null && active.releaseWindow !== this.#state.window;
    }
    this.#publish();
  }

  #retire(): void {
    const active = this.#active;
    this.#active = undefined;
    clearTimeout(active?.deadline);
    active?.stream?.cancel();
  }

  #publish(): void {
    this.#options.publish(this.snapshot());
  }
}
