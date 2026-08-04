@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-application-desk.ps1" -ProjectRoot "%~dp0"
set "APPLICATION_DESK_EXIT_CODE=%ERRORLEVEL%"
if not "%APPLICATION_DESK_EXIT_CODE%"=="0" pause
exit /b %APPLICATION_DESK_EXIT_CODE%
