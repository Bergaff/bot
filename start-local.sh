#!/usr/bin/env bash
# Локальный сервер для расширения: демо-панель + API + зеркало t.me/s одним процессом.
# Windows-версия — start-local.bat. Подробности: docs/try-it.md
set -euo pipefail
cd "$(dirname "$0")"

echo
echo " попутка. — локальный сервер для расширения (демо-панель + API + зеркало t.me/s)"
echo " ==========================================================================="

if ! command -v node >/dev/null 2>&1; then
  echo " [!] Node.js не найден. Поставьте Node.js 22.18 или новее: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo " [!] Node.js слишком старый: найден ${NODE_MAJOR}.x, нужен 22.18 или новее."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo " Устанавливаю зависимости (это один раз)..."
  npm install
fi

cat <<'EOF'

 Что вставить в попап расширения (иконка «попутка. — сбор объявлений»):

     serverUrl :  http://127.0.0.1:8790
     token     :  demo-ingest-token

 Админ-панель, куда попадают собранные заявки:   http://localhost:8790
 Ключ админа панель подставит сама:              demo-admin-token

 Порядок проверки:
   1. chrome://extensions → Режим разработчика → «Загрузить распакованное расширение» → папка extension/
   2. открыть https://web.telegram.org и войти
   3. в попапе заполнить serverUrl и token, в белый список вписать 1–2 чата
   4. «Проверить сервер», затем «Диагностика вкладки» (ничего не отправляет)
   5. «Отправить найденные» — и смотреть заявки в панели на http://localhost:8790

 Остановить сервер: Ctrl+C
 ---------------------------------------------------------------------------

EOF

exec node parcel/demo/server.mjs
