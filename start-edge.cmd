@echo off
chcp 65001 >nul
REM  Start Edge with a remote-debugging port, using the dedicated profile.
node "%~dp0start-edge.mjs" %*
