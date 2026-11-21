const bridge = window.companion;
const find = (id) => document.getElementById(id);
const device = find("speech-device");
const route = find("speech-enable");
const status = find("speech-status");
const deviceStatus = find("speech-device-status");
const jobs = new Map();
let selected = "";
let fixture = false;
let active = null;
let graph;

function showError(message) {
  status.textContent = message;
}

function disposeGraph() {
  if (!graph) return;
  const { context } = graph;
  graph = undefined;
  void context.close().catch(() => {});
}

async function refreshDevices() {
  const choices = [new Option("系统默认设备", "")];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(({ kind, deviceId }) => kind === "audiooutput" && deviceId && deviceId !== "default");
    outputs.forEach(({ label, deviceId }, index) => choices.push(new Option(label || `输出设备 ${index + 1}`, deviceId)));
    if (fixture) choices.push(new Option("模拟不可用设备", "fixture-unavailable"));
    device.replaceChildren(...choices);
    if (!choices.some(({ value }) => value === selected)) {
      device.add(new Option("已断开的输出设备", selected));
      route.checked = false;
      await Promise.all([bridge.enableSpeech(false), stopSpeech()]);
      disposeGraph();
      deviceStatus.textContent = "所选输出设备已断开，请重新选择。";
    }
    device.value = selected;
  } catch {
    device.replaceChildren(...choices);
    deviceStatus.textContent = "无法读取输出设备。可尝试系统默认设备。";
  }
}

async function preparePlayer() {
  if (graph) {
    const current = graph;
    await current.ready;
    if (graph !== current) throw new Error("输出设备已切换");
    return current.context;
  }
  if (selected === "fixture-unavailable") throw new Error("模拟输出设备不可用");
  const context = new AudioContext({ latencyHint: "interactive", sinkId: fixture ? { type: "none" } : selected });
  const ready = Promise.all([context.resume(), context.audioWorklet.addModule("./speech-worklet.js")]);
  const pending = { context, ready };
  graph = pending;
  try {
    await ready;
    if (graph !== pending) throw new Error("输出设备已切换");
    deviceStatus.textContent = fixture ? "模拟音频 · 无声输出" : `已连接 · ${device.selectedOptions[0]?.text || "系统默认设备"}`;
    return context;
  } catch (error) {
    if (graph === pending) disposeGraph();
    throw error;
  }
}

function finish(job, failed = false, message = "") {
  clearTimeout(job.stopTimer);
  job.node?.disconnect();
  if (job.node) job.node.port.onmessage = null;
  jobs.delete(job.id);
  if (active === job.id) {
    active = null;
    status.textContent = failed ? message : job.cancelled ? "已停播" : "播报完成";
  }
  void bridge.settleSpeech(job.id).catch(() => {});
  job.done?.();
}

function cancelJob(job) {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  if (active === job.id) status.textContent = "正在停播";
  if (!job.node) {
    finish(job);
    return;
  }
  job.node.port.postMessage("flush");
  job.stopTimer = setTimeout(() => finish(job, true, "音频设备未确认停播"), 1500);
}

async function stopSpeech() {
  const job = jobs.get(active);
  cancelJob(job);
  await Promise.all([job?.stopped, bridge.cancelSpeech()]);
}

// Chromium reports which frame its output device is presenting. Fixture mode has a silent, clocked destination.
async function presented(context, frame) {
  const limit = performance.now() + 1000;
  const position = frame / context.sampleRate;
  while (performance.now() < limit) {
    if (context.state !== "running") break;
    const stamp = context.getOutputTimestamp();
    if (fixture && context.currentTime >= position) return null;
    if (stamp.performanceTime > 0 && stamp.contextTime >= position) {
      return stamp.performanceTime - (stamp.contextTime - position) * 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  throw new Error("音频设备未确认帧时序");
}

function frameLabel(value, presentedAt) {
  return presentedAt === null ? `帧 ${value} · 无声测试` : `帧 ${value} · ${Math.round(presentedAt)} ms`;
}

async function playbackEvent(job, context, event) {
  if (!jobs.has(job.id)) return;
  try {
    if (typeof event.firstFrame === "number") {
      const first = await presented(context, event.firstFrame);
      if (active === job.id) {
        if (!job.cancelled) status.textContent = "播报中";
        find("speech-first").textContent = frameLabel(event.firstFrame, first);
      }
      return;
    }
    job.cancelled ||= event.cancelled;
    if (event.lastFrame !== null) {
      const last = await presented(context, event.lastFrame + 1);
      if (jobs.has(job.id)) find("speech-last").textContent = frameLabel(event.lastFrame, last);
    }
    if (jobs.has(job.id)) finish(job);
  } catch (error) {
    if (jobs.has(job.id)) finish(job, true, error.message);
  }
}

async function play(job, wave) {
  try {
    const context = await preparePlayer();
    if (job.cancelled || active !== job.id) return;
    const decoded = await context.decodeAudioData(new Uint8Array(wave).buffer);
    if (job.cancelled || active !== job.id) return;
    const node = new AudioWorkletNode(context, "companion-speech-frames", {
      numberOfInputs: 0,
      outputChannelCount: [1],
      processorOptions: { samples: decoded.getChannelData(0) },
    });
    job.node = node;
    node.port.onmessage = ({ data }) => void playbackEvent(job, context, data);
    node.onprocessorerror = () => finish(job, true, "音频播放设备错误");
    node.connect(context.destination);
  } catch (error) {
    if (jobs.has(job.id)) finish(job, true, `音频设备错误 · ${error.message}`);
  }
}

function receive(event) {
  const { id, type } = event;
  if (type === "queued") {
    cancelJob(jobs.get(active));
    const job = { id, cancelled: false };
    job.stopped = new Promise((resolve) => { job.done = resolve; });
    jobs.set(id, job);
    active = id;
    status.textContent = "待播 · 合成中";
    find("speech-synthesis").textContent = "—";
    find("speech-first").textContent = "—";
    return;
  }
  const job = jobs.get(id);
  if (!job) return;
  if (type === "cancel") cancelJob(job);
  if (type === "error") finish(job, true, event.detail);
  if (type === "wave" && !job.cancelled) {
    find("speech-synthesis").textContent = `${Math.round(event.elapsed)} ms`;
    status.textContent = "待播 · 音频已合成";
    void play(job, event.wave);
  }
}

find("speech-devices").addEventListener("click", () => void refreshDevices());
find("speech-stop").addEventListener("click", () => void stopSpeech().catch(() => showError("无法截停播报")));
find("speech-preview").addEventListener("click", () => {
  void preparePlayer().then(() => bridge.previewSpeech()).catch((error) => showError(`音频设备错误 · ${error.message}`));
});
device.addEventListener("change", () => {
  selected = device.value;
  route.checked = false;
  void Promise.all([bridge.enableSpeech(false), stopSpeech()]).then(() => {
    disposeGraph();
    deviceStatus.textContent = "已选设备 · 待连接";
  }).catch(() => showError("无法切换输出设备"));
});
route.addEventListener("change", () => {
  if (!route.checked) {
    void bridge.enableSpeech(false).then(stopSpeech).catch(() => showError("无法关闭播报"));
    return;
  }
  void preparePlayer().then(() => bridge.enableSpeech(route.checked)).catch((error) => {
    route.checked = false;
    showError(`音频设备错误 · ${error.message}`);
  });
});

navigator.mediaDevices?.addEventListener("devicechange", () => void refreshDevices());
bridge.onSpeech(receive);
void bridge.speechFixture().then((enabled) => { fixture = enabled; return refreshDevices(); });
