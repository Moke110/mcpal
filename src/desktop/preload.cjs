const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  snapshot: () => ipcRenderer.invoke("desktop:snapshot"),
  openSettingsFolder: () => ipcRenderer.invoke("desktop:settings-folder"),
  submit: (text, source) => ipcRenderer.invoke("desktop:submit", text, source),
  advanceObservation: () => ipcRenderer.invoke("desktop:observe"),
  setTimeoutNext: (enabled) => ipcRenderer.invoke("desktop:timeout", enabled),
  setSimulationScenario: (id) => ipcRenderer.invoke("desktop:simulation-scenario", id),
  reconnectSimulation: () => ipcRenderer.invoke("desktop:simulation-reconnect"),
  stop: () => ipcRenderer.invoke("desktop:stop"),
  testApi: () => ipcRenderer.invoke("desktop:test-api"),
  startLocal: () => ipcRenderer.invoke("desktop:start-local"),
  stopLocal: () => ipcRenderer.invoke("desktop:stop-local"),
  selectBackend: (backend) => ipcRenderer.invoke("desktop:select-backend", backend),
  setApiLive: (enabled) => ipcRenderer.invoke("desktop:api-live", enabled),
  speechFixture: () => ipcRenderer.invoke("desktop:speech-fixture"),
  enableSpeech: (enabled) => ipcRenderer.invoke("desktop:speech-enable", enabled),
  previewSpeech: () => ipcRenderer.invoke("desktop:speech-preview"),
  cancelSpeech: () => ipcRenderer.invoke("desktop:speech-cancel"),
  settleSpeech: (id) => ipcRenderer.invoke("desktop:speech-settled", id),
  onSpeech: (listener) => ipcRenderer.on("desktop:speech-event", (_event, event) => listener(event)),
  asrConfig: () => ipcRenderer.invoke("desktop:asr-config"),
  enableAsr: (enabled) => ipcRenderer.invoke("desktop:asr-enable", enabled),
  enableOpenMic: (enabled) => ipcRenderer.invoke("desktop:open-mic-enable", enabled),
  startAsr: (mode, token, openMic = false) => ipcRenderer.invoke("desktop:asr-start", mode, token, openMic),
  sendAsrAudio: (id, pcm) => ipcRenderer.invoke("desktop:asr-audio", id, pcm),
  releaseAsr: (id, voicedAt, releasedAt) => ipcRenderer.invoke("desktop:asr-release", id, voicedAt, releasedAt),
  cancelAsr: (id) => ipcRenderer.invoke("desktop:asr-cancel", id),
  failAsrDevice: (id) => ipcRenderer.invoke("desktop:asr-device-error", id),
  onAsr: (listener) => ipcRenderer.on("desktop:asr-state", (_event, state) => listener(state)),
  onState: (listener) => {
    ipcRenderer.on("desktop:state", (_event, state) => listener(state));
  },
});

contextBridge.exposeInMainWorld("minecraft", {
  snapshot: () => ipcRenderer.invoke("minecraft:snapshot"),
  readView: () => ipcRenderer.invoke("minecraft:view"),
  connect: (settings) => ipcRenderer.invoke("minecraft:connect", settings),
  disconnect: () => ipcRenderer.invoke("minecraft:disconnect"),
  follow: (target) => ipcRenderer.invoke("minecraft:follow", target),
  stop: () => ipcRenderer.invoke("minecraft:stop"),
  setChatRoute: (enabled) => ipcRenderer.invoke("minecraft:chat-route", enabled),
  onState: (listener) => {
    ipcRenderer.on("minecraft:state", (_event, state) => listener(state));
  },
});

contextBridge.exposeInMainWorld("palProfiles", {
  list: () => ipcRenderer.invoke("pal:list"),
  create: (profile) => ipcRenderer.invoke("pal:create", profile),
  startChat: (id) => ipcRenderer.invoke("pal:start-chat", id),
  windowControl: (action) => ipcRenderer.invoke("desktop:window-control", action),
});
