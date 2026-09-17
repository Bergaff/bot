/**
 * Автообход чатов и румов.
 *
 * У пользователя 8+ целей (румы форум-чата travelersminsk, belgranica,
 * granica_es, granica_bypl) и дальше — другие направления. Переключать чаты
 * руками и ждать он не хочет: расширение должно САМО открывать чаты из белого
 * списка, читать их, ждать случайную паузу и идти дальше.
 *
 * Границы, которые здесь закреплены:
 *   · обход только читает — ни отправки, ни печати, ни реакций;
 *   · темп человеческий: случайная пауза, несколько проходов на чат, предел
 *     переходов в час и «не мешать», пока пользователь сам работает во вкладке;
 *   · пауза/выключение — мгновенные;
 *   · если чат не открылся, обход пишет об этом и идёт дальше, а не молчит;
 *   · дедупликация по (chatId, messageId) работает и на втором круге;
 *   · ссылка на сообщение сохраняет рум: t.me/<чат>/<рум>/<сообщение>.
 *
 * В мини-браузере переход выглядит как в жизни: контент-скрипт пишет в
 * location.hash, а «вкладка» подменяет ленту на страницу этого чата. Паузы
 * двигаются виртуальными часами (advance), чтобы тесты не ждали минуты.
 */
import { describe, expect, it } from 'vitest';
import { core, dom } from './helpers/ext';
import { FakeNode, bubble, bubblesList } from './helpers/fake-dom';
import { FakeBrowser, minutesAgoIso } from './helpers/fake-browser';

/* ------------------------------------------------------------------ */
/* Цели и «страницы» чатов                                             */
/* ------------------------------------------------------------------ */

const OFFER_ROOM_1 = '25.09 Минск — Варшава, возьму посылку до 20 кг, +48 579 264 254';
const OFFER_ROOM_2 = '26.09 Брест — Варшава, везу документы, пишу в @anna_k';
const OFFER_BORDER = '27.09 Гродно — Белосток, есть место под 5 кг, +375 29 1234567';
const CHATTER_1 = 'Всем привет! Как дела?';
const CHATTER_2 = 'Спасибо, всё получил!';

/** Лента чата/рума: шапка (имя чата и рум) + сообщения с id, как в Telegram Web K. */
function chatPage(
  title: string,
  topic: string | null,
  messages: Array<{ id: string; text: string; author?: string }>,
): FakeNode {
  const info = new FakeNode('div', { className: 'chat-info' })
    .append(new FakeNode('div', { className: 'peer-title', text: title }));
  if (topic) info.append(new FakeNode('div', { className: 'topic-title', text: topic }));
  const list = bubblesList(messages.map((m) => bubble({
    text: m.text,
    id: m.id,
    datetime: minutesAgoIso(30),
    author: m.author ?? 'Участник',
  })));
  return new FakeNode('div', { className: 'page' }).append(info, list);
}

/** Три цели: два рума одного форум-чата и отдельный чат границы. */
const PAGES: Record<string, FakeNode> = {
  '#travelersminsk/1': chatPage('Посылки и попутчики', 'Общий', [
    { id: '1001', text: OFFER_ROOM_1, author: 'Сергей @sergei_i' },
    { id: '1002', text: CHATTER_1, author: 'Ольга' },
  ]),
  '#travelersminsk/91529': chatPage('Посылки и попутчики', 'Очередь BY-PL', [
    { id: '713464', text: OFFER_ROOM_2, author: 'Анна' },
    { id: '713465', text: CHATTER_2, author: 'Пётр' },
  ]),
  '#belgranica': chatPage('Граница', null, [
    { id: '528', text: OFFER_BORDER, author: 'Виктор @vikt_or' },
  ]),
};

const WHITELIST = ['t.me/travelersminsk/1', 't.me/travelersminsk/91529', 't.me/belgranica'];

/** Вкладка с включённым обходом: пауза 10 с, один проход на чат. */
async function walkBrowser(extra: Record<string, unknown> = {}, pages: Record<string, FakeNode> = PAGES) {
  const first = Object.keys(pages)[0] ?? '#belgranica';
  return new FakeBrowser({
    url: `https://web.telegram.org/k/${first}`,
    page: pages[first],
    pages,
    fakeClock: true,
    settings: Object.assign({
      whitelist: WHITELIST,
      autoWalk: true,
      walkReadsPerChat: 1,
      walkMinSec: 10,
      walkMaxSec: 10,
      walkMaxPerHour: 20,
      confirmMode: false,
      intervalSec: 60,
    }, extra),
  }).ready();
}

/** Довести обход до следующего чата: кончилась пауза → переход → чтение. */
async function nextChat(b: FakeBrowser, pauseMs = 10_000): Promise<void> {
  b.advance(pauseMs);
  await b.tick();          // такт перехода (адрес вкладки меняется)
  await b.tick();          // такт чтения нового чата
}

/**
 * Дождать конца долгого такта: ожидание «дорисовался ли чат» опрашивает вкладку
 * до 30 раз по 500 мс, а один flush() — это 12 оборотов цикла событий.
 */
async function settle(b: FakeBrowser): Promise<void> { await b.flush(80); }

/** Тела всех отправок: какие сообщения и из какого чата/рума ушли на сервер. */
function sentMessages(b: FakeBrowser): Array<{ chatId: string; messageId: number; topicId: number | null }> {
  return b.ingestCalls.flatMap((call) => {
    const body = JSON.parse(call.init.body);
    return body.messages.map((m: any) => ({
      chatId: m.chatId, messageId: m.messageId, topicId: m.topicId ?? null,
    }));
  });
}

/** Пермалинки из журнала разбора — их пользователь копирует, чтобы переслать вручную. */
function journalLinks(b: FakeBrowser): Array<string | null> {
  return (b.saved().recent ?? []).map((r: any) => r.link ?? null);
}

/* ------------------------------------------------------------------ */
/* План обхода: чистая логика (core.js)                                */
/* ------------------------------------------------------------------ */

describe('план автообхода', () => {
  it('белый список превращается в порядок обхода: румы, чаты, приватные — без повторов', () => {
    const plan = core.walkTargets([
      'https://t.me/travelersminsk/1',
      't.me/travelersminsk/91529',
      'https://t.me/belgranica/174591',
      'https://t.me/granica_es',
      'https://t.me/s/travelersminsk/91529',   // тот же рум, записанный иначе
      'https://t.me/c/1234567890/7',
    ]);
    expect(plan.map((t: any) => t.label)).toEqual([
      'travelersminsk/1',
      'travelersminsk/91529',
      'belgranica/174591',
      'granica_es',
      'приватный чат -1001234567890, рум 7',
    ]);
    expect(plan[0]).toMatchObject({ kind: 'username', value: 'travelersminsk', topicId: 1 });
    expect(plan[4]).toMatchObject({ kind: 'peer', value: '-1001234567890', topicId: 7, chatKey: 'ext:-1001234567890' });
  });

  it('цель «по названию» остаётся в плане: её откроем кликом по списку чатов', () => {
    const plan = core.walkTargets(['Граница BY-PL :: Очередь']);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'title', value: 'граница by-pl', topic: 'очередь' });
    // адреса для такой цели нет ни в Web K, ни в Web A — остаётся клик
    expect(core.walkHashFor(plan[0], { href: 'https://web.telegram.org/k/#@x' })).toBeNull();
    expect(core.walkHashFor(plan[0], { href: 'https://web.telegram.org/a/#/im?p=@x' })).toBeNull();
  });

  it('адрес вкладки строится под клиент: Web K — #чат/рум, Web A — #/im?p=…, приватный — #-100…', () => {
    const plan = core.walkTargets(['t.me/travelersminsk/91529', 't.me/granica_es', 't.me/c/1234567890/7']);
    const webK = { href: 'https://web.telegram.org/k/#@granica_es' };
    const webA = { href: 'https://web.telegram.org/a/#/im?p=@granica_es' };

    expect(core.walkHashFor(plan[0], webK)).toBe('#travelersminsk/91529');
    expect(core.walkHashFor(plan[1], webK)).toBe('#granica_es');
    expect(core.walkHashFor(plan[2], webK)).toBe('#-1001234567890/7');

    expect(core.walkHashFor(plan[1], webA)).toBe('#/im?p=@granica_es');
    expect(core.walkHashFor(plan[2], webA)).toBe('#/im?p=g1234567890_7');
    // рум по адресу Web A не открывается — обход пойдёт кликом по списку чатов
    expect(core.walkHashFor(plan[0], webA)).toBeNull();
    // не клиент Telegram Web — ничего не выдумываем
    expect(core.walkHashFor(plan[0], { href: 'https://example.com/' })).toBeNull();
    expect(core.walkHashFor(plan[0], null)).toBeNull();
  });

  it('пауза случайная и в заданных границах; переходы старше часа не считаются', () => {
    const pauses = Array.from({ length: 40 }, () => core.walkPauseMs(60, 240));
    expect(Math.min(...pauses)).toBeGreaterThanOrEqual(60_000);
    expect(Math.max(...pauses)).toBeLessThanOrEqual(240_000);
    expect(new Set(pauses).size).toBeGreaterThan(5);           // не одна и та же цифра
    expect(core.walkPauseMs(300, 60)).toBeGreaterThanOrEqual(60_000);  // перепутали местами

    const now = Date.now();
    expect(core.walkSwitchesInHour([now - 3_600_001, now - 60_000, now], now)).toHaveLength(2);
    expect(core.walkSwitchesInHour([], now)).toEqual([]);
    expect(core.walkSwitchesInHour(null as any, now)).toEqual([]);
  });

  it('открытый чат находится в плане: обход продолжает с него, а не «с начала»', () => {
    const plan = core.walkTargets(WHITELIST);
    expect(core.walkIndexForChat(plan, { username: 'travelersminsk', topicId: 91529 })).toBe(1);
    expect(core.walkIndexForChat(plan, { username: 'belgranica', topicId: null })).toBe(2);
    expect(core.walkIndexForChat(plan, { username: 'durov', topicId: null })).toBe(-1);
    expect(core.walkIndexForChat(plan, null)).toBe(-1);
    // рум не тот — это другая цель, даже если чат знакомый
    expect(core.walkIndexForChat(plan, { username: 'travelersminsk', topicId: 7 })).toBe(-1);
  });

  it('цель, которая не открылась, пропускается до конца круга', () => {
    const plan = core.walkTargets(['t.me/travelersminsk/1', 't.me/granica_es', 't.me/belgranica']);
    expect(plan.map((t: any) => t.label)).toEqual(['travelersminsk/1', 'granica_es', 'belgranica']);

    expect(core.walkNextIndex(plan, 0, [])).toBe(1);                       // просто следующая
    expect(core.walkNextIndex(plan, 0, ['granica_es'])).toBe(2);           // проваленную пропускаем
    expect(core.walkNextIndex(plan, 1, ['granica_es', 'belgranica'])).toBe(0);
    expect(core.walkNextIndex(plan, 0, ['travelersminsk/1', 'granica_es', 'belgranica'])).toBe(1);  // всё провалено — пробуем снова
    expect(core.walkNextIndex(plan, 2, [])).toBe(0);                       // по кругу
    expect(core.walkNextIndex([], 0, [])).toBe(0);
  });

  it('решение обхода: пауза, «не мешать», предел в час, чтение и переход', () => {
    const plan = core.walkTargets(WHITELIST);
    const settings = core.withDefaults({ autoWalk: true });
    const state = (over: Record<string, unknown> = {}) => Object.assign({
      plan, index: 0, reads: 0, nextAt: 0, switching: false, switches: [], lastUserActivity: 0, now: 1_000_000,
    }, over);

    expect(core.walkDecision(state(), core.withDefaults({ autoWalk: false }))).toMatchObject({ action: 'off' });
    expect(core.walkDecision(state({ plan: [] }), settings)).toMatchObject({ action: 'idle', reason: 'empty' });
    // переход уже сделан — ждём, пока чат дорисуется
    expect(core.walkDecision(state({ switching: true }), settings)).toMatchObject({ action: 'wait-load' });
    expect(core.walkDecision(state({ nextAt: 1_060_000 }), settings)).toMatchObject({ action: 'wait', reason: 'pause' });
    expect(core.walkDecision(state({ lastUserActivity: 999_990 }), settings)).toMatchObject({ action: 'wait', reason: 'user' });
    expect(core.walkDecision(
      state({ switches: Array.from({ length: 20 }, (_, i) => 1_000_000 - i * 1000) }),
      settings,
    )).toMatchObject({ action: 'wait', reason: 'limit' });
    // не дочитали чат — читаем ещё раз, без перехода
    expect(core.walkDecision(state({ reads: 1 }), settings)).toMatchObject({ action: 'read' });
    // дочитали — переходим к следующей цели
    expect(core.walkDecision(state({ reads: settings.walkReadsPerChat }), settings)).toMatchObject({
      action: 'navigate', index: 1,
    });
    // последняя цель — по кругу снова первая
    expect(core.walkDecision(state({ index: 2, reads: settings.walkReadsPerChat }), settings)).toMatchObject({
      action: 'navigate', index: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Поиск строки чата в боковой панели (запасной путь обхода)           */
/* ------------------------------------------------------------------ */

describe('строка чата в списке (когда адрес не сработал)', () => {
  function sidebar(rows: Array<{ title: string; clickable: boolean }>) {
    const list = new FakeNode('div', { className: 'chatlist' });
    for (const r of rows) {
      const row = new FakeNode('div', { className: 'chatlist-chat' })
        .append(new FakeNode('div', { className: 'peer-title', text: r.title }));
      if (r.clickable) row.addEventListener('click', () => { row.attrs['data-opened'] = 'yes'; });
      list.append(row);
    }
    return new FakeNode('div').append(list);
  }

  it('находит рум по имени, чужие чаты не трогает', () => {
    const doc = sidebar([
      { title: 'Посылки и попутчики', clickable: true },
      { title: 'Очередь BY-PL', clickable: true },
      { title: 'Граница', clickable: true },
    ]);
    expect(dom.findChatRow(doc, ['очередь by-pl', 'travelersminsk/91529'])?.title).toBe('очередь by-pl');
    expect(dom.findChatRow(doc, ['граница'])?.title).toBe('граница');
    expect(dom.findChatRow(doc, ['нет такого чата'])).toBeNull();
    expect(dom.findChatRow(doc, [])).toBeNull();
  });

  it('клик по строке открывает чат — обход пользуется этим, когда адреса нет', () => {
    const doc = sidebar([{ title: 'Очередь BY-PL', clickable: true }]);
    const row = dom.findChatRow(doc, ['очередь by-pl']);
    expect(row).toBeTruthy();
    (row!.node as FakeNode).dispatch('click');
    expect((row!.node as FakeNode).attrs['data-opened']).toBe('yes');
  });
});

/* ------------------------------------------------------------------ */
/* Обход в «живой» вкладке                                             */
/* ------------------------------------------------------------------ */

describe('автообход в вкладке Telegram Web', () => {
  it('сам открывает румы и чаты по кругу и шлёт находки с румом в ссылке', async () => {
    const b = await walkBrowser();
    await b.firstTick();

    // первая цель уже открыта — просто читаем
    expect(b.hashChanges).toEqual([]);
    expect(sentMessages(b)).toEqual([
      { chatId: 'web:travelersminsk', messageId: 1001, topicId: 1 },
    ]);
    // ссылка на найденное — с румом, чтобы открыть и переслать вручную
    expect(journalLinks(b)).toContain('https://t.me/travelersminsk/1/1001');

    await nextChat(b);
    await settle(b);
    expect(b.hashChanges).toEqual(['#travelersminsk/91529']);
    expect(sentMessages(b)[1]).toEqual({ chatId: 'web:travelersminsk', messageId: 713464, topicId: 91529 });
    expect(journalLinks(b)).toContain('https://t.me/travelersminsk/91529/713464');

    await nextChat(b);
    expect(b.hashChanges).toEqual(['#travelersminsk/91529', '#belgranica']);
    expect(sentMessages(b)[2]).toEqual({ chatId: 'web:belgranica', messageId: 528, topicId: null });
    expect(journalLinks(b)).toContain('https://t.me/belgranica/528');

    // круг замкнулся: снова первый рум, и старое НЕ уходит повторно
    await nextChat(b);
    await settle(b);
    expect(b.hashChanges).toEqual(['#travelersminsk/91529', '#belgranica', '#travelersminsk/1']);
    expect(sentMessages(b)).toHaveLength(3);
    expect(sentMessages(b).map((m) => m.chatId)).toEqual(['web:travelersminsk', 'web:travelersminsk', 'web:belgranica']);
    expect(b.panelText()).toContain('дублей');
  });

  it('болтовня не уходит на сервер, а в журнале обхода видно каждый переход', async () => {
    const b = await walkBrowser();
    await b.firstTick();
    await nextChat(b);

    expect(sentMessages(b).map((m) => m.messageId)).toEqual([1001, 713464]);   // болтовня отсечена детектом
    const text = b.panelText();
    expect(text).toContain('Обход чатов: включён');
    expect(text).toContain('travelersminsk/91529');
    expect(text).toContain('✔ открыт');
    expect(text).toContain('→ переход');

    const walk = b.saved().walk!;
    expect(walk.index).toBe(1);
    expect(walk.log.map((r: any) => r.label)).toContain('travelersminsk/91529');
  });

  it('пауза случайная: до её конца чат не переключается, после — переключается', async () => {
    const b = await walkBrowser({ walkReadsPerChat: 2, walkMinSec: 60, walkMaxSec: 240 });
    await b.firstTick();
    expect(sentMessages(b)).toHaveLength(1);

    // второй проход того же чата — перехода нет, пауза ещё не назначена
    await b.advance(61_000).tick();
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).toContain('проход 2 из 2');

    // чат дочитан: ждём случайную паузу (60–240 с)
    await b.advance(30_000).tick();
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).toMatch(/Пауза перед переходом: \d+ с/);

    await b.advance(220_000).tick();
    expect(b.hashChanges).toEqual(['#travelersminsk/91529']);
  });

  it('«не мешать»: пока пользователь во вкладке, обход не вырывает чат', async () => {
    const b = await walkBrowser({ walkIdleGuardSec: 45 });
    await b.firstTick();                 // рум прочитан, назначена пауза 10 с

    b.userTouches('mousedown');          // пользователь кликнул во вкладке
    await b.advance(10_000).tick();      // пауза кончилась, но человек работает
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).toContain('Вы сами работаете во вкладке');

    b.advance(20_000).userTouches('keydown');   // снова что-то печатает
    await b.tick();
    expect(b.hashChanges).toEqual([]);

    b.advance(46_000);                   // 46 с тишины — guard (45 с) прошёл
    await b.tick();
    expect(b.hashChanges).toEqual(['#travelersminsk/91529']);
  });

  it('предел переходов в час: обход встаёт и пишет почему', async () => {
    const b = await walkBrowser({ walkMaxPerHour: 2 });
    await b.firstTick();
    await nextChat(b);                   // переход 1
    await nextChat(b);                   // переход 2 — предел
    expect(b.hashChanges).toHaveLength(2);

    await b.advance(10_000).tick();
    expect(b.hashChanges).toHaveLength(2);
    expect(b.panelText()).toContain('Предел переходов в час (2) достигнут');
    expect(b.panelText()).toContain('переходов за час');

    // через час окно очистилось — обход снова идёт
    b.advance(3_600_000);
    await b.tick();
    expect(b.hashChanges.length).toBeGreaterThan(2);
  });

  it('чат не открылся — обход не молчит: запись в журнале и переход к следующей цели', async () => {
    // granica_es в белом списке есть, а вкладка его не открыла (нет доступа,
    // клиент не понял адрес): «страницы» для такого хэша в мини-браузере нет
    const b = await walkBrowser({
      whitelist: ['t.me/travelersminsk/1', 't.me/granica_es', 't.me/belgranica'],
    });
    await b.firstTick();
    await b.advance(10_000).tick();      // пытаемся открыть granica_es
    await settle(b);
    expect(b.hashChanges).toEqual(['#granica_es']);

    await b.tick();                      // 15 с ожидания, клик не нашёлся → пропускаем
    await settle(b);
    const text = b.panelText();
    expect(text).toContain('✖ не открылся');
    expect(text).toContain('не открылся за 15 с — пропускаю');
    // адрес вкладки вернули: клиент не переключился, и «врущий» hash привёл бы
    // к тому, что сообщения прежнего чата ушли бы под именем granica_es
    expect(b.hashChanges).toEqual(['#granica_es', '#travelersminsk/1']);
    expect(sentMessages(b).map((m) => m.chatId)).toEqual(['web:travelersminsk']);

    await b.advance(10_000).tick();      // прежний чат перечитан (дубли не уходят)
    expect(sentMessages(b).map((m) => m.messageId)).toEqual([1001]);

    await b.advance(10_000).tick();      // дальше по плану — сразу belgranica
    await b.tick();
    await settle(b);
    expect(b.hashChanges).toEqual(['#granica_es', '#travelersminsk/1', '#belgranica']);
    expect(sentMessages(b).map((m) => m.messageId)).toEqual([1001, 528]);
    expect(sentMessages(b).map((m) => m.chatId)).toEqual(['web:travelersminsk', 'web:belgranica']);
  });

  it('пауза и выключение обхода действуют сразу', async () => {
    const b = await walkBrowser();
    await b.firstTick();

    // «Пауза» в панели — обход стоит, чаты не переключаются
    await b.click('Пауза');
    await b.advance(10_000).tick();
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).toContain('пауза');
    expect(b.saved().settings?.paused).toBe(true);

    await b.click('Продолжить');
    await b.tick();
    await b.tick();
    expect(b.hashChanges).toEqual(['#travelersminsk/91529']);

    // кнопкой панели выключаем обход вовсе: расширение читает только открытый чат
    await b.click('Обход: выключить');
    const before = b.hashChanges.length;
    await b.advance(300_000).tick();
    await b.tick();
    expect(b.hashChanges).toHaveLength(before);
    expect(b.panelText()).toContain('Обход чатов: выключен');
    expect(b.saved().settings?.autoWalk).toBe(false);
  });

  it('обход включается кнопкой панели и стартует с открытого чата', async () => {
    const b = await walkBrowser({ autoWalk: false });
    await b.firstTick();
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).not.toContain('Обход чатов: включён');

    await b.click('Обход: включить');
    expect(b.saved().settings?.autoWalk).toBe(true);
    expect(b.panelText()).toContain('Обход чатов: включён');
    expect(b.panelText()).toContain('сейчас');
    expect(b.panelText()).toContain('travelersminsk/1');   // стартуем с открытого чата

    await b.advance(10_000).tick();      // прочитали открытый чат
    expect(b.panelText()).toMatch(/проход 1 из \d/);
    expect(b.panelText()).toContain('уже отправляли');   // перечитанный чат не дублируется
    await b.advance(10_000).tick();      // пауза кончилась — переход
    await b.tick();                      // чтение новой цели
    await settle(b);
    expect(b.hashChanges).toEqual(['#travelersminsk/91529']);
  });

  it('пользователь сам открыл чат из списка — обход продолжает с него', async () => {
    const b = await walkBrowser();
    await b.firstTick();

    // «человек» перешёл в belgranica руками
    (b as any).context.location.hash = '#belgranica';
    await b.flush();
    await b.tick();
    expect(sentMessages(b).map((m) => m.messageId)).toEqual([1001, 528]);
    expect(b.saved().walk!.index).toBe(2);

    await nextChat(b);                   // дальше — по кругу, снова первый рум
    await settle(b);
    expect(b.hashChanges).toEqual(['#belgranica', '#travelersminsk/1']);
  });

  it('перезагрузка вкладки не сбрасывает обход: продолжаем с той же цели', async () => {
    const b = await walkBrowser();
    await b.firstTick();
    await nextChat(b);
    const saved = b.saved();
    expect(saved.walk!.index).toBe(1);

    // та же вкладка, тот же localStorage — контент-скрипт запустился заново
    const again = await new FakeBrowser({
      url: 'https://web.telegram.org/k/#travelersminsk/91529',
      page: PAGES['#travelersminsk/91529'],
      pages: PAGES,
      fakeClock: true,
      stored: { settings: saved.settings, walk: saved.walk, sentKeys: saved.sentKeys },
      settings: { whitelist: WHITELIST, autoWalk: true, walkReadsPerChat: 1, walkMinSec: 10, walkMaxSec: 10, confirmMode: false },
    }).ready();
    await again.firstTick();

    // обход продолжил со второй цели, а не начал план заново
    expect(again.saved().walk!.index).toBe(1);
    await again.advance(60_000).tick();
    await again.tick();
    expect(again.hashChanges).toEqual(['#belgranica']);
    expect(sentMessages(again).map((m) => m.messageId)).toEqual([528]);
    // журнал переходов пережил перезагрузку
    expect(again.saved().walk!.log.length).toBeGreaterThan(0);
  });

  it('отметка для панели несёт, где обход сейчас и что он делал', async () => {
    const b = await walkBrowser();
    await b.firstTick();
    await nextChat(b);
    const beat = b.lastHeartbeat();
    expect(beat.walk).toMatchObject({ on: true, plan: 3, current: 'travelersminsk/91529', next: 'belgranica' });
    expect(beat.walk.reads).toBe(1);
    expect(beat.walk.switchesHour).toBe(1);
    expect(beat.walk.log.length).toBeGreaterThan(0);
    // обход НЕ отправляет сообщений: только отметка и приём находок
    expect(beat.chat).toMatchObject({ username: 'travelersminsk', topicId: 91529, whitelisted: true });
  });

  it('настройки обхода приходят с сервера вместе с белым списком', async () => {
    const b = await walkBrowser({ autoWalk: false });
    b.setRoute('/api/extension/config', {
      status: 200,
      body: {
        ok: true,
        config: {
          whitelist: ['t.me/travelersminsk/1', 't.me/travelersminsk/91529', 't.me/belgranica'],
          intervalSec: 60, paused: false, autoWalk: true,
          walkReadsPerChat: 3, walkMinSec: 90, walkMaxSec: 300, walkMaxPerHour: 12,
        },
      },
    });
    await b.firstTick();
    const s = b.saved().settings!;
    expect(s.autoWalk).toBe(true);
    expect(s.walkReadsPerChat).toBe(3);
    expect(s.walkMinSec).toBe(90);
    expect(s.walkMaxSec).toBe(300);
    expect(s.walkMaxPerHour).toBe(12);
    expect(b.panelText()).toContain('проход 1 из 3');
  });

  it('пустой белый список — обход честно пишет, что обходить нечего', async () => {
    const b = await walkBrowser({ whitelist: [] });
    await b.firstTick();
    expect(b.hashChanges).toEqual([]);
    expect(b.panelText()).toContain('Белый список пуст — обходить нечего.');
  });
});
