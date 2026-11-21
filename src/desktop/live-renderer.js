(() => {
  const bridge = window.minecraft;
  const el = (id) => document.getElementById(id);
  const connection = el("minecraft-connection");
  const auth = el("minecraft-auth");
  const playerSelect = el("minecraft-target");
  const disconnect = el("minecraft-disconnect");
  const stop = el("minecraft-stop");
  const follow = el("minecraft-follow");
  const connectionLabels = {
    disconnected: "未连接", connecting: "等待登录", positioning: "等待游戏观测",
    ready: "已就绪", disconnecting: "正在断开", failed: "连接失败",
  };
  const taskLabels = {
    idle: "空闲", pending: "等待开始", following: "正在跟随",
    stopping: "停止中 · 等待控制释放", released: "控制已释放",
  };
  let observedPlayers = [];
  let canFollow = false;

  function showMode(live) {
    el("simulation-workspace").hidden = live;
    el("minecraft-workspace").hidden = !live;
    el("show-simulation").setAttribute("aria-pressed", String(!live));
    el("show-minecraft").setAttribute("aria-pressed", String(live));
  }

  function optionalText(id, value) {
    el(id).textContent = value ?? "";
    el(id).hidden = !value;
  }

  function renderPlayers(players) {
    const names = players.map(({ username }) => username).filter(Boolean);
    if (names.length !== observedPlayers.length || names.some((name, index) => name !== observedPlayers[index])) {
      const previous = playerSelect.value;
      playerSelect.replaceChildren(new Option("请选择", ""),
        ...names.map((name) => new Option(name, name)));
      playerSelect.value = names.includes(previous) ? previous : "";
      observedPlayers = names;
    }
    playerSelect.disabled = !canFollow || names.length === 0;
    follow.disabled = playerSelect.disabled || !playerSelect.value;
  }

  function render(state) {
    const { phase, observation, task } = state;
    const available = !state.active && (phase === "disconnected" || phase === "failed");
    canFollow = phase === "ready" && (task.phase === "idle" || task.phase === "released");
    el("live-phase").textContent = connectionLabels[phase];
    el("minecraft-settings").disabled = !available;
    disconnect.disabled = available || phase === "disconnecting";
    stop.disabled = phase !== "ready" || (task.phase !== "following" && task.phase !== "pending");
    optionalText("live-auth-prompt", state.authPrompt);
    optionalText("live-reason", state.reason);
    el("live-player").textContent = observation ? `${observation.username} · ${observation.version}` : "未知";
    const { x, y, z } = observation?.position ?? {};
    el("live-position").textContent = observation
      ? `${observation.dimension ?? "未知维度"} · ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}` : "未知";
    el("live-block").textContent = observation?.blocks[0]?.name ?? "未知";
    el("live-inventory").textContent = observation?.inventory
      ? observation.inventory.map(({ name, count }) => `${name} × ${count}`).join("、") || "空"
      : "未知";
    el("live-nearby").textContent = observation ? observation.nearby.players.map(({ username, distance }) => (
      `${username ?? "未知玩家"} · ${distance.toFixed(1)} 格`
    )).join("、") || "未观测到玩家" : "未知";
    el("live-task").textContent = task.target ? `${taskLabels[task.phase]} · ${task.target}` : taskLabels[task.phase];
    optionalText("live-task-result", task.result?.message);
    renderPlayers(observation?.nearby.players ?? []);
  }

  function showError() {
    optionalText("live-reason", "无法与 Minecraft 会话通信。请重新打开 MC-Pal。");
  }

  el("show-simulation").addEventListener("click", () => showMode(false));
  el("show-minecraft").addEventListener("click", () => showMode(true));
  const showOfflineControl = () => { el("minecraft-offline-control").hidden = auth.value !== "offline"; };
  auth.addEventListener("change", showOfflineControl);
  showOfflineControl();
  connection.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = new FormData(connection);
    const settings = Object.fromEntries(fields);
    bridge.connect({ ...settings, offlineControl: fields.has("offlineControl") }).catch(showError);
  });
  el("minecraft-follow-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!follow.disabled) bridge.follow(playerSelect.value).catch(showError);
  });
  playerSelect.addEventListener("change", () => {
    follow.disabled = !canFollow || !playerSelect.value;
  });
  disconnect.addEventListener("click", () => bridge.disconnect().catch(showError));
  stop.addEventListener("click", () => bridge.stop().catch(showError));
  if (bridge) {
    bridge.onState(render);
    bridge.snapshot().then(render).catch(showError);
  }
})();
