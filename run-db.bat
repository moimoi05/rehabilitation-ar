@echo off
title Rehabilitation AR - PostgreSQL
cd /d "%~dp0"
echo ==========================================
echo   Starting PostgreSQL container...
echo ==========================================
docker compose -p rehabilitation-ar up -d postgres
echo.
echo Database is ready on port 5433!
pause
