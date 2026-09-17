@echo off
setlocal
cd /d "%~dp0"

echo.
echo   poputchka. local server  -  admin panel + /api/ingest + t.me/s mirror
echo   =====================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js not found. Install Node.js 22.18 or newer: https://nodejs.org/
  echo       Then run this file again.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 (
  echo   [!] Node.js is too old: version 22.18 or newer is required, see https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Installing dependencies, this happens once and takes about a minute...
  call npm install
  if errorlevel 1 (
    echo   [!] npm install failed - see the output above.
    pause
    exit /b 1
  )
)

echo.
echo   Values for the browser extension popup - the server prints them below too:
echo     serverUrl : http://127.0.0.1:8790
echo     token     : demo-ingest-token
echo     admin UI  : http://localhost:8790
echo.
echo   Full step-by-step guide in Russian: docs\try-it.md
echo   Install the extension: chrome://extensions - Developer mode -
echo   Load unpacked - pick the "extension" folder of this repository.
echo.
echo   Stop the server with Ctrl+C
echo   ---------------------------------------------------------------------
echo.

node parcel\demo\server.mjs

echo.
echo   Server stopped.
pause
