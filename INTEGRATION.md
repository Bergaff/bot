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
| `scripts/probe-chats.mjs` | `scripts/probe-chats.mjs` | как есть: разведка чатов перед добавлением (этап 7) |
| `scripts/collect-report.mjs` | `scripts/collect-report.mjs` | как есть: сводка состояния для мониторинга (этап 7) |
| `parcel/app-auto-collect.js` | ✂️ вставить в `public/app.js` | не отдельным файлом — `app.js` грузится как модуль (раздел 4) |
| `docs/rollout.md` | `docs/rollout.md` | runbook обкатки; пути к скриптам после переноса не меняются |
| `docs/ci/ci.yml`, `docs/ci/monitor.yml` | ✂️ `.github/workflows/` | скопировать вручную: бот песочницы не имеет права `workflows` (`docs/ci/README.md`) |
| `parcel/demo/` | не копировать | демо-панель для проверки UI до правки прод-файла |
| `local/`, `scripts/` (остальное), `tests/fixtures/` | не копировать | локальный CLI, sqlite-замена D1/KV, зеркало `t.me/s/` |
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

`public/app.js` подключается как `type="module"`, поэтому отдельным `<script>` блок не
подсоединить: содержимое [`parcel/app-auto-collect.js`](parcel/app-auto-collect.js)
**вставляется в конец `app.js`**. Все помощники, которые он использует (`el()`, `$()`,
`toast()`, `adminApi()`, `sourceContent()`, `contactInfo()`, `fmtDate()`), уже объявлены
выше по файлу; конфликтов имён нет — это проверяет `tests/admin-ui.test.ts`
(блок прогоняется в vm вместе с настоящими помощниками parcel).

Дальше четыре точечные правки в `app.js`.

### Правка 1 — блок авто-сбора на вкладке «чаты» (`renderAdminChats()`, ~L789)

В конце `try`, сразу после цикла `for (const ch of chats) { … }`:

```js
    // ---- авто-сбор публичных чатов (ТЗ п. 3.8) ----
    listEl.append(await renderAutoCollect());
```

Блок сам рисует таблицу обхода (username, тип, вкл/выкл, курсор, последняя проверка,
найдено/создано/отсеяно, последняя ошибка), кнопки «включить/выключить», «сбросить курсор»,
«проверить сейчас», «удалить», форму добавления чата и раскрывающийся «Отчёт последнего
прогона и статус источников» (`GET /api/admin/collect/status`). Если миграция 0004 не
применена, вместо таблицы показывается подсказка об этом.

### Правка 2 — бейдж источника в карточке модерации (`adminCard()`, ~L587)

```diff
-    el('span', { class: 'src' }, [sourceContent(l)]),
+    el('span', { class: 'src' }, [originBadge(l), sourceContent(l)]),
```

`originBadge()` возвращает `null` для заявок из бота (обычный источник, бейдж не нужен)
и подписи «сборщик» / «расширение» — для собранных автоматически.

### Правка 3 — фильтр очереди по источнику (`loadAdmin()`, ~L755)

```diff
-    const { items } = await res.json();
+    let { items } = await res.json();
     …
     const listEl = $('#admin-list');
     listEl.replaceChildren();
+
+    // ---- фильтр «откуда заявка» (ТЗ п. 3.8) ----
+    if (adminTab === 'pending') {
+      listEl.append(pendingOriginFilter(items, adminOriginFilter, (next) => {
+        adminOriginFilter = next;
+        loadAdmin();
+      }));
+      items = filterByOrigin(items, adminOriginFilter);
+    }
```

Фильтр клиентский: поле `origin` приходит в каждой заявке после миграции 0004, а счётчики
на кнопках («все · 12», «бот · 7», «сборщик · 4», «расширение · 1») считаются по тому же
списку, что уже загружен. `$('#admin-count`) остаётся про всю очередь — до фильтрации.

### Правка 4 — ссылка на источник для ключей авто-сбора (`sourceLinkUrl()`, ~L118)

```diff
 function sourceLinkUrl(l) {
   if (!l.sourceChatId) return null;
   if (chatLinks[l.sourceChatId]) return chatLinks[l.sourceChatId];
+  // авто-сбор: web:<username> — публичный чат (ссылка есть),
+  // ext:<peer-id> — приватный чат из расширения (ссылки нет)
+  const web = /^web:([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(l.sourceChatId);
+  if (web) return `https://t.me/${web[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
+  if (l.sourceChatId.startsWith('ext:')) return null;
   const m = /^-100(\d+)$/.exec(l.sourceChatId);
   if (!m) return null;
   return `https://t.me/c/${m[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
 }
```

Без этой правки подпись источника у собранных заявок остаётся некликабельной: существующий
код понимает только id вида `-100…`.

### Стили

Блок использует уже существующие классы (`admin-table`, `btn btn-ink btn-sm`, `q`, `kv`,
`muted`, `err`, `empty-note`, `admin-card-actions`, `badge`). Новых — два, их стоит добавить
в `public/styles.css`:

```css
.origin-filter { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.badge-origin { border-style: dashed; }
.badge-collector { color: #175cd3; border-color: #b2ccff; background: #f4f7ff; }
.badge-extension { color: #067647; border-color: #a6f4c5; background: #f0fdf4; }
```

### Демо-панель: проверить UI до правки прод-файла

```bash
node parcel/demo/server.mjs          # http://localhost:8790
```

Один процесс поднимает: страницу админки (склеенные `demo/helpers.js` + `app-auto-collect.js`
+ `demo/demo.js` — те же четыре правки, уже внесённые в демо-копию `loadAdmin`/`adminCard`/
`renderAdminChats`), настоящий API из `src/server.ts` на локальном sqlite вместо D1 и
зеркало `t.me/s/` на фикстурах. Кнопка «запустить сбор сейчас» делает настоящий прогон,
«проверить сейчас» — прогон одного чата. Подробно: [`parcel/demo/README.md`](parcel/demo/README.md).

---

## 5. README `parcel` — раздел «Авто-сбор объявлений»

Взять готовый текст из [README.md](README.md) этого репозитория (разделы «Как это работает», «Контракт POST /api/ingest», «Переменные окружения») и добавить обязательное предупреждение:

> Автоматизация аккаунта Telegram — на ваш страх и риск: только чтение, отдельный номер, редкий опрос, никаких массовых действий. Юзерботы (Telethon/Pyrogram/GramJS) и покупные аккаунты проектом не поддерживаются.

---

## 6. Этап 7 — обкатка

Порядок запуска, критерии перехода на следующий шаг, пороги и откат — в
[`docs/rollout.md`](docs/rollout.md). Два скрипта, которые нужны на обкатке:

```bash
# разведка чатов ПЕРЕД добавлением в обход (ТЗ п. 3.7): веб-превью открывается?
# чат живой? объявления вообще есть? какой тип — канал или супергруппа?
node scripts/probe-chats.mjs durov drivers_pl_by posylki_pl_by --deep

# состояние авто-сбора: проблемы, предупреждения, код возврата 1 для cron/алертов
node scripts/collect-report.mjs --url https://pop-utka.app --token $ADMIN_API_TOKEN \
  --stale-hours 6 --fail-on errors,disabled,stale
```

Оба работают и против локального зеркала (`--base-url http://127.0.0.1:8899/s` у разведки),
поэтому обкатку можно прогнать без интернета: `node local/mock-tme.mjs`. Ровно этот сценарий
(зеркало → разведка → dry run → боевой прогон → сброс курсора → дубликаты) на каждом пуше
прогоняет воркфайл `docs/ci/ci.yml`, job `smoke`.

Воркфайлы из `docs/ci/`:

| Файл | Переносить в `parcel`? | Что делает |
|---|---|---|
| `docs/ci/ci.yml` | job `smoke` — по желанию | типы, тесты, сборка бандла клиента и сквозной прогон на зеркале фикстур |
| `docs/ci/monitor.yml` | **да**, если хотите алерты | сводка `collect-report.mjs` каждые 3 часа; падает при проблемах → письмо от GitHub. Нужны переменная `COLLECT_REPORT_URL` и секрет `COLLECT_ADMIN_TOKEN`; пока переменной нет, job пропускается |

Кладутся в `.github/workflows/` вручную (`cp docs/ci/*.yml .github/workflows/`): у бота песочницы
нет права `workflows`, подробности — [`docs/ci/README.md`](docs/ci/README.md).
Расписание в `monitor.yml` работает только из default-ветки, то есть после слияния в `main`.

В `parcel` скрипты переносятся как есть (они не зависят от Worker API), а в `package.json`
удобно добавить:

```json
"probe": "node scripts/probe-chats.mjs",
"report": "node scripts/collect-report.mjs"
```

---

## 7. Приёмка после переноса

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
