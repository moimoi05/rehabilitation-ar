@echo off
title Rehabilitation AR - Frontend
cd /d "%~dp0frontend"
echo ==========================================
echo   Starting Frontend: http://127.0.0.1:5173
echo ==========================================
npm run dev
pause
