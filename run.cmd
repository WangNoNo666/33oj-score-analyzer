@echo off
chcp 65001 >nul
REM  run.cmd <uid> [options]   -- see README.md
node "%~dp0oj-user.mjs" %*
