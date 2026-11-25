import { monotonicClock, type WindowClock } from "../processor/read-window.ts";

export interface SensorMessage {
  source: string;
  sender: string;
  text: string;
  arrivedAt: number;
}

export class MessageCache {
  #messages: SensorMessage[] = [];
  #generation = 0;
  #cancel?: () => void;
  #publish: (messages: SensorMessage[]) => void;
  #clock: WindowClock;

  constructor(publish: (messages: SensorMessage[]) => void, clock: WindowClock = {
    now: () => performance.timeOrigin + performance.now(), after: monotonicClock.after,
  }) {
    this.#publish = publish;
    this.#clock = clock;
  }

  snapshot() {
    this.#expire();
    return this.#messages.slice();
  }

  begin() {
    this.end();
    const generation = this.#generation;
    return (source: string, sender: string, text: string) => {
      if (generation !== this.#generation || !text.trim()) return;
      this.#messages.push({ source, sender, text, arrivedAt: this.#clock.now() });
      this.#refresh();
    };
  }

  end() {
    this.#generation++;
    this.#cancel?.();
    this.#messages = [];
    this.#publish([]);
  }

  #expire() {
    const oldest = this.#clock.now() - 300_000;
    this.#messages = this.#messages.filter(message => message.arrivedAt > oldest);
  }

  #refresh() {
    this.#cancel?.();
    const current = this.snapshot();
    this.#publish(current);
    const first = current[0];
    if (first) this.#cancel = this.#clock.after(Math.max(1, Math.ceil(first.arrivedAt + 300_000 - this.#clock.now())), () => this.#refresh());
  }
}
