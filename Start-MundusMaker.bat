@echo off
rem Starts MundusMaker in the background with an icon in the Windows tray, so
rem there is no window that closing by mistake would stop. Quit it from the
rem tray icon or from Settings in the app. MundusMaker-Console.bat runs it in a
rem window instead, which helps when something goes wrong.
cd /d "%~dp0"

rem Without a bundled runtime or an installed Node.js, the console launcher
rem explains how to get one.
if exist "%~dp0runtime\MundusMaker.exe" goto runtime_found
if exist "%~dp0runtime\node.exe" goto runtime_found
where node >nul 2>nul
if errorlevel 1 goto console
:runtime_found

rem PowerShell, built into Windows, runs the tray icon. If it is missing or
rem blocked on this computer, use the console window instead.
if not exist "%~dp0MundusMaker-Tray.ps1" goto console
powershell -NoProfile -ExecutionPolicy Bypass -Command "exit 0" >nul 2>nul
if errorlevel 1 goto console

start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0MundusMaker-Tray.ps1"
exit /b 0

:console
call "%~dp0MundusMaker-Console.bat"
