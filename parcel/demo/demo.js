/* ------------------------------------------------------------------ *
 * Демо-обвязка админ-панели (этап 6).
 *
 * Здесь повторены ТОЧЕЧНЫЕ правки public/app.js из INTEGRATION.md (шаг 6):
 *   1. adminCard() — в строку источника добавлен originBadge(l);
 *   2. loadAdmin() — `const { items }` → `let { items }` и панель фильтра
 *      pendingOriginFilter() + filterByOrigin() для вкладки «очередь»;
 *   3. renderAdminChats() — в конец списка чатов добавлен блок
 *      `await renderAutoCollect()` (таблица обхода, форма, отчёт прогона).
 *
 * Всё остальное (el/toast/adminApi/$, sourceContent, contactInfo) — настоящее,
 * из parcel. Данные — с локального сервера демо (parcel/demo/server.mjs):
 * те же роуты, что поедут в воркер, на sqlite вместо D1 и зеркало t.me/s/
 * вместо боевого Telegram.
 * ------------------------------------------------------------------ */

/** Карточка заявки в очереди/на доске — упрощённая копия adminCard() из app.js. */
function adminCard(l, mode = 'pending') {
  const contact = contactInfo(l);
  const meta = [
    el('span', { text: ago(l.publishedAt || l.createdAt) }),
    l.departureDate ? el('span', { text: `выезд ${fmtDate(l.departureDate)}` }) : null,
    l.weightKg != null ? el('span', { class: 'mono', text: `${String(l.weightKg).replace('.', ',')} кг` }) : null,
    l.price ? el('span', { class: 'mono', text: l.price }) : null,
    // ПРАВКА 1: бейдж источника перед подписью «из чата …»
    el('span', { class: 'src' }, [originBadge(l), sourceContent(l)]),
  ];

  const act = (label, cls, fn) => el('button', {
    class: `btn ${cls} btn-sm`, type: 'button', text: label,
    onclick: async (ev) => {
      ev.target.disabled = true;
      try { await fn(); } catch (e) { toast(`Не получилось: ${e.message || e}`); }
      finally { await loadAdmin(); }
    },
  });

  const setStatus = (status) => adminApi(`/api/admin/listings/${encodeURIComponent(l.id)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }).then((r) => { if (!r.ok) throw new Error('http ' + r.status); toast('Готово.'); });

  return el('article', { class: 'admin-card' }, [
    el('div', { class: 'admin-card-head' }, [
      el('strong', { text: `${l.fromCity} → ${l.toCity}` }),
      el('span', { class: 'muted', text: l.type === 'offer' ? 'водитель везёт' : 'нужно передать' }),
      el('span', { class: 'badge', text: l.status }),
    ]),
    l.description ? el('p', { class: 'admin-descr', text: l.description }) : null,
    el('div', { class: 'admin-meta' }, meta),
    contact ? el('p', { class: 'admin-contact' }, [
      el('a', { href: contact.href, target: '_blank', rel: 'noopener', text: contact.label }),
    ]) : null,
    mode === 'pending'
      ? el('div', { class: 'admin-card-actions' }, [
          act('опубликовать', 'btn-ink', () => setStatus('published')),
          act('отклонить', 'btn-line', () => setStatus('rejected')),
          act('в архив', 'btn-line', () => setStatus('expired')),
        ])
      : el('div', { class: 'admin-card-actions' }, [
          act('в архив', 'btn-line', () => setStatus('expired')),
        ]),
  ]);
}

/** Вкладка «очередь»/«доска» — копия loadAdmin() из app.js с ПРАВКОЙ 2. */
async function loadAdmin() {
  if (!adminKey()) {
    $('#admin-login').hidden = false;
    $('#admin-panel').hidden = true;
    return;
  }
  $('#admin-login').hidden = true;
  $('#admin-panel').hidden = false;
  $('#admin-list').replaceChildren(el('p', { class: 'empty-note', text: 'загружаю…' }));

  if (adminTab === 'chats') { await renderAdminChats(); return; }

  try {
    const res = await adminApi(`/api/admin/listings?tab=${adminTab}`);
    if (res.status === 401) {
      localStorage.removeItem(ADMIN_KEY_STORAGE);
      $('#admin-login').hidden = false;
      $('#admin-panel').hidden = true;
      return;
    }
    if (!res.ok) throw new Error('network');
    // ПРАВКА 2 (часть 1): let, а не const — список ещё будет отфильтрован
    let { items } = await res.json();

    $('#admin-count').textContent = adminTab === 'pending'
      ? (items.length === 0
          ? '✅ Необработанных заявок нет.'
          : `⏳ Необработано заявок: ${items.length}`)
      : (items.length === 0 ? 'На доске пока пусто.' : `На доске: ${items.length} — действующие и архив`);

    const listEl = $('#admin-list');
    listEl.replaceChildren();

    // ПРАВКА 2 (часть 2): фильтр «откуда заявка» — только для очереди
    if (adminTab === 'pending') {
      listEl.append(pendingOriginFilter(items, adminOriginFilter, (next) => {
        adminOriginFilter = next;
        loadAdmin();
      }));
      items = filterByOrigin(items, adminOriginFilter);
    }

    if (items.length === 0) {
      listEl.append(el('p', {
        class: 'empty-note',
        text: adminTab === 'pending'
          ? (adminOriginFilter === 'all'
              ? 'Очередь пуста. Новые заявки появятся здесь.'
              : `Заявок из источника «${ORIGIN_LABELS[adminOriginFilter]}» в очереди нет.`)
          : 'На доске ничего нет.',
      }));
    } else {
      for (const l of items) listEl.append(adminCard(l, adminTab));
    }
  } catch {
    $('#admin-list').replaceChildren(el('p', {
      class: 'empty-note',
      text: 'Не получилось загрузить. Проверьте связь и нажмите «обновить».',
    }));
  }
}

/** Вкладка «чаты» — копия renderAdminChats() из app.js с ПРАВКОЙ 3. */
async function renderAdminChats() {
  const listEl = $('#admin-list');
  $('#admin-count').textContent = 'Чаты-источники и авто-сбор публичных чатов.';
  try {
    const res = await adminApi('/api/admin/source-chats');
    const { chats, needsSetup } = res.ok ? await res.json() : { chats: [], needsSetup: true };
    listEl.replaceChildren();

    if (needsSetup) {
      listEl.append(el('p', {
        class: 'empty-note',
        text: 'В базе ещё нет таблицы chat_links. Создать можно прямо здесь.',
      }), el('div', { class: 'admin-card-actions' }, [
        el('button', {
          class: 'btn btn-ink', type: 'button', text: 'создать таблицу',
          onclick: async () => {
            const r = await adminApi('/api/admin/ensure-chat-links', { method: 'POST' });
            toast(r.ok ? 'Таблица создана.' : 'Не получилось создать.');
            await renderAdminChats();
          },
        }),
      ]));
    } else {
      for (const ch of chats) {
        const input = el('input', { class: 'q', type: 'url', placeholder: 'https://t.me/…', value: ch.url || '', autocomplete: 'off' });
        listEl.append(el('article', { class: 'admin-card' }, [
          el('p', { class: 'admin-contact', text: `${ch.title || 'без названия'} · заявок: ${ch.count} · id ${ch.chatId}` }),
          el('div', { class: 'admin-card-actions' }, [
            input,
            el('button', {
              class: 'btn btn-ink btn-sm', type: 'button', text: 'сохранить',
              onclick: async () => {
                const url = input.value.trim();
                if (url && !/^https:\/\/t\.me\//.test(url)) { toast('Нужна ссылка вида https://t.me/…'); return; }
                const r = await adminApi('/api/admin/chat-links', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chatId: ch.chatId, url }),
                });
                chatLinks = {};
                toast(r.ok ? (url ? 'Ссылка сохранена.' : 'Ссылка убрана.') : 'Не получилось сохранить.');
                await renderAdminChats();
              },
            }),
          ]),
        ]));
      }
    }

    // ПРАВКА 3: блок авто-сбора публичных чатов — таблица обхода, форма, отчёт
    listEl.append(await renderAutoCollect());
  } catch (e) {
    listEl.replaceChildren(
      el('p', { class: 'empty-note', text: `Не получилось загрузить чаты: ${e.message || e}` }),
    );
  }
}

function switchAdminTab(tab) {
  adminTab = tab;
  for (const t of ['pending', 'board', 'chats']) {
    $(`#admin-tab-${t}`).classList.toggle('on', t === tab);
  }
  loadAdmin();
}

/* ---------- запуск демо ---------- */

async function initDemo() {
  // ключ админа в демо фиксированный: сервер поднят с ADMIN_API_TOKEN=demo-admin-token
  if (!adminKey()) localStorage.setItem(ADMIN_KEY_STORAGE, 'demo-admin-token');

  for (const t of ['pending', 'board', 'chats']) {
    $(`#admin-tab-${t}`).addEventListener('click', () => switchAdminTab(t));
  }
  $('#admin-refresh').addEventListener('click', () => loadAdmin());
  $('#admin-reset-demo').addEventListener('click', async () => {
    const r = await adminApi('/api/admin/demo/reset', { method: 'POST' });
    toast(r.ok ? 'Демо-данные пересозданы.' : 'Не получилось сбросить демо.');
    await loadAdmin();
  });
  $('#admin-run-collect').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      const r = await adminApi('/api/admin/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const { report } = await r.json();
      const t = report.totals;
      toast(`Прогон: чатов ${t.chats}, найдено ${t.fetched}, новых ${t.new}, заявок ${t.created}, дублей ${t.duplicate}, отсеяно ${t.skipped}, ошибок ${t.errors}`);
      switchAdminTab('chats');
    } catch (e) {
      toast(`Прогон не удался: ${e.message || e}`);
    } finally {
      ev.target.disabled = false;
    }
  });

  await loadAdmin();
}

initDemo();
