' Abre o Ata: inicia o servidor local (sem janela) e abre o app no Edge.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' Usa o Node instalado pelo instalar.cmd; se nao houver, o Node do sistema.
node = dir & "\engines\node\node.exe"
If Not fso.FileExists(node) Then node = "node"

On Error Resume Next
sh.Run """" & node & """ --no-warnings server.js", 0, False
If Err.Number <> 0 Then
  MsgBox "Nao encontrei o Node.js. Rode o instalar.cmd novamente.", 16, "Ata"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Sleep 1500
edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=http://127.0.0.1:4280", 1, False
Else
  sh.Run "http://127.0.0.1:4280", 1, False
End If
