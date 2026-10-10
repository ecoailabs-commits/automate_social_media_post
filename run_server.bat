@echo off
rem Watchdog: keeps the AI Automated Ads server alive. Logs to data\server.log
cd /d C:\Users\Galaxy\Desktop\ai_automate\automate_social_media_post
:loop
node src/server.js >> data\server.log 2>&1
timeout /t 5 /nobreak >nul
goto loop