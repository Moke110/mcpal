const el = (id) => document.getElementById(id);
const bridge = window.minecraft;
const panel = el("pal-play");
const operationPanel = el("pal-operation");
const form = el("pal-play-form");
const status = el("pal-play-status");
const end = el("pal-play-end");
const apiConsent = el("pal-play-api-consent");
const submit = form.querySelector('[type="submit"]');
let profile;
let currentPlay;
let pending = false;
let selected = false;

function setRoute(id, enabled) {
  const control = el(id);
  if (control.checked === enabled) return;
  control.checked = enabled;
  control.dispatchEvent(new Event("change"));
}

function showPlayWorkspace() {
  if (!selected || operationPanel.hidden) return;
  el("desktop-workspaces").hidden = false;
  el("simulation-workspace").hidden = false;
  el("minecraft-workspace").hidden = false;
}

operationPanel.addEventListener("pal-operation", ({ detail }) => {
  selected = detail.operation === "play";
  panel.hidden = !selected;
  if (!selected) return;
  profile = currentPlay?.profile ?? detail.profile;
  el("pal-operation-name").textContent = profile.nickname;
  const api = profile.backend === "api";
  apiConsent.hidden = !api;
  apiConsent.querySelector("input").required = api;
  apiConsent.querySelector("input").disabled = !api;
  if (!currentPlay) apiConsent.querySelector("input").checked = false;
  if (currentPlay && !end.hidden) showPlayWorkspace();
  if (!currentPlay) status.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!profile || currentPlay || pending) return;
  pending = true;
  submit.disabled = true;
  status.textContent = "正在连接 Minecraft…";
  const fields = new FormData(form);
  const choosing = profile;
  try {
    const snapshot = await bridge.snapshot();
    if (snapshot.active) throw new Error("请先断开当前 Minecraft 连接。");
    if (fields.get("input") === "voice") {
      const audio = await window.companion.asrConfig();
      if (!audio.configured && !audio.fixture) throw new Error("麦克风输入需要先配置本机语音识别。");
    }
    currentPlay = { profile: choosing, input: fields.get("input"), output: fields.get("output") };
    await bridge.playPal(choosing.id, {
      host: fields.get("host"),
      port: fields.get("port"),
      offlineControl: fields.has("offlineControl"),
      allowApi: fields.has("allowApi"),
    });
  } catch (error) {
    currentPlay = undefined;
    status.textContent = error.message;
  } finally {
    pending = false;
    submit.disabled = Boolean(currentPlay);
  }
});

end.addEventListener("click", async () => {
  end.disabled = true;
  try {
    await bridge.disconnect();
  } catch (error) {
    end.disabled = false;
    status.textContent = error.message;
  }
});

bridge.onState(({ phase, reason, active }) => {
  if (!currentPlay) return;
  if (phase === "ready") {
    if (end.hidden) {
      currentPlay.routes = [
        { id: "asr-enable", previous: el("asr-enable").checked, enabled: currentPlay.input === "voice" },
        { id: "speech-enable", previous: el("speech-enable").checked, enabled: currentPlay.output === "voice" },
      ];
      for (const { id, enabled } of currentPlay.routes) setRoute(id, enabled);
    }
    status.textContent = "陪玩中";
    end.hidden = false;
    end.disabled = false;
    form.hidden = true;
    showPlayWorkspace();
  } else if (phase === "disconnecting") {
    status.textContent = "正在结束陪玩…";
    end.disabled = true;
  } else if (!active && (phase === "disconnected" || phase === "failed")) {
    status.textContent = phase === "failed" && end.hidden
      ? `连接失败：${reason ?? "请检查地址、端口和离线登录设置。"}`
      : reason ? `陪玩已结束：${reason}` : "陪玩已结束";
    if (selected && !operationPanel.hidden) el("desktop-workspaces").hidden = true;
    for (const { id, previous, enabled } of currentPlay.routes ?? []) {
      if (el(id).checked === enabled) setRoute(id, previous);
    }
    currentPlay = undefined;
    end.hidden = true;
    form.hidden = false;
    submit.disabled = pending;
  }
});
