// Testes de ponta a ponta do Ata com motores simulados (não precisa dos modelos baixados).
// Uso: node test/run-tests.js
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startMockEngines } = require("./mock-engines");
const { speakerOf, groupBySpeaker, isHallucination } = require("../lib/transcriber");

const ROOT = path.join(__dirname, "..");
const PORTS = { app: 5380, whisper: 5381, llm: 5382 };
const BASE = `http://127.0.0.1:${PORTS.app}/api`;
const ORIGIN = { Origin: `http://127.0.0.1:${PORTS.app}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ata-test-"));
const cfgPath = path.join(tmp, "config.json");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
Object.assign(cfg, { port: PORTS.app, dataDir: path.join(tmp, "data"), user: { name: "Maria", aliases: ["Mari"] } });
cfg.whisper.port = PORTS.whisper;
cfg.whisper.exe = path.join(tmp, "nao-existe.exe"); // nunca inicia motor real
cfg.llm.port = PORTS.llm;
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

let server;
function startServer() {
  server = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "server.js")], { env: { ...process.env, ATA_CONFIG: cfgPath }, stdio: "ignore" });
  return waitFor(async () => (await fetch(`${BASE}/status`)).ok);
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch {}
    await sleep(200);
  }
  throw new Error("tempo esgotado");
}
async function api(p, method = "GET", body) {
  const opts = { method, headers: { ...ORIGIN } };
  if (body instanceof Uint8Array) Object.assign(opts, { body, headers: { ...ORIGIN, "Content-Type": "application/octet-stream" } });
  else if (body) Object.assign(opts, { body: JSON.stringify(body), headers: { ...ORIGIN, "Content-Type": "application/json" } });
  const res = await fetch(BASE + p, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${json.error}`);
  return json;
}
// 1 s de áudio estéreo: "fala" sintética no canal escolhido (0 = microfone, 1 = participantes).
function second(speech, channel = 0) {
  const a = new Int16Array(16000 * 2);
  if (speech) for (let i = 0; i < 16000; i++) a[2 * i + channel] = Math.round(6000 * Math.sin(i * 0.12) * (0.6 + 0.4 * Math.sin(i / 800)));
  return new Uint8Array(a.buffer);
}
async function until(id, statuses = ["ready", "error"]) {
  let d;
  await waitFor(async () => statuses.includes((d = await api(`/meetings/${id}`)).meeting.status), 30000);
  return d;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("atribui o falante pelo canal com mais energia", () => {
  const left = new Int16Array(32000), right = new Int16Array(32000);
  for (let i = 0; i < 16000; i++) left[i] = 5000 * Math.sin(i / 3);
  for (let i = 16000; i < 32000; i++) right[i] = 5000 * Math.sin(i / 3);
  assert.equal(speakerOf(left, right, 0.2, 0.8), "me");
  assert.equal(speakerOf(left, right, 1.2, 1.8), "others");
  const words = [
    { start: 0.1, end: 0.4, text: " Bom" }, { start: 0.5, end: 0.9, text: " dia." },
    { start: 1.1, end: 1.5, text: " Oi," }, { start: 1.5, end: 1.9, text: " tudo" },
  ];
  assert.deepEqual(groupBySpeaker(words, left, right).map(g => [g.channel, g.text]), [["me", "Bom dia."], ["others", "Oi, tudo"]]);
});

test("filtra alucinações comuns do Whisper", () => {
  assert.ok(isHallucination("Legendas pela comunidade Amara.org"));
  assert.ok(isHallucination("[Música]"));
  assert.ok(!isHallucination("Vamos validar o backup."));
});

test("grava, transcreve, gera notas e separa as minhas tarefas", async t => {
  const { id } = await api("/meetings", "POST", { hasSystemAudio: true });
  for (let s = 0; s < 62; s++) await api(`/meetings/${id}/audio`, "POST", second(s % 12 < 9));
  await api(`/meetings/${id}/stop`, "POST");
  await api(`/meetings/${id}/stop`, "POST"); // parar duas vezes não pode quebrar
  const d = await until(id);
  assert.equal(d.meeting.status, "ready");
  assert.equal(d.meeting.title, "Migração do cluster");
  assert.ok(Math.abs(d.meeting.duration_sec - 62) < 0.01);
  assert.ok(d.segments.length >= 2);
  assert.ok(d.segments.every(s => !/Amara/.test(s.text)), "alucinação deveria ser filtrada");
  assert.ok(d.segments.every(s => s.channel === "me"), "fala só no microfone");
  const mine = d.tasks.filter(x => x.mine).map(x => x.description).sort();
  assert.deepEqual(mine, ["Mandar ata", "Validar o backup"]); // pelo nome (Maria) e por para_mim
  const req = t.mocks.calls.lastLlmBody;
  assert.ok(req.messages[0].content.includes("Maria"));
  assert.equal(req.chat_template_kwargs.enable_thinking, false);
  assert.ok(req.response_format?.json_schema);
  t.meetingId = id;
});

test("chat, tarefas manuais, anotações e regerar notas", async t => {
  const id = t.meetingId;
  const { answer } = await api(`/meetings/${id}/chat`, "POST", { question: "Quais minhas tarefas?" });
  assert.equal(answer, "Você ficou com o backup até sexta [00:01]."); // sem o bloco <think>
  const task = await api(`/meetings/${id}/tasks`, "POST", { description: "Tarefa manual" });
  await api(`/tasks/${task.id}`, "PATCH", { done: true });
  await api(`/meetings/${id}`, "PATCH", { title: "Renomeada", my_notes: "minha anotação" });
  await api(`/meetings/${id}/summarize`, "POST", { instructions: "foque em custos" });
  const d = await until(id);
  assert.equal(d.meeting.title, "Renomeada", "título dado pelo usuário é mantido");
  assert.equal(d.meeting.my_notes, "minha anotação");
  assert.ok(d.tasks.some(x => x.description === "Tarefa manual" && x.done), "tarefa manual sobrevive");
  assert.ok(t.mocks.calls.lastLlmBody.messages[1].content.includes("foque em custos"));
  const all = await api("/tasks");
  assert.ok(all.every(x => x.mine));
});

test("áudio salvo em WAV estéreo 16 kHz com suporte a Range", async t => {
  const res = await fetch(`${BASE}/meetings/${t.meetingId}/audio.wav`, { headers: { Range: "bytes=0-43" } });
  assert.equal(res.status, 206);
  const h = Buffer.from(await res.arrayBuffer());
  assert.equal(h.toString("ascii", 0, 4), "RIFF");
  assert.equal(h.readUInt16LE(22), 2);
  assert.equal(h.readUInt32LE(24), 16000);
  assert.equal(h.readUInt32LE(40), 62 * 64000);
});

test("bloqueia escrita vinda de outros sites e acesso fora de public/", async () => {
  const res = await fetch(`${BASE}/meetings`, { method: "POST", headers: { Origin: "https://exemplo.com", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
  const trav = await fetch(`http://127.0.0.1:${PORTS.app}/..%2Fserver.js`);
  assert.equal(trav.status, 404);
});

test("recupera uma gravação interrompida por queda do servidor", async () => {
  const { id } = await api("/meetings", "POST", { hasSystemAudio: true });
  for (let s = 0; s < 30; s++) await api(`/meetings/${id}/audio`, "POST", second(s % 10 < 7, 1));
  server.kill("SIGKILL");
  await sleep(500);
  await startServer();
  const d = await until(id);
  assert.equal(d.meeting.status, "ready");
  assert.ok(Math.abs(d.meeting.duration_sec - 30) < 0.01);
  assert.ok(d.segments.length >= 1 && d.segments.every(s => s.channel === "others"));
});

test("erro de transcrição aparece como erro, não como 'sem fala'", async t => {
  await t.mocks.closeWhisper();
  const { id } = await api("/meetings", "POST", {});
  for (let s = 0; s < 10; s++) await api(`/meetings/${id}/audio`, "POST", second(true));
  await api(`/meetings/${id}/stop`, "POST");
  const d = await until(id);
  assert.equal(d.meeting.status, "error");
  assert.match(d.meeting.error, /A transcrição falhou/);
});

(async () => {
  const mocks = startMockEngines({ whisperPort: PORTS.whisper, llmPort: PORTS.llm });
  const ctx = { mocks };
  let failed = 0;
  try {
    await startServer();
    for (const { name, fn } of tests) {
      try {
        await fn(ctx);
        console.log(`  ok  ${name}`);
      } catch (e) {
        failed++;
        console.log(`  FALHOU  ${name}\n        ${e.message}`);
      }
    }
  } finally {
    server?.kill();
    await mocks.close().catch(() => {});
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} teste(s) falharam.` : `\nTodos os ${tests.length} testes passaram.`);
  process.exit(failed ? 1 : 0);
})();
