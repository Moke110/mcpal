import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadWindowScheduler, type ReadRequest, type ReadResult } from "../src/processor/read-window.ts";

import { fakeClock } from "./fake-clock.ts";

function setup() {
  const time = fakeClock();
  const runs: { request: ReadRequest<string, string>; result: ReadResult<string> }[] = [];
  const commits: string[] = [];
  const scheduler = new ReadWindowScheduler<string, string, string>({
    clock: time.clock,
    start(request, result) { runs.push({ request, result }); },
    commit(result) { commits.push(result); },
    changed() {},
  });
  return { ...time, runs, commits, scheduler };
}

test("读取截止冻结有序输入及最新游戏观测，提前完成只在下一窗口提交", () => {
  const { advance, runs, commits, scheduler } = setup();
  scheduler.submit("状态追问");
  scheduler.observe("河边");
  scheduler.submit("跟随小明");
  advance(400);
  scheduler.observe("草地");
  assert.deepEqual(runs[0]?.request.inputs, ["状态追问", "跟随小明"]);
  assert.equal(runs[0]?.request.observation, "河边");
  assert.equal(runs[0]?.request.submitAt, 800);
  advance(600);
  runs[0]!.result.first();
  runs[0]!.result.complete("跟随小明");
  assert.deepEqual(commits, []);
  assert.equal(scheduler.snapshot().result, "staged");
  advance(800);
  assert.deepEqual(commits, ["跟随小明"]);
  scheduler.dispose();
});

test("只用完整有效结果的近期耗时调整后续读取窗口，切换保留已承诺边界", () => {
  const { advance, runs, scheduler } = setup();
  scheduler.submit("状态追问");
  advance(400);
  advance(430);
  runs[0]!.result.first();
  advance(1175);
  runs[0]!.result.complete("状态");
  assert.equal(scheduler.snapshot().readMs, 400);
  assert.equal(scheduler.snapshot().nextReadMs, 325);
  assert.equal(scheduler.snapshot().firstMs, 30);
  assert.equal(scheduler.snapshot().p95Ms, 775);
  advance(1600);
  assert.equal(scheduler.snapshot().readUntil, 1925);
  scheduler.switchSession();
  assert.equal(scheduler.snapshot().readUntil, 1925);
  assert.equal(scheduler.snapshot().nextReadMs, 400);
  advance(2400);
  assert.equal(scheduler.snapshot().readMs, 400);
  scheduler.dispose();
});

test("过期、停止、乱序和重复结果不会提交动作，统计包含取消与超时", () => {
  const { advance, runs, commits, scheduler } = setup();
  scheduler.submit("跟随小明");
  advance(1200);
  assert.equal(scheduler.snapshot().result, "timeout");
  scheduler.submit("跟随小雨");
  advance(2000);
  scheduler.switchSession();
  scheduler.submit("现在在哪？");
  advance(2800);
  runs[2]!.result.complete("草地");
  runs[2]!.result.complete("重复回复");
  runs[1]!.result.complete("跟随小雨");
  runs[0]!.result.complete("跟随小明");
  advance(3200);
  assert.deepEqual(commits, ["草地"]);
  assert.equal(scheduler.snapshot().samples, 3);
  assert.equal(scheduler.snapshot().successful, 1);
  assert.equal(scheduler.snapshot().timeout, 1);
  assert.equal(scheduler.snapshot().cancelled, 1);
  assert.equal(scheduler.snapshot().discarded, 3);
  scheduler.dispose();
});

test("拥塞只保留在途和最新待发批次，未处理输入跨窗口保序", () => {
  const { advance, runs, commits, scheduler } = setup();
  scheduler.submit("预热");
  advance(1190);
  runs[0]!.result.complete("预热回复");
  advance(1600);
  scheduler.submit("正在生成");
  advance(1910);
  assert.equal(runs.length, 2);
  scheduler.submit("第一条待发");
  scheduler.observe("草地");
  advance(2710);
  assert.equal(runs.length, 2);
  assert.equal(scheduler.snapshot().queuedInputs, 1);
  scheduler.submit("第二条待发");
  scheduler.observe("河边");
  advance(2760);
  runs[1]!.result.complete("已失效回复");
  advance(3510);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[2]!.request.inputs, ["第一条待发", "第二条待发"]);
  assert.equal(runs[2]!.request.observation, "河边");
  assert.deepEqual(commits, ["预热回复"]);
  scheduler.dispose();
});
