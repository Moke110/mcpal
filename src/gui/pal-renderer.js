const profiles = window.palProfiles;
const list = document.querySelector("#pal-list");
const form = document.querySelector("#create-pal");
const login = form.elements.namedItem("login");
const offlineSettings = document.querySelector("#pal-offline-settings");
const creation = document.querySelector("#pal-creation");
const operationPanel = document.querySelector("#pal-operation");
const workspaces = document.querySelector("#desktop-workspaces");
const formError = document.querySelector("#pal-error");
const listError = document.querySelector("#pal-list-error");
const operationTitle = document.querySelector("#pal-operation-title");
const operationName = document.querySelector("#pal-operation-name");

function showPanel(panel) {
  for (const candidate of [document.getElementById("pal-home"), creation, operationPanel, workspaces]) {
    candidate.hidden = candidate !== panel;
  }
}

function addProfile(profile) {
  const item = document.createElement("li");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = profile.nickname;
  details.append(summary);
  for (const [operation, title] of [["chat", "开始聊天"], ["play", "开始陪玩"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.addEventListener("click", () => {
      operationTitle.textContent = title;
      operationName.textContent = profile.nickname;
      showPanel(operationPanel);
      operationPanel.dispatchEvent(new CustomEvent("pal-operation", { detail: { profile, operation } }));
    });
    details.append(button);
  }
  item.append(details);
  list.append(item);
  return details;
}

function syncLogin() {
  offlineSettings.hidden = offlineSettings.disabled = login.value !== "offline";
}

login.addEventListener("change", syncLogin);
document.querySelector("#new-pal").addEventListener("click", () => showPanel(creation));
const maximize = document.querySelector('[data-window-control="toggle-maximize"]');
profiles.onWindowMaximized((maximized) => {
  maximize.textContent = maximized ? "❐" : "□";
  maximize.setAttribute("aria-label", maximized ? "还原" : "最大化");
});
for (const control of document.querySelectorAll("[data-window-control]")) {
  control.addEventListener("click", () => void profiles.windowControl(control.dataset.windowControl));
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  formError.textContent = "";
  try {
    const profile = await profiles.create(Object.fromEntries(new FormData(form)));
    const details = addProfile(profile);
    details.open = true;
    details.querySelector("summary").focus();
    form.reset();
    syncLogin();
    operationTitle.textContent = "伙伴已保存";
    operationName.textContent = profile.nickname;
    showPanel(operationPanel);
    operationPanel.dispatchEvent(new CustomEvent("pal-operation", { detail: { profile, operation: "saved" } }));
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

void profiles.list().then((saved) => {
  if (saved.length === 0) {
    document.getElementById("home-instruction").textContent = "点击左侧「创建伙伴」，开始第一次聊天或陪玩。";
  }
  for (const profile of saved) addProfile(profile);
}).catch((error) => {
  listError.textContent = error.message;
});

void profiles.voices().then((voices) => {
  const voice = document.querySelector("#pal-voice");
  for (const name of voices) voice.append(new Option(name, name));
}).catch((error) => {
  listError.textContent = error.message;
});
