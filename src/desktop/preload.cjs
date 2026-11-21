const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  snapshot: () => ipcRenderer.invoke("desktop:snapshot"),
  submit: (text, source) => ipcRenderer.invoke("desktop:submit", text, source),
  advanceObservation: () => ipcRenderer.invoke("desktop:observe"),
  setTimeoutNext: (enabled) => ipcRenderer.invoke("desktop:timeout", enabled),
  setSimulationScenario: (id) => ipcRenderer.invoke("desktop:simulation-scenario", id),
  reconnectSimulation: () => ipcRenderer.invoke("desktop:simulation-reconnect"),
  stop: () => ipcRenderer.invoke("desktop:stop"),
  testApi: () => ipcRenderer.invoke("desktop:test-api"),
  selectBackend: (backend) => ipcRenderer.invoke("desktop:select-backend", backend),
  setApiLive: (enabled) => ipcRenderer.invoke("desktop:api-live", enabled),
  onState: (listener) => {
    ipcRenderer.on("desktop:state", (_event, state) => listener(state));
  },
});

contextBridge.exposeInMainWorld("minecraft", {
  snapshot: () => ipcRenderer.invoke("minecraft:snapshot"),
  connect: (settings) => ipcRenderer.invoke("minecraft:connect", settings),
  disconnect: () => ipcRenderer.invoke("minecraft:disconnect"),
  follow: (target) => ipcRenderer.invoke("minecraft:follow", target),
  stop: () => ipcRenderer.invoke("minecraft:stop"),
  onState: (listener) => {
    ipcRenderer.on("minecraft:state", (_event, state) => listener(state));
  },
});
