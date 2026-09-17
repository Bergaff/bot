@echo off
setlocal
cd /d "%~dp0"

rem Port: first argument, or 8790. The server itself picks the next free
rem port when 8790 is taken by another program and says so.
set SRVPORT=%~1
if "%SRVPORT%"=="" set SRVPORT=8790

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
echo   Values for the browser extension popup - the server prints the final ones below:
echo     serverUrl : http://127.0.0.1:%SRVPORT%
echo     token     : demo-ingest-token
echo     admin UI  : http://localhost:%SRVPORT%
echo.
echo   Port %SRVPORT% already in use?
echo     - if it is a previous run of THIS server, it will say so and give the URL;
echo     - if another program took it, the server moves to the next free port
echo       and prints the serverUrl to put into the extension popup;
echo     - to choose a port yourself:  start-local.bat 8791
echo.
echo   Full step-by-step guide in Russian: docs\try-it.md
echo   Install the extension: chrome://extensions - Developer mode -
echo   Load unpacked - pick the "extension" folder of this repository.
echo.
echo   Stop the server with Ctrl+C
echo   ---------------------------------------------------------------------
echo.

if "%~1"=="" (
  node parcel\demo\server.mjs
) else (
  node parcel\demo\server.mjs %~1
)

echo.
if errorlevel 1 (
  echo   [!] The server did not start - the reason is printed above.
) else (
  echo   Server stopped. If it said "already running", just open that URL.
)
pause
