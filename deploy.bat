@echo off
echo =======================================
echo Deploying Passport Scanner to GitHub...
echo =======================================
echo.
git add .
set /p msg="Enter commit message (default: 'Update code'): "
if "%msg%"=="" set msg=Update code
git commit -m "%msg%"
git push origin main
echo.
echo =======================================
echo 🎉 Deployment successful!
echo 🔗 Live link: https://yunis-560560.github.io/Scanner/
echo =======================================
pause
