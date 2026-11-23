@echo off
chcp 65001 >nul
echo ========================================================
echo   DIPchonanh - KHOI DONG TRANG CHON ANH TRUC TUYEN
echo ========================================================
echo.
echo Dang mo trang web tai: http://localhost:8088/
echo.
start "" "http://localhost:8088/"
python -m http.server 8088
pause
