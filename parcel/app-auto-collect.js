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
    const act = async (label, fn) => el('button', {
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

/** Отрисовать блок «Авто-сбор публичных чатов» (вызывается из renderAdminChats). */
async function renderAutoCollect(container) {
  const box = container ?? el('section', { class: 'admin-block' });
  box.replaceChildren(el('p', { class: 'empty-note', text: 'Загружаем авто-сбор…' }));
  try {
    const [chatsRes, statusRes] = await Promise.all([
      adminApi('/api/admin/watch-chats'),
      adminApi('/api/admin/collect/status'),
    ]);
    if (!chatsRes.ok) throw new Error('watch-chats http ' + chatsRes.status);
    const { chats, needsSetup } = await chatsRes.json();
    const status = statusRes.ok ? await statusRes.json() : null;

    box.replaceChildren(
      el('h3', { text: 'Авто-сбор публичных чатов' }),
      el('p', {
        class: 'muted',
        text: 'Сервер сам читает веб-превью t.me/<username> (бот в чат не добавляется). Курсор — последний обработанный id сообщения; ' +
          'дубли не страшны: их отсекает tg_seen. Заявки всегда попадают в очередь модерации.',
      }),
      needsSetup
        ? el('p', { class: 'empty-note', text: 'Нужна миграция 0004_ingest.sql: npm run deploy (или wrangler d1 migrations apply DB --remote).' })
        : (chats.length === 0
            ? el('p', { class: 'empty-note', text: 'Чатов в обходе нет. Добавьте публичный канал или супергруппу — и нажмите «проверить сейчас».' })
            : autoCollectTable(chats)),
      autoCollectForm(),
      status ? el('details', { class: 'admin-report' }, [
        el('summary', { text: 'Отчёт последнего прогона и статус источников' }),
        autoCollectReport(status),
      ]) : null,
    );
  } catch (e) {
    box.replaceChildren(el('p', { class: 'empty-note', text: `Авто-сбор не загрузился: ${e.message || e}` }));
  }
  return box;
}

/** Подпись источника в карточке модерации: «сборщик» / «расширение» / «бот». */
function originBadge(listing) {
  const label = ORIGIN_LABELS[listing.origin] || 'бот';
  return el('span', { class: 'badge badge-origin', text: label, title: 'Откуда пришла заявка' });
}
