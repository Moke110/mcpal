import type { ApiResult } from "./api-backend.ts";
import type { ModelInput } from "./model-protocol.ts";

export const dedicatedLimitBytes = 6_000_000_000;
export const memoryIntervalMs = 100;
type Phase = "off" | "starting" | "warming" | "ready" | "reclaiming" | "failed" | "over-budget";
export type LocalModel = { model: string; settings: string; fixture: boolean };
export type MemorySample = { dedicatedBytes: number; sharedBytes: number };
export type LocalView = LocalModel & {
  phase: Phase;
  dedicatedPeakBytes: number | null;
  sharedPeakBytes: number | null;
  samples: number;
  longestSampleGapMs: number | null;
  samplesBelowLimit: boolean | null;
  reason: string | null;
};
export type LocalRuntime = {
  ready(signal: AbortSignal): Promise<void>;
  generate(input: ModelInput, signal: AbortSignal, first: () => void): Promise<ApiResult>;
  readMemory(): Promise<MemorySample | null>;
  stop(): Promise<void> | void;
};
type Launch = (signal: AbortSignal) => Promise<LocalRuntime>;
type Run = {
  controller: AbortController;
  runtime?: LocalRuntime;
  ended?: Promise<void>;
  sample?: Promise<boolean>;
  lastSampleAt?: number;
};

export class LocalBackend {
  #view: LocalView;
  #run?: Run;
  #reclaiming?: Promise<void>;
  #unconfirmedExit = false;
  readonly #launch: Launch;
  readonly #publish: () => void;

  constructor(
    model: LocalModel,
    launch: Launch,
    publish: () => void = () => {},
  ) {
    this.#launch = launch;
    this.#publish = publish;
    this.#view = { ...model, phase: "off", dedicatedPeakBytes: null, sharedPeakBytes: null,
      samples: 0, longestSampleGapMs: null, samplesBelowLimit: null, reason: null };
  }

  snapshot(): LocalView {
    return { ...this.#view };
  }

  start(): Promise<void> {
    if (this.#run || this.#reclaiming || this.#unconfirmedExit) return Promise.resolve();
    const run: Run = { controller: new AbortController() };
    this.#run = run;
    Object.assign(this.#view, { phase: "starting", dedicatedPeakBytes: null, sharedPeakBytes: null,
      samples: 0, longestSampleGapMs: null, samplesBelowLimit: null, reason: null });
    this.#publish();
    run.ended = this.#start(run);
    return run.ended.then(() => this.#reclaiming);
  }

  async #start(run: Run): Promise<void> {
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(90_000)]);
    try {
      run.runtime = await this.#launch(signal);
      signal.throwIfAborted();
      void this.#monitor(run);
      await run.runtime.ready(signal);
      signal.throwIfAborted();
      this.#view.phase = "warming";
      this.#publish();
      // Do not use the operator's input for warm-up.
      const warm = await run.runtime.generate({ inputs: ["状态如何？"], observation: {
        place: "测试场景", players: [],
      } }, signal, () => {});
      signal.throwIfAborted();
      if (warm.kind !== "completed") throw new Error("预热未返回完整、可校验结果");
      if (!(await this.#freshSample(run)) || !this.#view.dedicatedPeakBytes) throw new Error("没有可用的独显测量");
      signal.throwIfAborted();
      this.#view.phase = "ready";
      this.#view.samplesBelowLimit = true;
      this.#publish();
    } catch (error) {
      if (this.#run === run) this.#retire(run, "failed", error instanceof Error ? error.message : "本地模型启动失败");
    }
  }

  async generate(input: ModelInput, signal: AbortSignal, first: () => void): Promise<ApiResult> {
    const run = this.#run;
    if (!run?.runtime || this.#view.phase !== "ready") return { kind: "invalid" };
    const combined = AbortSignal.any([signal, run.controller.signal]);
    if (combined.aborted) return { kind: "cancelled" };
    try {
      const result = await run.runtime.generate(input, combined, first);
      if (combined.aborted) return { kind: "cancelled" };
      if (result.kind === "completed" && !(await this.#freshSample(run))) return { kind: "invalid" };
      return combined.aborted ? { kind: "cancelled" } : result;
    } catch {
      return { kind: combined.aborted ? "cancelled" : "network" };
    }
  }

  stop(): Promise<void> {
    if (this.#run) this.#retire(this.#run, "off", null);
    return this.#reclaiming ?? Promise.resolve();
  }

  async #monitor(run: Run): Promise<void> {
    while (this.#run === run) {
      await this.#sample(run);
      if (this.#run !== run) break;
      if (this.#view.fixture) await new Promise<void>((resolve) => setTimeout(resolve, memoryIntervalMs).unref());
    }
  }

  #sample(run: Run): Promise<boolean> {
    if (!run.sample) run.sample = this.#read(run).finally(() => { run.sample = undefined; });
    return run.sample;
  }

  async #freshSample(run: Run): Promise<boolean> {
    await run.sample;
    return this.#run === run && this.#sample(run);
  }

  async #read(run: Run): Promise<boolean> {
    try {
      const sample = await run.runtime!.readMemory();
      if (this.#run !== run) return false;
      const { dedicatedBytes, sharedBytes } = sample ?? { dedicatedBytes: 0, sharedBytes: 0 };
      if (!validBytes(dedicatedBytes) || !validBytes(sharedBytes) ||
        ((!sample || !dedicatedBytes) && this.#view.phase !== "starting")) throw new Error();
      const now = performance.now();
      if (run.lastSampleAt !== undefined) {
        this.#view.longestSampleGapMs = Math.max(this.#view.longestSampleGapMs ?? 0, Math.round(now - run.lastSampleAt));
      }
      run.lastSampleAt = now;
      this.#view.samples++;
      this.#view.dedicatedPeakBytes = Math.max(this.#view.dedicatedPeakBytes ?? 0, dedicatedBytes);
      this.#view.sharedPeakBytes = Math.max(this.#view.sharedPeakBytes ?? 0, sharedBytes);
      if (dedicatedBytes >= dedicatedLimitBytes) {
        this.#view.samplesBelowLimit = false;
        this.#retire(run, "over-budget", "主模型进程独显样本达到显存上限");
        return false;
      }
      this.#publish();
      return true;
    } catch {
      if (this.#run === run) this.#retire(run, "failed", "主模型进程显存采样不可用");
      return false;
    }
  }

  #retire(run: Run, phase: Phase, reason: string | null): void {
    this.#run = undefined;
    this.#view.phase = "reclaiming";
    this.#view.reason = reason;
    if (phase === "failed") this.#view.samplesBelowLimit = null;
    run.controller.abort();
    // Startup may still be handing the process back. Keep selection locked until reclamation.
    this.#reclaiming = (async () => {
      await run.ended;
      await run.runtime?.stop();
    })().catch(() => {
      phase = "failed";
      this.#unconfirmedExit = true;
      this.#view.reason = "无法确认模型进程已退出";
      this.#view.samplesBelowLimit = null;
    }).finally(() => {
      this.#reclaiming = undefined;
      this.#view.phase = phase;
      this.#publish();
    });
    this.#publish();
  }
}

function validBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
