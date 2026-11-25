import type { RecognizerEvents, StreamingRecognizer } from "./voice-input.ts";

export class SentenceStream {
  #recognizer: StreamingRecognizer;
  #closed = false;
  #finishing = false;
  #timeout?: ReturnType<typeof setTimeout>;
  #resolve!: () => void;
  #done = new Promise<void>(resolve => { this.#resolve = resolve; });

  constructor(open: (events: RecognizerEvents) => StreamingRecognizer,
    append: (sentence: string) => void, failure: (message: string) => void) {
    const commit = (text: string) => { if (!this.#closed && text.trim()) append(text.trim()); };
    this.#recognizer = open({
      partial() {}, segment: commit,
      final: text => { clearTimeout(this.#timeout); commit(text); this.#closed = true; this.#resolve(); },
      failure: message => {
        if (this.#closed) return;
        this.disconnect();
        failure(message);
      },
    });
  }

  write(pcm: Uint8Array) {
    if (!this.#closed && !this.#finishing) this.#recognizer.write(pcm);
  }

  finish() {
    if (!this.#closed && !this.#finishing) {
      this.#finishing = true;
      this.#timeout = setTimeout(() => this.disconnect(), 5000);
      this.#recognizer.end();
    }
    return this.#done;
  }

  disconnect() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timeout);
    this.#recognizer.cancel();
    this.#resolve();
  }
}
