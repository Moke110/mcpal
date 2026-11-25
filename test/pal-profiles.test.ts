import { deepEqual, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PalProfiles } from "../src/gui/pal-profiles.ts";

test("offline Pal settings remain available when the desktop restarts", async () => {
  await mkdir("tmp", { recursive: true });
  const directory = await mkdtemp(join("tmp", "pal-profiles-"));
  try {
    const profiles = new PalProfiles(directory);
    const input = { nickname: "Alex", backend: "local", voice: "Microsoft Huihui Desktop", login: "offline", skin: "slim" };
    deepEqual(await profiles.list(), []);
    const created = await profiles.create(input);
    deepEqual(await new PalProfiles(directory).list(), [created]);
    deepEqual(created.sources, { gui: true, minecraft: true });
    await profiles.setTextSource(created.id, "gui", false);
    deepEqual((await new PalProfiles(directory).list())[0]?.sources, { gui: false, minecraft: true });
    await rejects(profiles.create({ ...input, login: "online" }));
  } finally {
    await rm(directory, { recursive: true });
  }
});
