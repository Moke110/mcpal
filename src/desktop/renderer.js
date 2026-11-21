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
};
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
  const items = messages.map(({ role, source, text }) => {
    const message = document.createElement("article");
    message.className = `message ${role}`;
    const speaker = document.createElement("span");
    speaker.className = "speaker";
    speaker.textContent = role === "companion" ? "MC-Pal" : source === "voice" ? "你 · 模拟语音" : "你";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    message.append(speaker, paragraph);
    return message;
  });
  conversation.replaceChildren(...items);
  conversation.scrollTop = conversation.scrollHeight;
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
  const { phase, target } = state.task;
  $("task").textContent = target ? `${taskLabels[phase]} · ${target}` : taskLabels[phase];
  $("playback").textContent = playbackLabels[state.playback.phase];
  $("timeout").checked = state.timeoutNext;
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

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit("gui");
});
$("voice").addEventListener("click", () => void submit("voice"));
$("advance").addEventListener("click", () => bridge.advanceObservation().catch(showError));
$("timeout").addEventListener("change", (event) => bridge.setTimeoutNext(event.target.checked).catch(showError));
$("stop").addEventListener("click", () => bridge.stop().catch(showError));
if (bridge) {
  bridge.onState(render);
  bridge.snapshot().then(render).catch(showError);
} else {
  showError();
}
