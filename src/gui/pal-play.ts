import type { PalProfile } from "./pal-profiles.ts";

export function offlinePlaySettings(profile: PalProfile, address: unknown) {
  if (!address || typeof address !== "object") throw new Error("请填写 Minecraft 地址和端口。");
  const { host, port, offlineControl } = address as Record<string, unknown>;
  if (typeof host !== "string" || !host.trim() || host.length > 255 ||
      typeof port !== "string" || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("请填写有效的 Minecraft 地址和端口（1–65535）。");
  }
  return { host: host.trim(), port, username: profile.nickname, auth: profile.login, offlineControl: offlineControl === true };
}
