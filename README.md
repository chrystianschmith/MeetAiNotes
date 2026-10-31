# Ata — caderno de reuniões 100% local

Grava suas reuniões, transcreve em português e gera notas com **resumo**, **tópicos principais**,
**decisões** e **as tarefas que são suas**. Tudo roda no seu computador: nenhum áudio, texto ou
nota é enviado para a internet.

![Notas de uma reunião](docs/notas.png)

## O que ele faz

- **Grava** o seu microfone e o áudio da chamada (Teams, Meet, Zoom…) e separa na transcrição
  o que **você** falou do que os **participantes** falaram.
- **Transcreve enquanto a reunião acontece**, em português, com o Whisper.
- **Gera as notas** quando você para a gravação: resumo, tópicos, decisões, pendências e tarefas.
- **Reconhece as tarefas que são suas**: atribuídas pelo seu nome, pedidas a você e aceitas, ou
  quando você mesmo se compromete ("deixa comigo", "eu vejo isso").
- **Minhas tarefas**: uma lista única com as suas tarefas de todas as reuniões, para marcar como feitas.
- **Perguntar**: converse com cada reunião ("o que ficou decidido?", "escreva o e-mail de follow-up").
- **Anotações pessoais** por reunião e **áudio** com clique no horário para ouvir o trecho.
- **Recupera** a gravação se o computador desligar no meio da reunião.

| Transcrição com quem falou | Minhas tarefas |
|---|---|
| ![Transcrição](docs/transcricao.png) | ![Minhas tarefas](docs/tarefas.png) |

## Requisitos

- Windows 10 ou 11 (64 bits)
- 16 GB de RAM recomendados (funciona com menos, porém mais devagar)
- Cerca de 4 GB livres em disco
- Microsoft Edge (já vem com o Windows)

Não precisa de placa de vídeo dedicada nem de conta em nenhum serviço.

## Instalação

1. Baixe este repositório: botão verde **Code → Download ZIP** (ou `git clone`) e extraia numa pasta
   definitiva, por exemplo `C:\Users\<você>\ata`.
2. Dê dois cliques em **`instalar.cmd`**. Ele baixa os motores e modelos das fontes oficiais
   (cerca de 3,3 GB na primeira vez), confere a integridade de cada arquivo (SHA-256) e cria o
   atalho **Ata** na área de trabalho. Se o seu Node.js for antigo ou não existir, ele instala uma
   cópia portátil só para o Ata.
3. Abra pelo atalho **Ata**. Na primeira vez, informe o seu nome: é com ele que o Ata reconhece
   as suas tarefas.

O instalador pode ser executado de novo a qualquer momento (por exemplo, se a internet cair no meio):
ele mantém o que já foi baixado.

## Como usar

1. Clique em **Nova gravação**.
2. Para captar os outros participantes da chamada, deixe marcado *Captar os outros participantes*.
   O navegador vai pedir para compartilhar a tela: escolha **Tela inteira** e marque
   **Compartilhar áudio do sistema**. Só o áudio é usado.
3. Ao terminar, clique em **Parar e gerar notas**. A transcrição termina e as notas aparecem sozinhas.

Em **Ajustes** você muda o nome, os apelidos, o vocabulário (nomes de clientes, produtos e siglas
para as notas saírem com a grafia certa) e o modo de transcrição.

> **Importante:** avise os participantes de que a reunião está sendo gravada. Gravar conversas sem
> o conhecimento das pessoas pode violar a LGPD e políticas da sua empresa.

## Desempenho

Medido num notebook com Intel Core i5-1235U, 32 GB de RAM e sem placa de vídeo dedicada:

| Etapa | Tempo |
|---|---|
| Transcrição "Precisa" (padrão) | ~1x a duração do áudio; acompanha a reunião ao vivo |
| Transcrição "Rápida" | ~3x mais rápida, com alguns erros de palavras |
| Notas, depois da transcrição | ~2 minutos (inclui carregar o modelo) |
| Perguntas | 5 a 40 segundos |

Numa reunião de 1 hora, conte com as notas prontas uns 15 a 20 minutos após o fim. Computadores
mais potentes são proporcionalmente mais rápidos.

## Privacidade

- O servidor do Ata só aceita conexões do próprio computador (`127.0.0.1`) e recusa pedidos vindos
  de outros sites abertos no navegador.
- Gravações, transcrições e notas ficam em `data/` dentro da pasta do Ata. Para apagar tudo, apague
  essa pasta (ou cada reunião pelo botão *Apagar reunião*).
- A internet só é usada pelo `instalar.cmd`, para baixar os motores e modelos.

## Como funciona

| Etapa | Tecnologia | Código |
|---|---|---|
| Captura | Navegador: microfone no canal esquerdo, áudio do computador no direito, 16 kHz | `public/capture-worklet.js` |
| Transcrição | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) + Whisper large-v3-turbo, em trechos de 18–28 s cortados nas pausas | `lib/transcriber.js` |
| Quem falou | Cada palavra vai para o canal com mais energia naquele instante | `lib/transcriber.js` |
| Notas e perguntas | [llama.cpp](https://github.com/ggml-org/llama.cpp) + Qwen 3.5 4B, saída JSON validada por esquema | `lib/summarizer.js` |
| Dados | SQLite (embutido no Node.js) e WAV | `lib/db.js`, `server.js` |

Sem dependências do npm: o app usa só o Node.js. Os motores rodam como processos locais e são
iniciados sob demanda; a transcrição roda com prioridade baixa para não atrapalhar a chamada de vídeo.

## Problemas comuns

- **Nada acontece ao abrir o atalho:** rode o `instalar.cmd` de novo e veja a mensagem de erro.
- **Notas ou transcrição com erro:** veja os registros em `data/ata.log`, `data/whisper.log` e `data/llm.log`.
- **Não aparece "Compartilhar áudio do sistema":** escolha **Tela inteira** (não uma janela ou aba).
- **Lento demais:** em Ajustes, troque a transcrição para **Rápida**.

## Desinstalar

Apague a pasta do Ata e o atalho da área de trabalho. Nada é instalado fora dessa pasta.

## Desenvolvimento

```
node test/run-tests.js
```

Roda a bateria de testes de ponta a ponta com motores simulados (não precisa dos modelos).

## Créditos e licenças

- Código do Ata: licença [MIT](LICENSE).
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) e [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT).
- Modelos [Whisper](https://github.com/openai/whisper) da OpenAI (MIT), convertidos pelo projeto whisper.cpp.
- [Qwen 3.5 4B](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) (consulte a licença no card do modelo).
- [Silero VAD](https://github.com/snakers4/silero-vad) (MIT).
- [Node.js](https://nodejs.org) (MIT).

Os motores e modelos não são distribuídos neste repositório: o instalador os baixa das fontes oficiais.
