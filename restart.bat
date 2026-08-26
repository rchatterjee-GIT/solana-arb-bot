@echo off
echo Stopping all node processes and windows...
taskkill /F /IM node.exe /T 2>nul
taskkill /F /FI "WINDOWTITLE eq Watchdog*" /T 2>nul
taskkill /F /FI "WINDOWTITLE eq Dashboard*" /T 2>nul
taskkill /F /FI "WINDOWTITLE eq Agent*" /T 2>nul
taskkill /F /FI "WINDOWTITLE eq Dex*" /T 2>nul
taskkill /F /FI "WINDOWTITLE eq cmd*" /FI "STATUS eq RUNNING" /T 2>nul
timeout /t 5

start "Watchdog" cmd /k "cd C:\Users\Ramen\solana-arb-bot && node watchdog.js"
timeout /t 8
start "Dashboard" cmd /k "cd C:\Users\Ramen\solana-arb-bot && node dashboard.js"
timeout /t 3
start "Agent" cmd /k "cd C:\Users\Ramen\solana-arb-bot && node agent.js"
timeout /t 3
start "Dex" cmd /k "cd C:\Users\Ramen\solana-arb-bot && dex-arb.js"
echo Done - 4 windows opened