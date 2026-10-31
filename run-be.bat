@echo off
title Rehabilitation AR - Backend
cd /d "%~dp0backend"
echo ==========================================
echo   Starting Backend: http://127.0.0.1:8001
echo   API Docs: http://127.0.0.1:8001/docs
echo ==========================================
.\.venv\Scripts\uvicorn app.main:app --port 8001
pause
