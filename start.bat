@echo off
title WhatsApp Business Bot
color 0A

echo.
echo ========================================
echo    WhatsApp Business Bot Starting...
echo ========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org
    echo Then run this script again.
    echo.
    pause
    exit /b 1
)

echo Node.js detected
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    echo This may take a few minutes...
    echo.
    npm install
    if errorlevel 1 (
        echo.
        echo Failed to install dependencies!
        echo Please check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Dependencies installed successfully!
    echo.
)

REM Check if config.json exists
if not exist "config.json" (
    echo Configuration not found!
    echo Running business setup wizard...
    echo.
    node setup-business.js
    if errorlevel 1 (
        echo.
        echo Setup failed!
        echo Please run setup-business.js manually.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo Setup completed!
    echo.
)

echo Starting WhatsApp Business Bot...
echo.

REM Start Node.js in background
echo Starting bot server...
start /min "WhatsApp Bot Server" cmd /c "node app.js"

REM Wait for server to start
echo Waiting for server to start...
timeout /t 6 /nobreak >nul

REM Try to open Chrome with different methods
echo Opening dashboard in Chrome...

REM Method 1: Try direct chrome command
start "" chrome "http://localhost:3000" >nul 2>&1

REM Method 2: Try with full path if Method 1 fails
timeout /t 2 /nobreak >nul
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "http://localhost:3000"
) else (
    REM Method 3: Fallback to default browser
    start "" "http://localhost:3000"
)

echo.
echo ========================================
echo   Bot is running successfully!
echo ========================================
echo.
echo Dashboard URL: http://localhost:3000
echo.
echo The dashboard should now be open in Chrome.
echo If not, manually open Chrome and go to: http://localhost:3000
echo.
echo Keep this window open to keep the bot running.
echo Press any key to stop the bot...
echo.

pause >nul

REM Stop the bot when user presses a key
echo Stopping bot...
taskkill /f /im node.exe >nul 2>&1
echo Bot stopped.
echo.
pause