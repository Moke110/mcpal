import { EchoGate } from "./echo-gate.js";

class OpenMic extends AudioWorkletProcessor {
  #aec = new EchoGate();
  #mic = new Float32Array(320);
  #ref = new Float32Array(320);
  #used = 0;
  #phase = 0;
  #micSum = 0;
  #refSum = 0;
  #count = 0;
  #candidate = [];
  #speaking = false;
  #lastVoice = 0;
  #silent = 0;
  #blocks = 0;
  #missing = 0;
  #quarantine = 0;
  #playbackExpected = false;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (typeof data === "boolean") {
        this.#playbackExpected = data;
        return;
      }
      this.#candidate = [];
      this.#speaking = false;
      this.#quarantine = 20;
    };
  }

  process([micChannels, referenceChannels]) {
    const mic = micChannels[0];
    const reference = referenceChannels[0];
    if (!mic) {
      if (++this.#missing > sampleRate / 128) this.port.postMessage({ fault: true });
      return true;
    }
    this.#missing = 0;
    for (let i = 0; i < mic.length; i++) {
      this.#micSum += mic[i];
      this.#refSum += reference?.[i] ?? 0;
      this.#count++;
      this.#phase += 16000;
      if (this.#phase < sampleRate) continue;
      this.#phase -= sampleRate;
      this.#mic[this.#used] = this.#micSum / this.#count;
      this.#ref[this.#used++] = this.#refSum / this.#count;
      this.#micSum = this.#refSum = this.#count = 0;
      if (this.#used === 320) {
        this.#used = 0;
        this.#block(currentTime + i / sampleRate);
      }
    }
    return true;
  }

  #block(at) {
    const { clean, speech, reference, locked } = this.#aec.process(this.#mic, this.#ref, this.#playbackExpected);
    if (++this.#blocks % 5 === 0) this.port.postMessage({ reference, locked });
    if (this.#quarantine > 0) {
      this.#quarantine--;
      return;
    }
    if (!speech) {
      this.#candidate = [];
      if (this.#speaking && ++this.#silent >= 18) {
        this.#speaking = false;
        this.port.postMessage({ end: at, lastVoice: this.#lastVoice });
      } else if (this.#speaking) {
        this.#send(new Float32Array(320));
      }
      return;
    }
    this.#lastVoice = at;
    this.#silent = 0;
    if (this.#speaking) {
      this.#send(clean);
      return;
    }
    this.#candidate.push(clean.slice());
    if (this.#candidate.length < 5) return;
    this.#speaking = true;
    this.port.postMessage({ start: at - 0.08 });
    for (const block of this.#candidate) this.#send(block);
    this.#candidate = [];
  }

  #send(samples) {
    const pcm = new Uint8Array(samples.length * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
    }
    this.port.postMessage({ pcm }, [pcm.buffer]);
  }
}

registerProcessor("open-mic", OpenMic);
