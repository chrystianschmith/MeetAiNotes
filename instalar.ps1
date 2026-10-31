# Instalador do MeetAiNotes.
# Baixa os motores e modelos das fontes oficiais, confere o SHA-256 de cada arquivo e cria o atalho.
# Pode ser executado de novo a qualquer momento: o que já estiver baixado e íntegro é mantido.
param(
  [switch]$SemAtalho
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot

function Escrever($texto, $cor = 'Gray') { Write-Host $texto -ForegroundColor $cor }

$Downloads = @(
  @{
    Nome = 'Motor de transcrição (whisper.cpp b5454)'
    Url = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
    Sha = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
    Arquivo = 'engines\whisper.zip'
    ExtrairEm = 'engines\whisper'
    Pronto = 'engines\whisper\Release\whisper-server.exe'
  },
  @{
    Nome = 'Motor de IA (llama.cpp b12017)'
    Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b12017/llama-b12017-bin-win-vulkan-x64.zip'
    Sha = 'e3d43788fed7b2e5983320975cb21d91fbc2579698a497f0f8cecbe9c029312b'
    Arquivo = 'engines\llama.zip'
    ExtrairEm = 'engines\llama'
    Pronto = 'engines\llama\llama-server.exe'
  },
  @{
    Nome = 'Detector de fala (Silero VAD, 1 MB)'
    Url = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin'
    Sha = '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf'
    Arquivo = 'engines\models\ggml-silero-v5.1.2.bin'
  },
  @{
    Nome = 'Transcrição "Rápida" (Whisper small, 190 MB)'
    Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
    Sha = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
    Arquivo = 'engines\models\ggml-small-q5_1.bin'
  },
  @{
    Nome = 'Transcrição "Precisa" (Whisper large-v3-turbo, 574 MB)'
    Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
    Sha = '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
    Arquivo = 'engines\models\ggml-large-v3-turbo-q5_0.bin'
  },
  @{
    Nome = 'Modelo de notas e perguntas (Qwen 3.5 4B, 2,7 GB)'
    Url = 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf'
    Sha = '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'
    Arquivo = 'engines\models\Qwen3.5-4B-Q4_K_M.gguf'
  }
)

$NodePortatil = @{
  Nome = 'Node.js 22.23.4 (portátil, só para o MeetAiNotes)'
  Url = 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip'
  Sha = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
  Arquivo = 'engines\node.zip'
  ExtrairEm = 'engines'
  Pronto = 'engines\node\node.exe'
}

# Usa .NET diretamente (e não Get-FileHash/Expand-Archive) para funcionar mesmo quando os módulos do
# PowerShell não carregam, por exemplo ao abrir o PowerShell 5.1 a partir do PowerShell 7.
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Sha256($caminho) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fluxo = [System.IO.File]::OpenRead($caminho)
  try { -join ($sha.ComputeHash($fluxo) | ForEach-Object { $_.ToString('x2') }) } finally { $fluxo.Dispose(); $sha.Dispose() }
}

function Hash-Confere($caminho, $sha) {
  (Test-Path $caminho) -and ((Sha256 $caminho) -eq $sha.ToLower())
}

function Baixar($item) {
  $destino = Join-Path $Root $item.Arquivo
  New-Item -ItemType Directory -Force (Split-Path $destino) | Out-Null
  if (Hash-Confere $destino $item.Sha) { Escrever "  ok (já baixado): $($item.Nome)"; return $destino }

  Escrever "  baixando: $($item.Nome)" 'Cyan'
  for ($tentativa = 1; $tentativa -le 2; $tentativa++) {
    # -C - retoma um download interrompido; na segunda tentativa começa do zero.
    if ($tentativa -eq 2 -and (Test-Path $destino)) { Remove-Item $destino -Force }
    & curl.exe -L --fail --retry 3 -C - -# -o $destino $item.Url
    if ($LASTEXITCODE -eq 0 -and (Hash-Confere $destino $item.Sha)) { return $destino }
  }
  if (Test-Path $destino) { Remove-Item $destino -Force }
  throw "Não foi possível baixar '$($item.Nome)' com o conteúdo esperado (SHA-256). Verifique a internet e rode o instalador de novo."
}

function Instalar($item) {
  if ($item.Pronto -and (Test-Path (Join-Path $Root $item.Pronto))) { Escrever "  ok (já instalado): $($item.Nome)"; return }
  $arquivo = Baixar $item
  if ($item.ExtrairEm) {
    $destino = Join-Path $Root $item.ExtrairEm
    $temp = Join-Path $Root 'engines\_extraindo'
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($arquivo, $temp)
    New-Item -ItemType Directory -Force $destino | Out-Null
    Get-ChildItem $temp | ForEach-Object { Move-Item $_.FullName $destino -Force }
    Remove-Item $temp -Recurse -Force
    Remove-Item $arquivo -Force
  }
}

function Node-Compativel {
  try {
    $v = & node --version 2>$null
    if ($v -match '^v(\d+)\.(\d+)') {
      $maior = [int]$Matches[1]; $menor = [int]$Matches[2]
      return ($maior -gt 22) -or ($maior -eq 22 -and $menor -ge 5)
    }
  } catch {}
  return $false
}

try {
  Escrever ''
  Escrever '=== Instalação do MeetAiNotes ===' 'White'
  Escrever "Pasta: $Root"

  if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'O MeetAiNotes precisa do Windows 10 ou 11.' }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'O MeetAiNotes precisa de um Windows de 64 bits.' }
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe não encontrado (vem com o Windows 10 1803 ou mais novo).' }

  $livreGB = [math]::Round((Get-PSDrive ((Resolve-Path $Root).Drive.Name)).Free / 1GB, 1)
  if ($livreGB -lt 4) { throw "Espaço livre insuficiente: $livreGB GB. São necessários cerca de 4 GB." }
  Add-Type -AssemblyName Microsoft.VisualBasic
  $ramGB = [math]::Round((New-Object Microsoft.VisualBasic.Devices.ComputerInfo).TotalPhysicalMemory / 1GB)
  if ($ramGB -lt 12) { Escrever "Aviso: este computador tem $ramGB GB de RAM. Recomendamos 16 GB; com menos, as notas podem demorar bastante." 'Yellow' }

  # Arquivos baixados do GitHub vêm marcados como "da internet"; desbloqueia os do próprio MeetAiNotes.
  Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\engines\*' -and $_.FullName -notlike '*\data\*' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }

  Escrever ''
  Escrever 'Node.js:' 'White'
  if (Test-Path (Join-Path $Root $NodePortatil.Pronto)) { Escrever '  ok (portátil já instalado)' }
  elseif (Node-Compativel) { Escrever "  ok (usando o Node do sistema: $(& node --version))" }
  else {
    Instalar $NodePortatil
    Rename-Item (Join-Path $Root 'engines\node-v22.23.4-win-x64') 'node'
  }

  Escrever ''
  Escrever 'Motores e modelos (cerca de 3,3 GB na primeira vez):' 'White'
  foreach ($item in $Downloads) { Instalar $item }

  $config = Join-Path $Root 'config.json'
  if (-not (Test-Path $config)) { Copy-Item (Join-Path $Root 'config.example.json') $config }

  if (-not $SemAtalho) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $atalho = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'MeetAiNotes.lnk'))
    $atalho.TargetPath = 'wscript.exe'
    $atalho.Arguments = '"' + (Join-Path $Root 'MeetAiNotes.vbs') + '"'
    $atalho.WorkingDirectory = $Root
    $atalho.IconLocation = "$env:SystemRoot\System32\imageres.dll,109"
    $atalho.Description = 'MeetAiNotes - caderno de reuniões'
    $atalho.Save()
    Escrever ''
    Escrever "Atalho criado: $desktop\MeetAiNotes.lnk"
  }

  Escrever ''
  Escrever 'Pronto! Abra o MeetAiNotes pelo atalho na área de trabalho (ou com dois cliques em MeetAiNotes.vbs).' 'Green'
} catch {
  Escrever ''
  Escrever "ERRO: $($_.Exception.Message)" 'Red'
  exit 1
}
