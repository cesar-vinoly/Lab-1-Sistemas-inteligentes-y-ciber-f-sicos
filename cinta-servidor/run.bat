@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instala Node.js 24 LTS desde https://nodejs.org/en/download
  echo Despues volve a ejecutar este archivo.
  pause
  exit /b 1
)
node server.mjs --host 0.0.0.0 --open
if errorlevel 1 pause
endlocal
