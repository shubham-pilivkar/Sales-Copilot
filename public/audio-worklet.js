// AudioWorklet processor — resamples to the target rate, extracts Int16 PCM,
// and posts fixed-size chunks to the main thread.
// Runs in the audio thread for zero-latency, jank-free processing.
// Pattern from chrome_extension/public/transcribe-worklet.js

class CopilotAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // The backend (Deepgram) is told the audio is `targetRate`. The AudioContext
    // may not honor a requested 16kHz on every platform, so `sampleRate` (the
    // AudioWorkletGlobalScope global = actual context rate) can differ. We
    // resample on the fly so the PCM we emit always matches `targetRate`.
    this._targetRate = opts.targetRate || 16000;
    this._inputRate = sampleRate; // actual context rate
    this._ratio = this._inputRate / this._targetRate; // input samples per output sample
    this._chunkSize = Math.round(this._targetRate * 0.1); // 100ms @ target rate

    // Pre-sized accumulator + write index — no per-quantum reallocation.
    this._acc = new Float32Array(this._chunkSize);
    this._accLen = 0;

    // Streaming linear-resampler state.
    this._outPos = 0;  // fractional read position into the current input block
    this._prev = 0;    // last sample of the previous block (for boundary interp)
  }

  _pushSample(v) {
    this._acc[this._accLen++] = v;
    if (this._accLen === this._chunkSize) {
      const int16 = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const s = Math.max(-1, Math.min(1, this._acc[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
      this._accLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const block = input[0];
    const L = block.length;
    const ratio = this._ratio;
    // sampleAt(-1) -> previous block's last sample; sampleAt(i) -> block[i].
    const sampleAt = (idx) => (idx < 0 ? this._prev : block[idx]);

    // Produce output samples while both interpolation neighbours are available.
    while (true) {
      const i0 = Math.floor(this._outPos);
      const i1 = i0 + 1;
      if (i1 > L - 1) break; // need the next block to interpolate
      const frac = this._outPos - i0;
      this._pushSample(sampleAt(i0) * (1 - frac) + sampleAt(i1) * frac);
      this._outPos += ratio;
    }

    // Rebase position for the next block and remember the boundary sample.
    this._outPos -= L;
    this._prev = block[L - 1];
    return true;
  }
}

registerProcessor('copilot-audio-processor', CopilotAudioProcessor);
