@echo off
cd %~dp0
echo ============================
echo Iniciando ClockIn DinEX...
echo ============================

IF NOT EXIST "node_modules" (
    echo Instalando dependencias...
    npm install
)

echo.
echo Abriendo navegador...
start http://localhost:3000

echo.
echo Iniciando servidor...
npm start

echo.
echo ============================
echo Presiona cualquier tecla para cerrar...
pause >nul
