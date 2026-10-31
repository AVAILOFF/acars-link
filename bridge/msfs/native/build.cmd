@echo off
rem SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
rem Copyright (c) 2026 AVAILOFF
rem
rem Builds acars_simconnect.dll (T73): the SimConnect client linked statically from the official
rem MSFS SDK (SimConnect SDK\lib\static\SimConnect.lib). The library uses the dynamic C runtime, so
rem the DLL is built with /MD and needs the VC++ 2015-2022 redistributable, which MSFS and the
rem .NET runtime need as well. Needs Visual Studio Build Tools 2022 with the C++ x64 tools.
rem   build.cmd "<MSFS SDK root>" "<output folder>"
setlocal
set "SDK=%~1"
set "OUT=%~2"
if "%SDK%"=="" goto usage
if "%OUT%"=="" goto usage
set "INC=%SDK%\SimConnect SDK\include"
set "LIBDIR=%SDK%\SimConnect SDK\lib\static"
if not exist "%INC%\SimConnect.h" (echo SimConnect.h not found in "%INC%" & exit /b 1)
if not exist "%LIBDIR%\SimConnect.lib" (echo SimConnect.lib not found in "%LIBDIR%" & exit /b 1)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo vswhere.exe not found: install Visual Studio Build Tools 2022 with the C++ tools & exit /b 1)
set "VSDIR="
set "VSTXT=%TEMP%\acars-vswhere-%RANDOM%.txt"
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%VSTXT%"
if exist "%VSTXT%" set /p VSDIR=<"%VSTXT%"
del "%VSTXT%" 2>nul
if "%VSDIR%"=="" (echo Visual Studio C++ x64 tools not found & exit /b 1)
rem vcvars64 prints a harmless "'vswhere.exe' is not recognized" on some installs; a real failure stops here.
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1

if not exist "%OUT%" mkdir "%OUT%"
set "OBJ=%OUT%\obj-acars-simconnect"
if not exist "%OBJ%" mkdir "%OBJ%"
cl /nologo /LD /MD /O2 /W4 /WX /EHsc /std:c++17 /DACARS_SC_BUILD /DNDEBUG /DWIN32_LEAN_AND_MEAN ^
  /I"%INC%" /I"%~dp0." "%~dp0acars_simconnect.cpp" ^
  /Fo"%OBJ%\\" /Fe"%OUT%\acars_simconnect.dll" /Fd"%OBJ%\acars_simconnect.pdb" ^
  /link /nologo /LIBPATH:"%LIBDIR%" SimConnect.lib shlwapi.lib user32.lib Ws2_32.lib advapi32.lib shell32.lib /MACHINE:X64 || exit /b 1
rd /s /q "%OBJ%" 2>nul
del "%OUT%\acars_simconnect.exp" "%OUT%\acars_simconnect.lib" 2>nul
exit /b 0

:usage
echo usage: build.cmd "<MSFS SDK root>" "<output folder>"
exit /b 2
