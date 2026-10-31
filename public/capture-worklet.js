// Recebe 2 canais (0 = microfone, 1 = áudio do computador), reamostra para 16 kHz
// e envia blocos PCM 16 bits estéreo intercalados para a página.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; // quantas amostras de entrada por amostra de saída
    this.pos = 0;
    this.blockLength = 16000 * 2 * 0.25; // blocos de 250 ms (estéreo)
    this.out = new Int16Array(this.blockLength);
    this.n = 0;
    this.peak = [0, 0];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const a = input[0];
    const b = input[1] || null;
    const len = a.length;
    while (this.pos < len) {
      const i = Math.floor(this.pos);
      const x = a[i];
      const y = b ? b[i] : 0;
      this.peak[0] = Math.max(this.peak[0], Math.abs(x));
      this.peak[1] = Math.max(this.peak[1], Math.abs(y));
      this.out[this.n++] = Math.max(-1, Math.min(1, x)) * 32767;
      this.out[this.n++] = Math.max(-1, Math.min(1, y)) * 32767;
      if (this.n === this.blockLength) {
        // O buffer é transferido (fica com tamanho 0 aqui), então o próximo usa o tamanho guardado.
        this.port.postMessage({ pcm: this.out, peak: this.peak }, [this.out.buffer]);
        this.out = new Int16Array(this.blockLength);
        this.n = 0;
        this.peak = [0, 0];
      }
      this.pos += this.step;
    }
    this.pos -= len;
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
