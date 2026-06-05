// AudioWorklet processor — extracts Int16 PCM and posts to main thread.
// Runs in the audio thread for zero-latency, jank-free processing.
// Pattern from chrome_extension/public/transcribe-worklet.js

class CopilotAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._chunkSize = 1600; // 100ms at 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];

    // Accumulate
    const newBuf = new Float32Array(this._buffer.length + samples.length);
    newBuf.set(this._buffer);
    newBuf.set(samples, this._buffer.length);
    this._buffer = newBuf;

    // Emit chunks
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.slice(0, this._chunkSize);
      this._buffer = this._buffer.slice(this._chunkSize);

      // float32 → int16
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true;
  }
}

registerProcessor('copilot-audio-processor', CopilotAudioProcessor);
