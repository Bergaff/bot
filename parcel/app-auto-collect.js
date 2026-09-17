/* ------------------------------------------------------------------ *
 * Авто-сбор публичных чатов — блок вкладки «чаты» админ-панели.
 *
 * Готовый кусок для public/app.js проекта Bergaff/parcel (ТЗ п. 3.8 и 4.6).
 * Использует те же помощники, что уже есть в app.js: el(), adminApi(),
 * toast(), $(). Вставлять в конец файла, вызов — из renderAdminChats()
 * (см. INTEGRATION.md, шаг 6).
 *
 * Что умеет:
 *   - таблица чатов обхода: username, тип, вкл/выкл, курсор, последняя
 *     проверка, найдено/создано/отсеяно, последняя ошибка;
 *   - форма добавления (username + тип), кнопки вкл/выкл, сброс курсора,
 *     «проверить сейчас» (POST /api/admin/collect с chatId);
 *   - «Отчёт последнего прогона» (GET /api/admin/collect/status) в читаемом виде;
 *   - статус расширения: сколько принято сообщений и создано заявок за сутки.
 * ------------------------------------------------------------------ */

const ORIGIN_LABELS = { bot: 'бот', collector: 'сборщик', extension: 'расширение' };

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { hour12: false });
}

/** Таблица чатов, которые обходит серверный сборщик. */
function autoCollectTable(chats) {
  const head = el('tr', {}, [
    'чат', 'тип', 'статус', 'курсор', 'проверен', 'найдено / создано / отсеяно', 'ошибка', 'действия',
  ].map((t) => el('th', { text: t })));

  const rows = chats.map((c) => {
    const busy = { value: false };
    // ВАЖНО: не async — иначе вернётся Promise, а не кнопка
    const act = (label, fn) => el('button', {
      class: 'btn btn-ink btn-sm', type: 'button', text: label,
      onclick: async (ev) => {
        if (busy.value) return;
        busy.value = true;
        ev.target.disabled = true;
        try { await fn(); } catch (e) { toast(`Не получилось: ${e.message || e}`); }
        finally { busy.value = false; await renderAutoCollect(); }
      },
    });

    return el('tr', {}, [
      el('td', {}, [
        el('a', { href: `https://t.me/${c.username}`, target: '_blank', rel: 'noopener', text: c.username }),
        c.title ? el('div', { class: 'muted', text: c.title }) : null,
      ]),
      el('td', { text: c.kind === 'supergroup' ? 'супергруппа' : 'канал' }),
      el('td', { text: c.enabled ? 'включён' : 'выключен' }),
      el('td', { text: c.lastMessageId == null ? 'не установлен' : String(c.lastMessageId) }),
      el('td', { text: fmtWhen(c.lastCheckedAt) }),
      el('td', { text: `${c.statsFound} / ${c.statsCreated} / ${c.statsSkipped}` }),
      el('td', { class: c.lastError ? 'err' : 'muted', text: c.lastError || '—' }),
      el('td', {}, [
        act(c.enabled ? 'выключить' : 'включить', () =>
          adminApi(`/api/admin/watch-chats/${encodeURIComponent(c.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !c.enabled }),
          }).then((r) => { if (!r.ok) throw new Error('http ' + r.status); })),
        act('сбросить курсор', () => {
          if (!confirm(`Сбросить курсор ${c.username}? Следующий прогон возьмёт только последнюю страницу — история назад не выкачивается.`)) return Promise.resolve();
          return adminApi(`/api/admin/watch-chats/${encodeURIComponent(c.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_message_id: null }),
          }).then((r) => { if (!r.ok) throw new Error('http ' + r.status); });
        }),
        act('проверить сейчас', () =>
          adminApi('/api/admin/collect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: c.id }),
          }).then(async (r) => {
            if (!r.ok) throw new Error('http ' + r.status);
            const { report } = await r.json();
            const one = (report.chats || [])[0] || {};
            toast(`${c.username}: ${one.status || 'ok'} — новых ${one.new ?? 0}, заявок ${one.created ?? 0}` +
              (one.error ? `, ошибка: ${one.error}` : ''));
          })),
        act('удалить', () => {
          if (!confirm(`Убрать ${c.username} из обхода? Созданные заявки останутся.`)) return Promise.resolve();
          return adminApi(`/api/admin/watch-chats/${encodeURIComponent(c.id)}`, { method: 'DELETE' })
            .then((r) => { if (!r.ok) throw new Error('http ' + r.status); });
        }),
      ]),
    ]);
  });

  return el('table', { class: 'admin-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)]);
}

/** Форма добавления публичного чата в обход. */
function autoCollectForm() {
  const username = el('input', { class: 'q', type: 'text', placeholder: 'durov или https://t.me/drivers_pl_by', autocomplete: 'off' });
  const kind = el('select', { class: 'q' }, [
    el('option', { value: 'channel', text: 'канал' }),
    el('option', { value: 'supergroup', text: 'супергруппа' }),
  ]);
  const add = el('button', { class: 'btn btn-ink', type: 'button', text: 'добавить в обход' });
  add.addEventListener('click', async () => {
    const value = username.value.trim();
    if (!value) { toast('Введите юзернейм чата'); return; }
    add.disabled = true;
    try {
      const r = await adminApi('/api/admin/watch-chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: value, kind: kind.value }),
      });
      if (r.status === 409) { toast('Такой чат уже в обходе.'); return; }
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'http ' + r.status); }
      toast('Чат добавлен. Первый прогон возьмёт только последнюю страницу.');
      username.value = '';
      await renderAutoCollect();
    } catch (e) {
      toast(`Не получилось добавить: ${e.message || e}`);
    } finally {
      add.disabled = false;
    }
  });
  return el('div', { class: 'admin-card-actions' }, [username, kind, add]);
}

/** Последний отчёт прогона — сводка + по чатам. */
function autoCollectReport(status) {
  const r = status.lastReport;
  const totals = r ? r.totals : null;
  const rows = [
    ['cron-сборщик', status.enabled ? 'включён' : 'выключен (COLLECT_ENABLED != 1)'],
    ['приём от расширения', status.ingestTokenSet ? 'включён (INGEST_TOKEN задан)' : 'выключен: wrangler secret put INGEST_TOKEN'],
    ['чатов в обходе', `${status.watchChats.enabled} из ${status.watchChats.total} (с ошибками: ${status.watchChats.withErrors})`],
    ['ИИ сборщика сегодня', `${status.ai.collectUsedToday} из ${status.ai.collectLimit}, осталось ${status.ai.collectLeft}`],
    ['ИИ расширения сегодня', `осталось ${status.ai.ingestLeft}`],
    ['заявок по источникам', `бот ${status.listingsByOrigin.bot} · сборщик ${status.listingsByOrigin.collector} · расширение ${status.listingsByOrigin.extension}`],
    ['расширение за сутки', `принято сообщений ${status.extensionToday.messages}, создано заявок ${status.extensionToday.created}`],
    ['последний прогон', r ? `${fmtWhen(r.startedAt)}${r.dryRun ? ' (dry run)' : ''}` : 'ещё не запускался'],
  ];
  if (totals) {
    rows.push(['итоги прогона',
      `чатов ${totals.chats}, запросов ${totals.fetches}, найдено ${totals.fetched}, новых ${totals.new}, ` +
      `заявок ${totals.created}, дублей ${totals.duplicate}, отсеяно ${totals.skipped}, ошибок ${totals.errors}`]);
  }
  return el('div', {}, rows.map(([k, v]) => el('div', { class: 'kv' }, [
    el('span', { class: 'muted', text: k }), el('span', { text: v }),
  ])));
}

/** Куда блок смонтирован: кнопки (добавить/удалить/включить/проверить) обновляют
 *  таблицу на месте, перезагружать страницу не нужно. */
let autoCollectBox = null;

/**
 * Отрисовать блок «Авто-сбор публичных чатов» (вызывается из renderAdminChats).
 * Без аргумента — перерисовать уже смонтированный блок (именно так делают кнопки).
 */
async function renderAutoCollect(container) {
  const box = container ?? autoCollectBox ?? el('section', { class: 'admin-block' });
  autoCollectBox = box;
  box.replaceChildren(el('p', { class: 'empty-note', text: 'Загружаем авто-сбор…' }));
  try {
    const [chatsRes, statusRes] = await Promise.all([
      adminApi('/api/admin/watch-chats'),
      adminApi('/api/admin/collect/status'),
    ]);
    if (!chatsRes.ok) throw new Error('watch-chats http ' + chatsRes.status);
    const { chats, needsSetup } = await chatsRes.json();
    const status = statusRes.ok ? await statusRes.json() : null;

    box.replaceChildren(...[
      el('h3', { text: 'Авто-сбор публичных чатов' }),
      el('p', {
        class: 'muted',
        text: 'Сервер сам читает веб-превью t.me/<username> (бот в чат не добавляется). Курсор — последний обработанный id сообщения; ' +
          'дубли не страшны: их отсекает tg_seen. Заявки всегда попадают в очередь модерации.',
      }),
      needsSetup
        ? el('p', { class: 'empty-note', text: 'Нужна миграция 0006_ingest.sql: npm run deploy (или wrangler d1 migrations apply DB --remote).' })
        : (chats.length === 0
            ? el('p', { class: 'empty-note', text: 'Чатов в обходе нет. Добавьте публичный канал или супергруппу — и нажмите «проверить сейчас».' })
            : autoCollectTable(chats)),
      autoCollectForm(),
      status ? el('details', { class: 'admin-report' }, [
        el('summary', { text: 'Отчёт последнего прогона и статус источников' }),
        autoCollectReport(status),
      ]) : null,
      await renderExtensionHub(),
    ].filter(Boolean));
  } catch (e) {
    box.replaceChildren(el('p', { class: 'empty-note', text: `Авто-сбор не загрузился: ${e.message || e}` }));
  }
  return box;
}

/**
 * Подпись источника в карточке модерации: «сборщик» / «расширение».
 * Для заявок из бота возвращает null — это обычный, привычный модератору
 * источник, и плодить лишние бейджи на каждой карточке смысла нет
 * (фильтр «бот · N» в pendingOriginFilter их всё равно считает).
 */
function originBadge(listing) {
  const origin = originOf(listing);
  if (origin === 'bot') return null;
  return el('span', {
    class: 'badge badge-origin badge-' + origin,
    text: ORIGIN_LABELS[origin],
    title: origin === 'collector'
      ? 'Собрано сервером из веб-превью публичного чата (t.me/s/…)'
      : 'Прислано расширением из вкладки Telegram Web',
  });
}

/* ------------------------------------------------------------------ *
 * Очередь модерации: подпись источника и фильтр «откуда заявка».
 *
 * Заявки теперь приходят из трёх мест (ТЗ п. 3.8): бот в чатах, серверный
 * сборщик публичных чатов и расширение в вкладке заказчика. Модератору важно
 * видеть источник — у собранных автоматически чаще плывут города и даты.
 *
 * Правки в app.js (подробно в INTEGRATION.md, шаг 6):
 *   1) в adminCard(): el('span', { class: 'src' }, [originBadge(l), sourceContent(l)])
 *   2) в loadAdmin(): const { items } → let { items }, и после listEl.replaceChildren()
 *        if (adminTab === 'pending') {
 *          listEl.append(pendingOriginFilter(items, adminOriginFilter, (next) => {
 *            adminOriginFilter = next; loadAdmin();
 *          }));
 *          items = filterByOrigin(items, adminOriginFilter);
 *        }
 * ------------------------------------------------------------------ */

/** Текущий фильтр очереди: 'all' | 'bot' | 'collector' | 'extension'. */
let adminOriginFilter = 'all';

/**
 * Источник заявки. У старых записей поля origin нет (миграция 0006 добавляет
 * его со значением 'bot'), поэтому всё неизвестное считаем ботом.
 */
function originOf(l) {
  return l && (l.origin === 'collector' || l.origin === 'extension') ? l.origin : 'bot';
}

/** Отфильтровать список заявок по источнику ('all' — без фильтра). */
function filterByOrigin(items, origin) {
  const list = Array.isArray(items) ? items : [];
  if (!origin || origin === 'all') return list.slice();
  return list.filter((l) => originOf(l) === origin);
}

/** Сколько заявок каждого источника в списке — для подписей на кнопках фильтра. */
function countByOriginClient(items) {
  const counts = { all: 0, bot: 0, collector: 0, extension: 0 };
  for (const l of Array.isArray(items) ? items : []) {
    counts.all++;
    counts[originOf(l)]++;
  }
  return counts;
}

/**
 * Панель фильтра очереди модерации. `onPick(origin)` — вызов при клике;
 * в app.js это `(next) => { adminOriginFilter = next; loadAdmin(); }`.
 */
function pendingOriginFilter(items, current, onPick) {
  const counts = countByOriginClient(items);
  const variants = [
    ['all', 'все'],
    ['bot', 'бот'],
    ['collector', 'сборщик'],
    ['extension', 'расширение'],
  ];
  return el('div', { class: 'origin-filter' }, variants.map(([value, label]) => el('button', {
    class: 'btn btn-sm ' + (value === current ? 'btn-ink' : 'btn-line'),
    type: 'button',
    text: `${label} · ${counts[value]}`,
    title: value === 'all'
      ? 'Показать всю очередь'
      : `Только заявки, которые пришли: ${ORIGIN_LABELS[value]}`,
    onclick: () => { if (value !== current && typeof onPick === 'function') onPick(value); },
  })));
}

/** Сбросить фильтр (например, после публикации всех заявок). */
function resetOriginFilter() { adminOriginFilter = 'all'; }

/* ------------------------------------------------------------------ *
 * Аккаунт Telegram: расширение как подключённая сессия (вариант B)
 *
 * Авторизация Telegram остаётся в браузере заказчика — расширение читает
 * DOM открытой вкладки web.telegram.org и присылает отметки сюда. Панель
 * работает пультом: белый список чатов и румов, пауза, статус, журнал
 * принятого со ссылками на сообщения (их модератор пересылает сам).
 * ------------------------------------------------------------------ */

/** Сколько минут без отметки считаем «нет связи» (интервал опроса до 600 с). */
const EXT_STALE_MS = 12 * 60 * 1000;

/** Когда расширение последний раз выходило на связь — по-человечески. */
function extAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  const min = Math.round((Date.now() - t) / 60000);
  if (min <= 0) return 'только что';
  if (min < 60) return min + ' мин назад';
  const h = Math.round(min / 60);
  if (h < 48) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
}

function extAlive(client) {
  const t = Date.parse((client && client.at) || '');
  return Number.isFinite(t) && (Date.now() - t) < EXT_STALE_MS;
}

/** Блок «Аккаунт Telegram (расширение)»: кто подключён, что читает, что принято. */
async function renderExtensionHub() {
  const box = el('section', { class: 'admin-block' });
  box.replaceChildren(el('p', { class: 'empty-note', text: 'Загружаем аккаунты Telegram…' }));
  try {
    const [extRes, logRes] = await Promise.all([
      adminApi('/api/admin/extension'),
      adminApi('/api/admin/ingest/log?limit=30'),
    ]);
    const ext = extRes.ok ? await extRes.json() : { clients: [], config: null, ingestEnabled: true };
    const log = logRes.ok ? await logRes.json() : { items: [] };
    box.replaceChildren(...[
      el('h3', { text: 'Аккаунт Telegram (расширение)' }),
      el('p', {
        class: 'muted',
        text: 'Авторизация Telegram — в браузере: расширение читает открытую вкладку web.telegram.org (только чтение) ' +
          'и присылает отметки сюда. Панель задаёт белый список чатов и румов, ставит паузу и показывает, что принято.',
      }),
      ext.clients && ext.clients.length ? extClientsList(ext.clients) : extNoClients(ext),
      extConfigForm(ext.config),
      ingestLogTable(log),
    ].filter(Boolean));
  } catch (e) {
    box.replaceChildren(el('p', { class: 'empty-note', text: `Блок аккаунтов не загрузился: ${e.message || e}` }));
  }
  return box;
}

function extNoClients(ext) {
  return el('p', {
    class: 'empty-note',
    text: ext.ingestEnabled === false
      ? 'Приём выключен: на сервере не задан INGEST_TOKEN (wrangler secret put INGEST_TOKEN).'
      : 'Ни один браузер ещё не подключился: отметок от расширения не было. Поставьте расширение ' +
        '(chrome://extensions → «Загрузить распакованное расширение» → папка extension/), откройте ' +
        'web.telegram.org, в попапе заполните serverUrl и token и нажмите «Самопроверка».',
  });
}

/** Карточки подключённых браузеров: чат, рум, счётчики, состояние, ошибки. */
function extClientsList(clients) {
  return el('div', {}, clients.map((c) => {
    const chat = c.chat || {};
    const counters = c.counters || {};
    const alive = extAlive(c);
    const room = chat.topicTitle || (chat.topicId != null ? 'рум id ' + chat.topicId : null);
    return el('article', { class: 'admin-card' }, [
      el('p', { class: 'admin-contact' }, [
        el('span', {
          class: 'badge badge-origin ' + (alive ? 'badge-extension' : 'badge-collector'),
          text: alive ? 'на связи' : 'нет связи',
          title: 'Отметка получена ' + extAgo(c.at),
        }),
        el('span', {
          text: ' ' + (chat.title || chat.chatKey || 'чат не определён') +
            (chat.username ? ' (@' + chat.username + ')' : ''),
        }),
      ]),
      el('p', {
        class: 'muted',
        text: [
          'отметка: ' + extAgo(c.at),
          c.collector ? 'клиент: ' + c.collector : null,
          c.clientId ? 'id: ' + String(c.clientId).slice(0, 8) : null,
          room ? room : null,
          chat.whitelisted === false ? 'чат НЕ в белом списке' : null,
          c.paused ? 'ПАУЗА' : null,
          c.intervalSec ? 'опрос ' + c.intervalSec + ' с' : null,
        ].filter(Boolean).join(' · '),
      }),
      el('p', {
        class: 'muted mono',
        text: 'найдено ' + (counters.found || 0) + ' · отправлено ' + (counters.sent || 0) +
          ' · заявок ' + (counters.created || 0) + ' · дублей ' + (counters.duplicate || 0) +
          ' · отсеяно ' + (counters.skipped || 0) + ' · прогонов ' + (counters.runs || 0) +
          ' · ошибок разметки ' + (counters.errors || 0),
      }),
      c.status ? el('p', { class: 'muted', text: 'состояние: ' + c.status }) : null,
      c.error ? el('p', { class: 'empty-note', text: '⚠ ' + c.error }) : null,
      c.unreadable
        ? el('p', { class: 'empty-note', text: '⚠ Разметка Telegram Web не читается: данные не отправляются. Нужна починка селекторов (extension/dom.js).' })
        : null,
    ].filter(Boolean));
  }));
}

/** Форма белого списка для расширения: чаты и румы, интервал, пауза. */
function extConfigForm(config) {
  const list = el('textarea', {
    class: 'q', rows: 5,
    placeholder: 'Граница\nt.me/granica_es\nГраница :: Очередь BY-PL\nГраница :: 7',
  });
  list.value = ((config && config.whitelist) || []).join('\n');

  const interval = el('input', { class: 'q', type: 'number', min: 60, max: 600, step: 10 });
  interval.value = String((config && config.intervalSec) || 120);

  const paused = el('input', { type: 'checkbox' });
  paused.checked = Boolean(config && config.paused);

  const save = el('button', {
    class: 'btn btn-ink', type: 'button', text: 'сохранить и передать расширению',
    onclick: async () => {
      save.disabled = true;
      try {
        const whitelist = String(list.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const r = await adminApi('/api/admin/extension/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            whitelist,
            intervalSec: Number(interval.value) || 120,
            paused: paused.checked,
          }),
        });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          throw new Error(b.error || 'http ' + r.status);
        }
        toast('Передано расширению: ' + whitelist.length + ' записей в белом списке' +
          (paused.checked ? ', пауза включена' : '') +
          '. Подхватит в следующий проход (или кнопка «Настройки из панели» в попапе).');
        await renderAutoCollect();
      } catch (e) {
        toast('Не получилось сохранить: ' + (e.message || e));
      } finally {
        save.disabled = false;
      }
    },
  });

  return el('div', {}, [
    el('p', {
      class: 'muted',
      text: 'Белый список расширения (по строке на чат). Запись с «::» ограничивает один рум (тему) ' +
        'форум-чата — названием или id; без «::» читаются все румы чата. Пустой список — не читается ничего.',
    }),
    el('div', { class: 'admin-card-actions' }, [
      list,
      el('label', { class: 'muted', text: 'опрос, с' }),
      interval,
      el('label', { class: 'muted' }, [paused, el('span', { text: ' пауза' })]),
      save,
    ]),
    config && config.updatedAt
      ? el('p', { class: 'muted', text: 'Настройки заданы ' + extAgo(config.updatedAt) + '.' })
      : el('p', { class: 'muted', text: 'Настройки из панели ещё не задавались — расширение работает по своему попапу.' }),
  ]);
}

/** Чем стало каждое принятое сообщение: заявка, дубль или ничего + ссылка на сообщение. */
function ingestLogKind(row) {
  const route = row.fromCity ? row.fromCity + ' → ' + row.toCity : '';
  const date = row.departureDate ? ', ' + fmtDate(row.departureDate) : '';
  if (row.kind === 'created') return 'заявка создана' + (route ? ': ' + route + date : '');
  if (row.kind === 'duplicate') return 'дубль: такая заявка уже была' + (route ? ' (' + route + ')' : '');
  return 'обработано, заявки нет';
}

function ingestLogTable(log) {
  const items = (log && log.items) || [];
  return el('details', { class: 'admin-report', open: true }, [
    el('summary', { text: 'Что принято от аккаунта: последние ' + items.length + ' сообщений' }),
    items.length === 0
      ? el('p', {
          class: 'empty-note',
          text: log && log.needsSetup
            ? 'Нужна миграция 0006_ingest.sql (npm run deploy).'
            : 'Пока пусто. Отсеянное на стороне расширения (болтовня, пассажирские, старые) сюда не попадает вовсе — ' +
              'это видно в его счётчиках выше.',
        })
      : el('table', { class: 'admin-table' }, [
          el('thead', {}, [el('tr', {}, [
            'когда', 'чат', 'сообщение', 'что вышло', 'заявка',
          ].map((t) => el('th', { text: t })))]),
          el('tbody', {}, items.map((r) => el('tr', {}, [
            el('td', { text: fmtWhen(r.seenAt) }),
            el('td', { class: 'mono', text: r.chatId }),
            el('td', {}, [r.link
              ? el('a', {
                  href: r.link, target: '_blank', rel: 'noopener', text: 'открыть сообщение',
                  title: r.link.startsWith('https://t.me/c/')
                    ? 'Служебная ссылка: открывается у участников чата'
                    : 'Публичная ссылка на сообщение',
                })
              : el('span', {
                  class: 'muted',
                  text: 'ссылки нет',
                  title: 'Личный чат или обычная группа: ссылки на сообщение не существует. ' +
                    'Для приватной супергруппы ссылка появится, если расширение прочитало id чата из адреса вкладки.',
                })]),
            el('td', { text: ingestLogKind(r) + (r.origin ? ' · ' + (ORIGIN_LABELS[r.origin] || r.origin) : '') }),
            el('td', { class: 'mono', text: r.listingId ? String(r.listingId).slice(0, 8) + (r.status ? ' · ' + r.status : '') : '—' }),
          ]))),
        ]),
  ]);
}
