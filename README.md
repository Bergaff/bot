# Сборщик объявлений из чатов Telegram — без добавления бота

Серверная часть ТЗ [`docs/tz-auto-collection.md`](https://github.com/Bergaff/parcel/blob/arena/01a0a5c0-parcel/docs/tz-auto-collection.md) проекта [`Bergaff/parcel`](https://github.com/Bergaff/parcel) (доска попутных передач «попутка.»).

Два новых источника объявлений, которым **не нужно добавлять бота в чаты**:

- **Вариант A — серверный сборщик.** Раз в 1–2 часа читает веб-превью публичных каналов и супергрупп `https://t.me/s/<username>` (открывается без логина), берёт сообщения новее курсора и прогоняет через общий конвейер разбора.
- **Вариант B — `POST /api/ingest`.** Принимает текст сообщений от браузерного расширения, которое работает в открытой вкладке Telegram Web на аккаунте заказчика (только чтение DOM). Приватные чаты — только так.

Оба источника выходят в **существующую очередь модерации** (`status = 'pending'`, уведомление админам) и **не дублируют** обработанное: единственный источник истины — строка `(chat_id, message_id)` в `tg_seen`.

Репозиторий самодостаточен: скраппер можно гонять локально как CLI (без Cloudflare), а файлы из `src/` переносятся в `parcel/src/` почти без правок — см. [INTEGRATION.md](INTEGRATION.md).

---

## Быстрый старт (5 минут, локально)

```bash
npm install
npm run db:local                                  # применить миграции → .data/collector.db

npm run scan -- durov                             # что парсер видит на t.me/s/durov
npm run scan -- durov --before 528 --html p.html  # пагинация вглубь + сохранить HTML

npm run watch -- watch-chats add drivers_pl_by --kind supergroup
npm run watch -- collect --dry                    # предпросмотр: ничего не пишем
npm run watch -- collect                          # боевой прогон → заявки в pending
npm run watch -- watch-chats list                 # курсоры, счётчики, ошибки
npm run watch -- report                           # отчёт последнего прогона

npm run server                                    # HTTP API: /api/ingest + админка
npm run daemon -- --every 900                     # обход каждые 15 мин (замена cron)
```

`npm test` — 133 теста, `npm run typecheck` — `tsc --noEmit`.

Локально D1 и KV заменяет встроенный `node:sqlite` (`local/sqlite-env.ts`), поэтому код из `src/` не знает, где он запущен: в воркере — настоящие биндинги, на вашей машине — sqlite-файл.

### Проверить без интернета

`t.me` из песочницы/CI может быть недоступен. Для сквозных прогонов есть локальное зеркало на фикстурах:

```bash
node local/mock-tme.mjs 8899                                   # «t.me/s/» на 127.0.0.1:8899
npm run scan -- drivers_pl_by --base-url http://127.0.0.1:8899/s
npm run collect -- --base-url http://127.0.0.1:8899/s --dry
```

---

## Как это работает

### Конвейер один на всех источников

```
                      ┌── бот в чате / пересылка боту        (origin = bot)
сообщение ────────────┼── cron-обход t.me/s/<username>       (origin = collector)
                      └── POST /api/ingest от расширения     (origin = extension)
                                        │
                                        ▼
                       src/ingest.ts :: ingestMessage()
   1 длина текста → 2 возраст → 3 пассажирское? → 4 markSeen (tg_seen)
   → 5 cascade(): правила (confidence ≥ 0.7) → иначе ИИ → 6 createListing(pending)
   → 7 notifyAdmins → 8 откат tg_seen, если создать не удалось
```

Порядок шагов фиксирован ТЗ. Ключевое: **`markSeen()` вызывается до любых обращений к ИИ** — дубли не тратят ни квоту, ни деньги. Если каскад вернул пустой список (болтовня), запись в `tg_seen` остаётся: повторно это сообщение не обрабатывается.

Курсор `watch_chats.last_message_id` — **оптимизация, а не защита от дублей**. Если он сбросится илиextension пришлёт перекрывающееся окно, сообщения упрутся в `tg_seen` и вернутся как `duplicate` — это штатный режим.

### Вариант A: обход публичных чатов

```
src/preview.ts       fetch + диагностика страницы (200/404/капча/смена разметки)
src/preview-html.ts  чистый парсер HTML → PreviewMessage[]   (тестируется на фикстурах)
src/collect.ts       курсор, ротация, лимит запросов, ошибки, отчёт
```

Что извлекаем из каждого сообщения: `messageId` (сначала `data-post="<username>/<id>"`, затем permalink `https://t.me/<username>/<id>`), `text` (`<br>` → `\n`, теги и обвязка «VIEW IN TELEGRAM» выбрасываются, сущности и emoji раскрываются, обрезка до 4000), `date` (`<time datetime>`, запасной вариант — видимая подпись «June 15» + «14:58»), `author`, `hasMedia`, `url`.

Алгоритм одного прогона:

1. `COLLECT_ENABLED != 1` → выходим (ручной запуск из админки идёт с `force`).
2. Проверяем **свой** дневной счётчик ИИ `ai:collect:day:<дата>`; исчерпан → собираем только правилами (`useAi: false`). Бюджет бота `ai:day:*` (300/день) не трогаем.
3. Берём включённые чаты из `watch_chats`, упорядочиваем по `last_checked_at ASC NULLS FIRST`, не больше `COLLECT_MAX_CHATS` — ротация обязательна (лимит подзапросов воркера).
4. На чат: `fetchPreview()` → отсев `messageId <= курсор` и старше `COLLECT_MAX_AGE_DAYS` → обработка **по возрастанию id** через `ingestMessage()` → курсор на максимум, `stats_*`, сброс `error_count`.
5. **Первый прогон по чату вглубь не листает**: берём только первую страницу и ставим курсор на максимум. Иначе при включении чата в очередь модерации выльется год истории.
6. Вторая страница `?before=` — только если на первой всё оказалось новым и страница полная, и не больше `COLLECT_MAX_PAGES`.
7. Между чатами пауза 300 мс; жёсткий потолок запросов на прогон — `COLLECT_MAX_FETCHES` (24). Никаких `Promise.all` на десятки чатов.

Деградация (ТЗ п. 3.7): не-200 / таймаут / пустой ответ → курсор не двигаем, `last_error`, `error_count++`. Страница 200, но контейнеров сообщений нет → `markup_changed?`. `error_count >= 3` → `enabled = 0` и сообщение админам в Telegram: «Сборщик остановлен по чату \<username\>: \<error\>. Проверьте разметку t.me/s/». 404 (чат удалён/переименован) → выключаем сразу. Ошибка одного чата не роняет прогон остальных.

### Вариант B: приём от расширения

```
src/routes.ts   POST /api/ingest (Bearer INGEST_TOKEN) + админ-API авто-сбора
src/server.ts   Hono-приложение, CORS, админ-middleware, scheduled() с switch (event.cron)
```

Сервер ничего не знает о браузере: принимает текст и метаданные, дальше работает тот же `ingestMessage()` с `origin: 'extension'`. Заявки **всегда** `pending` — `AUTO_APPROVE` на них не влияет.

Защита от мусора: `INGEST_TOKEN` — отдельный секрет (отзывается без потери админ-доступа), нет секрета → 503; rate limit 60 запросов/час на токен → 429 с `Retry-After`; максимум 100 сообщений в батче → 413; невалидные элементы идут в `results` со `status: 'invalid'` и не роняют батч; свой счётчик ИИ `ai:ingest:day:*`.

---

## Контракт `POST /api/ingest`

```http
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
Origin: https://web.telegram.org
```

```json
{
  "collector": "tg-web-ext/1.0.0",
  "dryRun": false,
  "messages": [
    {
      "chatId": "web:drivers_pl_by",
      "chatTitle": "Водители Польша–Беларусь",
      "chatUrl": "https://t.me/drivers_pl_by",
      "messageId": 12345,
      "date": 1789000000,
      "text": "Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254",
      "authorName": "Adelina Yasiuchenia",
      "authorUsername": "@adelina_y"
    }
  ]
}
```

| Поле | Тип | Обяз. | Правило |
|---|---|---|---|
| `messages` | array 1..100 | да | больше 100 → `413` |
| `messages[].chatId` | string 1..64 | да | публичный чат: `web:<username>`; приватный: `ext:<внутренний id>` |
| `messages[].messageId` | integer > 0 | да | id сообщения в этом чате |
| `messages[].text` | string | да | как есть, с переносами; > 4000 → `skipped:too_long` |
| `messages[].chatTitle` | string ≤ 120 | нет | попадёт в `source_chat` |
| `messages[].chatUrl` | string ≤ 200 | нет | только `https://t.me/…`, сохраняется в `chat_links` |
| `messages[].date` | unix-секунды или ISO | нет | отсев старых (`INGEST_MAX_AGE_DAYS`, по умолчанию 3) |
| `messages[].authorName` | string ≤ 120 | нет | для подписи источника |
| `messages[].authorUsername` | string ≤ 64 | нет | станет `telegram` заявки, если в тексте нет контакта |
| `dryRun` | boolean | нет | разобрать и вернуть результат, **не** создавая заявок и **не** трогая `tg_seen` |
| `collector` | string ≤ 64 | нет | версия клиента, уходит в лог |

Ответ `200`:

```json
{
  "ok": true,
  "dryRun": false,
  "summary": { "received": 3, "created": 1, "duplicate": 1, "skipped": 1, "invalid": 0, "listings": 1 },
  "results": [
    { "chatId": "web:drivers_pl_by", "messageId": 12345, "status": "created",
      "listings": [{ "id": "6336…", "type": "offer", "fromCity": "Варшава", "toCity": "Брест",
                     "departureDate": null, "source": "telegram", "origin": "extension" }] },
    { "chatId": "web:drivers_pl_by", "messageId": 12340, "status": "duplicate", "listingId": "a1b2…" },
    { "chatId": "ext:-100777",       "messageId": 555,   "status": "skipped",   "reason": "passenger" }
  ],
  "cursors": { "web:drivers_pl_by": 12345, "ext:-100777": 556 }
}
```

`cursors` — максимальный принятый `messageId` по каждому `chatId`. Расширение **может** использовать его как локальный курсор, но обязано присылать с перекрытием: источник истины — сервер.

`status` / `reason`: `created`, `duplicate`, `skipped` (`passenger`, `no_intent`, `ai_empty`, `too_old`, `too_long`, `too_short`), `invalid` (`bad_payload` — битое поле).

Ошибки: `400` (битое тело/поля), `401` (нет или неверный токен), `413` (> 100 сообщений), `429` (лимит, есть `Retry-After`), `503` (`INGEST_TOKEN` не задан). Тело — `{ "error": "…" }`.

Проверить руками:

```bash
curl -X POST https://<worker>/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"collector":"curl/1.0","messages":[
        {"chatId":"web:drivers_pl_by","messageId":1,"text":"25.09 Варшава — Брест, возьму посылку до 20 кг, +48579264254"},
        {"chatId":"web:drivers_pl_by","messageId":1,"text":"25.09 Варшава — Брест, возьму посылку до 20 кг, +48579264254"},
        {"chatId":"ext:-100777","messageId":2,"text":"Кто подвезёт пассажира из Минска в Брест?"}]}'
# → received 3, created 1, duplicate 1, skipped 1 (passenger)
```

---

## Админ-API авто-сбора

Все роуты под `Authorization: Bearer <ADMIN_API_TOKEN>`.

| Метод и путь | Назначение |
|---|---|
| `GET /api/admin/watch-chats` | список чатов: курсоры, счётчики `stats_*`, ошибки, `enabled` |
| `POST /api/admin/watch-chats` | `{ username, kind?, title? }` → `id = 'web:'+username`; `409` если уже есть. Сразу пишет `chat_links` → источник кликабелен на сайте |
| `PUT /api/admin/watch-chats/:id` | `{ enabled?, kind?, title?, last_message_id? }`; `last_message_id: null` — сброс курсора |
| `DELETE /api/admin/watch-chats/:id` | убрать из обхода (заявки не трогаем) |
| `POST /api/admin/collect` | ручной прогон `{ chatId?, dryRun? }`; работает даже при `COLLECT_ENABLED=0` |
| `GET /api/admin/collect/status` | отчёт последнего прогона (KV `collect:last-report`, TTL 7 дней), счётчики по `origin`, квоты ИИ, статус расширения |
| `GET /api/ingest/status` | жив ли приём (без админ-токена): `{ enabled, today, aiQuotaLeft }` |

---

## Переменные окружения

Секреты — `wrangler secret put`, несекретные — `[vars]` в `wrangler.toml`. Полный список с комментариями: [.dev.vars.example](.dev.vars.example).

| Имя | Тип | По умолчанию | Назначение |
|---|---|---|---|
| `INGEST_TOKEN` | секрет | — | Bearer для `POST /api/ingest`; не задан → 503 |
| `COLLECT_ENABLED` | var | `"0"` | `"1"` — cron-сборщик включён |
| `COLLECT_CRON` | wrangler | `17 */2 * * *` | расписание обхода |
| `COLLECT_MAX_CHATS` | var | `10` | чатов за один запуск (ротация) |
| `COLLECT_MAX_PAGES` | var | `2` | страниц `?before=` на чат |
| `COLLECT_MAX_AGE_DAYS` | var | `7` | старше — не берём |
| `COLLECT_MAX_FETCHES` | var | `24` | потолок сетевых запросов на прогон |
| `COLLECT_AI_DAILY_LIMIT` | var | `100` | дневной лимит ИИ авто-сбора |
| `COLLECT_AUTO_APPROVE` | var | `"0"` | зарезервировано; сборка **всегда** `pending` |
| `INGEST_MAX_AGE_DAYS` | var | `3` | сколько дней хранения у сообщений расширения |

---

## Что где лежит

| Файл | Что | Этап ТЗ |
|---|---|---|
| `src/ingest.ts` | `ingestMessage()`, `cascade()`, `rulesFields()`, `parseMessageDate()`, источники | 1 |
| `src/links.ts` | `listingSourceLink()` для `-100…` / `web:*` / `ext:*`, метки `origin` | 1 |
| `src/store.ts` | `watch_chats`, `unmarkSeen()`, `countByOrigin()`, фикс `listSourceChats()` | 1 |
| `migrations/0004_ingest.sql` | `listings.origin` + таблица `watch_chats` с курсором | 1 |
| `src/routes.ts` | `POST /api/ingest`, валидация контракта, rate limit, админ-API | 2, 5 |
| `src/server.ts` | Hono-приложение, CORS, админ-middleware, `scheduled()` с `switch (event.cron)` | 2 |
| `src/preview-html.ts` | чистый парсер HTML-превью (без fetch и Worker API) | 4 |
| `src/preview.ts` | `fetchPreview()`, заголовки браузера, диагностика страницы | 4 |
| `src/collect.ts` | `collectPublicChats()`, курсор, ротация, ошибки, отчёт | 4 |
| `src/parser.ts`, `src/util.ts`, `src/ai.ts`, `src/types.ts` | копия из `parcel` + точечные правки (см. INTEGRATION.md) | — |
| `src/telegram.ts` | локальная замена `formatListing`/`notifyAdmins` — в `parcel` НЕ переносится | — |
| `local/`, `scripts/` | CLI, sqlite-замена D1/KV, mock-зеркало t.me, снятие фикстур — в `parcel` НЕ переносятся | — |
| `tests/` | 133 теста + фикстуры разметки | 1–5 |

Квоты ИИ разведены по каналам (ТЗ п. 2.4, 3.5, 4.4): `ai:day:*` — бот (300/день), `ai:collect:day:*` — сборщик, `ai:ingest:day:*` — расширение (по `COLLECT_AI_DAILY_LIMIT`, 100/день). При исчерпании своего счётчика канал продолжает разбирать правила — сбор не встаёт.

---

## Тесты

```bash
npm test              # 133 теста
npm run typecheck
```

| Файл | Что проверяет |
|---|---|
| `tests/collect-html.test.ts` | парсер на фикстурах: канал, супергруппа с авторами и форвардами, `?before=`, пустой ответ, обрезанный HTML, «чат не найден», капча, смена разметки, разметка без `data-post`, запасной разбор даты, переносы строк, сущности, обрезка 4000 |
| `tests/collect.test.ts` | логика курсора (первая установка — вглубь не листаем, отсечение `id <= cursor`, сортировка, отсев по возрасту), прогон: создание заявок, `origin`/`pending`, дубли при повторе и при сбросе курсора, `dryRun`, 404, `markup_changed` ×3 → авто-отключение и алерт, ротация, бюджет запросов, отчёт в KV, дефолты конфигурации |
| `tests/ingest.test.ts` | порядок шагов конвейера, `duplicate` (каскад не вызывается), `skipped:passenger`/`no_intent`/`too_old`/`too_long`/`too_short`, откат `tg_seen` при ошибке, несколько заявок из одного сообщения, `dryRun`, счетчики квот, порядок обработки |
| `tests/ingest-api.test.ts` | контракт `/api/ingest`: 200/400/401/413/429/503, `summary`/`results`/`cursors`, `invalid` не роняет батч, `dryRun`, CORS и preflight, админ-API `watch-chats`/`collect`/`collect/status` |
| `tests/sourcelink.test.ts` | `listingSourceLink()`: `web:durov`+528 → `t.me/durov/528`, `ext:-100123` → `null`, приоритет `chat_links`, карточка `formatListing` |

Фикстуры в `tests/fixtures/` повторяют реальную структуру `t.me/s/` (контейнеры `.tgme_widget_message[_wrap]`, `data-post`, `.tgme_widget_message_text`, `<time datetime>`, media-обвязка, сервисные сообщения). Обновить снимки с живого Telegram: `npm run fixture -- durov drivers_pl_by`.

---

## Чего здесь deliberately нет

- Юзерботы на MTProto (Telethon/Pyrogram/GramJS), покупные аккаунты, вход в аккаунт с сервера — non-goal ТЗ.
- Любые записывающие действия от имени аккаунта заказчика. Сервер только читает публичные превью и принимает текст.
- Публикация без модерации: `AUTO_APPROVE=1` на собранные заявки не влияет.
- Сбор приватных чатов на сервере — приватные чаты идут только через расширение из браузера заказчика.
- Браузерное расширение (этап 3 ТЗ) — на стороне исполнителя; контракт к нему описан выше и покрыт тестами `tests/ingest-api.test.ts`.

Автоматизация аккаунта Telegram — на ваш страх и риск: только чтение, отдельный номер, редкий опрос, никаких массовых действий.
