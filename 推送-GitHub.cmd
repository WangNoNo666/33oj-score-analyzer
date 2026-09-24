@echo off
chcp 65001 >nul
title Push to GitHub
cd /d "%~dp0"

echo.
echo   ============================================
echo      Push 33OJ Score Analyzer to GitHub
echo   ============================================
echo.
echo   Need a GitHub token first:
echo     https://github.com/settings/tokens
echo   Classic token with "repo" scope is enough.
echo.
echo   Paste it below (the input is hidden, it is NOT saved anywhere).
echo.

set /p "GITHUB_TOKEN=Token: "
if "%GITHUB_TOKEN%"=="" (
  echo.
  echo   No token given, aborting.
  pause
  exit /b 1
)

node "%~dp0push-github.mjs"
set EXITCODE=%ERRORLEVEL%
set GITHUB_TOKEN=

echo.
echo   Done. Press any key to close.
pause >nul
exit /b %EXITCODE%
