@echo off
title Rehabilitation AR - Launcher
cd /d "%~dp0"

echo [1/3] Starting PostgreSQL...
docker compose -p rehabilitation-ar up -d postgres

echo.
echo [2/3] Launching Backend window...
start "Rehabilitation AR - Backend" cmd /k "cd /d ""%~dp0backend"" && .\.venv\Scripts\uvicorn app.main:app --port 8001"

echo [3/3] Launching Frontend window...
start "Rehabilitation AR - Frontend" cmd /k "cd /d ""%~dp0frontend"" && npm run dev"

echo.
echo ======================================================
echo   Rehabilitation AR is running!
echo   - Frontend: http://127.0.0.1:5173
echo   - Backend:  http://127.0.0.1:8001/docs
echo   - Database: 127.0.0.1:5433
echo ======================================================
echo.
pause
