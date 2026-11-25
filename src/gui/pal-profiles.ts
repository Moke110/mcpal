import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const defaultSources = { gui: true, minecraft: true };
export type TextSources = typeof defaultSources;

export interface PalProfile {
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
    const operation = this.#pending.then(async () => {
      const profiles = await this.list();
      const profile = profiles.find(item => item.id === id);
      if (!profile) throw new Error("找不到所选伙伴");
      profile.sources = { ...defaultSources, ...profile.sources, [key]: enabled };
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
