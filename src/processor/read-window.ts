export type WindowClock = {
  now(): number;
  after(delay: number, callback: () => void): () => void;
};

export const monotonicClock: WindowClock = {
  now: () => performance.now(),
  after(delay, callback) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export type ReadRequest<Input, Observation> = {
  readonly window: number;
  readonly session: number;
  readonly inputs: readonly Input[];
  readonly observation: Observation | undefined;
  readonly submitAt: number;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
};

export type ReadResult<Output> = {
  first(): void;
  /** The backend calls this only after validating a complete result. */
  complete(output: Output): void;
  reject(): void;
};

type Window = { id: number; start: number; readUntil: number; end: number; frozen: boolean };
type Batch<Input, Observation> = Omit<ReadRequest<Input, Observation>, "signal"> & { revision: number };
type Running<Input, Observation> = {
  batch: Batch<Input, Observation>;
  controller: AbortController;
  startedAt: number;
  firstMs: number | null;
  cancelled: boolean;
};
type Candidate<Input, Observation, Output> = {
  run: Running<Input, Observation>;
  output: Output;
  completeMs: number;
};

type Options<Input, Observation, Output> = {
  clock?: WindowClock;
  start: (request: ReadRequest<Input, Observation>, result: ReadResult<Output>) => void;
  commit: (output: Output) => void;
  changed: () => void;
  abortSuperseded?: () => boolean;
};

type Status = "idle" | "reading" | "running" | "staged" | "committed" | "timeout" | "cancelled" | "rejected";
// The rhythm and next-window submission slot stay fixed. Ending the read earlier gives the backend more time.
const windowMs = 800;
const submissionMs = 400;
const defaultReadMs = 400;

function percentile(samples: readonly number[], fraction: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

export class ReadWindowScheduler<Input, Observation, Output> {
  readonly #options: Options<Input, Observation, Output>;
  readonly #clock: WindowClock;
  #window: Window;
  #session = 1;
  #revision = 0;
  #inputs: Input[] = [];
  #observation: Observation | undefined;
  #queued?: Batch<Input, Observation>;
  #running?: Running<Input, Observation>;
  #candidate?: Candidate<Input, Observation, Output>;
  #status: Status = "idle";
  #firstMs: number | null = null;
  #completeMs: number | null = null;
  #totals = { successful: 0, timeout: 0, cancelled: 0, rejected: 0, discarded: 0 };
  #recent: number[] = [];
  #cancelWake?: () => void;
  #disposed = false;

  constructor(options: Options<Input, Observation, Output>) {
    this.#options = options;
    this.#clock = options.clock ?? monotonicClock;
    this.#window = this.#openWindow(1, this.#clock.now());
    this.#wake();
  }

  snapshot() {
    const { id, start, readUntil, end, frozen } = this.#window;
    const { successful, timeout, cancelled, rejected } = this.#totals;
    return {
      id, start, readUntil, end, frozen, session: this.#session,
      readMs: readUntil - start,
      nextReadMs: this.#readLength(),
      result: this.#status,
      firstMs: this.#firstMs,
      completeMs: this.#completeMs,
      runningWindow: this.#running?.batch.window ?? null,
      queuedInputs: (this.#queued?.inputs.length ?? 0) + this.#inputs.length,
      ...this.#totals,
      samples: successful + timeout + cancelled + rejected,
      p50Ms: percentile(this.#recent, 0.5),
      p95Ms: percentile(this.#recent, 0.95),
    };
  }

  observe(observation: Observation): void {
    // An observation arriving after the cutoff belongs to a later read window.
    this.#advance();
    this.#observation = structuredClone(observation);
    this.#wake();
  }

  nextInputWindow(): number {
    this.#advance();
    return this.#window.id + Number(this.#window.frozen);
  }

  submit(input: Input): number {
    this.#advance();
    this.#revision++;
    this.#invalidateResult();
    this.#inputs.push(structuredClone(input));
    if (this.#options.abortSuperseded?.() && this.#running?.cancelled) {
      const invalidated = this.#running;
      this.#running = undefined;
      invalidated.controller.abort();
    }
    this.#status = "reading";
    this.#firstMs = null;
    this.#completeMs = null;
    const window = this.#window.id + Number(this.#window.frozen);
    this.#notify();
    return window;
  }

  cancel(): void {
    this.#cancel(false);
  }

  switchSession(): void {
    this.#cancel(true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelWake?.();
    const running = this.#running;
    this.#running = undefined;
    this.#candidate = undefined;
    running?.controller.abort();
  }

  #cancel(switchSession: boolean): void {
    this.#advance();
    this.#revision++;
    if (switchSession) {
      this.#session++;
      this.#recent = [];
      this.#firstMs = null;
      this.#completeMs = null;
    }
    this.#invalidateResult();
    if (this.#queued || this.#inputs.length) this.#totals.cancelled++;
    this.#queued = undefined;
    this.#inputs = [];
    const running = this.#running;
    this.#running = undefined;
    running?.controller.abort();
    this.#status = "cancelled";
    this.#notify();
  }

  #invalidateResult(): void {
    if (this.#running && !this.#running.cancelled) {
      this.#running.cancelled = true;
      this.#totals.cancelled++;
    }
    if (this.#candidate) {
      this.#candidate = undefined;
      this.#totals.cancelled++;
    }
  }

  #readLength(): number {
    const recent = percentile(this.#recent, 0.75);
    if (recent === null) return defaultReadMs;
    return Math.max(100, Math.min(650, Math.round(windowMs + submissionMs - 100 - recent)));
  }

  #openWindow(id: number, start: number): Window {
    return { id, start, readUntil: start + this.#readLength(), end: start + windowMs, frozen: false };
  }

  #freeze(): void {
    this.#window.frozen = true;
    if (!this.#inputs.length) return;
    const { id, end } = this.#window;
    this.#queued = {
      window: id,
      session: this.#session,
      revision: this.#revision,
      inputs: [...(this.#queued?.inputs ?? []), ...this.#inputs],
      observation: this.#observation,
      submitAt: end,
      expiresAt: end + submissionMs,
    };
    this.#inputs = [];
  }

  #advance(): void {
    const now = this.#clock.now();
    if (this.#running && this.#running.batch.expiresAt <= now) {
      const expired = this.#running;
      this.#running = undefined;
      if (!expired.cancelled) this.#expire(expired.batch);
      expired.controller.abort();
    }
    if (this.#candidate && this.#candidate.run.batch.expiresAt <= now) {
      this.#expire(this.#candidate.run.batch);
      this.#candidate = undefined;
    }
    if (this.#queued && this.#queued.expiresAt <= now) {
      this.#expire(this.#queued);
      if (this.#inputs.length) this.#inputs = [...this.#queued.inputs, ...this.#inputs];
      this.#queued = undefined;
    }
    while (now >= this.#window.readUntil) {
      if (!this.#window.frozen) this.#freeze();
      if (now < this.#window.end) break;
      this.#window = this.#openWindow(this.#window.id + 1, this.#window.end);
    }
  }

  #expire(batch: Batch<Input, Observation>): void {
    this.#totals.timeout++;
    if (batch.revision === this.#revision) this.#status = "timeout";
  }

  #dispatch(): void {
    if (this.#running || !this.#queued) return;
    const batch = this.#queued;
    if (batch.expiresAt <= this.#clock.now()) {
      this.#queued = undefined;
      this.#expire(batch);
      return;
    }
    // Wait for the newer input to freeze so the backend sees one ordered batch.
    if (this.#inputs.length) return;
    this.#queued = undefined;
    const controller = new AbortController();
    const run = { batch, controller, startedAt: this.#clock.now(), firstMs: null, cancelled: false };
    this.#running = run;
    this.#status = "running";
    const { revision: _revision, ...request } = batch;
    try {
      this.#options.start({ ...structuredClone(request), signal: controller.signal }, {
        first: () => this.#first(run),
        complete: (output) => this.#complete(run, { output }),
        reject: () => this.#complete(run, null),
      });
    } catch {
      this.#complete(run, null);
    }
  }

  #first(run: Running<Input, Observation>): void {
    if (this.#disposed) return;
    this.#advance();
    if (this.#running === run && !run.cancelled && run.firstMs === null) {
      run.firstMs = this.#clock.now() - run.startedAt;
      this.#firstMs = run.firstMs;
    }
    this.#notify();
  }

  #complete(run: Running<Input, Observation>, result: { output: Output } | null): void {
    if (this.#disposed) return;
    this.#advance();
    if (this.#running !== run || run.cancelled || run.batch.revision !== this.#revision) {
      if (this.#running === run) this.#running = undefined;
      this.#totals.discarded++;
    } else {
      this.#running = undefined;
      if (result) {
        this.#completeMs = this.#clock.now() - run.startedAt;
        this.#candidate = { run, output: result.output, completeMs: this.#completeMs };
        this.#status = "staged";
      } else {
        this.#totals.rejected++;
        this.#status = "rejected";
      }
    }
    this.#notify();
  }

  #commit(): void {
    const candidate = this.#candidate;
    const now = this.#clock.now();
    if (!candidate || now < candidate.run.batch.submitAt) return;
    this.#candidate = undefined;
    if (now >= candidate.run.batch.expiresAt) {
      this.#expire(candidate.run.batch);
      return;
    }
    this.#recent.push(candidate.completeMs);
    if (this.#recent.length > 32) this.#recent.shift();
    this.#totals.successful++;
    this.#status = "committed";
    this.#options.commit(candidate.output);
  }

  #notify(): void {
    this.#commit();
    this.#dispatch();
    this.#wake();
    this.#options.changed();
  }

  #wake(): void {
    this.#cancelWake?.();
    if (this.#disposed) return;
    const boundary = this.#window.frozen ? this.#window.end : this.#window.readUntil;
    const next = Math.min(boundary, this.#running?.batch.expiresAt ?? Infinity, this.#queued?.expiresAt ?? Infinity,
      this.#candidate?.run.batch.submitAt ?? Infinity);
    this.#cancelWake = this.#clock.after(Math.max(0, next - this.#clock.now()), () => {
      this.#advance();
      this.#notify();
    });
  }
}
