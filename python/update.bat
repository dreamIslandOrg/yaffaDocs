@echo off
REM מעדכן את המערכת לגרסה האחרונה מ-GitHub
cd /d "%~dp0"
git pull
echo.
echo Updated. You can now run run.bat
pause
