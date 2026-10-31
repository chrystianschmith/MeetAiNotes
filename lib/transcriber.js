// Recebe o áudio ao vivo, corta em trechos e transcreve numa fila única.
// O Whisper roda uma vez sobre a mistura dos dois canais; quem falou cada frase é decidido
// comparando a energia do microfone (você) com a do áudio do computador (participantes).
const { Chunker, monoWav, speechRatio, rms, RATE } = require("./audio");

// Frases que o Whisper costuma "inventar" em silêncio ou ruído.
const HALLUCINATIONS = [
  /^legendas? (pela|por) .*/i,
  /amara\.org/i,
  /^obrigad[oa] (por assistir|pela aten[cç][aã]o)\.?$/i,
  /inscreva-se/i,
  /^tchau[.!]?$/i,
  /^\[.*\]$|^\(.*\)$/,
  /^[.\s…-]*$/,
];

const isHallucination = text => HALLUCINATIONS.some(re => re.test(text.trim()));

function speakerOf(left, right, startSec, endSec) {
  const from = Math.max(0, Math.floor((startSec - 0.1) * RATE));
  const to = Math.min(left.length, Math.ceil((endSec + 0.1) * RATE));
  if (to <= from) return null;
  return rms(right, from, to) > rms(left, from, to) ? "others" : "me";
}

// Recebe palavras com tempo, decide quem falou cada uma e agrupa em frases por falante.
function groupBySpeaker(words, left, right) {
  const items = words.filter(w => w.text.trim()).map(w => ({ ...w, channel: speakerOf(left, right, w.start, w.end) }));
  // Uma palavra curta isolada entre duas do mesmo falante quase sempre é erro de alinhamento.
  for (let i = 1; i < items.length - 1; i++) {
    const [a, b, c] = [items[i - 1], items[i], items[i + 1]];
    if (a.channel === c.channel && b.channel !== a.channel && b.end - b.start < 0.5) b.channel = a.channel;
  }
  const groups = [];
  for (const w of items) {
    const channel = w.channel ?? groups[groups.length - 1]?.channel ?? "me";
    const g = groups[groups.length - 1];
    const sentenceDone = g && /[.!?]$/.test(g.text) && g.end - g.start > 12;
    if (g && g.channel === channel && w.start - g.end < 1.5 && !sentenceDone) {
      g.text += w.text;
      g.end = w.end;
    } else groups.push({ channel, start: w.start, end: w.end, text: w.text });
  }
  return groups.map(g => ({ ...g, text: g.text.replace(/\s+/g, " ").trim() }));
}

class Transcriber {
  constructor({ db, engines, getConfig, log, onMeetingTranscribed }) {
    Object.assign(this, { db, engines, getConfig, log, onMeetingTranscribed });
    this.sessions = new Map();
    this.queue = [];
    this.running = false;
  }

  open(meetingId, startSec = 0) {
    const chunker = new Chunker((tracks, start) => this.enqueue(meetingId, tracks, start), { tracks: 3 });
    chunker.offset = Math.round(startSec * RATE);
    const session = { pending: 0, closed: false, chunker };
    this.sessions.set(meetingId, session);
    return session;
  }

  push(meetingId, { mix, left, right }) {
    this.sessions.get(meetingId)?.chunker.push(mix, left, right);
  }

  close(meetingId) {
    const s = this.sessions.get(meetingId);
    if (!s) return this.onMeetingTranscribed(meetingId);
    s.chunker.flush();
    s.closed = true;
    this.checkDone(meetingId);
  }

  pendingCount(meetingId) {
    return this.sessions.get(meetingId)?.pending ?? 0;
  }

  enqueue(meetingId, [mix, left, right], start) {
    if (speechRatio(mix) < 0.02) return; // trecho praticamente mudo
    const s = this.sessions.get(meetingId);
    if (s) s.pending++;
    this.queue.push({ meetingId, mix, left, right, start });
    this.work();
  }

  checkDone(meetingId) {
    const s = this.sessions.get(meetingId);
    if (s && s.closed && s.pending === 0) {
      this.sessions.delete(meetingId);
      this.onMeetingTranscribed(meetingId, s.lastError);
    }
  }

  async work() {
    if (this.running) return;
    this.running = true;
    const insert = this.db.prepare("INSERT INTO segments (meeting_id, channel, start, end, text) VALUES (?, ?, ?, ?, ?)");
    while (this.queue.length) {
      const job = this.queue.shift();
      const t0 = Date.now();
      try {
        // Sem prompt de contexto: nos testes ele deslocava os tempos das palavras (errando quem falou)
        // e vazava texto para a transcrição. Nomes e termos são corrigidos depois, pelo Qwen.
        const words = await this.engines.transcribe(monoWav(job.mix));
        let previous = "";
        for (const seg of groupBySpeaker(words, job.left, job.right)) {
          if (!seg.text || isHallucination(seg.text) || seg.text === previous) continue;
          previous = seg.text;
          insert.run(job.meetingId, seg.channel, job.start + seg.start, job.start + seg.end, seg.text);
        }
        this.log(`Trecho @${job.start.toFixed(0)}s (${(job.mix.length / RATE).toFixed(0)}s de áudio) transcrito em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        this.log(`Transcrição falhou (${job.meetingId} @${job.start.toFixed(0)}s): ${e.message}`);
        const s = this.sessions.get(job.meetingId);
        if (s) s.lastError = e.message;
      }
      const s = this.sessions.get(job.meetingId);
      if (s) s.pending--;
      this.checkDone(job.meetingId);
    }
    this.running = false;
  }
}

module.exports = { Transcriber, isHallucination, speakerOf, groupBySpeaker };
