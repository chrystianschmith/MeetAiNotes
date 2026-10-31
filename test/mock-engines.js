// Motores falsos para os testes: imitam o whisper-server (SRT palavra a palavra) e o llama-server.
const http = require("node:http");

function startMockEngines({ whisperPort, llmPort }) {
  const calls = { whisper: 0, llm: 0, lastLlmBody: null };
  const ts = t => `00:00:${String(Math.floor(t)).padStart(2, "0")},${String(Math.round((t % 1) * 1000)).padStart(3, "0")}`;

  const whisper = http.createServer((req, res) => {
    req.on("data", () => {}).on("end", () => {
      if (req.method === "GET") return res.end("ok");
      calls.whisper++;
      const words = `Trecho ${calls.whisper} da reunião, eu vejo o backup até sexta.`.split(" ");
      let srt = `1\n${ts(0)} --> ${ts(0.4)}\n\n\n`;
      words.forEach((w, i) => {
        const a = 0.5 + i * 0.3;
        srt += `${i + 2}\n${ts(a)} --> ${ts(a + 0.28)}\n ${w}\n\n`;
      });
      srt += `99\n${ts(6)} --> ${ts(7)}\n Legendas pela comunidade Amara.org\n\n`; // alucinação típica
      res.setHeader("Content-Type", "text/plain");
      res.end(srt);
    });
  }).listen(whisperPort, "127.0.0.1");

  const llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d)).on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end('{"status":"ok"}');
      calls.llm++;
      const b = JSON.parse(body);
      calls.lastLlmBody = b;
      const content = b.response_format
        ? JSON.stringify({
            titulo: "Migração do cluster", resumo: "Resumo de teste.",
            topicos: [{ titulo: "Backup", pontos: ["Validar backup", "Custos"] }], decisoes: ["Usar M30"],
            tarefas: [
              { descricao: "Validar o backup", responsavel: "Maria", prazo: "sexta", para_mim: false, trecho: "[00:01] eu vejo o backup" },
              { descricao: "Criar cluster", responsavel: "Ana", prazo: "", para_mim: false, trecho: "" },
              { descricao: "Mandar ata", responsavel: "Não definido", prazo: "", para_mim: true, trecho: "" },
            ],
            pendencias: ["Orçamento"],
          })
        : "<think>raciocínio</think>Você ficou com o backup até sexta [00:01].";
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  }).listen(llmPort, "127.0.0.1");

  return { calls, close: () => Promise.all([whisper, llm].map(s => new Promise(r => s.close(r)))), closeWhisper: () => new Promise(r => whisper.close(r)) };
}

module.exports = { startMockEngines };
