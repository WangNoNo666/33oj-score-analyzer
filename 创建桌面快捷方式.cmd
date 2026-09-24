@echo off
chcp 65001 >nul
REM  Create a desktop shortcut to the GUI launcher.
node "%~dp0make-shortcut.mjs" %*
