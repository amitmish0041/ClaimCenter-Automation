@echo off
cd /d "%~dp0.."
if not exist results\oneInc mkdir results\oneInc
node scripts\rerunOnClosedBugs.js >> results\oneInc\closed-bug-watch.log 2>&1
