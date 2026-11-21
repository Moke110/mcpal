import type { Bot } from "mineflayer";
import type { Position } from "./perception.ts";

type WorldView = {
  eye: Position;
  yaw: number;
  pitch: number;
  dimension: string | null;
  origin: Position;
  width: number;
  height: number;
  palette: string[];
  voxels: Uint16Array;
};

const radius = 12;
const width = radius * 2 + 1;
const height = 17;

export function readWorldView(bot: Bot, hasColumn: (x: number, z: number) => boolean): WorldView | null {
  const { position, eyeHeight, yaw, pitch } = bot.entity as Bot["entity"] & { eyeHeight: number };
  const eye = position.offset(0, eyeHeight, 0);
  if (![eye.x, eye.y, eye.z, yaw, pitch].every(Number.isFinite) || !hasColumn(eye.x, eye.z)) return null;

  const origin = eye.floored().offset(-radius, -8, -radius);
  const palette = ["unknown", "air"];
  const indices = new Map([["air", 1], ["cave_air", 1], ["void_air", 1]]);
  const voxels = new Uint16Array(width * width * height);
  const cursor = origin.clone();
  for (let z = 0; z < width; z++) {
    cursor.z = origin.z + z;
    for (let x = 0; x < width; x++) {
      cursor.x = origin.x + x;
      if (!hasColumn(cursor.x, cursor.z)) continue;
      for (let y = 0; y < height; y++) {
        cursor.y = origin.y + y;
        const name = bot.blockAt(cursor, false)?.name;
        if (!name) continue;
        let index = indices.get(name);
        if (index === undefined) {
          index = palette.length;
          palette.push(name);
          indices.set(name, index);
        }
        voxels[(y * width + z) * width + x] = index;
      }
    }
  }
  return {
    eye: { x: eye.x, y: eye.y, z: eye.z }, yaw, pitch, dimension: bot.game.dimension ?? null,
    origin: { x: origin.x, y: origin.y, z: origin.z }, width, height, palette, voxels,
  };
}
