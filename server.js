// MeetAiNotes: gravador e caderno de reuniões 100% local.
// Uso: node server.js  ->  http://127.0.0.1:4280
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDb } = require("./lib/db");
const { wavHeader, finalizeWav, deinterleave, RATE } = require("./lib/audio");
const { createEngines } = require("./lib/engines");
const { Transcriber } = require("./lib/transcriber");
const { createSummarizer } = require("./lib/summarizer");

const ROOT = __dirname;
// MEETAINOTES_CONFIG permite apontar outra configuração (usado pelos testes automatizados).
const CONFIG_PATH = process.env.MEETAINOTES_CONFIG || path.join(ROOT, "config.json");
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(ROOT, "config.example.json"), CONFIG_PATH);
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const getConfig = () => config;

const DATA = path.resolve(ROOT, config.dataDir || "data");
const AUDIO_DIR = path.join(DATA, "audio");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const LOG_PATH = path.join(DATA, "meetainotes.log");
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + "\n");
}

const db = openDb(path.join(DATA, "meetainotes.sqlite"));
const engines = createEngines(config, ROOT, DATA, log);
const summarizer = createSummarizer({ db, engines, getConfig, log });

// Resumos rodam um de cada vez (o modelo atende uma requisição por vez).
let summaryChain = Promise.resolve();
function queueSummary(id, extra = "") {
  db.prepare("UPDATE meetings SET status = 'summarizing', progress = 'Na fila para gerar as notas…', error = NULL WHERE id = ?").run(id);
  summaryChain = summaryChain.then(() => summarizer.summarize(id, extra)).catch(e => log(`Fila de resumo: ${e.message}`));
}

const transcriber = new Transcriber({
  db,
  engines,
  getConfig,
  log,
  onMeetingTranscribed: (id, lastError) => {
    const m = db.prepare("SELECT status FROM meetings WHERE id = ?").get(id);
    if (!m || m.status !== "processing") return;
    const segs = db.prepare("SELECT COUNT(*) n FROM segments WHERE meeting_id = ?").get(id).n;
    if (lastError && !segs) {
      // Nada foi transcrito por causa de erro: mostra o erro em vez de "nenhuma fala detectada".
      db.prepare("UPDATE meetings SET status = 'error', error = ?, progress = NULL WHERE id = ?")
        .run(`A transcrição falhou: ${lastError}. Use "Transcrever de novo" depois de corrigir.`, id);
      return;
    }
    queueSummary(id);
    if (lastError) db.prepare("UPDATE meetings SET progress = ? WHERE id = ?").run(`Alguns trechos não foram transcritos (${lastError}).`, id);
  },
});

const audioPath = id => path.join(AUDIO_DIR, `${id}.wav`);
const recordings = new Map(); // id -> { fd, bytes }
const now = () => new Date().toISOString();

// ---------- Gravação ----------

function createMeeting({ title, hasSystemAudio }) {
  const started = new Date();
  const id = started.toISOString().slice(0, 10).replace(/-/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const p = n => String(n).padStart(2, "0");
  const defaultTitle = `Reunião de ${p(started.getDate())}/${p(started.getMonth() + 1)} às ${p(started.getHours())}:${p(started.getMinutes())}`;
  db.prepare("INSERT INTO meetings (id, title, started_at, has_system_audio, status, updated_at) VALUES (?, ?, ?, ?, 'recording', ?)")
    .run(id, (title || "").trim() || defaultTitle, started.toISOString(), hasSystemAudio ? 1 : 0, now());
  const fd = fs.openSync(audioPath(id), "w");
  fs.writeSync(fd, wavHeader(0, 2));
  recordings.set(id, { fd, bytes: 0, lastAt: Date.now() });
  transcriber.open(id);
  log(`Gravação iniciada: ${id}`);
  return id;
}

function appendAudio(id, buf) {
  const rec = recordings.get(id);
  if (!rec) throw httpError(409, "Esta reunião não está gravando.");
  const usable = buf.subarray(0, buf.length - (buf.length % 4)); // estéreo 16 bits = 4 bytes por quadro
  fs.writeSync(rec.fd, usable);
  rec.bytes += usable.length;
  rec.lastAt = Date.now();
  transcriber.push(id, deinterleave(usable));
}

function stopMeeting(id) {
  const rec = recordings.get(id);
  if (!rec) return; // já parada (clique duplo, ou encerrada pelo vigia abaixo)
  fs.closeSync(rec.fd);
  recordings.delete(id);
  const duration = finalizeWav(audioPath(id), 2);
  db.prepare("UPDATE meetings SET status = 'processing', ended_at = ?, duration_sec = ?, updated_at = ? WHERE id = ?").run(now(), duration, now(), id);
  log(`Gravação encerrada: ${id} (${duration.toFixed(0)} s)`);
  transcriber.close(id);
}

// Se a janela foi fechada no meio da gravação, encerra sozinho após 90 s sem áudio.
setInterval(() => {
  for (const [id, rec] of recordings) {
    if (Date.now() - rec.lastAt > 90_000) {
      log(`Sem áudio há 90 s, encerrando gravação ${id}`);
      stopMeeting(id);
    }
  }
}, 15_000).unref();

// Retoma a transcrição a partir do WAV salvo (após queda de energia, ou para retranscrever).
function transcribeFromWav(id, fromScratch = false) {
  if (fromScratch) db.prepare("DELETE FROM segments WHERE meeting_id = ?").run(id);
  const startSec = db.prepare("SELECT MAX(end) e FROM segments WHERE meeting_id = ?").get(id).e || 0;
  db.prepare("UPDATE meetings SET status = 'processing', progress = NULL, error = NULL WHERE id = ?").run(id);
  transcriber.open(id, startSec);
  const file = audioPath(id);
  if (fs.existsSync(file)) {
    const fd = fs.openSync(file, "r");
    const block = Buffer.alloc(RATE * 4 * 10);
    const skipBytes = Math.round(startSec * RATE) * 4;
    let pos = 44 + skipBytes, n;
    while ((n = fs.readSync(fd, block, 0, block.length, pos)) > 0) {
      transcriber.push(id, deinterleave(block.subarray(0, n - (n % 4))));
      pos += n;
    }
    fs.closeSync(fd);
  }
  transcriber.close(id);
}

function recoverInterrupted() {
  for (const m of db.prepare("SELECT id, status FROM meetings WHERE status IN ('recording', 'processing', 'summarizing')").all()) {
    log(`Recuperando reunião interrompida: ${m.id} (${m.status})`);
    if (m.status === "summarizing") {
      queueSummary(m.id);
      continue;
    }
    const duration = finalizeWav(audioPath(m.id), 2);
    db.prepare("UPDATE meetings SET ended_at = COALESCE(ended_at, ?), duration_sec = ? WHERE id = ?").run(now(), duration, m.id);
    transcribeFromWav(m.id);
  }
}

// ---------- Leitura ----------

function meetingView(m) {
  if (!m) return null;
  const pending = transcriber.pendingCount(m.id);
  let progress = m.progress;
  if (m.status === "processing") progress = pending ? `Transcrevendo… ${pending} trecho(s) na fila` : "Finalizando a transcrição…";
  return { ...m, progress, summary: m.summary_json ? JSON.parse(m.summary_json) : null, summary_json: undefined };
}

function getMeeting(id, sinceSegment = 0) {
  const m = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
  if (!m) throw httpError(404, "Reunião não encontrada.");
  return {
    meeting: meetingView(m),
    segments: db.prepare("SELECT id, channel, start, end, text FROM segments WHERE meeting_id = ? AND id > ? ORDER BY start").all(id, sinceSegment),
    tasks: db.prepare("SELECT * FROM tasks WHERE meeting_id = ? ORDER BY mine DESC, id").all(id),
    chat: db.prepare("SELECT role, content, created_at FROM chat WHERE meeting_id = ? ORDER BY id").all(id),
  };
}

// ---------- HTTP ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, "Corpo muito grande."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const readJson = async req => {
  const buf = await readBody(req, 1024 * 1024);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function serveStatic(res, urlPath) {
  const file = path.join(ROOT, "public", urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveAudio(req, res, id) {
  const file = audioPath(id);
  if (!fs.existsSync(file)) throw httpError(404, "Áudio não encontrado.");
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": "audio/wav", "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const routes = [
  ["GET", /^\/api\/status$/, async () => ({
    user: config.user,
    whisper: await engines.whisper.healthy(),
    llm: await engines.llm.healthy(),
    recording: [...recordings.keys()],
  })],

  ["GET", /^\/api\/settings$/, async () => ({
    user: config.user,
    vocabulary: config.vocabulary || [],
    captureSystemAudio: config.captureSystemAudio !== false,
    transcriptionMode: config.whisper.mode,
  })],
  ["PUT", /^\/api\/settings$/, async req => {
    const b = await readJson(req);
    const mode = b.transcriptionMode in config.whisper.models ? b.transcriptionMode : config.whisper.mode;
    if (mode !== config.whisper.mode && (recordings.size || transcriber.queue.length))
      throw httpError(409, "Espere terminar a gravação e a transcrição em andamento para trocar o modo de transcrição.");
    config = {
      ...config,
      user: { name: String(b.user?.name || "").trim(), aliases: (b.user?.aliases || []).map(String).map(s => s.trim()).filter(Boolean) },
      vocabulary: (b.vocabulary || []).map(String).map(s => s.trim()).filter(Boolean),
      captureSystemAudio: !!b.captureSystemAudio,
      whisper: { ...config.whisper, mode },
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    engines.reconfigureWhisper(config);
    return { ok: true };
  }],

  ["GET", /^\/api\/meetings$/, async () =>
    db.prepare(`SELECT m.id, m.title, m.started_at, m.duration_sec, m.status,
                  (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id AND t.mine = 1 AND t.done = 0) AS my_open_tasks
                FROM meetings m ORDER BY m.started_at DESC`).all()],
  ["POST", /^\/api\/meetings$/, async req => ({ id: createMeeting(await readJson(req)) })],
  ["GET", /^\/api\/meetings\/([\w-]+)$/, async (req, [id], url) => getMeeting(id, +url.searchParams.get("since") || 0)],
  ["PATCH", /^\/api\/meetings\/([\w-]+)$/, async (req, [id]) => {
    const b = await readJson(req);
    if (typeof b.title === "string" && b.title.trim()) db.prepare("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?").run(b.title.trim(), now(), id);
    if (typeof b.my_notes === "string") db.prepare("UPDATE meetings SET my_notes = ?, updated_at = ? WHERE id = ?").run(b.my_notes, now(), id);
    return { ok: true };
  }],
  ["DELETE", /^\/api\/meetings\/([\w-]+)$/, async (req, [id]) => {
    if (recordings.has(id)) throw httpError(409, "Pare a gravação antes de apagar.");
    db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    fs.rmSync(audioPath(id), { force: true });
    log(`Reunião apagada: ${id}`);
    return { ok: true };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/audio$/, async (req, [id]) => {
    appendAudio(id, await readBody(req));
    return { ok: true };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/stop$/, async (req, [id]) => {
    stopMeeting(id);
    return { ok: true };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/summarize$/, async (req, [id]) => {
    queueSummary(id, (await readJson(req)).instructions || "");
    return { ok: true };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/retranscribe$/, async (req, [id]) => {
    if (recordings.has(id)) throw httpError(409, "A reunião ainda está gravando.");
    transcribeFromWav(id, true);
    return { ok: true };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/chat$/, async (req, [id]) => {
    const { question } = await readJson(req);
    if (!question?.trim()) throw httpError(400, "Pergunta vazia.");
    return { answer: await summarizer.ask(id, question.trim()) };
  }],
  ["POST", /^\/api\/meetings\/([\w-]+)\/tasks$/, async (req, [id]) => {
    const b = await readJson(req);
    if (!b.description?.trim()) throw httpError(400, "Descrição vazia.");
    const r = db.prepare("INSERT INTO tasks (meeting_id, description, owner, due, mine, manual, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(id, b.description.trim(), b.owner || config.user.name, b.due || null, b.mine === false ? 0 : 1, now());
    return { id: Number(r.lastInsertRowid) };
  }],

  ["GET", /^\/api\/tasks$/, async (req, _, url) => {
    const mineOnly = url.searchParams.get("mine") !== "0";
    return db.prepare(`SELECT t.*, m.title AS meeting_title, m.started_at AS meeting_started_at
                       FROM tasks t JOIN meetings m ON m.id = t.meeting_id
                       ${mineOnly ? "WHERE t.mine = 1" : ""}
                       ORDER BY t.done, m.started_at DESC, t.id`).all();
  }],
  ["PATCH", /^\/api\/tasks\/(\d+)$/, async (req, [id]) => {
    const b = await readJson(req);
    for (const [k, col] of [["done", "done"], ["mine", "mine"]]) if (k in b) db.prepare(`UPDATE tasks SET ${col} = ? WHERE id = ?`).run(b[k] ? 1 : 0, id);
    for (const k of ["description", "owner", "due"]) if (typeof b[k] === "string") db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(b[k].trim(), id);
    return { ok: true };
  }],
  ["DELETE", /^\/api\/tasks\/(\d+)$/, async (req, [id]) => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return { ok: true };
  }],

  ["POST", /^\/api\/shutdown$/, async () => {
    setTimeout(shutdown, 200);
    return { ok: true };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // Só aceita escrita vinda da própria página (bloqueia outros sites tentando falar com o localhost).
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw httpError(403, "Origem não permitida.");

    const audio = /^\/api\/meetings\/([\w-]+)\/audio\.wav$/.exec(url.pathname);
    if (req.method === "GET" && audio) return serveAudio(req, res, audio[1]);

    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) return send(res, 200, await handler(req, m.slice(1), url));
    }
    if (req.method === "GET" && serveStatic(res, url.pathname)) return;
    throw httpError(404, "Não encontrado.");
  } catch (e) {
    if (!e.status) log(`Erro em ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
});

function shutdown() {
  log("Encerrando…");
  for (const id of recordings.keys()) stopMeeting(id);
  engines.stopAll();
  server.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => engines.stopAll());

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log(`MeetAiNotes já está rodando em http://127.0.0.1:${config.port}`);
    process.exit(0);
  }
  throw e;
});

server.listen(config.port, "127.0.0.1", () => {
  log(`MeetAiNotes rodando em http://127.0.0.1:${config.port}`);
  recoverInterrupted();
});
