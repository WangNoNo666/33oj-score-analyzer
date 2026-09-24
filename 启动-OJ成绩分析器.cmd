@echo off
chcp 65001 >nul
title 33OJ Score Analyzer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Node.js not found.
  echo   This app requires Node.js 22 or newer.
  echo   Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "app\server.mjs"
if errorlevel 1 (
  echo.
  echo   Server exited. Press any key to close.
  pause >nul
)
