@echo off
title Titen
cd /d "%~dp0"
echo Starting Titen... (close this window to stop it)
node web/server.js --open
pause
