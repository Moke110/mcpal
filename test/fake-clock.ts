import type { WindowClock } from "../src/desktop/read-window.ts";

export function fakeClock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  const clock: WindowClock = {
    now: () => now,
    after(delay, callback) {
      timers.set(callback, now + delay);
      return () => { timers.delete(callback); };
    },
  };
  return {
    clock,
    advance(target: number) {
      while (true) {
        const next = [...timers].sort((left, right) => left[1] - right[1])[0];
        if (!next || next[1] > target) break;
        const [callback, time] = next;
        timers.delete(callback);
        now = time;
        callback();
      }
      now = target;
    },
  };
}
