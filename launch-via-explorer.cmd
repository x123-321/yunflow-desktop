@echo off
cd /d "D:/ds/yunflow-desktop/release/YunFlow-win32-x64"
start "" "YunFlow.exe" --no-sandbox --remote-debugging-port=9603
echo launched > D:/ds/yunflow-desktop/explorer-launch.txt
