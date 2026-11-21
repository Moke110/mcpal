// The capture worklet supplies 20 ms mono blocks resampled to 16 kHz.
export class EchoGate {
  #history = new Float32Array(8192);
  #cursor = 0;
  #tail = 0;
  #delay = -1;
  #reflections = [];
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
      this.#reflections = [];
      return { clean: mic, speech: !playbackExpected && rms(mic) > 0.023, reference: false, locked: false };
    }

    if (this.#stable < 2) {
      const previous = this.#measure(mic, start, this.#delay);
      const match = previous.score > 0.81 ? previous : this.#findPath(mic, start);
      if (match.score > 0.81) {
        this.#stable = match.delay === this.#delay ? this.#stable + 1 : 1;
        this.#delay = match.delay;
      }
    }

    const locked = this.#stable === 2;
    if (!locked) return { clean: mic, speech: false, reference: true, locked };

    const clean = mic.slice();
    const modeled = [this.#delay, ...this.#reflections];
    let strongestFit = 0;
    // Two coordinate passes jointly fit the known paths and remove residual cross-correlation.
    for (let pass = 0; pass < 2; pass++) {
      for (const delay of modeled) {
        const fit = this.#measure(clean, start, delay);
        strongestFit = Math.max(strongestFit, fit.score);
        if (fit.score < 0.12) continue;
        for (let i = 0; i < clean.length; i++) {
          clean[i] -= fit.gain * this.#history[(start + i - delay) & 8191];
        }
      }
    }
    const residual = rms(clean);
    const echo = rms(mic.map((sample, index) => sample - clean[index]));
    // Suppress weak or unexplained residuals while the playback path is uncertain.
    let speech = (strongestFit > 0.18 || this.#silentReference > 0) &&
      (!playbackExpected || this.#silentReference < 4) && residual > Math.max(0.023, echo * 0.65);
    if (residual > 0.023) {
      const unseen = this.#findPath(clean, start, modeled);
      if (unseen.score > 0.3) {
        // A novel correlated path is evidence of echo. Learn at most one path per block
        // and withhold the whole block while that path is unmodeled.
        this.#reflections.push(unseen.delay);
        if (this.#reflections.length > 7) this.#reflections.shift();
        speech = false;
      }
    }
    return { clean, speech, reference: true, locked };
  }

  #findPath(samples, start, modeled = []) {
    const best = { delay: -1, gain: 0, score: 0 };
    const candidate = { ...best };
    for (let delay = 0; delay <= 5120; delay++) {
      if (modeled.includes(delay)) continue;
      // The sparse scan is only a prefilter; acceptance uses the entire block.
      this.#measure(samples, start, delay, candidate, 5);
      if (candidate.score < 0.21) continue;
      this.#measure(samples, start, delay, candidate);
      if (candidate.score > best.score) {
        best.delay = delay;
        best.gain = candidate.gain;
        best.score = candidate.score;
      }
    }
    return best;
  }

  #measure(mic, start, delay, result = { delay, gain: 0, score: 0 }, stride = 1) {
    let dot = 0;
    let x = 0;
    let y = 0;
    if (delay >= 0) {
      for (let index = 0; index < mic.length; index += stride) {
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
