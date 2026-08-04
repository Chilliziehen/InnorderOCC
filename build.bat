@echo off
rem ===========================================================================
rem  Innorder OCC build launcher.
rem
rem    build.bat            open the interactive menu
rem    build.bat <target>   build one target directly
rem    build.bat help       list every target
rem
rem  This file stays pure ASCII on purpose. cmd.exe tracks byte offsets while
rem  it parses a batch file, so multi-byte characters in the script itself
rem  desynchronise the parser. All localized output comes from the Node menu.
rem ===========================================================================
setlocal
cd /d "%~dp0" || exit /b 1

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required but "node" was not found on PATH.
  exit /b 1
)

rem Show UTF-8 output correctly; restore the previous code page on exit.
for /f "tokens=2 delims=:" %%C in ('chcp') do set "OCC_OLDCP=%%C"
set "OCC_OLDCP=%OCC_OLDCP: =%"
chcp 65001 >nul

rem The machine-wide npm cache may not be writable; keep one inside the repo.
if not defined npm_config_cache set "npm_config_cache=%CD%\.cache\npm"
if not exist "%npm_config_cache%" mkdir "%npm_config_cache%" >nul 2>&1

node "scripts\build-menu.mjs" %*
set "OCC_EXIT=%ERRORLEVEL%"

chcp %OCC_OLDCP% >nul 2>&1
endlocal & exit /b %OCC_EXIT%
