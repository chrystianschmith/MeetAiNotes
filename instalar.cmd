@echo off
rem Instala o Ata: baixa os motores e modelos (cerca de 3,3 GB) e cria o atalho na area de trabalho.
chcp 65001 >nul
rem Evita conflito de modulos quando aberto a partir do PowerShell 7.
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
echo.
pause
