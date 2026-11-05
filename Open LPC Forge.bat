@echo off
title LPC Forge
cd /d "%~dp0"
set "URL=http://127.0.0.1:4179/"

curl -s -o nul --max-time 2 "%URL%"
if not errorlevel 1 (
  echo LPC Forge is already running. Opening it in your browser.
  if not defined LPCFORGE_NO_BROWSER start "" "%URL%"
  timeout /t 3 >nul
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found, so LPC Forge cannot start.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing what LPC Forge needs. This takes a few minutes.
  set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)

if not exist "dist\index.html" (
  echo Building LPC Forge. This takes a few minutes the first time.
  call npm run build
  if errorlevel 1 goto failed
)

echo.
echo LPC Forge is running at %URL%
echo Keep this window open while you use it. Closing the window stops it.
echo.
if not defined LPCFORGE_NO_BROWSER start "" "%URL%"
call npx vite preview --host 127.0.0.1 --port 4179 --strictPort
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo LPC Forge could not start. The error is shown above.
pause
exit /b 1
