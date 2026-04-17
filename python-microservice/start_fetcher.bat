@echo off
REM Start the ACE Biometric Fetcher Python Service
REM This script runs the fetcher.py using the virtual environment

title ACE Biometric Fetcher
cd /d "d:\aceHrModule-main\python-microservice"
"d:\aceHrModule-main\python-microservice\venv\Scripts\python.exe" fetcher.py
pause
