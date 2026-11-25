import { SentenceStream } from "./sentence-stream.ts";
import type { RecognizerEvents, StreamingRecognizer } from "./voice-input.ts";

export type CaptureEvents = { ready(): void; pcm(data: Uint8Array): void; lost(): void };
type Capture = (path: string, events: CaptureEvents) => () => Promise<void>;

export class ApplicationAudio {
  #stream?: SentenceStream;
  #retry?: ReturnType<typeof setTimeout>;
  #stopping = false;
  #stopCapture?: () => Promise<void>;
  #capture: Capture;
  #recognize: (events: RecognizerEvents) => StreamingRecognizer;
  #status: (state: string) => void;

  constructor(capture: Capture, recognize: (events: RecognizerEvents) => StreamingRecognizer, status: (state: string) => void) {
    this.#capture = capture;
    this.#recognize = recognize;
    this.#status = status;
  }

  start(path: string, append: (text: string) => void) {
    this.#stopping = false;
    let connected = false;
    const failed = (message: string) => {
      if (!connected || this.#stopping) return;
      this.#status(message);
      clearTimeout(this.#retry);
      this.#retry = setTimeout(listen, 2000);
    };
    const listen = () => {
      if (!connected || this.#stopping) return;
      try {
        this.#stream = new SentenceStream(this.#recognize, append, failed);
        this.#status("监听中");
      } catch (error) { failed(String(error)); }
    };
    this.#status("正在连接");
    this.#stopCapture = this.#capture(path, {
      ready: () => {
        connected = true;
        listen();
      },
      pcm: data => this.#stream?.write(data),
      lost: () => {
        connected = false;
        clearTimeout(this.#retry);
        this.#stream?.disconnect();
        this.#stream = undefined;
        this.#status("应用不可用，等待恢复");
      },
    });
  }

  async stop() {
    const stop = this.#stopCapture;
    if (!stop) return;
    this.#stopping = true;
    clearTimeout(this.#retry);
    this.#stopCapture = undefined;
    await stop();
    await this.#stream?.finish();
    this.#stream = undefined;
    this.#status("未监听");
  }
}
