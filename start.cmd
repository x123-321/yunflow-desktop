@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/3] Installing dependencies. This may take a few minutes...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [1/3] Dependencies already installed.
)

echo [2/3] Building main process and renderer...
call npm run build
if errorlevel 1 goto :fail

echo [3/3] Starting YunFlow...
call npm start
set CODE=%errorlevel%

echo.
if not "%CODE%"=="0" (
  echo YunFlow exited with code %CODE%.
  echo A full log was written to: %~dp0run.log
) else (
  echo YunFlow closed.
)
echo.
pause
goto :eof

:fail
echo.
echo Build or install failed. Please check the messages above.
echo.
pause
