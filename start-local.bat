@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  попутка. — локальный сервер для расширения (демо-панель + API + зеркало t.me/s)
echo  ===========================================================================

where node >nul 2>nul
if errorlevel 1 (
  echo  [!] Node.js не найден. Поставьте Node.js 22.18 или новее: https://nodejs.org/
  echo      После установки перезапустите этот файл.
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo  [!] Node.js слишком старый: найден %NODE_MAJOR%.x, нужен 22.18 или новее.
  echo      Скачайте свежую версию: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Устанавливаю зависимости (это один раз, займёт минуту)...
  call npm install
  if errorlevel 1 (
    echo  [!] npm install не удался — посмотрите вывод выше.
    pause
    exit /b 1
  )
)

echo.
echo  Что вставить в попап расширения (иконка «попутка. — сбор объявлений»):
echo.
echo      serverUrl :  http://127.0.0.1:8790
echo      token     :  demo-ingest-token
echo.
echo  Админ-панель, куда попадают собранные заявки:   http://localhost:8790
echo  Ключ админа панель подставит сама:              demo-admin-token
echo.
echo  Порядок проверки:
echo    1. chrome://extensions - Режим разработчика - Загрузить распакованное - папка extension
echo    2. открыть https://web.telegram.org и войти
echo    3. в попапе заполнить serverUrl и token, в белый список вписать 1-2 чата
echo    4. «Проверить сервер», затем «Диагностика вкладки» (ничего не отправляет)
echo    5. «Отправить найденные» - и смотреть заявки в панели на http://localhost:8790
echo.
echo  Остановить сервер: Ctrl+C (или закрыть это окно)
echo  ---------------------------------------------------------------------------
echo.

node parcel\demo\server.mjs

echo.
echo  Сервер остановлен.
pause
