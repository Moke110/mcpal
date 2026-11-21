// The capture worklet supplies 20 ms mono blocks resampled to 16 kHz.
export class EchoGate {
  #history = new Float32Array(8192);
  #cursor = 0;
  #tail = 0;
  #delay = -1;
  #gain = 0;
  #reflection = null;
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
      this.#reflection = null;
      return { clean: mic, speech: !playbackExpected && rms(mic) > 0.023, reference: false, locked: false };
    }

    const previous = this.#measure(mic, start, this.#delay);
    const match = previous.score < 0.81 ? this.#findPath(mic, start) : previous;
    const replacing = this.#stable === 2 && match.delay !== this.#delay;
    if (match.score > (replacing ? 0.94 : 0.81)) {
      if (match.delay !== this.#delay) {
        this.#stable = 0;
        this.#reflection = null;
      }
      this.#delay = match.delay;
      this.#gain = match.gain;
      this.#stable = Math.min(this.#stable + 1, 2);
    }

    const locked = this.#stable === 2;
    const primary = match.delay === this.#delay ? match : previous;
    let clean = locked && primary.score > 0.18 ? this.#subtract(mic, start, this.#delay, this.#gain) : mic;
    let uncertain = locked && primary.score <= 0.18 && this.#silentReference === 0;
    if (locked && rms(clean) > 0.023) {
      const strongest = this.#findPath(clean, start);
      if (strongest.score > 0.64 && strongest.delay !== this.#delay) {
        this.#reflection = strongest;
        clean = this.#subtract(clean, start, strongest.delay, strongest.gain);
        // Withhold residuals still correlated with playback after both projections.
        uncertain ||= rms(clean) > 0.023 && this.#findPath(clean, start).score > 0.6;
      } else if (this.#reflection) {
        const check = this.#measure(clean, start, this.#reflection.delay);
        if (check.score > 0.23 && check.gain * this.#reflection.gain > 0) {
          clean = this.#subtract(clean, start, this.#reflection.delay, this.#reflection.gain);
        }
      }
    }
    const echo = locked ? rms(mic.map((sample, index) => sample - clean[index])) : 0;
    // A weak residual is consistent with an imperfect estimate of the loudspeaker path.
    const speech = locked && !uncertain && (!playbackExpected || this.#silentReference < 4) &&
      rms(clean) > Math.max(0.023, echo * 0.75);
    return { clean, speech, reference: true, locked };
  }

  #findPath(samples, start) {
    const best = { delay: -1, gain: 0, score: 0 };
    const candidate = { ...best };
    for (let delay = 0; delay <= 5120; delay++) {
      this.#measure(samples, start, delay, candidate);
      if (candidate.score > best.score) {
        best.delay = delay;
        best.gain = candidate.gain;
        best.score = candidate.score;
      }
    }
    return best;
  }

  #subtract(samples, start, delay, gain) {
    return samples.map((sample, index) => sample - gain * this.#history[(start + index - delay) & 8191]);
  }

  #measure(mic, start, delay, result = { delay, gain: 0, score: 0 }) {
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
    result.delay = delay;
    result.gain = gain;
    result.score = Math.abs(gain) >= 0.015 && Math.abs(gain) <= 4 ? Math.abs(dot) / Math.sqrt(x * y) : 0;
    return result;
  }
}

function rms(samples) {
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}
