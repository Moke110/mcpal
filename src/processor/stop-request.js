/** @param {string} text */
export function isStopRequest(text) {
  return /^(?:请\s*)?停止(?:跟随)?[。！!\s]*$/u.test(text);
}
