@echo off
setlocal

cd /d "%~dp0"
if errorlevel 1 (
    echo ERROR: Could not open the Jarvis repository directory.
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo ERROR: Jarvis virtual environment was not found at .venv\Scripts\python.exe
    echo Create the project-local virtual environment before starting Jarvis.
    exit /b 1
)

if not exist "jarvis.py" (
    echo ERROR: jarvis.py was not found in %CD%
    exit /b 1
)

".venv\Scripts\python.exe" jarvis.py
set "JARVIS_EXIT_CODE=%ERRORLEVEL%"
if not "%JARVIS_EXIT_CODE%"=="0" (
    echo Jarvis exited with code %JARVIS_EXIT_CODE%.
)
exit /b %JARVIS_EXIT_CODE%
