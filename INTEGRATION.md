# Перенос в `Bergaff/parcel`

Этот репозиторий — самостоятельный скраппер, но `src/*.ts` написан под воркер `parcel` и переносится почти дословно: те же типы `Env`/`Listing`, тот же SQL, те же соглашения (`rateLimit`, `normalizeContacts`, `dedupeDescription`, `markSeen`).

Ниже — порядок переноса по этапам ТЗ. Всё, что нужно сделать руками, помечено ✂️.

---

## 0. Что копировать, а что нет

| Отсюда | Куда в `parcel` | Комментарий |
|---|---|---|
| `src/ingest.ts` | `src/ingest.ts` | новый файл, без правок |
| `src/links.ts` | `src/links.ts` | новый файл; `listingSourceLink()` переезжает сюда из `telegram.ts` |
| `src/preview.ts`, `src/preview-html.ts` | как есть | чистый код, Worker API не использует |
| `src/collect.ts` | `src/collect.ts` | ✂️ заменить `sendTextToAdmins` на ваш `sendText`/`notifyAdmins` (шаг 3) |
| `src/routes.ts` | `src/routes.ts` | новый файл |
| `migrations/0004_ingest.sql` | `migrations/0004_ingest.sql` | как есть |
| `src/store.ts` | ✂️ только дописать | в вашем `store.ts` уже всё есть — добавьте блок «Авто-сбор» из нашего файла и 3 точечные правки (шаг 2) |
| `src/ai.ts` | ✂️ только дописать | добавить счётчики квот по каналам (шаг 2) |
| `src/types.ts` | ✂️ только дописать | новые переменные `Env`, `ListingOrigin`, `origin` в `ListingInput` |
| `src/server.ts` | ✂️ не копировать | в `parcel` уже есть `src/index.ts` — перенести из него 3 вещи (шаг 4) |
| `src/telegram.ts` | ✂️ не копировать | это локальная замена ваших `formatListing`/`notifyAdmins` |
| `src/parser.ts`, `src/util.ts` | ✂️ не копировать | у вас свои, идентичные |
| `local/`, `scripts/`, `tests/fixtures/` | не копировать | локальный CLI и sqlite-замена D1/KV |
| `tests/*.test.ts` | скопировать все | ✂️ в `tests/collect.test.ts` и `tests/ingest*.test.ts` заменить `createLocalEnv()` из `local/sqlite-env.ts` на вашу mock-`env` (или оставить sqlite — в воркер он не попадёт) |

Проверить, что ваши `parser.ts`/`util.ts` не разъехались с нашими копиями:

```bash
git clone --depth 1 -b arena/01a0a5c0-parcel https://github.com/Bergaff/parcel /tmp/parcel
diff /tmp/parcel/src/parser.ts src/parser.ts   # ожидаемо: только .ts в импортах
diff /tmp/parcel/src/util.ts   src/util.ts
```

---

## 1. Этап 1 — общий конвейер

### 1.1 `migrations/0004_ingest.sql`

Скопировать как есть: `ALTER TABLE listings ADD COLUMN origin TEXT NOT NULL DEFAULT 'bot'` (без `CHECK` — значения контролирует код) + `CREATE TABLE IF NOT EXISTS watch_chats (…)`. Применяется штатно: `npm run deploy`.

### 1.2 `src/types.ts`

```ts
export type ListingOrigin = 'bot' | 'collector' | 'extension';
```

- в `ListingInput` добавить `origin?: ListingOrigin;`
- в `Listing` — `origin: ListingOrigin;`
- в `Env` — переменные из `.dev.vars.example` этого репозитория (`INGEST_TOKEN`, `COLLECT_*`, `INGEST_MAX_AGE_DAYS`, `COLLECT_CRON`, `ARCHIVE_CRON`).

### 1.3 `src/store.ts`

- `mapRow()`: `origin: (row.origin as ListingOrigin | undefined) ?? 'bot',`
- `createListing()`: добавить колонку `origin` в `INSERT` и `input.origin ?? 'bot'` в `bind()`.
- ✂️ **`listSourceChats()`** — ваше условие `source_chat_id LIKE '-%'` не пустит новые ключи на вкладку «чаты»:

```sql
WHERE l.source_chat_id IS NOT NULL
  AND (l.source_chat_id LIKE '-%' OR l.source_chat_id LIKE 'web:%' OR l.source_chat_id LIKE 'ext:%')
```

- дописать из нашего `store.ts`: `unmarkSeen()`, `countByOrigin()`, `getIngestDailyStats()`, `bumpIngestDailyStats()` и весь блок `watch_chats` (`WatchChat`, `addWatchChat`, `patchWatchChat`, `deleteWatchChat`, `dueWatchChats`, `markWatchChecked`, `markWatchError`, `WATCH_MAX_ERRORS`).

> Курсор в `markWatchChecked()` двигается через `CASE`, а не `MAX(?, last_message_id)`: скалярный `MAX` в SQLite возвращает `NULL`, если любой аргумент `NULL`, — на первом прогоне курсор остался бы не установленным.

### 1.4 `src/telegram.ts`

- ✂️ `cascade()` и `rulesFields()` — **удалить**, вместо них `import { cascade, ingestMessage } from './ingest'`.
- ✂️ `listingSourceLink()` — удалить локальную версию, сделать re-export:

```ts
import { listingSourceLink } from './links';
export { listingSourceLink };   // ваши тесты tests/sourcelink.test.ts останутся зелёными
```

- `handleGroupText()` и обработку пересылок перевести на `ingestMessage()`:

```ts
const res = await ingestMessage(env, text, {
  chatId: String(msg.chat.id),
  chatTitle: msg.chat.title ?? null,
  messageId: msg.message_id,
  origin: 'bot',
}, { aiScope: 'bot' });
if (res.status === 'created' && env.REPLY_IN_GROUPS === '1') { /* ваш ответ в группу */ }
```

Поведение бота не меняется: те же правила → ИИ → модерация, те же карточки, тот же откат `tg_seen` при ошибке создания (он теперь внутри `ingestMessage`).

> ✂️ Единственное отличие, которое надо решить осознанно: у бота `status` зависит от `AUTO_APPROVE`, а `ingestMessage()` всегда пишет `pending` (ТЗ п. 0: собранные объявления — только через модерацию). Чтобы бот сохранил старое поведение, передавайте статус через хук создания или оставьте ветку бота на `createListing()` напрямую — но для `origin: 'collector' | 'extension'` статус обязан быть `pending`.

### 1.5 `src/index.ts` — ✂️ `scheduled()` с ветвлением

Сейчас хендлер игнорирует `event.cron`, и с появлением второго триггера архивация запускалась бы вместе со сборщиком:

```ts
import { ARCHIVE_CRON, COLLECT_CRON, runScheduled } from './server';   // или скопировать runScheduled к себе

const worker = {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    await runScheduled(event, env, { archive: archiveExpired });
  },
};
```

Либо буквально:

```ts
scheduled: async (event, env) => {
  switch (event.cron) {
    case '0 21 * * *': {                                    // ARCHIVE_CRON
      const res = await archiveExpired(env);
      console.log('archiveExpired:', JSON.stringify(res));
      return;
    }
    case '17 */2 * * *': {                                  // COLLECT_CRON
      const report = await collectPublicChats(env);
      console.log('collect:', JSON.stringify(report.totals));
      return;
    }
    default:
      console.log('scheduled: неизвестный cron', event.cron);
  }
},
```

---

## 2. Этапы 2 и 5 — роуты

В `src/index.ts`:

```ts
import { registerIngestRoutes, registerAdminCollectRoutes } from './routes';

registerIngestRoutes(app);          // ✂️ ДО app.use('/api/admin/*') — своя авторизация (INGEST_TOKEN)

app.use('/api/admin/*', async (c, next) => { /* ваш существующий middleware */ });

registerAdminCollectRoutes(app);    // ✂️ ПОСЛЕ него — Bearer ADMIN_API_TOKEN
```

CORS менять не нужно: ваш middleware на `/api/*` уже отдаёт `Access-Control-Allow-Origin: <origin>`, методы `GET, POST, OPTIONS`, заголовки `Content-Type, Authorization` и `204` на `OPTIONS` — этого расширению хватает (`PUT` оно не использует). Если захотите `PUT` из браузера — добавьте метод в список (в нашем `server.ts` он уже есть).

`wrangler.toml`:

```toml
[vars]
COLLECT_ENABLED = "1"
COLLECT_MAX_CHATS = "10"
COLLECT_MAX_PAGES = "2"
COLLECT_MAX_AGE_DAYS = "7"
COLLECT_MAX_FETCHES = "24"
COLLECT_AI_DAILY_LIMIT = "100"
COLLECT_AUTO_APPROVE = "0"
INGEST_MAX_AGE_DAYS = "3"

[triggers]
crons = ["0 21 * * *", "17 */2 * * *"]     # архив + сборщик (итого 2 cron'а, лимит 3–5 не превышен)
```

Секреты:

```bash
wrangler secret put INGEST_TOKEN
```

---

## 3. Квоты ИИ (`src/ai.ts`)

Добавить счётчики по каналам — иначе авто-сбор съест дневной бюджет бота (300):

- `export type AiQuotaScope = 'bot' | 'collect' | 'extension';`
- ключи: `ai:day:<дата>` (бот, как сейчас), `ai:collect:day:<дата>`, `ai:ingest:day:<дата>`, TTL 2 суток;
- `aiExtractListing(env, text, { scope, consumeQuota })` — сигнатура обратно совместима: без `opts` работает как раньше;
- `aiQuotaAvailable()`, `aiQuotaLeft()`, `aiQuotaUsed()` — для планирования прогона и для статуса в админке;
- лимит `collect`/`extension` — `COLLECT_AI_DAILY_LIMIT` (100), при исчерпании канал продолжает разбирать правилами.

Готовый дифф — в нашем `src/ai.ts` (ищите `AiQuotaScope`).

---

## 4. Этап 6 — админ-панель (`public/app.js`)

Готовый блок: [`parcel/app-auto-collect.js`](parcel/app-auto-collect.js). Вставить в конец `app.js` и подключить:

```js
async function renderAdminChats() {
  const listEl = $('#admin-list');
  /* …ваш существующий код вкладки «чаты»… */

  // ✂️ добавить в конец: блок авто-сбора под списком источников
  const box = el('section', { class: 'admin-block' });
  listEl.append(box);
  await renderAutoCollect(box);
}
```

Подпись `origin` в карточке очереди модерации (ТЗ п. 3.8, 4.6) — в `adminCard()`:

```js
card.append(originBadge(l));   // «сборщик» / «расширение» / «бот»
```

Фильтр очереди по `origin`: `GET /api/admin/collect/status` уже отдаёт `listingsByOrigin`, а для самого списка достаточно клиентской фильтрации `items.filter(l => (l.origin || 'bot') === tab)` — поле `origin` приходит в каждой заявке после миграции 0004.

Инструкция про токен для расширения — на вкладке «чаты» в блоке отчёта (`autoCollectReport` уже печатает «выключен: wrangler secret put INGEST_TOKEN», если секрета нет).

---

## 5. README `parcel` — раздел «Авто-сбор объявлений»

Взять готовый текст из [README.md](README.md) этого репозитория (разделы «Как это работает», «Контракт POST /api/ingest», «Переменные окружения») и добавить обязательное предупреждение:

> Автоматизация аккаунта Telegram — на ваш страх и риск: только чтение, отдельный номер, редкий опрос, никаких массовых действий. Юзерботы (Telethon/Pyrogram/GramJS) и покупные аккаунты проектом не поддерживаются.

---

## 6. Приёмка после переноса

```bash
npm run typecheck
npm test                                  # ваш существующий набор + новые тесты
npm run db:local && npm run dev           # локальная D1 + воркер
```

1. `POST /api/admin/collect` с `dryRun: true` → отчёт, в базе ничего не появилось.
2. Тот же вызов без `dryRun` → заявки в `pending`, `origin = 'collector'`, в карточке модератора ссылка «исходное сообщение» ведёт на `t.me/<username>/<id>`.
3. Повторный прогон → `duplicate`, вторая заявка не создана.
4. `curl` батча из 3 сообщений (дубль / пассажирское / объявление) → `summary { created: 1, duplicate: 1, skipped: 1 }`.
5. `dryRun: true` от расширения → заявок нет, следующий обычный запрос создаёт заявку.
6. 61-й запрос за час → `429` с `Retry-After`.
7. Preflight `OPTIONS` с `Origin: https://web.telegram.org` → `204` + заголовки CORS.
8. Дневной лимит ИИ бота (`ai:day:*`) не изменился после прогона сборщика.
9. `npm run deploy` применил миграцию 0004 без ручной правки базы.
