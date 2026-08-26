@echo off
echo ============================================
echo  Setting up Staging Environment
echo ============================================
echo.

set "PROD=C:\Users\Ramen\solana-arb-bot"
set "STAGING=C:\Users\Ramen\solana-arb-bot-staging"

if exist "%STAGING%" (
  echo Staging already exists at %STAGING%
  echo Pulling latest from staging branch...
  cd "%STAGING%"
  git pull origin staging
) else (
  echo Cloning staging environment...
  git clone "%PROD%" "%STAGING%"
  cd "%STAGING%"
  git checkout -b staging 2>nul || git checkout staging
)

echo.
echo Copying .env from prod (not committed to git)...
copy /Y "%PROD%\.env" "%STAGING%\.env" >nul
echo Done.

echo.
echo Staging environment ready at:
echo   %STAGING%
echo.
echo Workflow:
echo   1. Make changes in staging folder
echo   2. Run: cd %STAGING% ^&^& node run-tests.js
echo   3. If ALL TESTS PASSED: copy to prod and deploy
echo.
pause
