export type Synthesizer = (text: string, signal: AbortSignal) => Promise<Uint8Array>;
export type SpeechEvent =
  | { id: number; type: "queued" | "cancel" }
  | { id: number; type: "wave"; elapsed: number; wave: Uint8Array }
  | { id: number; type: "error"; detail: string };

type SpeechOptions = {
  synthesize: Synthesizer;
  publish: (event: SpeechEvent) => void;
  now?: () => number;
};

export class SpeechOutput {
  readonly #options: SpeechOptions;
  readonly #now: () => number;
  #enabled = false;
  #next = 0;
  #active?: { id: number; abort: AbortController };

  constructor(options: SpeechOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.cancel();
  }

  reply(text: string): void {
    if (this.#enabled) this.#start(text);
  }

  preview(): void {
    this.#start("你好，我是你的 Minecraft 伙伴。这是本机语音试听。");
  }

  settled(id: number): void {
    if (this.#active?.id === id) this.#active = undefined;
  }

  cancel(): void {
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    active.abort.abort();
    this.#options.publish({ type: "cancel", id: active.id });
  }

  dispose(): void {
    this.#active?.abort.abort();
    this.#active = undefined;
    this.#enabled = false;
  }

  #start(text: string): void {
    this.cancel();
    const active = { id: ++this.#next, abort: new AbortController() };
    const { id, abort } = active;
    this.#active = active;
    const started = this.#now();
    this.#options.publish({ type: "queued", id });
    void this.#render(text, id, abort.signal, started);
  }

  async #render(text: string, id: number, signal: AbortSignal, started: number): Promise<void> {
    try {
      const wave = await this.#options.synthesize(text, signal);
      if (this.#active?.id !== id) return;
      this.#options.publish({ type: "wave", id, wave, elapsed: this.#now() - started });
    } catch (error) {
      if (this.#active?.id !== id) return;
      this.#active = undefined;
      const detail = error instanceof Error ? error.message : "语音合成失败";
      this.#options.publish({ type: "error", id, detail });
    }
  }
}
