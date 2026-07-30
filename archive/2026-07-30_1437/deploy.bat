@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ============================================
echo  Arb Bot Deploy
echo  %date% %time%
echo ============================================

echo.
echo [1/4] Pulling latest from GitHub...
git pull origin main
if errorlevel 1 (echo ERROR: git pull failed & pause & exit /b 1)

echo.
echo [2/4] Running pre-deploy verification...
node verify-deploy.js
if errorlevel 1 (
  echo.
  echo DEPLOY ABORTED - verification failed.
  echo Fix the issues above then run deploy.bat again.
  pause & exit /b 1
)

echo.
echo [3/4] Backing up state...
if exist "arb-state.json" copy /Y "arb-state.json" "arb-state.json.deploy-bak" >nul
if exist "trades.json"    copy /Y "trades.json"    "trades.json.deploy-bak"    >nul
echo       Done. Rollback available via dashboard.

echo.
echo [4/4] Starting processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul
start "Watchdog" /D "%~dp0" node watchdog.js
timeout /t 5 /nobreak >nul
start "Dashboard" /D "%~dp0" node dashboard.js

echo.
echo ============================================
echo  DEPLOYED
echo  Dashboard: http://localhost:3001
echo ============================================
echo.
pause >nul
