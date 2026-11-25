const api = window.palProfiles;
const select = document.querySelector("#mic-device");
const sender = document.querySelector("#mic-user");
const enabled = document.querySelector("#mic-enabled");
const status = document.querySelector("#mic-state");
let profile;
let capture;
let state = "未监听";

function showStatus(message) {
  state = message;
  status.textContent = message;
}

async function devices() {
  const owner = profile;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d =>
    d.kind === "audioinput" && d.deviceId && !["default", "communications"].includes(d.deviceId));
  if (profile !== owner) return;
  const saved = owner?.microphone;
  select.replaceChildren(...inputs.map((d, i) => new Option(d.label || "麦克风 " + (i + 1), d.deviceId)));
  if (saved?.deviceId) {
    if (!inputs.some(d => d.deviceId === saved.deviceId)) select.add(new Option(saved.label, saved.deviceId));
    select.value = saved.deviceId;
  }
}

document.querySelector("#pal-operation").addEventListener("pal-operation", ({ detail }) => {
  profile = detail.profile;
  enabled.checked = !!profile.microphone?.enabled;
  sender.value = profile.microphone?.sender || "桌面操作者";
  status.textContent = state;
  void devices().catch(error => { status.textContent = error.message; });
});

document.querySelector("#mic-discover").onclick = async () => {
  try {
    await api.microphoneDiscover();
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
    permission.getTracks().forEach(track => track.stop());
    await devices();
  } catch (error) { status.textContent = error.message; }
};

document.querySelector("#sensor-microphone").addEventListener("change", async () => {
  const owner = profile;
  try {
    owner.microphone = await api.setMicrophone(owner.id, { enabled: enabled.checked, deviceId: select.value,
      label: select.selectedOptions[0]?.textContent || "", sender: sender.value });
  } catch (error) {
    enabled.checked = !!owner.microphone?.enabled;
    status.textContent = error.message;
  }
});

function release(c) {
  clearTimeout(c.retry);
  c.stream?.getTracks().forEach(track => track.stop());
  c.source?.disconnect();
  c.node?.port.close();
  if (c.context && c.context.state !== "closed") void c.context.close().catch(() => {});
  c.node = c.context = c.source = c.stream = null;
}

async function lost(c, message) {
  if (capture !== c || c.stopping || c.losing) return;
  c.losing = true;
  release(c);
  showStatus("不可用 · " + message);
  await api.microphoneLost(c.token);
  if (capture !== c || c.stopping) return;
  c.retry = setTimeout(() => { c.losing = false; void listen(c); }, 2000);
}

async function listen(c) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: c.deviceId } } });
    if (capture !== c || c.stopping) { stream.getTracks().forEach(t => t.stop()); return; }
    c.stream = stream;
    stream.getAudioTracks()[0].onended = () => void lost(c, "设备断开");
    const context = c.context = new AudioContext();
    await context.audioWorklet.addModule("./asr-worklet.js");
    if (capture !== c || c.stopping || c.context !== context) return;
    if (!await api.microphoneReady(c.token)) return;
    if (capture !== c || c.stopping || c.context !== context) return;
    const node = c.node = new AudioWorkletNode(context, "asr-capture");
    node.port.onmessage = ({ data }) => {
      if (capture !== c || c.node !== node) return;
      if (data.pcm) c.pending = api.microphoneAudio(c.token, data.pcm).catch(error => lost(c, error.message));
      if (data.done) c.flush?.();
    };
    node.onprocessorerror = () => void lost(c, "采集失败");
    c.source = context.createMediaStreamSource(stream);
    c.source.connect(node).connect(context.destination);
    await context.resume();
    if (capture === c && !c.losing && !c.stopping) showStatus("监听中 · " + stream.getAudioTracks()[0].label);
  } catch (error) { await lost(c, error.message); }
}

api.onMicrophone(async command => {
  if (command.action === "start") {
    capture = { token: command.token, deviceId: command.deviceId };
    showStatus("正在连接");
    await listen(capture);
    return;
  }
  const c = capture;
  if (!c || c.token !== command.token) return;
  if (command.action === "failure") { await lost(c, command.message); return; }
  c.stopping = true;
  if (c.node) {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 300);
      c.flush = () => { clearTimeout(timeout); resolve(); };
      c.node.port.postMessage("flush");
    });
    await c.pending;
  }
  release(c);
  capture = undefined;
  showStatus("未监听");
  await api.microphoneFlushed(c.token);
});
