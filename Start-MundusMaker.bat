@echo off
title MundusMaker
cd /d "%~dp0"

rem Prefer the bundled runtime (one-click download), fall back to installed Node.
if exist "%~dp0runtime\node.exe" (
  echo.
  echo  Starting MundusMaker... your browser will open in a moment.
  echo  Keep this window open while you use it. Close it to stop.
  echo.
  "%~dp0runtime\node.exe" server.js
  if errorlevel 1 pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ============================================================
  echo   MundusMaker needs Node.js ^(free, one-time install^).
  echo.
  echo   1. Your browser will open nodejs.org - click the green
  echo      "LTS" download button.
  echo   2. Run the installer. Just click Next until it finishes.
  echo   3. Double-click Start-MundusMaker.bat again.
  echo.
  echo   ^(Or grab the "windows-x64" MundusMaker download instead -
  echo    it has everything built in.^)
  echo  ============================================================
  echo.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)

echo.
echo  Starting MundusMaker... your browser will open in a moment.
echo  Keep this window open while you use it. Close it to stop.
echo.
node server.js
if errorlevel 1 pause
