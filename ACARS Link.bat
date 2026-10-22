@echo off
rem ACARS Link: builds and starts the sim bridge and the desktop app; stops the bridge when the
rem app window is closed. Shortcut: right click -> Create shortcut, Run: Minimized.
rem The bridge reads MSFS, or X-Plane 12 when Settings -> "Simulator" is "X-Plane 12" (T18).
setlocal
cd /d "%~dp0"
title ACARS Link

set "BRIDGE_EXE=%~dp0bridge\msfs\src\AcarsBridge\bin\Debug\net8.0\acars-msfs-bridge.exe"
set "BRIDGE_STARTED="
set "BRIDGE_ARGS="
findstr /r /c:"\"simulator\": *\"xplane\"" "%APPDATA%\ACARS Link\settings.json" >nul 2>&1
if not errorlevel 1 set "BRIDGE_ARGS=--source xplane"

tasklist /fi "imagename eq acars-msfs-bridge.exe" | find /i "acars-msfs-bridge.exe" >nul
if not errorlevel 1 (
  echo The sim bridge is already running.
  goto app
)

echo Building the sim bridge...
call pnpm bridge:build >"%TEMP%\acars-bridge-build.log" 2>&1
if errorlevel 1 (
  echo Bridge build failed, see %TEMP%\acars-bridge-build.log
  echo The app starts anyway; it waits for the bridge.
  goto app
)
start "ACARS bridge" /min "%BRIDGE_EXE%" %BRIDGE_ARGS%
set "BRIDGE_STARTED=1"

:app
echo Building and starting the app...
rem electron-vite preview builds the app before it starts it.
call pnpm -F @acars/desktop start
if errorlevel 1 (
  echo The app exited with an error. If it did not start, run "pnpm install" in this folder.
  pause
)

if defined BRIDGE_STARTED (
  taskkill /im acars-msfs-bridge.exe /f >nul 2>&1
)
endlocal
