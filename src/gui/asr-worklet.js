class AsrCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 16000 / sampleRate;
    this.bucket = new Int16Array(800);
    this.count = 0;
    this.phase = 0;
    this.sum = 0;
    this.samples = 0;
    this.lastVoice = null;
    this.active = true;
    this.port.onmessage = () => {
      this.active = false;
      this.send();
      this.port.postMessage({ done: true, lastVoice: this.lastVoice });
    };
  }

  send() {
    if (!this.count) return;
    const pcm = new Uint8Array(this.count * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < this.count; i++) view.setInt16(i * 2, this.bucket[i], true);
    this.port.postMessage({ pcm }, [pcm.buffer]);
    this.count = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const mono = inputs[0]?.[0];
    if (!mono?.length) return true;
    let energy = 0;
    for (const sample of mono) {
      energy += sample * sample;
      this.sum += sample;
      this.samples++;
      this.phase += this.ratio;
      while (this.phase >= 1) {
        this.phase--;
        const average = this.samples > 0 ? this.sum / this.samples : sample;
        this.bucket[this.count++] = Math.round(Math.max(-1, Math.min(1, average)) * 32767);
        if (this.count === this.bucket.length) this.send();
        this.sum = 0;
        this.samples = 0;
      }
    }
    if (Math.sqrt(energy / mono.length) >= 0.018) this.lastVoice = currentTime + mono.length / sampleRate;
    return true;
  }
}

registerProcessor("asr-capture", AsrCapture);
