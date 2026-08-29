@echo off
setlocal
set "BOT=C:\Users\Ramen\solana-arb-bot"

echo ============================================
echo  arb-core v5.0 -- Deploy
echo  %date% %time%
echo ============================================
echo.

echo [1/5] Killing all node processes and bot windows...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Watchdog*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Dashboard*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Agent*" >nul 2>&1
timeout /t 8 /nobreak >nul
taskkill /F /IM node.exe /T >nul 2>&1
echo Done.
echo.

echo [2/5] Syncing disk with git...
pushd "%BOT%"
git pull origin main
echo Done.
echo.

echo [3/5] Running unit tests...
node "%BOT%\test\unit.test.js"
if errorlevel 1 (
  echo.
  echo UNIT TESTS FAILED -- deploy aborted
  popd & pause & exit /b 1
)
echo.

echo [4/5] Starting bot windows...
timeout /t 2 /nobreak >nul
start "Watchdog"  cmd /k "title Watchdog && pushd %BOT% && node watchdog.js"
timeout /t 5 /nobreak >nul
start "Dashboard" cmd /k "title Dashboard && pushd %BOT% && node dashboard.js"
timeout /t 3 /nobreak >nul
start "Agent"     cmd /k "title Agent && pushd %BOT% && node agent.js"
echo.

echo [5/5] Waiting 25s then running integration tests...
timeout /t 25 /nobreak >nul
node "%BOT%\test\integration.test.js"
if errorlevel 1 (
  echo.
  echo WARNING: INTEGRATION TESTS FAILED
  popd & pause & exit /b 1
)
echo.
echo ============================================
echo  DEPLOY COMPLETE
echo ============================================
popd
pause
