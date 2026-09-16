/**
 * Тесты чтения DOM (этап 3 ТЗ): extension/dom.cjs.
 *
 * Разметка Telegram Web меняется, поэтому код ищет каждое поле по списку
 * кандидатов-селекторов. Здесь проверяем на синтетическом дереве
 * (tests/helpers/fake-dom.ts), что:
 *   - сообщения находятся и основной стратегией (.bubbles .bubble), и запасной;
 *   - id берётся из атрибутов/ссылок, а при коллизиях обнуляется (core синтезирует);
 *   - сервисные строки и пустые узлы не считаются объявлениями;
 *   - даты разбираются из подписей клиента;
 *   - пустая/незнакомая разметка → честное «не могу прочитать сообщения».
 */
import { describe, expect, it } from 'vitest';
import * as parser from '../src/parser';
import { core, dom } from './helpers/ext';
import { FakeNode, bubble, bubblesList, fakeDocument } from './helpers/fake-dom';

/** 15.09.2026 12:00 по локальному времени машины (тесты не зависят от TZ). */
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime();

const OFFER = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';
const CHATTER = 'Всем привет! Как дела?';
const PASSENGER = 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?';

describe('текст и атрибуты узлов', () => {
  it('неразрывные пробелы и повторы пробелов нормализуются, переносы строк остаются', () => {
    const n = new FakeNode('div', { text: '  Варшава\u00a0—\u00a0Брест \n\n\n 25.09  ' });
    expect(dom.textOf(n)).toBe('Варшава — Брест \n\n 25.09');
  });

  it('innerText важнее textContent (в браузере он ближе к видимому тексту)', () => {
    expect(dom.textOf({ innerText: ' из innerText ', textContent: 'из textContent' })).toBe('из innerText');
    expect(dom.textOf({ textContent: ' только textContent ' })).toBe('только textContent');
    expect(dom.textOf(null)).toBe('');
    expect(dom.textOf({})).toBe('');
  });

  it('attrOf берёт первое непустое значение из списка', () => {
    const n = new FakeNode('time', { attrs: { datetime: '  ', title: ' 12.09.2026 ' } });
    expect(dom.attrOf(n, ['datetime', 'title', 'aria-label'])).toBe('12.09.2026');
    expect(dom.attrOf(n, ['data-x', 'data-y'])).toBeNull();
    expect(dom.attrOf({ text: 'без getAttribute' }, ['datetime'])).toBeNull();
  });
});

describe('messageId из разметки', () => {
  it('прямой числовой id в атрибуте', () => {
    expect(dom.toMessageId('528')).toBe(528);
    expect(dom.toMessageId(12345)).toBe(12345);
    expect(dom.toMessageId('  528 ')).toBe(528);
  });

  it('составной id «peerId_msgId» — берём последнюю группу (первая одинакова у всего чата)', () => {
    expect(dom.toMessageId('1001234567890_528')).toBe(528);
    expect(dom.toMessageId('mid:12345')).toBe(12345);
    expect(dom.toMessageId('p-100123_456')).toBe(456);
  });

  it('мусор и ноль → null (тогда core синтезирует устойчивый id)', () => {
    expect(dom.toMessageId('0')).toBeNull();
    expect(dom.toMessageId('')).toBeNull();
    expect(dom.toMessageId(null)).toBeNull();
    expect(dom.toMessageId(undefined)).toBeNull();
    expect(dom.toMessageId('abc')).toBeNull();
    expect(dom.toMessageId('-5')).toBeNull();
  });

  it('messageIdFromNode: атрибут → ссылка на сообщение → ничего', () => {
    expect(dom.messageIdFromNode(bubble({ text: OFFER, id: '528' })))
      .toEqual({ id: 528, source: 'attr' });

    const withLink = new FakeNode('div', { className: 'bubble' });
    withLink.append(new FakeNode('a', { attrs: { href: 'https://t.me/drivers_pl_by/529' }, text: '14:32' }));
    expect(dom.messageIdFromNode(withLink)).toEqual({ id: 529, source: 'link' });

    const preview = new FakeNode('div', { className: 'tgme_widget_message' });
    preview.append(new FakeNode('a', { attrs: { href: 'https://t.me/s/durov/530' }, text: '14:32' }));
    expect(dom.messageIdFromNode(preview)).toEqual({ id: 530, source: 'link' });

    expect(dom.messageIdFromNode(new FakeNode('div', { className: 'bubble', text: OFFER })))
      .toEqual({ id: null, source: 'none' });
    expect(dom.messageIdFromNode(null)).toEqual({ id: null, source: 'none' });
  });
});

describe('дата сообщения из подписи клиента', () => {
  it('ISO в time[datetime] — с часовым поясом и без', () => {
    expect(dom.parseDomDate('2026-09-12T14:32:00Z', NOW)).toBe(Date.parse('2026-09-12T14:32:00Z'));
    expect(dom.parseDomDate('2026-09-12T14:32:00.000Z', NOW)).toBe(Date.parse('2026-09-12T14:32:00.000Z'));
    expect(dom.parseDomDate('2026-09-12T14:32', NOW)).toBe(new Date(2026, 8, 12, 14, 32).getTime());
    expect(dom.parseDomDate('2026-09-12 14:32', NOW)).toBe(new Date(2026, 8, 12, 14, 32).getTime());
  });

  it('«14:32» — сегодня, а если время ещё не наступило, то вчера', () => {
    expect(dom.parseDomDate('11:30', NOW)).toBe(new Date(2026, 8, 15, 11, 30).getTime());
    expect(dom.parseDomDate('14:32', NOW)).toBe(new Date(2026, 8, 14, 14, 32).getTime());
  });

  it('«вчера» и «позавчера», в том числе со временем', () => {
    expect(dom.parseDomDate('вчера', NOW)).toBe(new Date(2026, 8, 14, 0, 0).getTime());
    expect(dom.parseDomDate('вчера 18:20', NOW)).toBe(new Date(2026, 8, 14, 18, 20).getTime());
    expect(dom.parseDomDate('позавчера', NOW)).toBe(new Date(2026, 8, 13, 0, 0).getTime());
    expect(dom.parseDomDate('yesterday 09:05', NOW)).toBe(new Date(2026, 8, 14, 9, 5).getTime());
  });

  it('числовые и словесные даты, короткие годы', () => {
    expect(dom.parseDomDate('12.09', NOW)).toBe(new Date(2026, 8, 12, 0, 0).getTime());
    expect(dom.parseDomDate('12.09.26', NOW)).toBe(new Date(2026, 8, 12, 0, 0).getTime());
    expect(dom.parseDomDate('12.09.2025', NOW)).toBe(new Date(2025, 8, 12, 0, 0).getTime());
    expect(dom.parseDomDate('12/09 18:40', NOW)).toBe(new Date(2026, 8, 12, 18, 40).getTime());
    expect(dom.parseDomDate('12 сентября', NOW)).toBe(new Date(2026, 8, 12, 0, 0).getTime());
    expect(dom.parseDomDate('5 мая', NOW)).toBe(new Date(2026, 4, 5, 0, 0).getTime());
    expect(dom.parseDomDate('Sep 12', NOW)).toBe(new Date(2026, 8, 12, 0, 0).getTime());
  });

  it('дата без года в будущем — значит, это прошлый год («31.12» в январской ленте)', () => {
    const january = new Date(2026, 0, 15, 12, 0, 0).getTime();
    expect(dom.parseDomDate('31.12', january)).toBe(new Date(2025, 11, 31, 0, 0).getTime());
  });

  it('месяц находится по любому началу слова, мусор — null', () => {
    expect(dom.monthOf('сентября')).toBe(9);
    expect(dom.monthOf('сен.')).toBe(9);
    expect(dom.monthOf('мая')).toBe(5);
    expect(dom.monthOf('sept')).toBe(9);
    expect(dom.monthOf('часов')).toBeNull();
    expect(dom.monthOf('')).toBeNull();
    expect(dom.parseDomDate('', NOW)).toBeNull();
    expect(dom.parseDomDate('без времени', NOW)).toBeNull();
    expect(dom.parseDomDate(null, NOW)).toBeNull();
  });
});

describe('какой чат открыт', () => {
  it('заголовок вкладки чистится от счётчика и приписки Telegram Web', () => {
    expect(dom.cleanDocTitle('(3) Водители Польша–Беларусь — Telegram Web')).toBe('Водители Польша–Беларусь');
    expect(dom.cleanDocTitle('Водители | Telegram Web')).toBe('Водители');
    expect(dom.cleanDocTitle('Telegram Web K: Семейный чат')).toBe('Семейный чат');
    expect(dom.cleanDocTitle('')).toBe('');
  });

  it('Telegram Web K: юзернейм из хэша #@username', () => {
    const root = new FakeNode('div', { className: 'chat-info' })
      .append(new FakeNode('div', { className: 'peer-title', text: 'Водители Польша–Беларусь' }));
    const { doc, location } = fakeDocument(root, 'https://web.telegram.org/k/#@drivers_pl_by');
    expect(dom.readChatInfo(doc, location)).toEqual({
      title: 'Водители Польша–Беларусь',
      username: 'drivers_pl_by',
      id: null,
    });
    expect(core.chatKeyOf(dom.readChatInfo(doc, location))).toBe('web:drivers_pl_by');
  });

  it('Telegram Web A: приватный чат — peer-id из URL, ключ ext:…', () => {
    const root = new FakeNode('div', { className: 'chat-info' })
      .append(new FakeNode('div', { className: 'peer-title', text: 'Семейный чат' }));
    const { doc, location } = fakeDocument(root, 'https://web.telegram.org/a/#/im/p-1001234567890');
    const chat = dom.readChatInfo(doc, location);
    expect(chat).toEqual({ title: 'Семейный чат', username: null, id: '-1001234567890' });
    expect(core.chatKeyOf(chat)).toBe('ext:-1001234567890');
  });

  it('название берётся из заголовка вкладки, если шапки чата в DOM нет', () => {
    const empty = new FakeNode('div');
    const doc = {
      querySelector: (sel: string) => empty.querySelector(sel),
      querySelectorAll: (sel: string) => empty.querySelectorAll(sel),
      title: '(2) Водители Польша–Беларусь — Telegram Web',
    };
    const chat = dom.readChatInfo(doc, { href: 'https://web.telegram.org/k/', hash: '' });
    expect(chat.title).toBe('Водители Польша–Беларусь');
    expect(chat.username).toBeNull();
    expect(core.chatKeyOf(chat)).toMatch(/^ext:\d+$/);
  });

  it('юзернейм виден в шапке чата (@username в .user-status)', () => {
    const root = new FakeNode('div', { className: 'chat-info' })
      .append(
        new FakeNode('div', { className: 'peer-title', text: 'Перевозка вещей' }),
        new FakeNode('div', { className: 'user-status', text: '@perevozka_vei' }),
      );
    const { doc, location } = fakeDocument(root, 'https://web.telegram.org/k/#1234567890');
    const chat = dom.readChatInfo(doc, location);
    expect(chat.username).toBe('perevozka_vei');
    expect(chat.id).toBe('1234567890');
    expect(core.chatKeyOf(chat)).toBe('web:perevozka_vei');
  });
});

describe('harvest: чтение ленты', () => {
  it('основная стратегия Web K: .bubbles .bubble, порядок по возрастанию id', () => {
    const root = bubblesList([
      bubble({ text: 'старое сообщение про посылку из Минска в Брест, +375 29 123 45 67', id: '526', date: '11:30', author: 'Иван Петров' }),
      bubble({ text: CHATTER, id: '527', date: '11:31', author: 'Ольга' }),
      bubble({ text: OFFER, id: '528', date: '11:45', author: 'Сергей @sergei_i' }),
    ]);
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { limit: 30, now: NOW });

    expect(report.unreadable).toBe(false);
    expect(report.strategy).toBe('.bubbles .bubble');
    expect(report.total).toBe(3);
    expect(report.messages.map((m) => m.messageId)).toEqual([526, 527, 528]);
    expect(report.messages.map((m) => m.idSource)).toEqual(['attr', 'attr', 'attr']);
    expect(dom.isReadable(doc)).toBe(true);
  });

  it('автор: имя или @username, но не оба', () => {
    const root = bubblesList([
      bubble({ text: OFFER, id: '1', author: 'Сергей @sergei_i' }),
      bubble({ text: CHATTER, id: '2', author: 'Иван Петров' }),
    ]);
    const { doc } = fakeDocument(root);
    const [first, second] = dom.harvest(doc, { now: NOW }).messages;
    expect(first).toMatchObject({ authorUsername: '@sergei_i', authorName: null });
    expect(second).toMatchObject({ authorUsername: null, authorName: 'Иван Петров' });
  });

  it('дата из time[datetime] и из подписи «11:30»', () => {
    const root = bubblesList([
      bubble({ text: OFFER, id: '1', datetime: '2026-09-12T14:32:00Z' }),
      bubble({ text: CHATTER, id: '2', date: '11:30' }),
    ]);
    const { doc } = fakeDocument(root);
    const msgs = dom.harvest(doc, { now: NOW }).messages;
    expect(msgs[0]!.dateMs).toBe(Date.parse('2026-09-12T14:32:00Z'));
    expect(msgs[0]!.dateRaw).toBe('2026-09-12T14:32:00Z');
    expect(msgs[1]!.dateMs).toBe(new Date(2026, 8, 15, 11, 30).getTime());
  });

  it('сервисные сообщения не собираются (ни по классу, ни по тексту)', () => {
    const root = bubblesList([
      bubble({ text: 'Иван присоединился к группе', id: '10', service: true }),
      bubble({ text: 'Ольга закрепила сообщение', id: '11' }),
      bubble({ text: OFFER, id: '12' }),
    ]);
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { now: NOW });
    expect(report.messages.map((m) => m.messageId)).toEqual([12]);
    expect(report.counts.service).toBe(2);
  });

  it('пустые узлы и повторяющийся текст не плодят кандидатов', () => {
    const root = bubblesList([
      bubble({ text: '', id: '20' }),
      bubble({ text: OFFER, id: '21' }),
      bubble({ text: OFFER.replace(/ /g, '  '), id: '22' }),
    ]);
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { now: NOW });
    expect(report.messages).toHaveLength(1);
    expect(report.counts.no_text).toBe(1);
    expect(report.counts.dup).toBe(1);
  });

  it('limit читает только самые свежие сообщения (ТЗ: не больше ~20 в запросе)', () => {
    const root = bubblesList(Array.from({ length: 10 }, (_, i) =>
      bubble({ text: `сообщение №${i} про посылку из Варшавы в Брест, +48 579 264 25${i}`, id: String(100 + i), date: '10:00' })));
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { limit: 3, now: NOW });
    expect(report.messages).toHaveLength(3);
    expect(report.messages.map((m) => m.messageId)).toEqual([107, 108, 109]);
    expect(report.total).toBe(10);
  });

  it('запасная стратегия: другой клиент, другие классы (.message-text, [data-mid])', () => {
    const root = new FakeNode('div', { className: 'messages' }).append(
      new FakeNode('li', { className: 'message-list-item', attrs: { 'data-mid': '7' } })
        .append(new FakeNode('div', { className: 'message-text', text: OFFER })),
      new FakeNode('li', { className: 'message-list-item', attrs: { 'data-mid': '8' } })
        .append(new FakeNode('div', { className: 'message-text', text: CHATTER })),
    );
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { now: NOW });
    expect(report.strategy).toBe('[data-mid]');
    expect(report.messages.map((m) => m.messageId)).toEqual([7, 8]);
  });

  it('id живёт только в ссылке на сообщение — берём из неё', () => {
    const root = bubblesList([
      bubble({ text: OFFER, permalink: 'https://t.me/drivers_pl_by/528', date: '11:45' }),
    ]);
    const { doc } = fakeDocument(root);
    const [msg] = dom.harvest(doc, { now: NOW }).messages;
    expect(msg!.messageId).toBe(528);
    expect(msg!.idSource).toBe('link');
  });

  it('клиент не отдаёт id → null, core синтезирует устойчивый', () => {
    const root = bubblesList([bubble({ text: OFFER, date: '11:45' })]);
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { now: NOW });
    expect(report.messages[0]!.messageId).toBeNull();
    expect(report.messages[0]!.idSource).toBe('none');
    expect(report.counts.syntheticId).toBe(1);

    const chat = { chatId: 'web:drivers_pl_by' };
    const m = core.toPayloadMessage({ ...report.messages[0]!, chat }, {});
    expect(m.idSource).toBe('synthetic');
    expect(m.messageId).toBeGreaterThan(0);
    // повторный проход по той же ленте даёт тот же id — сервер отловит дубль
    const again = core.toPayloadMessage({ ...dom.harvest(doc, { now: NOW }).messages[0]!, chat }, {});
    expect(again.messageId).toBe(m.messageId);
  });

  it('коллизия id (взяли peerId вместо номера) не схлопывает сообщения в один дубль', () => {
    const root = bubblesList([
      bubble({ text: OFFER, id: '999', date: '11:45' }),
      bubble({ text: 'Передам документы из Кракова в Минск 26.09, @sergei_i', id: '999', date: '11:46' }),
      bubble({ text: CHATTER, id: '1000', date: '11:47' }),
    ]);
    const { doc } = fakeDocument(root);
    const report = dom.harvest(doc, { now: NOW });
    expect(report.counts.idCollision).toBe(2);
    expect(report.messages.map((m) => m.idSource)).toEqual(['collision', 'collision', 'attr']);

    const chat = { chatId: 'web:x' };
    const ids = report.messages.map((m) => core.toPayloadMessage({ ...m, chat }, {}).messageId);
    expect(new Set(ids).size).toBe(3); // три разных id → сервер не посчитает их дублями
  });

  it('незнакомая разметка → unreadable, а не молчаливая работа вхолостую', () => {
    const { doc } = fakeDocument(new FakeNode('div', { className: 'some-new-layout' })
      .append(new FakeNode('section', { className: 'unknown', text: OFFER })));
    const report = dom.harvest(doc, { now: NOW });
    expect(report).toMatchObject({ unreadable: true, strategy: null, total: 0 });
    expect(report.messages).toEqual([]);
    expect(dom.isReadable(doc)).toBe(false);
    expect(core.diagnostic({ unreadable: true, total: 0 })).toContain('НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ');
  });

  it('root можно задать явно (чтение только контейнера ленты)', () => {
    const list = bubblesList([bubble({ text: OFFER, id: '528' })]);
    const page = new FakeNode('div').append(new FakeNode('aside', { text: 'список чатов' }), list);
    const { doc } = fakeDocument(page);
    expect(dom.harvest(doc, { root: list, now: NOW }).messages).toHaveLength(1);
    expect(dom.harvest(doc, { root: page, now: NOW }).messages).toHaveLength(1);
  });
});

describe('сквозной проход: DOM → детект → тело запроса', () => {
  function tab() {
    const root = bubblesList([
      bubble({ text: OFFER, id: '528', datetime: '2026-09-15T11:45:00Z', author: 'Сергей @sergei_i' }),
      bubble({ text: CHATTER, id: '529', datetime: '2026-09-15T11:46:00Z', author: 'Ольга' }),
      bubble({ text: PASSENGER, id: '530', datetime: '2026-09-15T11:47:00Z', author: 'Пётр' }),
      bubble({ text: 'Нужно передать документы из Кракова в Минск 26.09, до 2 кг, @sergei_i', id: '531', datetime: '2026-09-15T11:48:00Z', author: 'Анна' }),
    ]);
    const chatInfo = new FakeNode('div', { className: 'chat-info' })
      .append(new FakeNode('div', { className: 'peer-title', text: 'Водители Польша–Беларусь' }));
    const page = new FakeNode('div').append(chatInfo, root);
    return fakeDocument(page, 'https://web.telegram.org/k/#@drivers_pl_by');
  }

  it('на сервер уходит только похожее на объявление, поля — по контракту', () => {
    const { doc, location } = tab();
    const chat = dom.readChatInfo(doc, location);
    const chatKey = core.chatKeyOf(chat)!;
    expect(chatKey).toBe('web:drivers_pl_by');
    expect(core.matchesWhitelist(chat, ['t.me/drivers_pl_by'])).toBe(true);

    const harvested = dom.harvest(doc, { limit: 30, now: NOW });
    const candidates = harvested.messages
      .map((raw) => core.toPayloadMessage({ ...raw, chat: { ...chat, chatId: chatKey } }, {}))
      .filter((m) => core.detect(m.text, parser, {}).send);

    expect(candidates.map((m) => m.messageId)).toEqual([528, 531]);

    const payload = core.buildPayload(candidates, { collector: core.COLLECTOR });
    expect(payload).toMatchObject({ collector: 'tg-web-ext/1.0.0', dryRun: false });
    expect(payload.messages[0]).toEqual({
      chatId: 'web:drivers_pl_by',
      messageId: 528,
      text: OFFER,
      chatTitle: 'Водители Польша–Беларусь',
      chatUrl: 'https://t.me/drivers_pl_by',
      date: Math.floor(Date.parse('2026-09-15T11:45:00Z') / 1000),
      authorUsername: '@sergei_i',
    });
    // пустые поля в тело не добавляются: authorName тут null
    expect(payload.messages[0]).not.toHaveProperty('authorName');
  });

  it('чат не из белого списка: сообщения не читаются вовсе', () => {
    const { doc, location } = tab();
    const chat = dom.readChatInfo(doc, location);
    expect(core.matchesWhitelist(chat, ['Другой чат'])).toBe(false);
    expect(core.matchesWhitelist(chat, [])).toBe(false);
    // сборщик в этом случае даже не вызывает harvest — проверяем сам факт отказа
    expect(dom.harvest(doc, { now: NOW }).messages.length).toBeGreaterThan(0);
  });

  it('второй проход по той же ленте ничего нового не находит (локальный лог)', () => {
    const { doc, location } = tab();
    const chat = dom.readChatInfo(doc, location);
    const chatKey = core.chatKeyOf(chat)!;

    const pass = () => dom.harvest(doc, { limit: 30, now: NOW }).messages
      .map((raw) => core.toPayloadMessage({ ...raw, chat: { ...chat, chatId: chatKey } }, {}))
      .filter((m) => core.detect(m.text, parser, {}).send);

    const first = pass();
    expect(first).toHaveLength(2);

    const sentLog = first.map((m) => core.sentKey(m.chatId, m.messageId));
    expect(core.filterUnsent(pass(), sentLog)).toEqual([]);

    // сервер ответил успешно — эти ключи добавляются в лог из summary
    const response = {
      summary: { received: 2, created: 1, duplicate: 1, skipped: 0, invalid: 0, listings: 1 },
      results: [
        { chatId: chatKey, messageId: 528, status: 'created' },
        { chatId: chatKey, messageId: 531, status: 'duplicate', listingId: 'l-1' },
      ],
    };
    const summary = core.summarizeResponse(response);
    expect(summary.sentKeys).toEqual(sentLog);
    expect(core.mergeCounters({}, { sent: 2, created: summary.created, duplicate: summary.duplicate }))
      .toMatchObject({ sent: 2, created: 1, duplicate: 1 });
  });
});
