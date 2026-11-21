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
import { VoiceInput } from "./voice-input.ts";
import { openAsrFixture, openVosk } from "./vosk-asr.ts";
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
    onInputAccepted: () => {
      speech.cancel();
      voice.cancel();
    },
    onSessionChange: () => {
      speech.cancel();
      voice.cancel();
    },
    invalidateLiveReplacement: () => live.invalidateReplacement(),
    minecraftReplyRoute: () => live.chatReplyRoute(),
    minecraftReply: (route, reply) => live.sendChatReply(route, reply),
    liveAction: (intent) => {
      if (intent.kind === "follow") live.replaceFollow(intent.target);
      if (intent.kind === "stop") live.stop();
    },
  });
  const asrFixture = process.env.MCPAL_ASR_FIXTURE === "1";
  const voice = new VoiceInput({
    open: (events, mode) => asrFixture ? openAsrFixture(events, mode) : openVosk(events, process.env),
    publish: (state) => {
      if (!window.isDestroyed()) window.webContents.send("desktop:asr-state", state);
    },
    interrupt: () => speech.cancel(),
    now: () => performance.timeOrigin + performance.now(),
    window: () => session.nextInputWindow(),
    submit: (text) => session.submitText(text, "voice"),
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, decide, details) => {
    decide(contents === window.webContents && permission === "media" &&
      details.isMainFrame && details.requestingUrl === page.href &&
      "mediaTypes" in details && details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === "audio" && voice.snapshot().phase === "recording");
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
    voice.cancel();
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
  handle("desktop:asr-config", () => ({ fixture: asrFixture, configured: !!process.env.MCPAL_ASR_MODEL }));
  handle("desktop:asr-enable", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid ASR route");
    voice.setEnabled(enabled);
  });
  handle("desktop:asr-start", (mode, token) => {
    if (typeof token !== "string" || token.length !== 36) throw new TypeError("Invalid capture token");
    return voice.start(asrFixture && typeof mode === "string" ? mode : "", token);
  });
  handle("desktop:asr-audio", (id, pcm) => {
    if (typeof id === "number" && pcm instanceof Uint8Array) voice.write(id, pcm);
  });
  handle("desktop:asr-release", (id, voicedAt, releasedAt) => {
    if (typeof id === "number" && (voicedAt === null || typeof voicedAt === "number") && typeof releasedAt === "number") {
      voice.release(id, voicedAt, releasedAt);
    }
  });
  handle("desktop:asr-cancel", (id) => {
    if (id === undefined || typeof id === "number") voice.cancel(id);
  });
  handle("desktop:asr-device-error", (id) => {
    if (typeof id === "number") voice.fail(id, "无法采集麦克风，请检查设备和 Windows 权限。");
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
  }, (config, report, authPrompt, options) => connect(config, report, authPrompt, {
    ...options,
    profilesFolder: join(app.getPath("userData"), "minecraft-profiles"),
  }), (message) => session.submitMinecraft(message));
  handle("minecraft:snapshot", () => live.snapshot());
  handle("minecraft:connect", (settings) => live.open(settings));
  handle("minecraft:disconnect", () => live.disconnect());
  handle("minecraft:follow", (target) => live.follow(target));
  handle("minecraft:stop", () => {
    voice.cancel();
    live.stop();
  });
  handle("minecraft:chat-route", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid Minecraft reply route");
    live.setChatRoute(enabled);
  });
  window.on("closed", () => {
    voice.cancel();
    speech.dispose();
    session.dispose();
    live.disconnect();
    app.quit();
  });
  await window.loadURL(page.href);
}
