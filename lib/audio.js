// Utilitários de áudio: WAV PCM 16 bits e corte em trechos nas pausas da fala.
const fs = require("node:fs");

const RATE = 16000;

function wavHeader(dataBytes, channels, rate = RATE) {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

// Reescreve o cabeçalho com o tamanho final (o arquivo é gravado incrementalmente).
function finalizeWav(file, channels) {
  if (!fs.existsSync(file)) return 0;
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, wavHeader(size - 44, channels), 0, 44, 0);
  fs.closeSync(fd);
  return (size - 44) / (channels * 2) / RATE;
}

function monoWav(samples) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([wavHeader(data.length, 1), data]);
}

function concat(arrays, total) {
  const out = new Int16Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

// Fração de janelas de 30 ms com energia acima do limiar: estimativa barata de "tem fala aqui?".
function speechRatio(samples, threshold = 350) {
  const win = 480;
  let voiced = 0, total = 0;
  for (let i = 0; i + win <= samples.length; i += win, total++) if (rms(samples, i, i + win) > threshold) voiced++;
  return total ? voiced / total : 0;
}

// Acumula faixas de áudio alinhadas e entrega trechos de ~18-28 s cortados no ponto mais
// silencioso da primeira faixa, para não partir palavras ao meio (o Whisper aceita até 30 s).
class Chunker {
  constructor(onChunk, { tracks = 1, minSec = 18, maxSec = 28 } = {}) {
    this.onChunk = onChunk;
    this.min = minSec * RATE;
    this.max = maxSec * RATE;
    this.tracks = tracks;
    this.parts = Array.from({ length: tracks }, () => []);
    this.length = 0;
    this.offset = 0; // amostras já entregues
  }

  push(...arrays) {
    arrays.forEach((a, i) => this.parts[i].push(a));
    this.length += arrays[0].length;
    while (this.length >= this.max) this.cut(false);
  }

  flush() {
    if (this.length > RATE * 0.5) this.cut(true);
    else {
      this.offset += this.length;
      this.parts = this.parts.map(() => []);
      this.length = 0;
    }
  }

  cut(final) {
    const all = this.parts.map(p => concat(p, this.length));
    let at = this.length;
    if (!final) {
      const win = 3200, step = 1600;
      let best = Infinity;
      for (let i = this.min; i + win <= this.max; i += step) {
        const e = rms(all[0], i, i + win);
        if (e < best) {
          best = e;
          at = i + win / 2;
        }
      }
    }
    this.onChunk(all.map(a => a.slice(0, at)), this.offset / RATE);
    this.offset += at;
    this.parts = all.map(a => (at < a.length ? [a.slice(at)] : []));
    this.length -= at;
  }
}

// Separa PCM estéreo intercalado (L = microfone, R = áudio do computador) e gera a mistura mono.
function deinterleave(buf) {
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const n = Math.floor(pcm.length / 2);
  const left = new Int16Array(n), right = new Int16Array(n), mix = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = pcm[2 * i];
    right[i] = pcm[2 * i + 1];
    mix[i] = Math.max(-32768, Math.min(32767, left[i] + right[i]));
  }
  return { left, right, mix };
}

module.exports = { RATE, wavHeader, finalizeWav, monoWav, speechRatio, rms, Chunker, deinterleave };
