class SpeechFrames extends AudioWorkletProcessor {
  samples = null;
  offset = 0;
  last = null;
  first = false;

  constructor(options) {
    super();
    this.samples = options.processorOptions.samples;
    this.port.onmessage = () => this.settle(true);
  }

  settle(cancelled) {
    if (!this.samples) return;
    this.samples = null;
    this.port.postMessage({ lastFrame: this.last, cancelled });
  }

  process(_inputs, [[output]]) {
    if (!this.samples) return false;
    const frames = this.samples.subarray(this.offset, this.offset + output.length);
    output.set(frames);
    if (!this.first) {
      const position = frames.findIndex((sample) => sample !== 0);
      if (position >= 0) {
        this.first = true;
        this.port.postMessage({ firstFrame: currentFrame + position });
      }
    }
    this.offset += frames.length;
    this.last = currentFrame + frames.length - 1;
    if (this.offset >= this.samples.length) this.settle(false);
    return this.samples !== null;
  }
}

registerProcessor("companion-speech-frames", SpeechFrames);
