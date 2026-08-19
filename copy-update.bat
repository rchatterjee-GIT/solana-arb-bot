cat > /d/Downloads/copy-update.bat << 'EOF'
@echo off
setlocal EnableDelayedExpansion
set "BOT=C:\Users\Ramen\solana-arb-bot"
set "DL=D:\Downloads"
set "ARCH=%BOT%\archive\%date:~-4%-%date:~3,2%-%date:~0,2%_%time:~0,2%%time:~3,2%"
set "ARCH=%ARCH: =0%"
echo ============================================
echo  Copy Updates from Downloads to Bot Folder
echo  %date% %time%
echo ============================================
echo.
echo [1/3] Creating archive of current files...
mkdir "%ARCH%" 2>nul
set "ARCHIVED=0"
for %%f in (
  okx-arb.js dashboard.js watchdog.js verify-deploy.js
  agent.js agent-rules.js market-data.js listing-monitor.js
  spread-analysis.js funding-monitor.js hygiene.js news-monitor.js
  coinbase-scaffold.js kraken-scaffold.js threshold-engine.js
  arb-config.json macro-context.json
) do (
  if exist "%BOT%\%%f" (
    copy /Y "%BOT%\%%f" "%ARCH%\%%f" >nul
    set /a ARCHIVED+=1
  )
)
echo       %ARCHIVED% files archived to: %ARCH%
echo.
echo [2/3] Copying new files from Downloads...
set "COPIED=0"
set "SKIPPED=0"
for %%f in (
  okx-arb.js dashboard.js watchdog.js verify-deploy.js
  agent.js agent-rules.js market-data.js listing-monitor.js
  spread-analysis.js funding-monitor.js hygiene.js news-monitor.js
  coinbase-scaffold.js kraken-scaffold.js threshold-engine.js
  arb-config.json macro-context.json
) do (
  if exist "%DL%\%%f" (
    copy /Y "%DL%\%%f" "%BOT%\%%f" >nul
    echo       Copied: %%f
    set /a COPIED+=1
    del "%DL%\%%f" >nul
  ) else (
    echo       Skipped (not in Downloads): %%f
    set /a SKIPPED+=1
  )
)
echo       %COPIED% copied, %SKIPPED% skipped.
echo.
echo [3/3] Next steps in Git Bash:
echo   cd ~/solana-arb-bot
echo   git add -A ^&^& git commit -m "vX.XX desc" ^&^& git push
echo   node verify-deploy.js
echo.
pause >nul
EOF