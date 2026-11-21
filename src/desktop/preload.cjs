const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  snapshot: () => ipcRenderer.invoke("desktop:snapshot"),
  submit: (text, source) => ipcRenderer.invoke("desktop:submit", text, source),
  advanceObservation: () => ipcRenderer.invoke("desktop:observe"),
  setTimeoutNext: (enabled) => ipcRenderer.invoke("desktop:timeout", enabled),
  setSimulationScenario: (id) => ipcRenderer.invoke("desktop:simulation-scenario", id),
  reconnectSimulation: () => ipcRenderer.invoke("desktop:simulation-reconnect"),
  stop: () => ipcRenderer.invoke("desktop:stop"),
  onState: (listener) => {
    ipcRenderer.on("desktop:state", (_event, state) => listener(state));
  },
});
