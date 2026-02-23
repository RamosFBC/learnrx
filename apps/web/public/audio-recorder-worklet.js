class AudioProcessingWorklet extends AudioWorkletProcessor {
  buffer = new Int16Array(2048);
  bufferWriteIndex = 0;
  constructor() {
    super();
  }
  process(inputs) {
    if (inputs[0].length) {
      const channel0 = inputs[0][0];
      this.processChunk(channel0);
    }
    return true;
  }
  sendAndClearBuffer() {
    this.port.postMessage({
      event: 'chunk',
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer
      }
    });
    this.bufferWriteIndex = 0;
  }
  processChunk(float32Array) {
    const l = float32Array.length;
    for (let i = 0; i < l; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      this.buffer[this.bufferWriteIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      if(this.bufferWriteIndex >= this.buffer.length) {
        this.sendAndClearBuffer();
      }
    }
  }
}
registerProcessor('audio-recorder-worklet', AudioProcessingWorklet);
