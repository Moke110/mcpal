import { SentenceStream } from "./sentence-stream.ts";
import type { MicrophoneSource } from "../gui/pal-profiles.ts";
import type { RecognizerEvents, StreamingRecognizer } from "./voice-input.ts";

type Capture = { token: number; source: MicrophoneSource; append: (text: string) => void;
  stream?: SentenceStream; flushed?: () => void };

export class Microphone {
  #next = 0;
  #capture?: Capture;
  #open: (events: RecognizerEvents) => StreamingRecognizer;
  #send: (event: object) => void;

  constructor(open: (events: RecognizerEvents) => StreamingRecognizer, send: (event: object) => void) {
    this.#open = open;
    this.#send = send;
  }
  get enabled() { return !!this.#capture; }

  start(source: MicrophoneSource, append: (text: string) => void) {
    this.#capture = { token: ++this.#next, source, append };
    this.#send({ action: "start", token: this.#next, deviceId: source.deviceId });
  }

  ready(token: unknown) {
    const capture = this.#capture;
    if (!capture || capture.token !== token || capture.flushed || capture.stream) return false;
    capture.stream = new SentenceStream(this.#open, capture.append, message => {
      this.lost(token);
      this.#send({ action: "failure", token, message });
    });
    return true;
  }

  audio(token: unknown, pcm: unknown) {
    if (this.#capture?.token === token && pcm instanceof Uint8Array && pcm.length <= 3200)
      this.#capture?.stream?.write(pcm);
  }

  lost(token: unknown) {
    const capture = this.#capture;
    if (!capture || capture.token !== token) return;
    capture.stream?.disconnect();
    delete capture.stream;
    capture.flushed?.();
  }

  flushed(token: unknown) {
    if (this.#capture?.token === token) this.#capture?.flushed?.();
  }

  async stop() {
    const capture = this.#capture;
    if (!capture) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const acknowledged = new Promise<void>(resolve => {
      capture.flushed = resolve;
      timeout = setTimeout(resolve, 1200);
    });
    this.#send({ action: "stop", token: capture.token });
    await acknowledged;
    clearTimeout(timeout);
    await capture.stream?.finish();
    this.#capture = undefined;
  }
}
