import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { SimulationSession } from "./sim-session.ts";

const dataPath = process.env.MCPAL_DESKTOP_DATA;
if (dataPath) app.setPath("userData", dataPath);

void app.whenReady().then(startDesktop).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    title: "MC-Pal",
    width: 1120,
    height: 800,
    minWidth: 600,
    minHeight: 540,
    backgroundColor: "#f3f2eb",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const page = new URL("./index.html", import.meta.url);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const session = new SimulationSession((state) => window.webContents.send("desktop:state", state));

  function handle(
    channel: string,
    operation: (...args: unknown[]) => unknown,
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame?.url !== page.href) {
        throw new Error("Untrusted desktop IPC sender");
      }
      return operation(...args);
    });
  }

  handle("desktop:snapshot", () => session.snapshot());
  handle("desktop:submit", (input, source) => {
    if (typeof input !== "string" || (source !== "gui" && source !== "voice")) {
      throw new TypeError("Invalid desktop input");
    }
    session.submitText(input, source);
  });
  handle("desktop:observe", () => session.advanceObservation());
  handle("desktop:timeout", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid timeout setting");
    session.setTimeoutNext(enabled);
  });
  handle("desktop:stop", () => session.stop());
  window.on("closed", () => {
    session.dispose();
    app.quit();
  });
  await window.loadURL(page.href);
}
