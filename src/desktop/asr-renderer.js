const find = (id) => document.getElementById(id);
const bridge = window.companion;
const enable = find("asr-enable");
const record = find("asr-record");
const device = find("asr-device");
const fixtureMode = find("asr-fixture-mode");
const deviceStatus = find("asr-device-status");
const config = await bridge.asrConfig();
const now = () => performance.timeOrigin + performance.now();
let capture = null;
let press = null;
let latest = "idle";

enable.disabled = !config.fixture && !config.configured;
find("asr-fixture").hidden = !config.fixture;
if (config.fixture) deviceStatus.textContent = "模拟采集，不打开麦克风。";
else if (!config.configured) deviceStatus.textContent = "请配置本机普通话 ASR 模型，或继续使用文字输入。";

const phases = {
  idle: "待启用", recording: "采集中", processing: "等待最终文字", final: "已提交最终文字",
  empty: "未识别到文字", cancelled: "录音已取消", error: "录音或识别出错",
};

function stamp(value) {
  return value === null ? "—" : new Date(value).toLocaleTimeString("zh-CN", { fractionalSecondDigits: 3 });
}

bridge.onAsr((state) => {
  latest = state.phase;
  find("asr-status").textContent = phases[state.phase] + (state.message ? " · " + state.message : "") +
    (state.late ? " · 晚到，进入后续读取窗口" : "");
  find("asr-partial").textContent = state.partial || "—";
  find("asr-final").textContent = state.final || "—";
  find("asr-voice-time").textContent = stamp(state.lastVoiceAt);
  find("asr-release-time").textContent = stamp(state.releasedAt);
  find("asr-final-time").textContent = stamp(state.finalAt);
  find("asr-window").textContent = state.window ?? (state.phase === "final" ? "立即停止" : "—");
  if (state.phase === "cancelled" || state.phase === "error") discard(false);
});

async function refreshDevices() {
  if (config.fixture || !config.configured) return;
  try {
    const current = device.value;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((item) =>
      item.kind === "audioinput" && item.deviceId && item.deviceId !== "default");
    const present = !current || inputs.some((item) => item.deviceId === current);
    device.replaceChildren(new Option("系统默认设备", ""), ...inputs.map((item, index) =>
      new Option(item.label || "麦克风 " + (index + 1), item.deviceId)));
    device.value = present ? current : "";
    if (!present && capture) {
      const id = capture.id;
      discard(false);
      if (id !== null) await bridge.failAsrDevice(id);
    }
    deviceStatus.textContent = present ? "仅在按住说话时使用所选设备。" : "所选设备已移除，改用系统默认设备。";
  } catch {
    deviceStatus.textContent = "无法列出麦克风，请检查系统权限。";
  }
}

function close(current) {
  clearTimeout(current.limit);
  clearTimeout(current.flushTimeout);
  current.stream?.getTracks().forEach((track) => track.stop());
  current.source?.disconnect();
  current.node?.port.close();
  if (current.context && current.context.state !== "closed") void current.context.close().catch(() => {});
}

function discard(notify = true) {
  const current = capture;
  capture = null;
  press = null;
  record.setAttribute("aria-pressed", "false");
  if (current) close(current);
  if (notify) void bridge.cancelAsr(current?.id ?? undefined);
}

function ready(current) {
  return capture === current && current.releasedAt === null;
}

async function start() {
  if (!enable.checked) return;
  if (capture) discard();
  const current = { id: null, releasedAt: null, mode: fixtureMode.value, pending: Promise.resolve() };
  capture = current;
  record.setAttribute("aria-pressed", "true");
  current.limit = setTimeout(() => discard(), 30_000);
  try {
    const id = await bridge.startAsr(current.mode);
    if (id === null) {
      if (capture === current) discard(false);
      return;
    }
    current.id = id;
    if (capture !== current) {
      await bridge.cancelAsr(id);
      return;
    }
    if (current.releasedAt !== null) {
      finish(current, null);
      return;
    }
    if (config.fixture && current.mode === "device-error") {
      await bridge.failAsrDevice(id);
      return;
    }
    const context = new AudioContext();
    current.context = context;
    await context.audioWorklet.addModule("./asr-worklet.js");
    if (!ready(current)) return;
    let source;
    if (config.fixture) {
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.13) * 0.045;
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = current.mode !== "empty";
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { channelCount: 1, deviceId: device.value ? { exact: device.value } : undefined },
      });
      if (!ready(current)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => {
        if (ready(current)) void bridge.failAsrDevice(id);
      }, { once: true });
      source = context.createMediaStreamSource(stream);
      void refreshDevices();
    }
    current.source = source;
    const node = new AudioWorkletNode(context, "asr-capture", { numberOfInputs: 1, numberOfOutputs: 1 });
    current.node = node;
    node.port.onmessage = ({ data }) => {
      if (capture !== current) return;
      if (data.pcm) current.pending = bridge.sendAsrAudio(id, data.pcm).catch(() => {
        if (capture === current) void bridge.failAsrDevice(id);
      });
      if (data.done) {
        const voiceAt = data.lastVoice === null ? null : now() - Math.max(0, context.currentTime - data.lastVoice) * 1000;
        finish(current, voiceAt === null ? null : Math.min(voiceAt, current.releasedAt));
      }
    };
    node.onprocessorerror = () => { if (capture === current) void bridge.failAsrDevice(id); };
    source.connect(node).connect(context.destination);
    if (config.fixture) source.start();
    await context.resume();
  } catch {
    if (capture === current && current.id !== null && current.releasedAt === null) {
      await bridge.failAsrDevice(current.id);
    }
  }
}

function finish(current, lastVoiceAt) {
  if (capture !== current) return;
  capture = null;
  close(current);
  void current.pending.then(() => bridge.releaseAsr(current.id, lastVoiceAt, current.releasedAt)).catch(() => {
    void bridge.failAsrDevice(current.id);
  });
}

function release() {
  const current = capture;
  press = null;
  record.setAttribute("aria-pressed", "false");
  if (!current || current.releasedAt !== null) return;
  current.releasedAt = now();
  current.stream?.getTracks().forEach((track) => track.stop());
  current.source?.disconnect();
  if (current.node) {
    current.node.port.postMessage("flush");
    current.flushTimeout = setTimeout(() => finish(current, null), 300);
  } else if (current.id !== null) {
    finish(current, null);
  }
}

enable.addEventListener("change", async () => {
  if (!enable.checked) discard();
  record.disabled = !enable.checked;
  await bridge.enableAsr(enable.checked);
  if (enable.checked) {
    if (latest === "idle") find("asr-status").textContent = "待按键";
    void refreshDevices();
  }
});
find("asr-refresh").addEventListener("click", () => void refreshDevices());
device.addEventListener("change", () => discard());
find("asr-cancel").addEventListener("click", () => discard());
record.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || press !== null || record.disabled) return;
  record.setPointerCapture(event.pointerId);
  void start();
  press = event.pointerId;
});
record.addEventListener("pointerup", (event) => { if (press === event.pointerId) release(); });
record.addEventListener("lostpointercapture", (event) => { if (press === event.pointerId) discard(); });
record.addEventListener("pointercancel", (event) => { if (press === event.pointerId) discard(); });
record.addEventListener("keydown", (event) => {
  if (event.key !== " " && event.key !== "Enter") return;
  event.preventDefault();
  if (event.repeat || press !== null || record.disabled) return;
  void start();
  press = event.key;
});
record.addEventListener("keyup", (event) => { if (press === event.key) release(); });
record.addEventListener("blur", () => { if (typeof press === "string") discard(); });
find("show-minecraft").addEventListener("click", () => discard());
window.addEventListener("blur", () => { if (press !== null) discard(); });
window.addEventListener("pagehide", () => discard());
navigator.mediaDevices?.addEventListener("devicechange", () => void refreshDevices());
void refreshDevices();
