@echo off
cd /d "%~dp0"
python scripts\update_assets.py --check
pause

