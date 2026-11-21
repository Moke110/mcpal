import { openPlaybackReference } from "./speech-renderer.js";
import { isStopRequest } from "./stop-request.js";

const find = (id) => document.getElementById(id);
const bridge = window.companion;
const enable = find("open-mic-enable");
const permission = find("asr-enable");
const ptt = find("asr-record");
const source = find("asr-device");
const scenario = find("open-mic-scenario");
const config = await bridge.asrConfig();
const now = () => performance.timeOrigin + performance.now();
const clock = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false,
});
let graph;
let reading;
let liveTask;
let simTask;

function metric(name, time, text = "", start = null) {
  const elapsed = start === null || time === null ? "" : ` · +${Math.max(0, Math.round(time - start))} ms`;
  find("open-mic-" + name).textContent = time === null ? "—" : clock.format(time) + elapsed + text;
}

function availability() {
  enable.disabled = !permission.checked || !(config.configured || config.openMicFixture) ||
    (config.fixture && !config.openMicFixture);
}

function close(reason = "未启用") {
  const current = graph;
  graph = undefined;
  enable.checked = false;
  ptt.disabled = !permission.checked;
  find("open-mic-status").textContent = reason;
  find("open-mic-reference").textContent = "—";
  void bridge.enableOpenMic(false);
  if (!current) return;
  clearInterval(current.watch);
  current.stream?.getTracks().forEach((track) => track.stop());
  current.input?.disconnect();
  current.echo?.disconnect();
  current.user?.disconnect();
  if (current.echo) current.reference.disconnect(current.echo);
  if (current.node) {
    current.node.port.close();
    current.node.disconnect();
    try { current.reference.disconnect(current.node); } catch { /* The stopped graph is already disconnected. */ }
  }
  if (reading?.id != null) void bridge.cancelAsr(reading.id);
  reading = undefined;
}

function fail(current, reason) {
  if (graph === current) close(reason + " · 已回到按键或文字");
}

function soundFixture(current) {
  if (!config.openMicFixture || current.sampleSent || scenario.value === "echo") return;
  current.sampleSent = true;
  if (scenario.value === "error") {
    current.reference.disconnect(current.node);
    return;
  }
  const user = current.context.createOscillator();
  const level = current.context.createGain();
  user.frequency.value = 213;
  level.gain.value = 0.16;
  user.connect(level).connect(current.input);
  const at = current.context.currentTime;
  user.start(at);
  user.stop(at + 0.34);
  current.user = user;
}

async function listen() {
  const current = { lastHeartbeat: now(), sampleSent: false };
  graph = current;
  ptt.disabled = true;
  stopRequest = null;
  for (const name of ["start", "cut", "final", "stop"]) metric(name, null);
  find("asr-cancel").click();
  find("open-mic-status").textContent = "连接输入设备与播放参考";
  try {
    if (!(await bridge.enableOpenMic(true))) throw new Error("麦克风未授权");
    const { context, reference, playing } = await openPlaybackReference();
    if (graph !== current) return;
    current.context = context;
    current.reference = reference;
    await context.audioWorklet.addModule("./open-mic-worklet.js");
    if (graph !== current) return;
    const node = new AudioWorkletNode(context, "open-mic", { numberOfInputs: 2, numberOfOutputs: 1 });
    current.node = node;
    current.playingSince ??= playing ? now() : null;
    node.port.postMessage(current.playingSince !== null);
    if (config.openMicFixture) {
      const delay = context.createDelay();
      delay.delayTime.value = 0.05;
      const input = context.createGain();
      input.gain.value = 0.65;
      reference.connect(delay).connect(input);
      current.echo = delay;
      current.input = input;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: source.value ? { exact: source.value } : undefined,
          channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
      });
      if (graph !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      const track = stream.getAudioTracks()[0];
      current.inputName = track.label || source.selectedOptions[0]?.text || "系统默认设备";
      track.addEventListener("ended", () => fail(current, "输入设备已断开"), { once: true });
      track.addEventListener("mute", () => fail(current, "输入设备停止提供音频"), { once: true });
      current.input = context.createMediaStreamSource(stream);
    }
    current.input.connect(node);
    reference.connect(node, 0, 1);
    node.connect(context.destination);
    node.onprocessorerror = () => fail(current, "本机回声消除器发生错误");
    node.port.onmessage = ({ data }) => {
      if (graph !== current) return;
      current.lastHeartbeat = now();
      if (data.fault) return fail(current, "输入设备停止提供音频");
      if (typeof data.reference === "boolean") {
        if (data.reference) current.lastReference = now();
        find("open-mic-reference").textContent = !data.reference ? "等待输出" :
          data.locked ? "正在消除播放回声" : "参考未对齐 · 暂缓识别";
        if (data.reference && data.locked) soundFixture(current);
        if (!data.reference) current.sampleSent = false;
      }
      if (data.start !== undefined && !reading) {
        const at = epoch(context, data.start);
        reading = {
          token: crypto.randomUUID(), at, tail: Promise.resolve(),
          liveFollow: liveTask?.phase === "following" || liveTask?.phase === "pending",
          simFollow: simTask?.phase === "following" || simTask?.phase === "cleaning",
        };
        const utterance = reading;
        metric("start", at);
        for (const name of ["cut", "final", "stop"]) metric(name, null);
        utterance.tail = bridge.startAsr(
          config.openMicFixture && scenario.value === "status" ? "status" : "stop", utterance.token, true,
        ).then(async (id) => {
          utterance.id = id;
          if (reading !== utterance && id !== null) await bridge.cancelAsr(id);
          if (id === null && reading === utterance) fail(current, "本机识别器未启动");
        }).catch(() => fail(current, "本机识别器未启动"));
      }
      const utterance = reading;
      if (data.pcm && utterance && !utterance.ended) append(current, utterance, (id) => bridge.sendAsrAudio(id, data.pcm));
      if (data.end !== undefined && utterance && !utterance.ended) {
        utterance.ended = true;
        append(current, utterance, (id) => bridge.releaseAsr(id, epoch(context, data.lastVoice), epoch(context, data.end)));
      }
    };
    current.lastHeartbeat = now();
    current.watch = setInterval(() => {
      if (context.state !== "running" || now() - current.lastHeartbeat > 1200) {
        fail(current, "采集或播放参考无响应");
      } else if (current.playingSince && now() - Math.max(current.playingSince, current.lastReference ?? 0) > 1200) {
        fail(current, "播放参考已中断");
      }
    }, 400);
    find("open-mic-status").textContent = config.openMicFixture ? "持续监听 · 模拟输入与无声输出" :
      `正在持续监听 · ${current.inputName}`;
  } catch {
    fail(current, "无法访问输入设备或播放参考");
  }
}

function append(current, utterance, operation) {
  utterance.tail = utterance.tail.then(() => {
    if (reading === utterance && utterance.id != null) return operation(utterance.id);
  }).catch(() => fail(current, "无法传送本机音频"));
}

function epoch(context, audioTime) {
  return now() - Math.max(0, context.currentTime - audioTime) * 1000;
}

bridge.onAsr((state) => {
  if (!reading || state.token !== reading.token) return;
  if (state.phase === "error") return fail(graph, state.message);
  if (state.phase === "cancelled") {
    graph?.node.port.postMessage("reset");
    reading = undefined;
    return;
  }
  if (state.phase === "final" || state.phase === "empty") {
    metric("final", state.finalAt, state.final ? " · " + state.final : " · 未识别", reading.at);
    if (isStopRequest(state.final) && (reading.liveFollow || reading.simFollow)) {
      observeStop(state.finalAt, reading.liveFollow);
    }
    reading = undefined;
  }
});

let stopRequest = null;
function observeStop(at, live) {
  stopRequest = { live, at, expires: at + 5000 };
  void bridge.snapshot().then(observeSim);
  void window.minecraft.snapshot().then(observeLive);
}
function showTaskStopped(reason) {
  if (!stopRequest || now() > stopRequest.expires) return;
  metric("stop", now(), " · " + reason, stopRequest.at);
  stopRequest = null;
}
function observeSim({ task, api }) {
  simTask = task;
  if (!stopRequest?.live && !api.live && task.phase === "stopped") showTaskStopped("模拟任务已终止");
}
function observeLive({ task, active }) {
  liveTask = active ? task : undefined;
  if (stopRequest?.live && active && task.phase === "released" && task.result?.state === "cancelled")
    showTaskStopped("任务已取消，控制已释放");
}

bridge.onState(observeSim);
void bridge.snapshot().then(observeSim);
window.minecraft.onState(observeLive);
void window.minecraft.snapshot().then(observeLive);
window.addEventListener("speech-interrupted", ({ detail }) => {
  if (reading && detail >= reading.at) metric("cut", detail, " · 输出末帧", reading.at);
});
window.addEventListener("speech-reference-state", ({ detail }) => {
  if (!graph) return;
  graph.playingSince = detail ? now() : null;
  graph.node?.port.postMessage(detail);
});
window.addEventListener("speech-reference-lost", () => { if (graph) fail(graph, "播放参考已中断"); });
window.addEventListener("pagehide", () => close());
source.addEventListener("change", () => { if (graph) fail(graph, "输入设备已更改"); });
permission.addEventListener("change", () => {
  if (!permission.checked && graph) close("麦克风已关闭");
  availability();
});
enable.addEventListener("change", () => {
  if (enable.checked) void listen();
  else close();
});
scenario.addEventListener("change", () => { if (graph) graph.sampleSent = false; });
find("open-mic-fixture").hidden = !config.openMicFixture;
availability();
