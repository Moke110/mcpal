const api = window.palProfiles;
const select = document.getElementById("app-source");
const enabled = document.getElementById("app-enabled");
const status = document.getElementById("app-state");
let profile;

function updateStatus(event) {
  status.textContent = event.profileId === profile?.id ? event.status : "未监听";
}

async function refresh() {
  const current = profile;
  const paths = await api.listAudioApps();
  if (profile !== current) return;
  const saved = current.application?.path;
  if (saved && !paths.includes(saved)) paths.push(saved);
  select.replaceChildren(new Option("选择应用", ""), ...paths.map(path =>
    new Option(path.split("\\").pop() + " · " + path, path)));
  select.value = saved || "";
}

document.getElementById("pal-operation").addEventListener("pal-operation", ({ detail }) => {
  profile = detail.profile;
  enabled.checked = !!profile.application?.enabled;
  select.replaceChildren();
  status.textContent = "未监听";
  void api.audioAppStatus().then(updateStatus);
  void refresh().catch(error => { status.textContent = error.message; });
});
document.getElementById("app-discover").onclick = () => {
  void refresh().catch(error => { status.textContent = error.message; });
};

async function save() {
  const current = profile;
  try {
    current.application = await api.setAudioApp(current.id, select.value, enabled.checked);
  } catch (error) {
    if (profile !== current) return;
    enabled.checked = !!current.application?.enabled;
    select.value = current.application?.path || "";
    status.textContent = error.message;
  }
}
enabled.onchange = save;
select.onchange = save;
api.onAudioAppStatus(updateStatus);
