import { bindChatComposer } from "./chat-composer.js";

const bridge = window.companion;
const $ = (id) => document.getElementById(id);
const conversation = $("conversation");
const composer = $("composer");
const input = $("input");
let lastMessages = "[]";

const replyLabels = {
  idle: "等待输入",
  pending: "等待回复",
  ready: "回复已显示",
  timeout: "回复超时 · 已丢弃",
  cancelled: "已停止等待",
  rejected: "结果校验失败",
};
const windowLabels = {
  idle: "等待输入", reading: "等待读取截止", running: "生成结果", staged: "候选暂存",
  committed: "已在下一窗提交", timeout: "已过期", cancelled: "已取消", rejected: "校验失败",
};
const milliseconds = (value) => value === null ? "—" : `${Math.round(value)} ms`;
const playbackLabels = {
  idle: "未开始",
  playing: "播报中",
  finished: "播报完成",
  interrupted: "已中断播报",
};
const taskLabels = {
  idle: "空闲",
  following: "正在跟随",
  cleaning: "正在清理",
  stopped: "任务已终止",
};

function renderConversation(messages) {
  const serialized = JSON.stringify(messages);
  if (serialized === lastMessages) return;
  lastMessages = serialized;
  const items = messages.map(({ role, source, text, player, publicReply }) => {
    const message = document.createElement("article");
    message.className = `message ${role}`;
    const speaker = document.createElement("span");
    speaker.className = "speaker";
    speaker.textContent = role === "companion"
      ? publicReply ? "MC-Pal · GUI 和 Minecraft" : "MC-Pal"
      : source === "minecraft" ? `${player} · Minecraft` : source === "voice" ? "你 · 语音" : "你";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    message.append(speaker, paragraph);
    return message;
  });
  conversation.replaceChildren(...items);
  conversation.scrollTop = conversation.scrollHeight;
}

const apiLabels = {
  idle: "未开始", pending: "处理中", completed: "完成",
  network: "连接失败或测试超时", cancelled: "已尝试取消 · 服务端是否停止未知",
  invalid: "响应校验失败", truncated: "响应截断或未完整结束", "missing-model": "供应方未列出配置的模型",
};

function apiLabel(status) {
  return status.kind === "http" ? "供应方返回 HTTP " + status.status : apiLabels[status.kind];
}

const localPhases = {
  off: "待启动", starting: "正在加载", warming: "正在预热", ready: "就绪",
  reclaiming: "正在回收资源", failed: "本地后端失败", "over-budget": "显存超限，模型已卸载",
};

function renderLocal(state) {
  const local = state.local;
  $("model-backend").querySelector('[value="local"]').disabled = !local;
  $("local-unconfigured").hidden = !!local;
  $("local-panel").hidden = !local || state.backend !== "local";
  if (!local) return;
  const busy = ["starting", "warming", "ready"].includes(local.phase);
  $("local-start").disabled = busy || local.phase === "reclaiming";
  $("local-stop").disabled = !busy;
  $("local-configuration").textContent = `${local.model} · ${local.settings}`;
  $("local-status").textContent = local.reason ? `${localPhases[local.phase]} · ${local.reason}` : localPhases[local.phase];
  const bytes = (value) => value == null ? "—" : `${value.toLocaleString()} B`;
  $("local-dedicated").textContent = bytes(local.dedicatedPeakBytes);
  $("local-shared").textContent = bytes(local.sharedPeakBytes);
  const sampleResult = local.samplesBelowLimit === null ? "证据未齐" : local.samplesBelowLimit ? "已有样本低于上限" : "超限";
  $("local-limit").textContent = `< 6,000,000,000 B · ${sampleResult}${local.fixture ? "（模拟）" : ""}`;
  $("local-sampling").textContent = `${local.samples} 个样本 · 最大间隔 ${milliseconds(local.longestSampleGapMs)}`;
  $("local-request").textContent = state.localRequest.kind === "cancelled"
    ? "已尝试取消 · 模型资源仍由后端管理"
    : apiLabel(state.localRequest);
  $("local-cancelled").textContent = String(state.localCancelled);
}

function render(state) {
  renderConversation(state.messages);
  $("place").textContent = state.observation.place;
  $("players").replaceChildren(...state.observation.players.map(({ name, distance }) => {
    const player = document.createElement("li");
    const detail = document.createElement("span");
    detail.textContent = `${distance} 格`;
    player.append(name, detail);
    return player;
  }));
  $("reply").textContent = replyLabels[state.reply];
  const liveTask = state.api.live ? state.api.liveTask : null;
  const { phase, target } = liveTask ?? state.task;
  const phaseLabel = ({ ...taskLabels, pending: "等待动作接收", stopping: "正在清理", released: "控制已释放" })[phase];
  $("task").textContent = target ? `${phaseLabel} · ${target}` : phaseLabel;
  $("playback").textContent = playbackLabels[state.playback.phase];
  $("timeout").checked = state.timeoutNext;
  const read = state.window;
  $("read-window").textContent = `会话 ${read.session} · #${read.id} · ${milliseconds(read.readMs)} · ${read.frozen ? "已冻结" : "读取中"}`;
  $("next-read").textContent = milliseconds(read.nextReadMs);
  $("window-result").textContent = windowLabels[read.result];
  $("window-latency").textContent = `${milliseconds(read.firstMs)} / ${milliseconds(read.completeMs)}`;
  $("window-counts").textContent = `${read.samples} 次 · 成功 ${read.successful} · 超时 ${read.timeout} · 取消 ${read.cancelled} · 校验失败 ${read.rejected} · 丢弃 ${read.discarded}`;
  $("window-percentiles").textContent = `${milliseconds(read.p50Ms)} / ${milliseconds(read.p95Ms)}`;
  $("simulation-scenario").value = state.scenario;
  $("model-backend").value = state.backend;
  $("model-backend").querySelector('[value="api"]').disabled = !state.api.origin;
  $("api-origin").textContent = state.api.origin
    ? "连接目标 " + state.api.origin + "。启用 API 后会将输入和观测发送到该地址。"
    : "请在本机配置 API 地址、模型和密钥。";
  $("api-test").disabled = !state.api.origin || state.api.test.kind === "pending";
  $("api-test-result").textContent = apiLabel(state.api.test);
  $("api-request").textContent = apiLabel(state.api.request);
  $("api-cancelled").textContent = String(state.api.cancelled);
  $("api-live-option").hidden = state.backend === "simulated";
  $("api-live").checked = state.api.live;
  $("api-observation-source").textContent = state.api.live ? "Minecraft 实机" : "模拟观测";
  $("advance").disabled = state.api.live;
  $("timeout").disabled = state.backend !== "simulated";
  $("simulation-scenario").disabled = state.backend !== "simulated";
  renderLocal(state);
}

function showError() {
  $("error").textContent = "无法与桌面会话通信。请重新打开 MC-Pal。";
  $("error").hidden = false;
}

async function submit(source) {
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  try {
    await bridge.submit(text, source);
    if (input.value.trim() === text) input.value = "";
    input.focus();
  } catch {
    showError();
  }
}

bindChatComposer(input, composer);
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("gui");
});
$("voice").addEventListener("click", () => void submit("voice"));
$("advance").addEventListener("click", () => bridge.advanceObservation().catch(showError));
$("timeout").addEventListener("change", (event) => bridge.setTimeoutNext(event.target.checked).catch(showError));
$("simulation-scenario").addEventListener("change", (event) => bridge.setSimulationScenario(event.target.value).catch(showError));
$("simulation-reconnect").addEventListener("click", () => bridge.reconnectSimulation().catch(showError));
$("stop").addEventListener("click", () => bridge.stop().catch(showError));
$("api-test").addEventListener("click", () => bridge.testApi().catch(showError));
$("local-start").addEventListener("click", () => bridge.startLocal().catch(showError));
$("local-stop").addEventListener("click", () => bridge.stopLocal().catch(showError));
$("model-backend").addEventListener("change", (event) => bridge.selectBackend(event.target.value).catch(showError));
$("api-live").addEventListener("change", (event) => bridge.setApiLive(event.target.checked).catch(showError));
$("open-settings-folder").addEventListener("click", () => bridge.openSettingsFolder().catch(showError));
if (bridge) {
  bridge.onState(render);
  bridge.snapshot().then(render).catch(showError);
} else {
  showError();
}
