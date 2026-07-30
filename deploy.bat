@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  Arb Bot Deploy
echo  %date% %time%
echo ============================================

echo.
echo [1/6] Pulling latest from GitHub...
git pull origin main
if errorlevel 1 (echo ERROR: git pull failed & pause & exit /b 1)

for /f "delims=" %%i in ('node -e "const s=require('fs').readFileSync('okx-arb.js','utf8');const m=s.match(/BOT_VERSION\s*=\s*'([^']+)'/);console.log(m?m[1]:'unknown')" 2^>nul') do set "BOTVER=%%i"
echo       Deploying %BOTVER%

echo.
echo [2/6] Stopping node processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul
echo       Done.

echo.
echo [3/6] Syntax checking...
node --check okx-arb.js >nul 2>&1
if errorlevel 1 (echo ERROR: okx-arb.js syntax & pause & exit /b 1)
node --check dashboard.js >nul 2>&1
if errorlevel 1 (echo ERROR: dashboard.js syntax & pause & exit /b 1)
node --check watchdog.js >nul 2>&1
if errorlevel 1 (echo ERROR: watchdog.js syntax & pause & exit /b 1)
echo       All OK.

echo.
echo [4/6] Validating config...
node -e "try{JSON.parse(require('fs').readFileSync('arb-config.json','utf8'));process.exit(0);}catch(e){process.exit(1);}" >nul 2>&1
if errorlevel 1 (echo ERROR: arb-config.json invalid & pause & exit /b 1)
echo       OK.

echo.
echo [5/6] Backing up state...
if exist "arb-state.json" copy /Y "arb-state.json" "arb-state.json.deploy-bak" >nul
if exist "trades.json" copy /Y "trades.json" "trades.json.deploy-bak" >nul
echo       Done.

echo.
echo [6/6] Starting %BOTVER%...
start "Watchdog [%BOTVER%]" /D "%~dp0" node watchdog.js
timeout /t 5 /nobreak >nul
start "Dashboard [%BOTVER%]" /D "%~dp0" node dashboard.js

echo.
echo ============================================
echo  DEPLOYED: %BOTVER%
echo  Dashboard: http://localhost:3000
echo ============================================
echo.
pause
