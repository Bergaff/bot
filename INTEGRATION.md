# Перенос в `Bergaff/parcel`

Этот репозиторий — самостоятельный скраппер, но `src/*.ts` написан под воркер `parcel` и переносится почти дословно: те же типы `Env`/`Listing`, тот же SQL, те же соглашения (`rateLimit`, `normalizeContacts`, `dedupeDescription`, `markSeen`).

Ниже — порядок переноса по этапам ТЗ. Всё, что нужно сделать руками, помечено ✂️.

---

## 0. Что копировать, а что нет

| Отсюда | Куда в `parcel` | Комментарий |
|---|---|---|
| `src/ingest.ts` | `src/ingest.ts` | новый файл, без правок: `findDuplicate`/`touchListing` он берёт из вашего `store.ts` — там они уже есть |
| `src/dedupe.ts` | ✂️ не копировать | это копия вашего `src/dedupe.ts` (коммит `e037b3f`); нужна только для автономного запуска скраппера |
| `src/links.ts` | `src/links.ts` | новый файл; `listingSourceLink()` переезжает сюда из `telegram.ts` |
| `src/preview.ts`, `src/preview-html.ts` | как есть | чистый код, Worker API не использует |
| `src/collect.ts` | `src/collect.ts` | ✂️ заменить `sendTextToAdmins` на ваш `sendText`/`notifyAdmins` (шаг 3) |
| `src/routes.ts` | `src/routes.ts` | новый файл |
| `migrations/0006_ingest.sql` | `migrations/0006_ingest.sql` | как есть |
| `src/store.ts` | ✂️ только дописать | в вашем `store.ts` уже всё есть — добавьте блок «Авто-сбор» из нашего файла и 3 точечные правки (шаг 2) |
| `src/ai.ts` | ✂️ только дописать | добавить счётчики квот по каналам (шаг 2) |
| `src/types.ts` | ✂️ только дописать | новые переменные `Env`, `ListingOrigin`, `origin` в `ListingInput` |
| `src/server.ts` | ✂️ не копировать | в `parcel` уже есть `src/index.ts` — перенести из него 3 вещи (шаг 4) |
| `src/telegram.ts` | ✂️ не копировать | это локальная замена ваших `formatListing`/`notifyAdmins` |
| `src/parser.ts`, `src/util.ts` | ✂️ не копировать | у вас свои: `util.ts` совпадает байт-в-байт, в `parser.ts` вы дополнительно экспортируете `findCities()` для `/подбор` — наши копии его не заменяют |
| `scripts/probe-chats.mjs` | `scripts/probe-chats.mjs` | как есть: разведка чатов перед добавлением (этап 7) |
| `scripts/collect-report.mjs` | `scripts/collect-report.mjs` | как есть: сводка состояния для мониторинга (этап 7) |
| `parcel/app-auto-collect.js` | ✂️ вставить в `public/app.js` | не отдельным файлом — `app.js` грузится как модуль (раздел 4) |
| `docs/rollout.md` | `docs/rollout.md` | runbook обкатки; пути к скриптам после переноса не меняются |
| `docs/ci/ci.yml`, `docs/ci/monitor.yml` | ✂️ `.github/workflows/` | скопировать вручную: бот песочницы не имеет права `workflows` (`docs/ci/README.md`) |
| `parcel/demo/` | не копировать | демо-панель для проверки UI до правки прод-файла |
| `local/`, `scripts/` (остальное), `tests/fixtures/` | не копировать | локальный CLI, sqlite-замена D1/KV, зеркало `t.me/s/` |
| `tests/*.test.ts` (кроме `dedupe.test.ts`) | скопировать все | ✂️ в `tests/collect.test.ts` и `tests/ingest*.test.ts` заменить `createLocalEnv()` из `local/sqlite-env.ts` на вашу mock-`env` (или оставить sqlite — в воркер он не попадёт) |

### 0.1 Состояние `parcel`, под которое это написано

Проверено на `arena/01a0a5c0-parcel`, коммит `e037b3f` (16.09.2026, «Без «ИИ-разбора» в
объявлениях и без дублей при повторных пересылках») и повторно на текущем HEAD ветки —
`a7fcd19` (17.09.2026, «Отклик на нажатие в строке доски: карточка сразу, без ожидания
сети»): все четыре правки `app.js` встают на место, новых пересечений с авто-сбором нет.
`public/app.js` за это время вырос с 1297 до **1450 строк**, поэтому номера строк в
разделе 4 даны для `a7fcd19` (старые — в скобках).

| Что там появилось | Что это значит для переноса |
|---|---|
| `src/dedupe.ts`, `store.findDuplicate()/touchListing()/createListingSafe()` | Наш `ingest.ts` уже вызывает `findDuplicate()` + `touchListing()` — авто-сбор не плодит одинаковые заявки («еду 20 сентября» каждый день новым сообщением). Копировать `src/dedupe.ts` **не нужно**, он у вас есть; наш — та же копия |
| `migrations/0005_matches.sql` | Номер 0005 занят, поэтому наша миграция называется `0006_ingest.sql` — кладётся как есть |
| `src/match.ts`, `src/seo-routes.ts`, `src/og.ts` | Не пересекаются с авто-сбором; `store.ts` и `types.ts` из-за них ушли вперёд — поэтому их **дописываем**, а не заменяем |
| Пометка «ИИ-разбор» убрана из карточек | Наш блок этапа 6 её не возвращает: `originBadge()` показывает только источник (бот/сборщик/расширение) |
| `/api/admin/listings` аннотирует pending бейджем `duplicate` | Наш фильтр очереди по `origin` и бейдж источника с этим не конфликтуют: они про разные поля (`origin` и `duplicate`) |

Проверить, что ваши `parser.ts`/`util.ts` не разъехались с нашими копиями:

```bash
git clone --depth 1 -b arena/01a0a5c0-parcel https://github.com/Bergaff/parcel /tmp/parcel
diff /tmp/parcel/src/parser.ts src/parser.ts
diff /tmp/parcel/src/util.ts   src/util.ts
```

Сверено на `a7fcd19` (17.09.2026): `util.ts` идентичен (кроме `.ts` в импортах),
в `parser.ts` единственное расхождение — у вас `findCities()` сделана `export` с
комментарием про команду `/подбор`, у нас она локальная. Логика разбора одинаковая,
поэтому **наши `parser.ts`/`util.ts` в `parcel` не копируются вовсе**: ваши новее.

---

## 1. Этап 1 — общий конвейер

### 1.1 `migrations/0006_ingest.sql`

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

- ✂️ блок «Дубликаты по смыслу» (`findDuplicateCandidates`, `findDuplicate`, `touchListing`,
  `createListingSafe`) из нашего `store.ts` **не переносить** — в `parcel` он уже есть
  (коммит `e037b3f`), а у нас лежит только для автономного запуска;
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

CORS менять не нужно: ваш middleware на `/api/*` уже отдаёт `Access-Control-Allow-Origin: <origin>`, методы `GET, POST, OPTIONS`, заголовки `Content-Type, Authorization` и `204` на `OPTIONS` — этого расширению хватает (оно использует только `GET` и `POST`; `PUT` дёргает сама панель, она же same-origin). Если `PUT` в списке методов нет — добавьте (в нашем `server.ts` он уже есть).

### 2.1 Панель как пульт расширения — те же две функции, проводка не меняется

Авторизация Telegram остаётся в браузере заказчика (расширение читает DOM открытой вкладки —
MTProto/юзерботов нет, ТЗ п. 1.3 «не цели»). Панель задаёт, что читать, и видит, что принято:

| Ручка | Авторизация | Зачем |
| --- | --- | --- |
| `GET /api/extension/config` | `INGEST_TOKEN` | расширение забирает белый список чатов и румов, интервал, паузу |
| `POST /api/extension/heartbeat` | `INGEST_TOKEN` | отметка «аккаунт подключён»: чат, рум, счётчики, состояние, ошибки |
| `GET /api/admin/extension` | `ADMIN_API_TOKEN` | панель: кто подключён + текущие настройки |
| `PUT /api/admin/extension/config` | `ADMIN_API_TOKEN` | панель: задать белый список/интервал/паузу |
| `GET /api/admin/ingest/log` | `ADMIN_API_TOKEN` | журнал принятого: чем стало сообщение + ссылка на него |

Хранится всё в `env.KV` (ключи `ext:config` и `ext:clients`, второй — не больше 20 аккаунтов,
отметки старше 14 дней выбрасываются), KV у вас уже есть (счётчики ИИ из §3) — **миграция не нужна**.
Лимиты: у отметки свой ключ `ext-hb:<первые 8 символов токена>`, 600 в час — она не съедает
бюджет приёма (60/ч), поэтому расширение может отмечаться каждый проход.
Журнал читает `tg_seen` (миграция `0006_ingest.sql`, §1.1) с `LEFT JOIN listings`:
для приватной супергруппы ссылка служебная `t.me/c/<id>/<msg>` — открывается у участников чата,
её модератор и пересылает сам.

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

Дальше четыре точечные правки в `app.js`. Номера строк — для коммита `a7fcd19`
(1450 строк в `public/app.js`, в скобках — прежние для `e037b3f`); ищите по коду,
а не по номеру.

### Правка 1 — блок авто-сбора на вкладке «чаты» (`renderAdminChats()`, L852; была L813)

В конце `try`, сразу после цикла `for (const ch of chats) { … }` (он закрывается на L920,
перед `} catch {` на L921; раньше — ~L881):

```js
    // ---- авто-сбор публичных чатов (ТЗ п. 3.8) ----
    listEl.append(await renderAutoCollect());
```

Блок сам рисует таблицу обхода (username, тип, вкл/выкл, курсор, последняя проверка,
найдено/создано/отсеяно, последняя ошибка), кнопки «включить/выключить», «сбросить курсор»,
«проверить сейчас», «удалить», форму добавления чата и раскрывающийся «Отчёт последнего
прогона и статус источников» (`GET /api/admin/collect/status`). Если миграция 0006 не
применена, вместо таблицы показывается подсказка об этом.

### Правка 2 — бейдж источника в карточке модерации (`adminCard()`, L645; была L610)

```diff
 function adminCard(l, mode = 'pending') {
   const meta = [
     …
-    el('span', { class: 'src' }, [sourceContent(l)]),
+    el('span', { class: 'src' }, [originBadge(l), sourceContent(l)]),
   ];
```

⚠️ Такая же строка есть дважды: L251 (была L242) — карточка на публичной доске,
L645 (была L610) — `adminCard()`. Правим **только вторую**: посетителям сайта источник
заявки не нужен.

`originBadge()` возвращает `null` для заявок из бота (обычный источник, бейдж не нужен)
и подписи «сборщик» / «расширение» — для собранных автоматически. Уже существующий
`duplicateNote(l)` (объявлена на L623, вызывается первой строкой карточки на L700;
«♻️ Это повтор» / «⚠️ Похоже на дубль») не трогаем — он про другое: про дубликаты по смыслу,
которые рисует ваш `dedupe.ts`.

### Правка 3 — фильтр очереди по источнику (`loadAdmin()`, L796; `const { items }` — L829;
были L761 и L790)

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

Фильтр клиентский: поле `origin` приходит в каждой заявке после миграции 0006, а счётчики
на кнопках («все · 12», «бот · 7», «сборщик · 4», «расширение · 1») считаются по тому же
списку, что уже загружен. `$('#admin-count`) остаётся про всю очередь — до фильтрации.

### Правка 4 — ссылка на источник для ключей авто-сбора (`sourceLinkUrl()`, L120 — не сдвинулась)

```diff
 function sourceLinkUrl(l) {
   if (!l.sourceChatId) return null;
   if (chatLinks[l.sourceChatId]) return chatLinks[l.sourceChatId];
+  // авто-сбор: web:<username> — публичный чат, открытая ссылка;
+  // ext:-100<id> — приватная супергруппа из расширения, служебная t.me/c/<id>/<msg>
+  // (открывается у участников чата — модератор может открыть и переслать сам);
+  // остальные ext: (обычная группа, личный чат, ключ по заголовку) — ссылки нет
+  const web = /^web:([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(l.sourceChatId);
+  if (web) return `https://t.me/${web[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
+  const ext = /^ext:(-100\d+)$/.exec(l.sourceChatId);
+  if (ext) return `https://t.me/c/${ext[1].slice(4)}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
+  if (l.sourceChatId.startsWith('ext:')) return null;
   const m = /^-100(\d+)$/.exec(l.sourceChatId);
   if (!m) return null;
   return `https://t.me/c/${m[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
 }
```

Без этой правки подпись источника у собранных заявок остаётся некликабельной: существующий
код понимает только id вида `-100…`, а расширение присылает `web:<username>` и `ext:<peer-id>`.
Тот же разбор живёт в нашем `src/links.ts` (`listingSourceLink`) — тесты `tests/sourcelink.test.ts`.

Оговорка про служебную ссылку: она верна, только если расширение прочитало настоящий id
сообщения (`data-mid` / ссылка на сообщение). Если DOM-клиент id не отдал, `extension/core.js`
синтезирует устойчивый id (дедупликация по паре `chatId:messageId` при этом работает), и ссылка
`t.me/c/…` поведёт не туда — в журнале приёма (§2.1) рядом виден и id, и текст заявки, так что
проверить легко.

### Блок «Аккаунт Telegram (расширение)» — отдельной правки не требует

Он уже внутри `parcel/app-auto-collect.js` (`renderExtensionHub()`): `renderAutoCollect()`
рисует его последним разделом, то есть та же вставка из Правки 1 добавляет и его. Что показывает:

- подключённые браузеры: на связи / нет связи, текущий чат и рум, счётчики
  (найдено · отправлено · заявок · дублей · отсеяно · прогонов · ошибок разметки), состояние и ошибки;
- форма белого списка: по строке на чат, запись с `::` ограничивает один рум (название или id),
  плюс интервал опроса и пауза — «сохранить и передать расширению»;
- журнал принятого: когда, чат, **ссылка на сообщение**, чем оно стало (заявка создана / дубль /
  обработано без заявки) и id карточки.

Нужны только ручки из §2.1 (они в тех же `registerIngestRoutes` / `registerAdminCollectRoutes`).

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
3.1. То же объявление **другим** `messageId` (водитель повторяет его каждый день) →
   `duplicate` с `duplicateOf`/`duplicateWhy`, заявка в базе одна, а опубликованная
   освежается (`published_at` обновлён). Если у вас это не так — `ingest.ts` вызывает
   голый `createListing()` вместо `findDuplicate()` + `touchListing()`.
4. `curl` батча из 3 сообщений (дубль / пассажирское / объявление) → `summary { created: 1, duplicate: 1, skipped: 1 }`.
5. `dryRun: true` от расширения → заявок нет, следующий обычный запрос создаёт заявку.
6. 61-й запрос за час → `429` с `Retry-After`.
7. Preflight `OPTIONS` с `Origin: https://web.telegram.org` → `204` + заголовки CORS.
8. Дневной лимит ИИ бота (`ai:day:*`) не изменился после прогона сборщика.
9. `npm run deploy` применил миграцию 0006 без ручной правки базы.
