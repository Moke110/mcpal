import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const defaultSources = { gui: true, minecraft: true };
export type TextSources = typeof defaultSources;

export type MicrophoneSource = { enabled: boolean; deviceId: string; label: string; sender: string };

export interface PalProfile {
  application?: { enabled: boolean; path: string };
  microphone?: MicrophoneSource;
  sources?: TextSources;
  id: string;
  nickname: string;
  backend: "sim" | "api" | "local";
  voice: string;
  login: "offline";
  skin: "classic" | "slim";
}

export class PalProfiles {
  #pending: Promise<unknown> = Promise.resolve();

  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async list(): Promise<PalProfile[]> {
    try {
      const profiles = JSON.parse(await readFile(join(this.directory, "pal-profiles.json"), "utf8")) as PalProfile[];
      return profiles.map(profile => ({ ...profile, sources: { ...defaultSources, ...profile.sources } }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  setTextSource(id: string, key: keyof TextSources, enabled: boolean) {
    return this.#update(id, profile => {
      profile.sources = { ...defaultSources, ...profile.sources, [key]: enabled };
    });
  }

  setApplication(id: string, path: unknown, enabled: unknown) {
    if (typeof enabled !== "boolean" || typeof path !== "string" ||
        !/^[a-z]:\\[^\x00-\x1f]+\.exe$/i.test(path) || path.length > 1024) throw new TypeError("请选择 Windows 应用");
    return this.#update(id, profile => { profile.application = { path, enabled }; });
  }

  setMicrophone(id: string, input: unknown) {
    if (!input || typeof input !== "object") throw new TypeError("麦克风配置无效");
    const { enabled, deviceId, label, sender } = input as Record<string, unknown>;
    if (typeof enabled !== "boolean" || typeof deviceId !== "string" || deviceId.length > 512 ||
        typeof label !== "string" || label.length > 256 || typeof sender !== "string" ||
        sender.length > 100 || (enabled && (!deviceId || !sender.trim()))) throw new TypeError("请选择设备并绑定用户");
    return this.#update(id, profile => { profile.microphone = { enabled, deviceId, label, sender: sender.trim() }; });
  }

  #update(id: string, update: (profile: PalProfile) => void) {
    const operation = this.#pending.then(async () => {
      const profiles = await this.list();
      const profile = profiles.find(item => item.id === id);
      if (!profile) throw new Error("找不到所选伙伴");
      update(profile);
      await this.#save(profiles);
      return profile;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }

  async #save(profiles: PalProfile[]) {
    await mkdir(this.directory, { recursive: true });
    const pending = join(this.directory, "pal-profiles.pending");
    await writeFile(pending, JSON.stringify(profiles, null, 2));
    await rename(pending, join(this.directory, "pal-profiles.json"));
  }

  create(input: unknown): Promise<PalProfile> {
    const operation = this.#pending.then(async () => {
      if (!input || typeof input !== "object") throw new Error("伙伴设置无效");
      const { nickname, backend, voice, login, skin } = input as Record<string, unknown>;
      if (typeof nickname !== "string" || !/^[a-zA-Z0-9_]{1,16}$/.test(nickname) ||
          (backend !== "sim" && backend !== "api" && backend !== "local") ||
          typeof voice !== "string" || !voice.trim() || voice.length > 200 || login !== "offline" || (skin !== "classic" && skin !== "slim")) {
        throw new Error("伙伴设置无效");
      }
      const profile: PalProfile = { id: randomUUID(), nickname, backend, voice, login, skin, sources: { ...defaultSources } };
      await this.#save([...await this.list(), profile]);
      return profile;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
}
