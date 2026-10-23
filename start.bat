@echo off
setlocal
rem ------------------------------------------------------------
rem  Heart Wall - launcher (Windows)
rem  Double-click this file to start. Keep the window open
rem  while the show is running.
rem ------------------------------------------------------------

rem UTF-8 code page so Chinese text printed by Node displays correctly.
rem This file itself is pure ASCII, so it is safe on any code page.
chcp 65001 >nul 2>nul

rem pushd (not cd /d) so this also works from a UNC path like \NAS\share
pushd "%~dp0"

title Heart Wall

echo.
echo   Heart Wall  (Nian Hui Ai Xin Qiang)
echo   ------------------------------------
echo.

rem ---------- Check Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
    echo   [x] Node.js not found.
    echo.
    echo   Please install Node.js first ^(free, one time^):
    echo.
    echo     1. Open https://nodejs.org
    echo     2. Click the green LTS button
    echo     3. Run the installer, keep clicking Next
    echo     4. Close this window and double-click start.bat again
    echo.
    echo   If Node.js is already installed, close and reopen this
    echo   window ^(or restart the computer^), then try again.
    echo.
    popd
    pause
    exit /b 1
)

rem ---------- Everything else is handled by start.js ----------
node start.js
if errorlevel 1 (
    echo.
    echo   [x] Something went wrong. See the messages above.
    echo.
    popd
    pause
    exit /b 1
)

popd
endlocal
