const { ipcRenderer } = require("electron");
ipcRenderer.on("sensor:messages", (_event, messages) => {
  const log = document.querySelector("pre");
  if (!log) return;
  const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
  log.textContent = messages.map(({ arrivedAt, source, sender, text }) =>
    `[${new Date(arrivedAt).toLocaleTimeString()}] ${source} · ${sender}\n${text}`
  ).join("\n\n");
  if (atEnd) window.scrollTo(0, document.documentElement.scrollHeight);
});
