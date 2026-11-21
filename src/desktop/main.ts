import { app, BrowserWindow, ipcMain, Menu } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { connect } from "../client.ts";
import { createApiBackend } from "./api-backend.ts";
import { LiveMinecraftSession } from "./live-session.ts";
import { scenarios, SimulationSession } from "./sim-session.ts";
import { SpeechOutput } from "./speech-output.ts";
import { synthesizeSpeechFixture, synthesizeWindowsSpeech } from "./windows-speech.ts";

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
  const fixture = process.env.MCPAL_TTS_FIXTURE === "1";
  const speech = new SpeechOutput({
    synthesize: fixture ? synthesizeSpeechFixture : synthesizeWindowsSpeech,
    publish: (event) => {
      if (!window.isDestroyed()) window.webContents.send("desktop:speech-event", event);
    },
  });
  const session = new SimulationSession((state) => {
    if (!window.isDestroyed()) window.webContents.send("desktop:state", state);
  }, undefined, {
    api,
    onReply: (reply) => speech.reply(reply),
    onSessionChange: () => speech.cancel(),
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
    if (input.trim().length > 0 && input.trim().length <= 500) speech.cancel();
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
  handle("desktop:test-api", () => session.testApi());
  handle("desktop:select-backend", (backend) => {
    if (backend !== "simulated" && backend !== "api") throw new TypeError("Invalid backend");
    session.setBackend(backend);
  });
  handle("desktop:api-live", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid observation source");
    session.setApiLive(enabled);
  });
  handle("desktop:stop", () => {
    speech.cancel();
    session.stop();
  });
  handle("desktop:speech-fixture", () => fixture);
  handle("desktop:speech-enable", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid speech route");
    speech.setEnabled(enabled);
  });
  handle("desktop:speech-preview", () => speech.preview());
  handle("desktop:speech-cancel", () => speech.cancel());
  handle("desktop:speech-settled", (id) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new TypeError("Invalid speech ID");
    speech.settled(id);
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
    speech.dispose();
    session.dispose();
    live.disconnect();
    app.quit();
  });
  await window.loadURL(page.href);
}
