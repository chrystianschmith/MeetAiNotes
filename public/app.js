// Interface do MeetAiNotes: caderno de reuniões, gravação, tarefas e perguntas.
const main = document.getElementById("main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Markdown simples das respostas do modelo: negrito, títulos e listas (o texto já sai escapado).
const md = s => esc(s)
  .replace(/^#{1,6}\s+(.+)$/gm, "<strong>$1</strong>")
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/^(\s*)[*-]\s+/gm, "$1• ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

async function api(path, method = "GET", body) {
  const opts = { method };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    opts.body = body;
    opts.headers = { "Content-Type": "application/octet-stream" };
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch("/api" + path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Erro ${res.status}`);
  return json;
}

const fmtClock = sec => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return h ? `${h}:${mmss}` : mmss;
};
const fmtDuration = sec => {
  const m = Math.round((sec || 0) / 60);
  if (m < 1) return "< 1 min";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
const fmtDate = iso => new Date(iso).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
const fmtHour = iso => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
}

const STATUS = {
  recording: ["Gravando", "rec"],
  processing: ["Transcrevendo", ""],
  summarizing: ["Gerando notas", ""],
  error: ["Erro", "error"],
};

let settings = { user: { name: "" } };
let pollTimer = null;
const stopPolling = () => {
  clearTimeout(pollTimer);
  pollTimer = null;
};

// ---------- Barra lateral ----------

async function renderSidebar() {
  const meetings = await api("/meetings").catch(() => []);
  const current = location.hash.match(/^#\/m\/([\w-]+)/)?.[1];
  let html = "", lastDay = "";
  for (const m of meetings) {
    const day = dayLabel(m.started_at);
    if (day !== lastDay) {
      html += `<div class="day-label">${esc(day)}</div>`;
      lastDay = day;
    }
    const st = STATUS[m.status];
    html += `<a class="meeting-item ${m.id === current ? "active" : ""}" href="#/m/${m.id}">
      <span class="t">${esc(m.title)}</span>
      <span class="m">${fmtHour(m.started_at)} · ${fmtDuration(m.duration_sec)}
        ${st ? `<span class="badge ${st[1]}">${st[0]}</span>` : ""}
        ${m.my_open_tasks ? `<span>✓ ${m.my_open_tasks}</span>` : ""}</span>
    </a>`;
  }
  document.getElementById("meeting-list").innerHTML = html || `<div class="day-label">Nenhuma reunião ainda.</div>`;
  const open = meetings.reduce((n, m) => n + (m.my_open_tasks || 0), 0);
  document.getElementById("my-task-count").textContent = open || "";
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("active", location.hash === `#/${a.dataset.nav}`);
  return meetings;
}

// ---------- Gravação ----------

const rec = { active: false };

async function startRecording(title, withSystem) {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let sys = null;
  if (withSystem) {
    try {
      sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include" });
    } catch {
      sys = null;
    }
    if (sys && !sys.getAudioTracks().length) {
      sys.getTracks().forEach(t => t.stop());
      sys = null;
    }
    if (!sys) alert('Sem o áudio do computador. Para captar os outros participantes, escolha "Tela inteira" e marque "Compartilhar áudio do sistema". Vou gravar só o microfone.');
  }

  const { id } = await api("/meetings", "POST", { title, hasSystemAudio: !!sys });
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch {
    ctx = new AudioContext();
  }
  await ctx.audioWorklet.addModule("capture-worklet.js");
  const merger = ctx.createChannelMerger(2);
  ctx.createMediaStreamSource(mic).connect(merger, 0, 0);
  if (sys) ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks())).connect(merger, 0, 1);
  const node = new AudioWorkletNode(ctx, "capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "discrete",
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  merger.connect(node);
  node.connect(mute).connect(ctx.destination); // mantém o nó ativo sem tocar nada

  Object.assign(rec, {
    active: true, id, ctx, node, streams: [mic, sys].filter(Boolean), hasSystem: !!sys,
    pending: [], sending: false, peak: [0, 0], startedAt: Date.now(), lastSeg: 0,
  });
  node.port.onmessage = e => {
    rec.pending.push(e.data.pcm);
    rec.peak = e.data.peak;
  };
  rec.flushTimer = setInterval(flushAudio, 3000);
  location.hash = "#/gravar";
}

async function flushAudio() {
  if (rec.sending || !rec.pending.length) return;
  rec.sending = true;
  const parts = rec.pending.splice(0);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Int16Array(total);
  let pos = 0;
  for (const p of parts) {
    all.set(p, pos);
    pos += p.length;
  }
  try {
    await api(`/meetings/${rec.id}/audio`, "POST", all);
  } catch (e) {
    rec.pending.unshift(all); // tenta de novo no próximo ciclo
    console.warn("Falha ao enviar áudio:", e);
  } finally {
    rec.sending = false;
  }
}

async function stopRecording() {
  clearInterval(rec.flushTimer);
  rec.node.port.onmessage = null;
  rec.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  await rec.ctx.close();
  while (rec.sending) await new Promise(r => setTimeout(r, 100));
  await flushAudio();
  await api(`/meetings/${rec.id}/stop`, "POST");
  const id = rec.id;
  rec.active = false;
  location.hash = `#/m/${id}`;
}

window.addEventListener("beforeunload", e => {
  if (rec.active) e.preventDefault();
});

function renderRecordSetup() {
  main.innerHTML = `<div class="page">
    <h1>Nova gravação</h1>
    <p class="muted">O áudio fica só neste computador. A transcrição acontece enquanto você fala, e as notas são geradas quando a gravação termina.</p>
    <div class="card" style="margin-top:20px">
      <label class="field"><span>Título (opcional)</span>
        <input type="text" id="rec-title" placeholder="Ex.: Sync semanal do time"></label>
      <label class="check"><input type="checkbox" id="rec-system" ${settings.captureSystemAudio !== false ? "checked" : ""}>
        <span><b>Captar os outros participantes da chamada</b><br>
        <small class="muted">O navegador vai pedir para compartilhar a tela: escolha <b>Tela inteira</b> e marque <b>Compartilhar áudio do sistema</b>. Só o áudio é usado.</small></span></label>
      <div class="actions"><button class="btn rec big" id="rec-start">● Começar a gravar</button></div>
    </div>
  </div>`;
  document.getElementById("rec-start").onclick = async e => {
    e.target.disabled = true;
    try {
      await startRecording(document.getElementById("rec-title").value, document.getElementById("rec-system").checked);
      renderSidebar();
      render();
    } catch (err) {
      alert("Não foi possível começar a gravação: " + err.message);
      e.target.disabled = false;
    }
  };
}

function renderRecording() {
  const labels = speakerLabels({ has_system_audio: rec.hasSystem });
  main.innerHTML = `<div class="page">
    <div class="card recorder">
      <div><span class="pulse"></span><b>Gravando</b></div>
      <div class="timer" id="rec-timer">00:00</div>
      <div class="meters">
        <div class="meter"><span>${esc(labels.me)}</span><div class="bar"><div class="fill" id="lvl-me"></div></div></div>
        ${rec.hasSystem ? `<div class="meter others"><span>Participantes</span><div class="bar"><div class="fill" id="lvl-others"></div></div></div>` : ""}
      </div>
      <button class="btn big" id="rec-stop">■ Parar e gerar notas</button>
    </div>
    <h2>Transcrição ao vivo</h2>
    <div class="live" id="live"><p class="muted" id="live-empty">Os primeiros trechos aparecem cerca de 30 segundos depois que alguém começa a falar.</p></div>
  </div>`;
  document.getElementById("rec-stop").onclick = async e => {
    e.target.disabled = true;
    e.target.textContent = "Finalizando…";
    await stopRecording().catch(err => alert(err.message));
    renderSidebar();
  };
  const tick = () => {
    if (!rec.active || !document.getElementById("rec-timer")) return;
    document.getElementById("rec-timer").textContent = fmtClock((Date.now() - rec.startedAt) / 1000);
    const lvl = v => `${Math.min(100, Math.sqrt(v) * 140)}%`;
    document.getElementById("lvl-me").style.width = lvl(rec.peak[0]);
    const o = document.getElementById("lvl-others");
    if (o) o.style.width = lvl(rec.peak[1]);
    requestAnimationFrame(tick);
  };
  tick();
  const poll = async () => {
    if (!rec.active || !document.getElementById("live")) return;
    try {
      const data = await api(`/meetings/${rec.id}?since=${rec.lastSeg}`);
      if (data.segments.length) {
        document.getElementById("live-empty")?.remove();
        const live = document.getElementById("live");
        live.insertAdjacentHTML("beforeend", data.segments.map(s => segHtml(s, labels)).join(""));
        rec.lastSeg = Math.max(rec.lastSeg, ...data.segments.map(s => s.id));
        live.scrollTop = live.scrollHeight;
      }
    } catch {}
    pollTimer = setTimeout(poll, 4000);
  };
  poll();
}

// ---------- Reunião ----------

function speakerLabels(m) {
  if (!m.has_system_audio) return { me: "Microfone", others: "Microfone" };
  return { me: settings.user?.name || "Você", others: "Participantes" };
}

const segHtml = (s, labels) =>
  `<div class="seg ${s.channel}"><span class="time" data-t="${s.start}">${fmtClock(s.start)}</span>
   <div><span class="who">${esc(labels[s.channel])}</span>${esc(s.text)}</div></div>`;

// Junta falas seguidas do mesmo canal para leitura mais fluida.
function mergeSegments(segs) {
  const out = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.channel === s.channel && s.start - last.end < 3) {
      last.text += " " + s.text;
      last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

function taskHtml(t, { showMeeting = false } = {}) {
  return `<div class="task ${t.done ? "done" : ""}" data-task="${t.id}">
    <input type="checkbox" ${t.done ? "checked" : ""} data-act="done" title="Concluída">
    <div>
      <div class="desc">${esc(t.description)}</div>
      <div class="sub">
        ${!t.mine && t.owner ? `<span>👤 ${esc(t.owner)}</span>` : ""}
        ${t.due ? `<span>📅 ${esc(t.due)}</span>` : ""}
        ${showMeeting ? `<a href="#/m/${t.meeting_id}">${esc(t.meeting_title)} · ${fmtDate(t.meeting_started_at)}</a>` : ""}
      </div>
      ${t.quote ? `<div class="quote">“${esc(t.quote)}”</div>` : ""}
    </div>
    <div class="tools">
      <button class="icon-btn" data-act="mine" title="${t.mine ? "Não é minha" : "É minha"}">${t.mine ? "↧ não é minha" : "↥ é minha"}</button>
      <button class="icon-btn" data-act="edit" title="Editar">✎</button>
      <button class="icon-btn" data-act="del" title="Apagar">✕</button>
    </div>
  </div>`;
}

function bindTasks(root, tasks, onChange) {
  root.querySelectorAll("[data-task]").forEach(el => {
    const t = tasks.find(x => x.id === +el.dataset.task);
    el.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener(btn.type === "checkbox" ? "change" : "click", async () => {
        const act = btn.dataset.act;
        if (act === "done") await api(`/tasks/${t.id}`, "PATCH", { done: btn.checked });
        if (act === "mine") await api(`/tasks/${t.id}`, "PATCH", { mine: !t.mine });
        if (act === "edit") {
          const d = prompt("Tarefa:", t.description);
          if (d === null) return;
          const due = prompt("Prazo (deixe vazio se não houver):", t.due || "");
          await api(`/tasks/${t.id}`, "PATCH", { description: d, due: due ?? t.due ?? "" });
        }
        if (act === "del" && !confirm("Apagar esta tarefa?")) return;
        if (act === "del") await api(`/tasks/${t.id}`, "DELETE");
        await onChange();
        renderSidebar();
      });
    });
  });
}

const view = { id: null, tab: "notas", data: null };

async function renderMeeting(id) {
  if (view.id !== id) Object.assign(view, { id, tab: "notas" });
  view.data = await api(`/meetings/${id}`);
  const { meeting: m } = view.data;
  main.innerHTML = `<div class="page">
    <input class="title-input" id="m-title" value="${esc(m.title)}" aria-label="Título">
    <div class="meta">
      <span>${fmtDate(m.started_at)}, ${fmtHour(m.started_at)}</span>
      <span>${fmtDuration(m.duration_sec)}</span>
      <span>${m.has_system_audio ? "Microfone + participantes" : "Só microfone"}</span>
    </div>
    <div id="m-banner"></div>
    <div class="tabs">
      ${["notas", "transcricao", "perguntar"].map(t => `<button data-tab="${t}" class="${view.tab === t ? "active" : ""}">${{ notas: "Notas", transcricao: "Transcrição", perguntar: "Perguntar" }[t]}</button>`).join("")}
    </div>
    <div id="m-body"></div>
  </div>`;
  const title = document.getElementById("m-title");
  title.onchange = async () => {
    await api(`/meetings/${id}`, "PATCH", { title: title.value });
    renderSidebar();
  };
  title.onkeydown = e => e.key === "Enter" && title.blur();
  main.querySelectorAll("[data-tab]").forEach(b => (b.onclick = () => {
    view.tab = b.dataset.tab;
    renderMeeting(id);
  }));
  renderBanner(m);
  ({ notas: renderNotes, transcricao: renderTranscript, perguntar: renderChat })[view.tab](view.data);

  stopPolling();
  if (["processing", "summarizing", "recording"].includes(m.status)) {
    const poll = async () => {
      if (location.hash !== `#/m/${id}`) return;
      const fresh = await api(`/meetings/${id}`).catch(() => null);
      if (!fresh) return (pollTimer = setTimeout(poll, 4000));
      const changed = fresh.meeting.status !== m.status || fresh.segments.length !== view.data.segments.length;
      if (changed && document.activeElement?.tagName !== "TEXTAREA") {
        renderMeeting(id);
        renderSidebar();
      } else {
        renderBanner(fresh.meeting);
        pollTimer = setTimeout(poll, 3000);
      }
    };
    pollTimer = setTimeout(poll, 3000);
  }
}

function renderBanner(m) {
  const el = document.getElementById("m-banner");
  if (!el) return;
  if (m.status === "error") el.innerHTML = `<div class="banner error">${esc(m.error)} <button class="btn" id="retry">Tentar de novo</button></div>`;
  else if (m.status !== "ready") el.innerHTML = `<div class="banner">${esc(m.progress || STATUS[m.status]?.[0] || "")}…</div>`;
  else el.innerHTML = m.progress ? `<div class="banner">${esc(m.progress)}</div>` : "";
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = async () => {
    const transcriptionFailed = /^A transcrição falhou/.test(m.error || "");
    await api(`/meetings/${m.id}/${transcriptionFailed ? "retranscribe" : "summarize"}`, "POST", {});
    renderMeeting(m.id);
  };
}

function renderNotes({ meeting: m, tasks }) {
  const s = m.summary;
  const mine = tasks.filter(t => t.mine), others = tasks.filter(t => !t.mine);
  const body = document.getElementById("m-body");
  body.innerHTML = `
    ${s ? `<h2>Resumo</h2><p class="summary">${esc(s.resumo)}</p>` : ""}
    <h2>Minhas tarefas</h2>
    <div class="card">
      <div id="my-tasks">${mine.map(t => taskHtml(t)).join("") || `<p class="muted" style="margin:0">${s ? "Nenhuma tarefa atribuída a você nesta reunião." : "As tarefas aparecem quando as notas ficarem prontas."}</p>`}</div>
      <form class="add-task" id="add-task"><input type="text" placeholder="Adicionar uma tarefa minha…"><button class="btn">Adicionar</button></form>
    </div>
    ${s?.topicos?.length ? `<h2>Tópicos principais</h2><div class="card">${s.topicos.map(t => `<div class="topic"><h3>${esc(t.titulo)}</h3><ul>${t.pontos.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>`).join("")}</div>` : ""}
    ${s?.decisoes?.length ? `<h2>Decisões</h2><div class="card"><ul class="plain-list">${s.decisoes.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
    ${others.length ? `<h2>Tarefas de outras pessoas</h2><div class="card">${others.map(t => taskHtml(t)).join("")}</div>` : ""}
    ${s?.pendencias?.length ? `<h2>Em aberto</h2><div class="card"><ul class="plain-list">${s.pendencias.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
    <h2>Minhas anotações <span class="muted" id="notes-state" style="text-transform:none;letter-spacing:0"></span></h2>
    <textarea class="notes" id="my-notes" placeholder="Escreva aqui o que quiser lembrar desta reunião…">${esc(m.my_notes)}</textarea>
    ${m.status === "ready" || m.status === "error" ? `<div class="actions">
      <button class="btn" id="regen">↻ Gerar as notas de novo</button>
      <button class="btn danger" id="del">Apagar reunião</button></div>` : ""}`;

  const reload = () => renderMeeting(m.id);
  bindTasks(body, tasks, reload);
  document.getElementById("add-task").onsubmit = async e => {
    e.preventDefault();
    const input = e.target.querySelector("input");
    if (!input.value.trim()) return;
    await api(`/meetings/${m.id}/tasks`, "POST", { description: input.value });
    renderSidebar();
    reload();
  };
  const notes = document.getElementById("my-notes"), state = document.getElementById("notes-state");
  let t;
  notes.oninput = () => {
    state.textContent = "· salvando…";
    clearTimeout(t);
    t = setTimeout(async () => {
      await api(`/meetings/${m.id}`, "PATCH", { my_notes: notes.value });
      state.textContent = "· salvo";
    }, 700);
  };
  const regen = document.getElementById("regen");
  if (regen) regen.onclick = async () => {
    const extra = prompt("Gerar as notas de novo. Quer dar alguma orientação? (opcional)\nEx.: \"foque nas decisões técnicas\". As tarefas criadas automaticamente serão substituídas.", "");
    if (extra === null) return;
    await api(`/meetings/${m.id}/summarize`, "POST", { instructions: extra });
    reload();
  };
  const del = document.getElementById("del");
  if (del) del.onclick = async () => {
    if (!confirm("Apagar esta reunião, o áudio e as notas? Não dá para desfazer.")) return;
    await api(`/meetings/${m.id}`, "DELETE");
    location.hash = "#/tarefas";
    renderSidebar();
  };
}

function renderTranscript({ meeting: m, segments }) {
  const labels = speakerLabels(m);
  const body = document.getElementById("m-body");
  body.innerHTML = `
    ${m.status !== "recording" ? `<audio controls preload="metadata" src="/api/meetings/${m.id}/audio.wav"></audio>` : ""}
    <div class="card">${mergeSegments(segments).map(s => segHtml(s, labels)).join("") || `<p class="muted" style="margin:0">Sem falas transcritas.</p>`}</div>
    ${m.status === "ready" || m.status === "error" ? `<div class="actions"><button class="btn" id="retx">Transcrever de novo</button></div>` : ""}`;
  const audio = body.querySelector("audio");
  body.querySelectorAll("[data-t]").forEach(el => (el.onclick = () => {
    if (!audio) return;
    audio.currentTime = +el.dataset.t;
    audio.play();
  }));
  const retx = document.getElementById("retx");
  if (retx) retx.onclick = async () => {
    if (!confirm("Transcrever todo o áudio de novo e depois gerar as notas? Leva alguns minutos.")) return;
    await api(`/meetings/${m.id}/retranscribe`, "POST");
    renderMeeting(m.id);
  };
}

function renderChat({ meeting: m, chat }) {
  const body = document.getElementById("m-body");
  const suggestions = ["Quais são as minhas tarefas e prazos?", "O que ficou decidido?", "Escreva um e-mail curto de follow-up", "O que ficou em aberto?"];
  body.innerHTML = `
    <div class="chat" id="chat">${chat.map(c => `<div class="msg ${c.role}">${c.role === "assistant" ? md(c.content) : esc(c.content)}</div>`).join("")}</div>
    ${chat.length ? "" : `<p class="muted">Pergunte qualquer coisa sobre esta reunião. A resposta vem só da transcrição e das notas, processadas no seu computador.</p>`}
    <div class="suggestions">${suggestions.map(q => `<button>${esc(q)}</button>`).join("")}</div>
    <form class="chat-form" id="chat-form"><input type="text" placeholder="Sua pergunta…" autocomplete="off"><button class="btn primary">Perguntar</button></form>`;
  const form = document.getElementById("chat-form"), input = form.querySelector("input"), list = document.getElementById("chat");
  const ask = async q => {
    if (!q.trim()) return;
    input.value = "";
    form.querySelector("button").disabled = true;
    list.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(q)}</div><div class="msg assistant muted" id="thinking">Pensando… (a primeira pergunta carrega o modelo e pode levar um ou dois minutos)</div>`);
    try {
      const { answer } = await api(`/meetings/${m.id}/chat`, "POST", { question: q });
      document.getElementById("thinking").outerHTML = `<div class="msg assistant">${md(answer)}</div>`;
    } catch (e) {
      document.getElementById("thinking").textContent = "Erro: " + e.message;
    }
    form.querySelector("button").disabled = false;
    input.focus();
  };
  form.onsubmit = e => {
    e.preventDefault();
    ask(input.value);
  };
  body.querySelectorAll(".suggestions button").forEach(b => (b.onclick = () => ask(b.textContent)));
}

// ---------- Minhas tarefas ----------

let showAllTasks = false;
async function renderTasks() {
  const tasks = await api(`/tasks?mine=${showAllTasks ? 0 : 1}`);
  const open = tasks.filter(t => !t.done), done = tasks.filter(t => t.done);
  const groups = new Map();
  for (const t of open) {
    if (!groups.has(t.meeting_id)) groups.set(t.meeting_id, []);
    groups.get(t.meeting_id).push(t);
  }
  main.innerHTML = `<div class="page">
    <h1>${showAllTasks ? "Todas as tarefas" : "Minhas tarefas"}</h1>
    <div class="meta"><span>${open.length} em aberto</span>
      <label class="check"><input type="checkbox" id="all" ${showAllTasks ? "checked" : ""}><span>Mostrar tarefas de todos</span></label></div>
    ${[...groups.values()].map(list => `
      <div class="group-title"><a href="#/m/${list[0].meeting_id}">${esc(list[0].meeting_title)}</a><span class="muted">${fmtDate(list[0].meeting_started_at)}</span></div>
      <div class="card">${list.map(t => taskHtml(t)).join("")}</div>`).join("") || `<div class="empty">Nada pendente. 🎉</div>`}
    ${done.length ? `<details><summary>Concluídas (${done.length})</summary><div class="card" style="margin-top:10px">${done.map(t => taskHtml(t, { showMeeting: true })).join("")}</div></details>` : ""}
  </div>`;
  document.getElementById("all").onchange = e => {
    showAllTasks = e.target.checked;
    renderTasks();
  };
  bindTasks(main, tasks, renderTasks);
}

// ---------- Ajustes ----------

async function renderSettings() {
  const [s, status] = await Promise.all([api("/settings"), api("/status")]);
  main.innerHTML = `<div class="page">
    <h1>Ajustes</h1>
    <form class="card" id="settings" style="margin-top:20px">
      <label class="field"><span>Seu nome</span><small>Usado para identificar as tarefas que são suas.</small>
        <input type="text" name="name" value="${esc(s.user.name)}"></label>
      <label class="field"><span>Apelidos e sobrenome</span><small>Separados por vírgula. Ex.: Chris, Schmith</small>
        <input type="text" name="aliases" value="${esc((s.user.aliases || []).join(", "))}"></label>
      <label class="field"><span>Vocabulário</span><small>Nomes de pessoas, clientes, produtos e siglas, para as notas saírem com a grafia certa.</small>
        <input type="text" name="vocabulary" value="${esc(s.vocabulary.join(", "))}"></label>
      <label class="field"><span>Transcrição</span>
        <select name="mode">
          <option value="preciso" ${s.transcriptionMode === "preciso" ? "selected" : ""}>Precisa — melhor em português; numa reunião de 1 h as notas saem ~15 min após o fim</option>
          <option value="rapido" ${s.transcriptionMode === "rapido" ? "selected" : ""}>Rápida — cerca de 3x mais rápida, com alguns erros de palavras</option>
        </select></label>
      <label class="check"><input type="checkbox" name="system" ${s.captureSystemAudio ? "checked" : ""}><span>Captar o áudio dos participantes por padrão</span></label>
      <div class="actions"><button class="btn primary">Salvar</button><span class="muted" id="saved"></span></div>
    </form>
    <h2>Motores locais</h2>
    <div class="card">
      <div>Transcrição (Whisper): <b>${status.whisper ? "carregado" : "inicia quando necessário"}</b></div>
      <div>Notas e perguntas (Qwen): <b>${status.llm ? "carregado" : "inicia quando necessário"}</b></div>
      <p class="muted" style="margin-bottom:0">Tudo roda neste computador. Nenhum áudio, texto ou nota é enviado para a internet.</p>
      <div class="actions"><button class="btn danger" id="quit">Encerrar o MeetAiNotes</button></div>
    </div>
  </div>`;
  const split = v => v.split(",").map(x => x.trim()).filter(Boolean);
  document.getElementById("settings").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    await api("/settings", "PUT", {
      user: { name: f.name.value, aliases: split(f.aliases.value) },
      vocabulary: split(f.vocabulary.value),
      captureSystemAudio: f.system.checked,
      transcriptionMode: f.mode.value,
    }).then(
      () => (document.getElementById("saved").textContent = "Salvo."),
      err => (document.getElementById("saved").textContent = err.message)
    );
    settings = await api("/settings");
  };
  document.getElementById("quit").onclick = async () => {
    if (rec.active) return alert("Pare a gravação primeiro.");
    if (!confirm("Encerrar o MeetAiNotes e liberar a memória dos modelos?")) return;
    await api("/shutdown", "POST");
    main.innerHTML = `<div class="empty">O MeetAiNotes foi encerrado. Pode fechar esta janela.</div>`;
  };
}

// ---------- Primeira abertura ----------

function renderWelcome() {
  main.innerHTML = `<div class="page">
    <h1>Bem-vindo ao MeetAiNotes</h1>
    <p class="muted">Grave suas reuniões e receba as notas com tópicos principais e as tarefas que são suas.
      Tudo é processado neste computador; nada é enviado para a internet.</p>
    <form class="card" id="welcome" style="margin-top:20px">
      <label class="field"><span>Como você se chama?</span>
        <small>É assim que o MeetAiNotes reconhece, na conversa, as tarefas que são suas.</small>
        <input type="text" name="name" required autofocus placeholder="Ex.: Maria"></label>
      <label class="field"><span>Apelidos ou sobrenome (opcional)</span><small>Separados por vírgula.</small>
        <input type="text" name="aliases" placeholder="Ex.: Mari, Silva"></label>
      <div class="actions"><button class="btn primary">Começar</button></div>
    </form>
  </div>`;
  document.getElementById("welcome").onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    await api("/settings", "PUT", {
      ...settings,
      user: { name: f.name.value, aliases: f.aliases.value.split(",").map(x => x.trim()).filter(Boolean) },
    });
    settings = await api("/settings");
    location.hash = "#/gravar";
  };
}

// ---------- Navegação ----------

async function render() {
  stopPolling();
  const hash = location.hash;
  try {
    if (!settings.user?.name && hash !== "#/ajustes") return renderWelcome();
    if (hash === "#/gravar") rec.active ? renderRecording() : renderRecordSetup();
    else if (hash.startsWith("#/m/")) await renderMeeting(hash.slice(4));
    else if (hash === "#/tarefas") await renderTasks();
    else if (hash === "#/ajustes") await renderSettings();
    else {
      const meetings = await renderSidebar();
      if (meetings.length) return (location.hash = "#/tarefas");
      main.innerHTML = `<div class="empty"><h1>Seu caderno de reuniões</h1>
        <p>Grave uma reunião e o MeetAiNotes transcreve, separa os tópicos principais e lista as tarefas que são suas.</p>
        <p><a class="btn rec big" href="#/gravar">● Começar a primeira gravação</a></p></div>`;
    }
  } catch (e) {
    main.innerHTML = `<div class="page"><div class="banner error">${esc(e.message)}</div></div>`;
  }
  renderSidebar();
}

window.addEventListener("hashchange", render);
api("/settings").then(s => (settings = s)).catch(() => {}).finally(render);
