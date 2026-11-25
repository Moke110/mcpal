import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { createStateExpressor } from "../expressor/state-expressor.ts";
import { createTextSensor } from "../sensor/text-sensor.ts";
import { connect } from "../client.ts";
import { createApiBackend } from "../processor/api-backend.ts";
import { createLocalBackend } from "../processor/llama-server.ts";
import { PalProfiles, type PalProfile } from "../gui/pal-profiles.ts";
import { ApplicationAudio } from "../sensor/application-audio.ts";
import { captureApplication, listAudioApplications } from "../sensor/process-loopback.ts";
import { Microphone } from "../sensor/microphone.ts";
import { MessageCache } from "../sensor/message-cache.ts";
import { openLocalFixture } from "../processor/local-fixture.ts";
import { offlinePlaySettings } from "../gui/pal-play.ts";
import { LiveMinecraftSession } from "../sensor/live-session.ts";
import { scenarios, SimulationSession } from "../processor/sim-session.ts";
import { SpeechOutput } from "../expressor/speech-output.ts";
import { VoiceInput } from "../sensor/voice-input.ts";
import { openAsrFixture, openVosk } from "../sensor/vosk-asr.ts";
import { listWindowsVoices, synthesizeSpeechFixture, synthesizeWindowsSpeech } from "../expressor/windows-speech.ts";

const dataPath = process.env.MCPAL_DESKTOP_DATA;
if (dataPath) app.setPath("userData", dataPath);
app.on("window-all-closed", () => {}); // The closed handler confirms model reclamation before quitting.

void app.whenReady().then(startDesktop).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

async function startDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    title: "MC-Pal",
    frame: false,
    width: 1120,
    height: 800,
    minWidth: 600,
    minHeight: 540,
    backgroundColor: "#f3f2eb",
    webPreferences: {
      preload: fileURLToPath(new URL("../gui/preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const publishWindowState = () => {
    if (!window.isDestroyed()) window.webContents.send("desktop:window-maximized", window.isMaximized());
  };
  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);

  const page = new URL("../gui/index.html", import.meta.url);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    if (app.isPackaged) loadEnvFile(join(app.getPath("userData"), ".env"));
    else loadEnvFile();
  } catch {
    // API setup is optional. The GUI reports missing settings.
  }
  const api = createApiBackend(process.env);
  const localFixture = process.env.MCPAL_LOCAL_FIXTURE;
  const expressState = createStateExpressor<ReturnType<SimulationSession["snapshot"]>>(
    (state) => window.webContents.send("desktop:state", state),
    () => !window.isDestroyed(),
  );
  const publish = () => expressState(session.snapshot());
  const local = localFixture === "1" || localFixture === "over-budget"
    ? openLocalFixture(publish, localFixture === "over-budget")
    : createLocalBackend(process.env, publish);
  const fixture = process.env.MCPAL_TTS_FIXTURE === "1";
  let palVoice = "default";
  const speech = new SpeechOutput({
    synthesize: fixture ? synthesizeSpeechFixture : (text, signal) => synthesizeWindowsSpeech(text, signal, palVoice),
    publish: (event) => {
      if (!window.isDestroyed()) window.webContents.send("desktop:speech-event", event);
    },
  });
  const session = new SimulationSession(expressState, undefined, {
    api,
    local,
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
  const senseText = createTextSensor((text, source) => session.submitText(text, source));
  const asrFixture = process.env.MCPAL_ASR_FIXTURE === "1";
  let openMicEnabled = false;
  const voice = new VoiceInput({
    open: (events, mode) => asrFixture ? openAsrFixture(events, mode) : openVosk(events, process.env),
    publish: (state) => {
      if (!window.isDestroyed()) window.webContents.send("desktop:asr-state", state);
    },
    interrupt: () => speech.cancel(),
    now: () => performance.timeOrigin + performance.now(),
    window: () => session.nextInputWindow(),
    submit: (text) => senseText(text, "voice"),
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, decide, details) => {
    decide(contents === window.webContents && permission === "media" &&
      details.isMainFrame && details.requestingUrl === page.href &&
      "mediaTypes" in details && details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === "audio" &&
      (microphone.enabled || Date.now() < microphoneDiscoveryUntil || !asrFixture && openMicEnabled || voice.snapshot().phase === "recording"));
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

  const profiles = new PalProfiles(app.getPath("userData"));
  let debugWindow: BrowserWindow | null = null;
  const cache = new MessageCache(messages => debugWindow?.webContents.send("sensor:messages", messages));
  let activeProfile: PalProfile | undefined;
  let appendMessage: ReturnType<MessageCache["begin"]> | undefined;

  let microphoneDiscoveryUntil = 0;
  const microphone = new Microphone(events => openVosk(events, process.env), event => {
    if (!window.isDestroyed()) window.webContents.send("sensor:microphone-command", { ...event, profileId: activeProfile?.id });
  });
  let applicationState = { profileId: "", status: "未监听" };
  const application = new ApplicationAudio(captureApplication, events => openVosk(events, process.env), status => {
    applicationState = { profileId: activeProfile?.id || "", status };
    if (!window.isDestroyed()) window.webContents.send("sensor:application-state", applicationState);
  });
  function startApplication(profile: PalProfile) {
    const source = profile.application;
    const append = appendMessage;
    if (source?.enabled && append) application.start(source.path,
      text => append("应用 · " + basename(source.path), "未知发言人", text));
  }
  handle("sensor:applications", listAudioApplications);
  handle("sensor:application-status", () => applicationState);
  handle("sensor:application-set", async (id, path, enabled) => {
    if (typeof id !== "string") throw new TypeError("Invalid Pal");
    const profile = await profiles.setApplication(id, path, enabled);
    await transition(async () => {
      if (activeProfile?.id !== id) return;
      await application.stop();
      activeProfile = profile;
      startApplication(profile);
    });
    return profile.application;
  });
  let transitioning = Promise.resolve();
  function transition(change: () => Promise<void>) {
    const next = transitioning.then(change);
    transitioning = next.catch(() => {});
    return next;
  }
  function startMicrophone(profile: PalProfile) {
    const source = profile.microphone;
    const append = appendMessage;
    if (source?.enabled && append) microphone.start(source, text => append("麦克风 · " + source.label, source.sender, text));
  }
  handle("sensor:microphone-discover", () => { microphoneDiscoveryUntil = Date.now() + 5000; });
  handle("sensor:microphone-ready", token => microphone.ready(token));
  handle("sensor:microphone-audio", (token, pcm) => microphone.audio(token, pcm));
  handle("sensor:microphone-lost", token => microphone.lost(token));
  handle("sensor:microphone-flushed", token => microphone.flushed(token));
  handle("sensor:microphone-set", async (id, input) => {
    if (typeof id !== "string") throw new TypeError("Invalid Pal");
    const profile = await profiles.setMicrophone(id, input);
    await transition(async () => {
      if (activeProfile?.id !== id) return;
      await microphone.stop();
      activeProfile = profile;
      startMicrophone(profile);
    });
    return profile.microphone;
  });

  function startSensor(profile: PalProfile) {
    return transition(async () => {
      await Promise.all([microphone.stop(), application.stop()]);
      activeProfile = profile;
      appendMessage = cache.begin();
      startMicrophone(profile);
      startApplication(profile);
    });
  }
  function endSensor() {
    return transition(async () => {
      await Promise.all([microphone.stop(), application.stop()]);
      activeProfile = undefined;
      appendMessage = undefined;
      cache.end();
    });
  }

  handle("sensor:debug", async () => {
    if (debugWindow) { debugWindow.show(); return; }
    const viewer = new BrowserWindow({ parent: window, title: "感受器消息", width: 720, height: 450,
      backgroundColor: "#161a1c", webPreferences: {
        preload: fileURLToPath(new URL("../gui/sensor-debug-preload.cjs", import.meta.url)),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      } });
    debugWindow = viewer;
    viewer.on("closed", () => { debugWindow = null; });
    viewer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    viewer.webContents.on("will-navigate", event => event.preventDefault());
    await viewer.loadURL(new URL("../gui/sensor-debug.html", import.meta.url).href);
    if (!viewer.isDestroyed()) viewer.webContents.send("sensor:messages", cache.snapshot());
  });
  handle("sensor:text-source", async (id, key, enabled) => {
    if (typeof id !== "string" || (key !== "gui" && key !== "minecraft") || typeof enabled !== "boolean")
      throw new TypeError("Invalid text source");
    const profile = await profiles.setTextSource(id, key, enabled);
    if (activeProfile?.id === id) activeProfile = profile;
    return profile.sources;
  });
  handle("pal:list", () => profiles.list());
  handle("pal:voices", () => listWindowsVoices());
  handle("pal:create", (input) => profiles.create(input));
  handle("pal:start-chat", async (id) => {
    const profile = (await profiles.list()).find((pal) => pal.id === id);
    if (!profile) throw new Error("找不到所选伙伴");
    if (live.snapshot().active) throw new Error("请先结束 Minecraft 陪玩");
    session.startDesktopChat(profile.backend === "sim" ? "simulated" : profile.backend);
    await startSensor(profile);
    palVoice = profile.voice;
    if (profile.backend === "local") void session.startLocal();
  });
  handle("desktop:window-control", (action) => {
    switch (action) {
      case "minimize": window.minimize(); break;
      case "toggle-maximize":
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      case "close": window.close(); break;
      default: throw new TypeError("Invalid window action");
    }
  });
  handle("desktop:snapshot", () => session.snapshot());
  handle("desktop:settings-folder", async () => {
    const path = app.getPath("userData");
    await mkdir(path, { recursive: true });
    if (await shell.openPath(path)) throw new Error("无法打开本机设置目录");
  });
  handle("desktop:submit", (input, source) => {
    if (source === "gui" && activeProfile) {
      if (!activeProfile.sources?.gui) return;
      if (typeof input === "string") appendMessage?.("GUI", "桌面操作者", input);
    }
    senseText(input, source);
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
    if (backend !== "simulated" && backend !== "api" && backend !== "local") throw new TypeError("Invalid backend");
    session.setBackend(backend);
  });
  handle("desktop:start-local", () => session.startLocal());
  handle("desktop:stop-local", () => session.stopLocal());
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
  handle("desktop:asr-config", () => ({
    fixture: asrFixture, openMicFixture: asrFixture && fixture, configured: !!process.env.MCPAL_ASR_MODEL,
  }));
  handle("desktop:asr-enable", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid ASR route");
    if (!enabled) openMicEnabled = false;
    voice.setEnabled(enabled);
  });
  handle("desktop:open-mic-enable", (enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Invalid open microphone setting");
    openMicEnabled = enabled && voice.snapshot().enabled &&
      (asrFixture ? fixture : !!process.env.MCPAL_ASR_MODEL);
    if (!openMicEnabled) voice.cancelOpenMic();
    return openMicEnabled;
  });
  handle("desktop:asr-start", (mode, token, openMic = false) => {
    if (typeof token !== "string" || token.length !== 36) throw new TypeError("Invalid capture token");
    if (typeof openMic !== "boolean" || (openMic && !openMicEnabled)) return null;
    return voice.start(asrFixture && typeof mode === "string" ? mode : "", token, openMic);
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
  let palPlayActive = false;
  const live = new LiveMinecraftSession((state) => {
    if (palPlayActive && (state.phase === "disconnecting" || state.phase === "disconnected" || state.phase === "failed")) {
      palPlayActive = false;
      palVoice = "default";
      endSensor();
      session.endPalPlay();
    }
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
  }), (message) => {
    if (activeProfile) {
      if (activeProfile.sources?.minecraft) appendMessage?.("Minecraft 聊天", message.player, message.text);
      return;
    }
    const request = /^!pal\s+([\s\S]+)$/iu.exec(message.text.trim())?.[1]?.trim();
    if (request) session.submitMinecraft({ ...message, text: request });
  });
  handle("minecraft:snapshot", () => live.snapshot());
  handle("minecraft:view", () => live.readView());
  handle("minecraft:connect", (settings) => live.open(settings));
  handle("minecraft:play-pal", async (profileId, address) => {
    const profile = (await profiles.list()).find(({ id }) => id === profileId);
    if (!profile) throw new Error("找不到已保存的伙伴。");
    if (live.snapshot().active) throw new Error("请先断开当前 Minecraft 连接。");
    const settings = offlinePlaySettings(profile, address);
    const allowApi = typeof address === "object" && address !== null &&
      "allowApi" in address && address.allowApi === true;
    session.startPalPlay(profile.backend === "sim" ? "simulated" : profile.backend, allowApi);
    await startSensor(profile);
    palPlayActive = true;
    palVoice = profile.voice;
    if (profile.backend === "local") void session.startLocal();
    live.open(settings, !settings.offlineControl);
  });
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
  let closing = false;
  window.on("close", event => {
    if (closing) return;
    event.preventDefault();
    void endSensor().finally(() => { closing = true; window.close(); });
  });
  window.on("closed", () => {
    voice.cancel();
    speech.dispose();
    session.dispose();
    live.disconnect();
    if (local) void local.stop().finally(() => app.quit());
    else app.quit();
  });
  await window.loadURL(page.href);
}
