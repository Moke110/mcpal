import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { connect } from "../client.ts";
import { createApiBackend } from "./api-backend.ts";
import { LiveMinecraftSession } from "./live-session.ts";
import { scenarios, SimulationSession } from "./sim-session.ts";

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
  try {
    loadEnvFile();
  } catch {
    // API setup is optional. The GUI reports missing settings.
  }
  const api = createApiBackend(process.env);
  const session = new SimulationSession((state) => {
    if (!window.isDestroyed()) window.webContents.send("desktop:state", state);
  }, undefined, {
    api,
    invalidateLiveReplacement: () => live.invalidateReplacement(),
    liveAction: (intent) => {
      if (intent.kind === "follow") live.replaceFollow(intent.target);
      if (intent.kind === "stop") live.stop();
    },
  });

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
  handle("desktop:simulation-scenario", (id) => {
    const scenario = scenarios.find((value) => value === id);
    if (!scenario) throw new TypeError("Invalid simulation scenario");
    session.setScenario(scenario);
  });
  handle("desktop:simulation-reconnect", () => session.switchSession());
  handle("desktop:stop", () => session.stop());
  handle("desktop:test-api", () => session.testApi());
  handle("desktop:select-backend", (backend) => {
    if (backend !== "simulated" && backend !== "api") throw new TypeError("Invalid backend");
    session.setBackend(backend);
  });
  handle("desktop:api-live", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid observation source");
    session.setApiLive(enabled);
  });
  const live = new LiveMinecraftSession((state) => {
    const observation = state.observation;
    session.updateLiveObservation(observation ? {
      place: [observation.dimension ?? "维度未知",
        [observation.position.x, observation.position.y, observation.position.z].map(Math.floor).join(", ")].join(" · "),
      players: observation.nearby.players.flatMap(({ username, distance }) => username ? [{ name: username, distance }] : []),
      health: observation.health,
      food: observation.food,
      inventory: observation.inventory?.map(({ name, count }) => ({ name, count })) ?? null,
    } : null, state.task);
    if (!window.isDestroyed()) window.webContents.send("minecraft:state", state);
  }, (config, report, authPrompt) => connect(config, report, authPrompt, {
    profilesFolder: join(app.getPath("userData"), "minecraft-profiles"),
  }));
  handle("minecraft:snapshot", () => live.snapshot());
  handle("minecraft:connect", (settings) => live.open(settings));
  handle("minecraft:disconnect", () => live.disconnect());
  handle("minecraft:follow", (target) => live.follow(target));
  handle("minecraft:stop", () => live.stop());
  window.on("closed", () => {
    session.dispose();
    live.disconnect();
    app.quit();
  });
  await window.loadURL(page.href);
}
