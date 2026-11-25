const get = (id) => document.getElementById(id);
const operation = get("pal-operation");
const form = get("pal-chat-setup");
const error = get("pal-chat-error");
const workspace = get("simulation-workspace");
const title = get("conversation-title");
let selected = null;
let starting = false;

function setRoute(id, enabled) {
  const route = get(id);
  if (route.checked === enabled) return;
  route.checked = enabled;
  route.dispatchEvent(new Event("change"));
}

function leaveChatView() {
  workspace.classList.remove("pal-chat-mode", "pal-chat-text-input", "pal-chat-text-output");
  title.textContent = "对话";
}

get("new-pal").addEventListener("click", () => {
  selected = null;
  form.hidden = true;
  leaveChatView();
});

operation.addEventListener("pal-operation", ({ detail }) => {
  selected = detail.operation === "chat" ? detail.profile : null;
  form.hidden = !selected;
  form.reset();
  error.textContent = "";
  leaveChatView();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selected || starting) return;
  const profile = selected;
  const fields = new FormData(form);
  const microphone = fields.get("input") === "microphone";
  const speech = fields.get("output") === "speech";
  if (microphone && get("asr-enable").disabled) {
    error.textContent = "本机语音识别尚未配置，请选择键盘输入。";
    return;
  }
  starting = true;
  const confirm = form.querySelector("button");
  confirm.disabled = true;
  error.textContent = "";
  try {
    await window.palProfiles.startChat(profile.id);
    if (profile !== selected) return;
    operation.hidden = true;
    get("desktop-workspaces").hidden = false;
    get("minecraft-workspace").hidden = true;
    workspace.hidden = false;
    get("session-settings").open = false;
    title.textContent = "与" + profile.nickname + "聊天";
    workspace.classList.add("pal-chat-mode");
    workspace.classList.toggle("pal-chat-text-input", !microphone);
    workspace.classList.toggle("pal-chat-text-output", !speech);
    setRoute("asr-enable", microphone);
    setRoute("speech-enable", speech);
    (microphone ? get("asr-record") : get("input")).focus();
  } catch (failure) {
    if (profile === selected) error.textContent = failure.message;
  } finally {
    starting = false;
    confirm.disabled = false;
  }
});
