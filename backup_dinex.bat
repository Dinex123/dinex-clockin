@echo off
setlocal enabledelayedexpansion

REM === Carpeta del proyecto = donde está este .BAT ===
set "PROJECT_DIR=%~dp0"
set "DIR_NOSLASH=%PROJECT_DIR:~0,-1%"
for %%I in ("%DIR_NOSLASH%") do set "PROJECT_NAME=%%~nxI"

REM === Timestamp seguro vía PowerShell (requiere Win10/11) ===
for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set "STAMP=%%I"

set "ZIP_NAME=%PROJECT_NAME%_Backup_%STAMP%.zip"
set "ZIP_PATH=%PROJECT_DIR%%ZIP_NAME%"

echo.
echo Creando backup: %ZIP_NAME%
echo Carpeta origen: %PROJECT_DIR%
echo.

REM === Comprimir excluyendo carpetas pesadas/datos locales ===
REM     Puedes agregar/quitar nombres en $exclude
powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$src = '%PROJECT_DIR%';" ^
  "$out = '%ZIP_PATH%';" ^
  "$exclude = @('.git','node_modules','dist','build','.cache','db','backups');" ^
  "Get-ChildItem -LiteralPath $src -Force | Where-Object { $exclude -notcontains $_.Name } | Compress-Archive -DestinationPath $out -Force;"

if errorlevel 1 (
  echo.
  echo [ERROR] No se pudo crear el ZIP. Revisa que tengas espacio y permisos.
  pause
  exit /b 1
)

echo.
echo ✔ Backup creado: %ZIP_PATH%
echo.
echo (Opcional) Escribe la letra de tu USB/Disco para copiar el ZIP
set /p TARGET="Ejemplos: E  o  F  (Enter para saltar): "

if not "%TARGET%"=="" (
  set "DEST=%TARGET%:\Backups\%PROJECT_NAME%"
  echo Copiando a %DEST% ...
  powershell -NoProfile -Command "New-Item -Path '%DEST%' -ItemType Directory -Force > $null"
  copy /Y "%ZIP_PATH%" "%DEST%\"
  if errorlevel 1 (
    echo [ADVERTENCIA] No se pudo copiar al destino. Verifica la letra de unidad.
  ) else (
    echo ✔ Copia lista en: %DEST%
    explorer "%DEST%"
  )
) else (
  echo Saltando copia a USB.
)

echo.
echo Listo. Abriendo carpeta para que veas el archivo...
explorer /select,"%ZIP_PATH%"
echo.
pause
