// Gerencia os motores locais: whisper-server (transcrição) e llama-server (Qwen).
// Ambos escutam só em 127.0.0.1 e são iniciados sob demanda.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Engine {
  constructor({ name, exe, args, port, healthPath, log }) {
    Object.assign(this, { name, exe, args, port, healthPath, log });
    this.proc = null;
    this.starting = null;
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  async healthy() {
    try {
      const res = await fetch(this.base + this.healthPath, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensure() {
    if (await this.healthy()) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  async start() {
    if (!this.proc) {
      if (!fs.existsSync(this.exe)) throw new Error(`${this.name}: executável não encontrado em ${this.exe}`);
      this.log(`${this.name}: iniciando`);
      const logFile = fs.openSync(path.join(path.dirname(this.logPath), `${this.name}.log`), "a");
      this.proc = spawn(this.exe, this.args, { windowsHide: true, stdio: ["ignore", logFile, logFile], cwd: path.dirname(this.exe) });
      try {
        // Prioridade baixa: a chamada de vídeo e o resto do computador têm preferência.
        os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
      this.proc.on("exit", code => {
        this.log(`${this.name}: encerrado (código ${code})`);
        this.proc = null;
      });
    }
    const deadline = Date.now() + 300_000; // carregar modelo grande pode levar alguns minutos
    while (Date.now() < deadline) {
      if (await this.healthy()) return this.log(`${this.name}: pronto`);
      if (!this.proc) throw new Error(`${this.name}: o processo encerrou ao iniciar (veja data/${this.name}.log)`);
      await sleep(1000);
    }
    throw new Error(`${this.name}: não respondeu em 5 minutos`);
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

function createEngines(cfg, root, dataDir, log) {
  const abs = p => path.resolve(root, p.replace(/%([A-Z_]+)%/gi, (_, v) => process.env[v] || ""));
  // 0 = automático: deixa dois núcleos livres para o resto do computador (entre 2 e 8 threads).
  const threads = n => String(n > 0 ? n : Math.max(2, Math.min(8, os.cpus().length - 2)));

  const whisperArgs = c => [
    "-m", abs(c.whisper.models[c.whisper.mode] || c.whisper.models.preciso),
    "--host", "127.0.0.1",
    "--port", String(c.whisper.port),
    "-t", threads(c.whisper.threads),
    "-l", c.language,
    ...(c.whisper.vadModel ? ["--vad", "-vm", abs(c.whisper.vadModel)] : []),
  ];

  const whisper = new Engine({
    name: "whisper",
    exe: abs(cfg.whisper.exe),
    port: cfg.whisper.port,
    healthPath: "/",
    log,
    args: whisperArgs(cfg),
  });

  const llm = new Engine({
    name: "llm",
    exe: abs(cfg.llm.exe),
    port: cfg.llm.port,
    healthPath: "/health",
    log,
    args: [
      "-m", abs(cfg.llm.model),
      "--host", "127.0.0.1",
      "--port", String(cfg.llm.port),
      "-c", String(cfg.llm.contextSize),
      "-ngl", String(cfg.llm.gpuLayers),
      "-t", threads(cfg.llm.threads),
      "--parallel", "1",
      "--jinja",
      "--reasoning", "off",
      "--no-webui",
    ],
  });

  for (const e of [whisper, llm]) e.logPath = path.join(dataDir, "ata.log");

  // Envia um trecho WAV (16 kHz mono) e devolve [{start, end, text}] em segundos.
  async function transcribe(wav, prompt) {
    await whisper.ensure();
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
    // SRT traz o tempo de cada palavra; o verbose_json custa o dobro de processamento neste servidor.
    form.append("response_format", "srt");
    form.append("temperature", "0.0");
    form.append("temperature_inc", "0.2");
    form.append("language", cfg.language);
    // Um segmento por palavra: permite separar quem falou cada palavra quando as falas se emendam.
    form.append("max_len", "1");
    form.append("split_on_word", "true");
    if (prompt) form.append("prompt", prompt);
    const res = await fetch(`${whisper.base}/inference`, { method: "POST", body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`whisper: HTTP ${res.status} ${body}`);
    if (body.trimStart().startsWith("{")) throw new Error(`whisper: ${JSON.parse(body).error || body}`);
    return parseSrt(body);
  }

  // "1\n00:00:00,460 --> 00:00:00,610\n Bom\n\n2\n..." -> [{ start, end, text }]
  function parseSrt(srt) {
    const toSec = t => {
      const [h, m, s] = t.replace(",", ".").split(":");
      return +h * 3600 + +m * 60 + +s;
    };
    const out = [];
    for (const block of srt.replace(/\r/g, "").split(/\n\n+/)) {
      const lines = block.split("\n");
      const i = lines.findIndex(l => l.includes("-->"));
      if (i < 0) continue;
      const [a, b] = lines[i].split("-->").map(x => x.trim());
      const text = lines.slice(i + 1).join(" ");
      if (text.trim()) out.push({ start: toSec(a), end: toSec(b), text: text.startsWith(" ") ? text : " " + text });
    }
    return out;
  }

  // Chamada de chat no formato OpenAI do llama-server. Com `schema`, a saída é JSON garantido.
  async function chat(messages, { schema, maxTokens = 2500, temperature = 0.3 } = {}) {
    await llm.ensure();
    const body = {
      messages,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.8,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "saida", schema } };
    const res = await fetch(`${llm.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`llm: HTTP ${res.status} ${json.error?.message || ""}`);
    let text = json.choices?.[0]?.message?.content ?? "";
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return schema ? JSON.parse(text) : text;
  }

  // Troca o modelo de transcrição: reinicia o whisper-server na próxima vez que for usado.
  function reconfigureWhisper(newCfg) {
    const args = whisperArgs(newCfg);
    if (JSON.stringify(args) === JSON.stringify(whisper.args)) return;
    whisper.args = args;
    whisper.stop();
    log(`whisper: modo de transcrição alterado para "${newCfg.whisper.mode}"`);
  }

  return {
    whisper,
    llm,
    transcribe,
    chat,
    reconfigureWhisper,
    stopAll: () => [whisper, llm].forEach(e => e.stop()),
  };
}

module.exports = { createEngines };
