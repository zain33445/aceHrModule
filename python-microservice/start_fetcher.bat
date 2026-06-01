@echo off
title ACE Biometric Fetcher
cd /d "%~dp0"
echo Starting ACE Biometric Fetcher using local virtual environment...
".\venv\Scripts\python.exe" fetcher.py
pause
