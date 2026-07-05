@echo off
cd /d "C:\Users\Unknown\Documents\Projects\Marketing agency Project\Intelligence agent\Code"
pm2 resurrect
timeout /t 3
pm2 start ecosystem.config.cjs --no-daemon-kill-timeout
pm2 save
