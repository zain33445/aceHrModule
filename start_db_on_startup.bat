@echo off
set "BASE_DIR=d:\aceHrModule-main\nodejs-backend"

echo Checking for Docker...
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Docker is not installed or not running.
    pause
    exit /b 1
)

cd /d "%BASE_DIR%"
echo Starting only the Database (db) in Docker...
docker-compose up -d db

echo Database started successfully.
timeout /t 5
