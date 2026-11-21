// The capture worklet supplies 20 ms mono blocks resampled to 16 kHz.
export class EchoGate {
  #history = new Float32Array(8192);
  #cursor = 0;
  #tail = 0;
  #delay = -1;
  #gain = 0;
  #stable = 0;
  #silentReference = 0;

  /** @param {Float32Array} mic @param {Float32Array} output */
  process(mic, output, playbackExpected = false) {
    let referenceEnergy = 0;
    const start = this.#cursor;
    for (const sample of output) {
      this.#history[this.#cursor++ & 8191] = sample;
      referenceEnergy += sample * sample;
    }
    // Keep the reference quarantine past the last loudspeaker frame.
    if (referenceEnergy > 1e-8) {
      this.#tail = 18;
      this.#silentReference = 0;
    } else {
      this.#silentReference++;
      if (this.#tail > 0) this.#tail--;
    }
    if (!this.#tail) {
      this.#stable = 0;
      this.#delay = -1;
      return { clean: mic, speech: !playbackExpected && rms(mic) > 0.023, reference: false, locked: false };
    }

    let match = this.#measure(mic, start, this.#delay);
    if (match.score < 0.81) {
      for (let delay = 0; delay <= 5120; delay++) {
        const candidate = this.#measure(mic, start, delay);
        if (candidate.score > match.score) match = candidate;
      }
    }
    if (match.score > 0.81) {
      if (match.delay !== this.#delay) this.#stable = 0;
      this.#delay = match.delay;
      this.#gain = match.gain;
      this.#stable = Math.min(this.#stable + 1, 2);
    }

    const locked = this.#stable === 2;
    const clean = mic.map((sample, index) =>
      sample - (locked ? this.#gain * this.#history[(start + index - this.#delay) & 8191] : 0));
    const echo = locked ? rms(mic.map((sample, index) => sample - clean[index])) : 0;
    // A weak residual is consistent with an imperfect estimate of the loudspeaker path.
    const speech = locked && (!playbackExpected || this.#silentReference < 4) &&
      rms(clean) > Math.max(0.023, echo * 0.75);
    return { clean, speech, reference: true, locked };
  }

  #measure(mic, start, delay) {
    let dot = 0;
    let x = 0;
    let y = 0;
    if (delay >= 0) {
      for (let index = 0; index < mic.length; index += 5) {
        const reference = this.#history[(start + index - delay) & 8191];
        dot += mic[index] * reference;
        x += reference * reference;
        y += mic[index] * mic[index];
      }
    }
    const gain = x > 0 ? dot / x : 0;
    return { delay, gain, score: Math.abs(gain) >= 0.015 && Math.abs(gain) <= 4 ? Math.abs(dot) / Math.sqrt(x * y) : 0 };
  }
}

function rms(samples) {
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}
