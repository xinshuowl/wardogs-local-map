@echo off
cd /d "%~dp0"
echo Close the local server before updating. Previous resources are kept as a backup.
choice /C YN /M "Download and apply verified model, terrain and point updates"
if errorlevel 2 exit /b
python scripts\update_assets.py --apply
pause

