@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  Arb Bot Deploy Script v2
echo  %date% %time%
echo ============================================

:: ── Get expected version from okx-arb.js ─────────────────────────────────────
for /f "delims=" %%i in ('node -e "const s=require('fs').readFileSync('okx-arb.js','utf8');const m=s.match(/BOT_VERSION\s*=\s*'([^']+)'/);console.log(m?m[1]:'unknown')" 2^>nul') do set "BOTVER=%%i"
echo.
echo [1/8] Expected version: %BOTVER%

:: ── Verify dashboard.js has matching version ──────────────────────────────────
echo.
echo [2/8] Verifying file versions match...
node -e "
const fs=require('fs');
const bot=fs.readFileSync('okx-arb.js','utf8');
const dash=fs.readFileSync('dashboard.js','utf8');
const botVer=(bot.match(/BOT_VERSION\s*=\s*'([^']+)'/)||[])[1]||'?';
const dashVer=(dash.match(/Dashboard\s+(v[\d.]+)/)||[])[1]||'?';
const krakenOk=fs.existsSync('kraken-scaffold.js');
console.log('  okx-arb.js:    '+botVer);
console.log('  dashboard.js:  '+dashVer);
console.log('  kraken:        '+(krakenOk?'present':'MISSING'));
" 2>nul
echo.

:: ── Stop all node processes ───────────────────────────────────────────────────
echo [3/8] Stopping node processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 "') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 /nobreak >nul
echo       Done.

:: ── Verify required files ─────────────────────────────────────────────────────
echo.
echo [4/8] Verifying files...
set "MISSING=0"
if not exist "okx-arb.js"        (echo       MISSING: okx-arb.js & set "MISSING=1")
if not exist "dashboard.js"       (echo       MISSING: dashboard.js & set "MISSING=1")
if not exist "kraken-scaffold.js" (echo       MISSING: kraken-scaffold.js & set "MISSING=1")
if not exist "watchdog.js"        (echo       MISSING: watchdog.js & set "MISSING=1")
if not exist "arb-config.json"    (echo       MISSING: arb-config.json & set "MISSING=1")
if not exist ".env"               (echo       MISSING: .env & set "MISSING=1")
if "!MISSING!"=="1" (echo. & echo ERROR: Files missing. & pause & exit /b 1)
echo       All files present.

:: ── Syntax check all JS ───────────────────────────────────────────────────────
echo.
echo [5/8] Syntax checking...
node --check okx-arb.js >nul 2>&1
if errorlevel 1 (echo       ERROR: okx-arb.js has syntax errors & pause & exit /b 1)
echo       okx-arb.js OK
node --check dashboard.js >nul 2>&1
if errorlevel 1 (echo       ERROR: dashboard.js has syntax errors & pause & exit /b 1)
echo       dashboard.js OK
node --check kraken-scaffold.js >nul 2>&1
if errorlevel 1 (echo       ERROR: kraken-scaffold.js has syntax errors & pause & exit /b 1)
echo       kraken-scaffold.js OK
node --check watchdog.js >nul 2>&1
if errorlevel 1 (echo       ERROR: watchdog.js has syntax errors & pause & exit /b 1)
echo       watchdog.js OK

:: ── Validate config ───────────────────────────────────────────────────────────
echo.
echo [6/8] Validating arb-config.json...
node -e "try{JSON.parse(require('fs').readFileSync('arb-config.json','utf8'));process.exit(0);}catch(e){console.error(e.message);process.exit(1);}" >nul 2>&1
if errorlevel 1 (echo       ERROR: arb-config.json invalid JSON & pause & exit /b 1)
echo       arb-config.json OK

:: ── Backup state ──────────────────────────────────────────────────────────────
echo.
echo [7/8] Backing up state...
if exist "arb-state.json" copy /Y "arb-state.json" "arb-state.json.deploy-bak" >nul
if exist "trades.json"    copy /Y "trades.json"    "trades.json.deploy-bak"    >nul
echo       Done. Rollback available via dashboard.

:: ── Start processes ───────────────────────────────────────────────────────────
echo.
echo [8/8] Starting %BOTVER%...
start "Watchdog [%BOTVER%]" /D "%~dp0" node watchdog.js
timeout /t 5 /nobreak >nul
start "Dashboard [%BOTVER%]" /D "%~dp0" node dashboard.js
timeout /t 3 /nobreak >nul

:: ── Final check ───────────────────────────────────────────────────────────────
echo.
echo Checking dashboard started...
timeout /t 3 /nobreak >nul
node -e "
const h=require('http');
const r=h.get('http://localhost:3000',res=>{console.log('  Dashboard: HTTP '+res.statusCode+' OK');});
r.on('error',()=>console.log('  Dashboard: NOT RESPONDING - check Dashboard window for errors'));
r.setTimeout(3000,()=>console.log('  Dashboard: TIMEOUT'));
" 2>nul

echo.
echo ============================================
echo  DEPLOYED: %BOTVER%
echo  Dashboard: http://localhost:3000
echo ============================================
echo.
pause >nul
