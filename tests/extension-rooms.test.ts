/**
 * Румы (топики) форум-чатов и ссылки на найденные сообщения.
 *
 * Пользователь задаёт белый список ссылками из Telegram — в том числе ссылками
 * на отдельные румы форум-чата (t.me/<чат>/<рум>), а найденные объявления хочет
 * открывать и переслать вручную по пермалинку t.me/<чат>/<рум>/<сообщение>.
 * Проверяем весь путь: разбор записи белого списка → чтение рума из адреса
 * вкладки → вердикт по каждому сообщению → пермалинк → контракт POST /api/ingest.
 */
import { describe, expect, it } from 'vitest';
import { core, dom } from './helpers/ext';
import { FakeNode, bubble, bubblesList, fakeDocument } from './helpers/fake-dom';
import { FakeBrowser, minutesAgoIso } from './helpers/fake-browser';

/* Форум-супергруппа travelersminsk, рум 91529, сообщение 713464 — пример пользователя. */
const FORUM = 'travelersminsk';
const ROOM = 91529;
const MSG = 713464;
const PERMALINK = `https://t.me/${FORUM}/${ROOM}/${MSG}`;
const ROOM_URL = `https://web.telegram.org/k/#${FORUM}/${ROOM}`;

const OFFER = `25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254`;
const CHATTER = 'Всем привет! Как дела?';

/** Лента рума: шапка с именем группы и рума + два сообщения. */
function forumPage(): FakeNode {
  const chatInfo = new FakeNode('div', { className: 'chat-info' })
    .append(new FakeNode('div', { className: 'peer-title', text: 'Travelers Minsk' }))
    .append(new FakeNode('div', { className: 'topic-title', text: 'Очередь BY-PL' }));
  const list = bubblesList([
    bubble({ text: OFFER, id: String(MSG), datetime: minutesAgoIso(45), author: 'Сергей @sergei_i' }),
    bubble({ text: CHATTER, id: String(MSG + 1), datetime: minutesAgoIso(44), author: 'Ольга' }),
  ]);
  return new FakeNode('div', { className: 'page' }).append(chatInfo, list);
}

describe('белый список: рум ссылкой из Telegram', () => {
  it('ссылка на рум t.me/<чат>/<рум> задаёт чат и id рума', () => {
    expect(core.normalizeWhitelistEntry(`https://t.me/${FORUM}/${ROOM}`)).toMatchObject({
      kind: 'username', value: FORUM, topicId: ROOM,
    });
    // то же без https и с t.me/s/
    expect(core.normalizeWhitelistEntry(`t.me/${FORUM}/${ROOM}`)).toMatchObject({ topicId: ROOM });
    expect(core.normalizeWhitelistEntry(`https://t.me/s/${FORUM}/${ROOM}`)).toMatchObject({ topicId: ROOM });
  });

  it('ссылка на сообщение t.me/<чат>/<рум>/<сообщение> — румом считается первое число', () => {
    const entry = core.normalizeWhitelistEntry(`https://t.me/${FORUM}/${ROOM}/${MSG}`);
    expect(entry).toMatchObject({ kind: 'username', value: FORUM, topicId: ROOM, topicStrict: true });
  });

  it('приватный форум: t.me/c/<id> и t.me/c/<id>/<рум>', () => {
    expect(core.normalizeWhitelistEntry('https://t.me/c/1234567890')).toMatchObject({
      kind: 'peer', value: '-1001234567890',
    });
    expect(core.normalizeWhitelistEntry(`https://t.me/c/1234567890/${ROOM}`)).toMatchObject({
      kind: 'peer', value: '-1001234567890', topicId: ROOM, topicStrict: true,
    });
  });

  it('синтаксис «чат :: тема» по-прежнему работает и считается явным', () => {
    expect(core.normalizeWhitelistEntry('Граница :: Очередь BY-PL')).toMatchObject({
      kind: 'title', topic: 'очередь by-pl', topicStrict: true,
    });
    expect(core.normalizeWhitelistEntry(`Граница :: ${ROOM}`)).toMatchObject({
      topicId: ROOM, topicStrict: true,
    });
  });

  it('читаем только свой рум: чужой рум того же чата не читаем', () => {
    const wl = [`https://t.me/${FORUM}/${ROOM}`];
    const room = (topicId: number) => ({ username: FORUM, title: 'Travelers Minsk', topicTitle: 'Очередь BY-PL', topicId });
    expect(core.matchesWhitelist(room(ROOM), wl)).toBe(true);
    expect(core.matchesWhitelist(room(ROOM + 1), wl)).toBe(false);
    expect(core.whitelistMismatch(room(ROOM + 1), wl)).toContain('рум не совпал');
    // список тем (рум не открыт): клиент показывает контейнер тем, значит это форум —
    // ссылка на рум остаётся строгой, весь чат не читаем
    const topicsList = { username: FORUM, title: 'Travelers Minsk', topicTitle: 'Очередь BY-PL' };
    expect(core.matchesWhitelist(topicsList, wl)).toBe(false);
    expect(core.whitelistMismatch(topicsList, wl)).toContain('рум');
    // рум не прочитался вовсе и признаков форума нет: двухчастная ссылка могла быть
    // ссылкой на сообщение обычного чата — тогда читаем весь чат (отдельный тест ниже)
    expect(core.matchesWhitelist({ username: FORUM, title: 'Travelers Minsk' }, wl)).toBe(true);
  });

  it('запись без рума — весь чат со всеми румами', () => {
    const wl = [`t.me/${FORUM}`];
    expect(core.matchesWhitelist({ username: FORUM, title: 'Travelers Minsk', topicId: ROOM }, wl)).toBe(true);
    expect(core.matchesWhitelist({ username: FORUM, title: 'Travelers Minsk' }, wl)).toBe(true);
  });

  it('несколько ссылок на разные румы — читаем каждый из них', () => {
    const wl = [`t.me/${FORUM}/${ROOM}`, `t.me/${FORUM}/${ROOM + 1}`, 't.me/granica_es'];
    expect(core.matchesWhitelist({ username: FORUM, topicId: ROOM }, wl)).toBe(true);
    expect(core.matchesWhitelist({ username: FORUM, topicId: ROOM + 1 }, wl)).toBe(true);
    expect(core.matchesWhitelist({ username: FORUM, topicId: ROOM + 2 }, wl)).toBe(false);
    expect(core.matchesWhitelist({ username: 'granica_es', title: 'Граница BY-PL-LT' }, wl)).toBe(true);
  });

  it('двухчастная ссылка в НЕ форумном чате — это ссылка на сообщение, читаем весь чат', () => {
    // так бывает: пользователь вставил ссылку на конкретное сообщение обычного чата
    expect(core.matchesWhitelist({ username: 'durov', title: 'Durov' }, ['https://t.me/durov/528'])).toBe(true);
    // но в форум-чате та же запись остаётся строгой: читаем только указанный рум
    expect(core.matchesWhitelist({ username: 'durov', title: 'Durov', topicId: 7 }, ['https://t.me/durov/528'])).toBe(false);
  });

  it('приватный чат находится по ссылке t.me/c/<id>', () => {
    const chat = { id: '-1001234567890', title: 'Водители', topicId: 7 };
    expect(core.matchesWhitelist(chat, ['t.me/c/1234567890'])).toBe(true);
    expect(core.matchesWhitelist(chat, [`t.me/c/1234567890/7`])).toBe(true);
    expect(core.matchesWhitelist(chat, [`t.me/c/1234567890/8`])).toBe(false);
    expect(core.matchesWhitelist(chat, ['t.me/c/9999999999'])).toBe(false);
    expect(core.chatKeyOf(chat)).toBe('ext:-1001234567890');
  });

  it('если клиент не отдал id рума, берём его из белого списка — и предупреждаем', () => {
    const wl = [`t.me/${FORUM}/${ROOM}`];
    const inRoom = { username: FORUM, title: 'Очередь BY-PL', topicTitle: 'Очередь BY-PL' };
    const adopted = core.adoptTopicFromWhitelist(inRoom, wl);
    expect(adopted?.topicId).toBe(ROOM);
    expect(adopted?.note).toContain('id рума взят из ссылки в белом списке');

    // угадывать нельзя: id уже прочитался…
    expect(core.adoptTopicFromWhitelist({ ...inRoom, topicId: 5 }, wl)).toBeNull();
    // …рума не видно вовсе (открыт обычный чат или список тем)…
    expect(core.adoptTopicFromWhitelist({ username: FORUM, title: 'Travelers Minsk' }, wl)).toBeNull();
    // …или румов закреплено несколько
    expect(core.adoptTopicFromWhitelist(inRoom, [`t.me/${FORUM}/1`, `t.me/${FORUM}/2`])).toBeNull();
    // …или запись без рума
    expect(core.adoptTopicFromWhitelist(inRoom, [`t.me/${FORUM}`])).toBeNull();
  });
});

describe('пермалинк на сообщение', () => {
  it('публичный форум: t.me/<чат>/<рум>/<сообщение>', () => {
    expect(core.messageLink({ username: FORUM, title: 'Travelers Minsk', topicId: ROOM }, MSG)).toBe(PERMALINK);
  });

  it('публичный чат без румов: t.me/<чат>/<сообщение>', () => {
    expect(core.messageLink({ username: 'durov', title: 'Durov' }, 528)).toBe('https://t.me/durov/528');
  });

  it('приватная супергруппа: служебная t.me/c/<id>[/<рум>]/<сообщение>', () => {
    expect(core.messageLink({ id: '-1001234567890', title: 'Водители' }, 12)).toBe('https://t.me/c/1234567890/12');
    expect(core.messageLink({ id: '-1001234567890', topicId: 7 }, 12)).toBe('https://t.me/c/1234567890/7/12');
  });

  it('обычная группа и личный чат ссылок на сообщение не имеют', () => {
    expect(core.messageLink({ id: '-123456789', title: 'Старая группа' }, 12)).toBeNull();
    expect(core.messageLink({ id: '987654321', title: 'Иван' }, 12)).toBeNull();
    expect(core.messageLink({ title: 'Без имени' }, 12)).toBeNull();
  });

  it('синтетический id ссылкой не снабжаем: она вела бы не туда', () => {
    expect(core.messageLink({ username: FORUM, topicId: ROOM }, MSG, { idSource: 'synthetic' })).toBeNull();
    expect(core.messageLink({ username: FORUM, topicId: ROOM }, MSG, { synthetic: true })).toBeNull();
    expect(core.messageLink({ username: FORUM }, 0)).toBeNull();
    expect(core.messageLink({ username: FORUM }, -5)).toBeNull();
  });

  it('toPayloadMessage отдаёт и рум, и ссылку; в контракт уходит только рум', () => {
    const m = core.toPayloadMessage({
      messageId: MSG,
      text: OFFER,
      dateMs: Date.now(),
      chat: { chatId: `web:${FORUM}`, username: FORUM, title: 'Travelers Minsk', topicId: ROOM },
    }, {});
    expect(m.link).toBe(PERMALINK);
    expect(m.topicId).toBe(ROOM);

    const payload = core.buildPayload([m], {});
    expect(payload.messages[0]).toMatchObject({
      chatId: `web:${FORUM}`, messageId: MSG, topicId: ROOM,
    });
    // ссылка — служебное поле клиента, сервер строит её сам по chatId + topicId
    expect(payload.messages[0].link).toBeUndefined();
  });

  it('у сообщения без настоящего id ссылки нет, но рум остаётся', () => {
    const m = core.toPayloadMessage({
      messageId: null,
      text: OFFER,
      dateMs: Date.now(),
      chat: { chatId: `web:${FORUM}`, username: FORUM, topicId: ROOM },
    }, {});
    expect(m.idSource).toBe('synthetic');
    expect(m.link).toBeNull();
    expect(m.topicId).toBe(ROOM);
  });
});

describe('рум в адресе вкладки (dom.js)', () => {
  const header = () => new FakeNode('div', { className: 'chat-info' })
    .append(new FakeNode('div', { className: 'peer-title', text: 'Travelers Minsk' }))
    .append(new FakeNode('div', { className: 'topic-title', text: 'Очередь BY-PL' }));

  it('Web K: #<чат>/<рум> и #@<чат>/<рум>', () => {
    for (const url of [`https://web.telegram.org/k/#${FORUM}/${ROOM}`, `https://web.telegram.org/k/#@${FORUM}/${ROOM}`]) {
      const { doc, location } = fakeDocument(header(), url);
      const chat = dom.readChatInfo(doc, location);
      expect(chat.username, url).toBe(FORUM);
      expect(chat.topicId, url).toBe(ROOM);
      expect(chat.topicTitle, url).toBe('Очередь BY-PL');
      expect(core.chatKeyOf(chat), url).toBe(`web:${FORUM}`);
      expect(core.messageLink(chat, MSG), url).toBe(PERMALINK);
    }
  });

  it('Web K без «@»: #<чат> — юзернейм читаем, рума нет', () => {
    const { doc, location } = fakeDocument(header(), `https://web.telegram.org/k/#${FORUM}`);
    const chat = dom.readChatInfo(doc, location);
    expect(chat.username).toBe(FORUM);
    expect(chat.topicId).toBeNull();
  });

  it('приватный форум: #-100<id>/<рум> и #/im?p=g<id>_<рум>', () => {
    const forms: Array<[string, number]> = [
      ['https://web.telegram.org/k/#-1001234567890/7', 7],
      ['https://web.telegram.org/a/#/im?p=g1234567890_12', 12],
      ['https://web.telegram.org/a/#/im/p-1001234567890-3', 3],
    ];
    for (const [url, topicId] of forms) {
      const { doc, location } = fakeDocument(header(), url);
      const chat = dom.readChatInfo(doc, location);
      expect(chat.topicId, url).toBe(topicId);
      expect(chat.id, url).toBe('-1001234567890');
    }
  });

  it('список тем форум-чата — не рум: ссылка на рум остаётся строгой', () => {
    // на списке тем клиент показывает контейнер тем: по нему видно, что чат форумный,
    // поэтому «смягчить» запись до всего чата нельзя — иначе читались бы чужие румы
    const page = new FakeNode('div', { className: 'topics-container' })
      .append(new FakeNode('div', { className: 'peer-title', text: 'Очередь BY-PL' }));
    const { doc, location } = fakeDocument(page, `https://web.telegram.org/k/#${FORUM}`);
    const chat = dom.readChatInfo(doc, location);
    expect(chat.username).toBe(FORUM);
    expect(chat.topicTitle).toBe('Очередь BY-PL');
    expect(core.matchesWhitelist(chat, [`t.me/${FORUM}/${ROOM}`])).toBe(false);
    expect(core.whitelistMismatch(chat, [`t.me/${FORUM}/${ROOM}`])).toContain('рум не совпал');
  });

  it('служебные экраны клиента чатом не считаются (#settings, #contactlist)', () => {
    for (const url of ['https://web.telegram.org/k/#settings', 'https://web.telegram.org/k/#contactlist']) {
      const { doc, location } = fakeDocument(header(), url);
      expect(dom.readChatInfo(doc, location).username, url).toBeNull();
    }
  });

  it('id рума из атрибута шапки data-topic-id', () => {
    const info = new FakeNode('div', { className: 'chat-info' })
      .append(new FakeNode('div', { className: 'peer-title', text: 'Travelers Minsk' }))
      .append(new FakeNode('div', { className: 'topic-title', attrs: { 'data-topic-id': String(ROOM) }, text: 'Очередь BY-PL' }));
    const { doc, location } = fakeDocument(info, 'https://web.telegram.org/k/');
    expect(dom.readChatInfo(doc, location).topicId).toBe(ROOM);
  });
});

describe('проход по руму в вкладке (content.js)', () => {
  it('читает рум из белого списка и шлёт topicId в контракте', async () => {
    const b = await new FakeBrowser({
      url: ROOM_URL,
      page: forumPage(),
      settings: { whitelist: [`https://t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    b.respond({
      status: 200,
      body: {
        ok: true,
        summary: { received: 1, created: 1, duplicate: 0, skipped: 0, invalid: 0, listings: 1 },
        results: [{ chatId: `web:${FORUM}`, messageId: MSG, status: 'created', listings: [{ id: 'l-1', origin: 'extension' }] }],
      },
    });
    await b.firstTick();

    expect(b.ingestCalls).toHaveLength(1);
    expect(b.lastPayload().messages).toHaveLength(1);
    expect(b.lastPayload().messages[0]).toMatchObject({
      chatId: `web:${FORUM}`, messageId: MSG, topicId: ROOM,
      chatUrl: `https://t.me/${FORUM}`,
    });
    // в контракт не должно попасть служебное поле ссылки
    expect(b.lastPayload().messages[0].link).toBeUndefined();
  });

  it('панель показывает каждое прочитанное сообщение: вердикт, причину и пермалинк', async () => {
    const b = await new FakeBrowser({
      url: ROOM_URL,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    await b.firstTick();

    const text = b.panelText();
    expect(text).toContain('Что нашлось (2)');
    expect(text).toContain('🟢 объявление');
    expect(text).toContain('⚪ отсеяно');
    expect(text).toContain('нет признаков объявления');
    expect(text).toContain(`t.me/${FORUM}/${ROOM}/${MSG}`);

    // видно, откуда сообщение: журнал переживает смену чата
    expect(text).toContain('Travelers Minsk · рум ' + ROOM);
    // ссылка кликабельна и ведёт точно на найденное сообщение
    const hrefs = b.panelNodes('a').map((a) => a.attrs.href);
    expect(hrefs).toContain(PERMALINK);
    expect(hrefs).toContain(`https://t.me/${FORUM}/${ROOM}/${MSG + 1}`);
  });

  it('журнал разбора сохраняется в localStorage и уходит в диагностику', async () => {
    const b = await new FakeBrowser({
      url: ROOM_URL,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    await b.firstTick();

    const recent = b.saved().recent ?? [];
    expect(recent).toHaveLength(2);
    // новые сверху: лента читается сверху вниз, а журнал — «что последнее видели»
    expect(recent[0]).toMatchObject({ messageId: MSG + 1, verdict: 'rejected', reason: 'chatter' });
    expect(recent[1]).toMatchObject({
      chatId: `web:${FORUM}`, messageId: MSG, verdict: 'listing', link: PERMALINK,
      // dom.js оставляет только @username, если автор подписан и именем, и юзернеймом
      chat: 'Travelers Minsk', topicId: ROOM, author: '@sergei_i',
    });
    expect(recent.every((r) => typeof r.link === 'string' && r.link.startsWith('https://t.me/'))).toBe(true);

    // кнопка «Диагностика» печатает тот же журнал со ссылками
    await b.click('Диагностика');
    const diag = b.panelNodes('pre').map((p) => p.textContent).join('\n');
    expect(diag).toContain('Что разобрали (2 последних)');
    expect(diag).toContain(PERMALINK);
    expect(diag).toContain(`Рум (тема): Очередь BY-PL (id ${ROOM})`);
  });

  it('после отправки в журнале отмечается «отправлено на сервер»', async () => {
    const b = await new FakeBrowser({
      url: ROOM_URL,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    b.respond({
      status: 200,
      body: {
        ok: true,
        summary: { received: 1, created: 1, duplicate: 0, skipped: 0, invalid: 0, listings: 1 },
        results: [{ chatId: `web:${FORUM}`, messageId: MSG, status: 'created', listings: [{ id: 'l-1', origin: 'extension' }] }],
      },
    });
    await b.firstTick();

    const sent = (b.saved().recent ?? []).find((r) => r.messageId === MSG);
    expect(sent?.sent).toBe(true);
    expect(b.panelText()).toContain('отправлено на сервер');
  });

  it('чужой рум не читаем и объясняем почему', async () => {
    const b = await new FakeBrowser({
      url: `https://web.telegram.org/k/#${FORUM}/${ROOM + 1}`,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`] },
    }).ready();
    await b.firstTick();

    expect(b.ingestCalls).toHaveLength(0);
    expect(b.saved().counters?.found ?? 0).toBe(0);
    expect(b.panelText()).toContain('рум не совпал');
  });

  it('id рума из белого списка, если клиент его не отдал: читаем и предупреждаем', async () => {
    const b = await new FakeBrowser({
      url: `https://web.telegram.org/k/#${FORUM}`,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    await b.firstTick();

    expect(b.lastPayload().messages[0]).toMatchObject({ messageId: MSG, topicId: ROOM });
    expect(b.panelText()).toContain('id рума взят из ссылки в белом списке');
    expect(b.panelNodes('a').map((a) => a.attrs.href)).toContain(PERMALINK);
  });

  it('запись без рума — читаем все румы чата', async () => {
    const b = await new FakeBrowser({
      url: `https://web.telegram.org/k/#${FORUM}/${ROOM + 1}`,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}`], confirmMode: false },
    }).ready();
    await b.firstTick();

    expect(b.ingestCalls).toHaveLength(1);
    expect(b.lastPayload().messages[0].topicId).toBe(ROOM + 1);
    expect(b.panelNodes('a').map((a) => a.attrs.href))
      .toContain(`https://t.me/${FORUM}/${ROOM + 1}/${MSG}`);
  });

  it('повторный проход не плодит записи журнала, а обновляет их', async () => {
    const b = await new FakeBrowser({
      url: ROOM_URL,
      page: forumPage(),
      settings: { whitelist: [`t.me/${FORUM}/${ROOM}`], confirmMode: false },
    }).ready();
    await b.firstTick();
    await b.tick();

    expect(b.saved().recent ?? []).toHaveLength(2);
    expect(b.panelText()).toContain('Что нашлось (2)');
  });
});

describe('журнал разбора в человекочитаемом виде (core.js)', () => {
  it('вердикт, автор, причина и ссылка — одной строкой', () => {
    const line = core.verdictLine({
      verdict: 'listing', author: 'Сергей', text: OFFER, reason: 'ok', link: PERMALINK, sent: true,
    });
    expect(line).toContain('🟢 объявление');
    expect(line).toContain('Сергей');
    expect(line).toContain('есть признаки объявления');
    expect(line).toContain('отправлено');
    expect(line).toContain(PERMALINK);
  });

  it('без ссылки честно пишем, что её нет', () => {
    const line = core.verdictLine({ verdict: 'rejected', text: CHATTER, reason: 'passenger' });
    expect(line).toContain('⚪ отсеяно');
    expect(line).toContain('про поездку людей');
    expect(line).toContain('ссылки нет');
  });

  it('подписи вердиктов и причин по-русски', () => {
    expect(core.explainReason('chatter')).toContain('переписка');
    expect(core.explainReason('unknown_reason')).toBe('unknown_reason');
    expect(core.VERDICT_LABELS.duplicate).toContain('уже отправляли');
  });
});
