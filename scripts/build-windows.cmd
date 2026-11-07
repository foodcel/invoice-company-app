@echo off
setlocal

set "VSROOT="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%I"
)
if not defined VSROOT set "VSROOT=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
if not exist "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" (
  echo Microsoft C++ Build Tools with Desktop development with C++ are required.
  exit /b 1
)
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
if exist "%USERPROFILE%\.tauri\invoice-company-app.key" set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\invoice-company-app.key"
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare-nemotron.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%
call npm run tauri build
exit /b %ERRORLEVEL%
