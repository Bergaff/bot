/**
 * Тесты чистой логики клиентской части (этап 3 ТЗ): extension/core.js.
 *
 * Проверяем то, что можно проверить без браузера: диапазоны настроек,
 * белый список чатов, ключи chatId, клиентский детект (тот же src/parser.ts,
 * что и на сервере), локальную дедупликацию, батчи, backoff, классификацию
 * ошибок HTTP и точное соответствие тела запроса контракту POST /api/ingest.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as parser from '../src/parser';
import { core } from './helpers/ext';
import type { ChatRef, PayloadMessage } from './helpers/ext';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();

const OFFER = '25.09 Варшава — Брест, возьму посылку до 20 кг, +48 579 264 254';
const REQUEST = 'Нужно передать документы из Кракова в Минск завтра, до 2 кг, @sergei_i';
const CHATTER = 'Всем привет! Как дела? Кто сегодня в чате?';
const PASSENGER = 'Кто подвезёт пассажира из Гродно в Минск сегодня вечером?';
const NO_CONTACT = 'Завтра еду Варшава — Брест, возьму посылку до 20 кг, пишите в личку';
const SERVICE = 'Иван присоединился к группе';

describe('настройки: с дефолтами и валидацией диапазонов', () => {
  it('дефолты соответствуют ТЗ: 120 с, батч 20, подтверждение включено', () => {
    const s = core.withDefaults({});
    expect(s.intervalSec).toBe(120);
    expect(s.batchSize).toBe(20);
    expect(s.maxPerChat).toBe(30);
    expect(s.confirmMode).toBe(true);
    expect(s.paused).toBe(false);
    expect(s.whitelist).toEqual([]);
    expect(core.COLLECTOR).toMatch(/^tg-web-ext\/\d+\.\d+\.\d+$/);
  });

  it('интервал опроса не выходит за 60–600 с (ТЗ п. 4.5)', () => {
    expect(core.withDefaults({ intervalSec: 5 }).intervalSec).toBe(60);
    expect(core.withDefaults({ intervalSec: 99999 }).intervalSec).toBe(600);
    expect(core.withDefaults({ intervalSec: 180 }).intervalSec).toBe(180);
  });

  it('батч ограничен сверху 100 (предел сервера), maxPerChat — 200', () => {
    expect(core.withDefaults({ batchSize: 500 }).batchSize).toBe(100);
    expect(core.withDefaults({ batchSize: '50' }).batchSize).toBe(50);
    expect(core.withDefaults({ maxPerChat: 500 }).maxPerChat).toBe(200);
  });

  it('нечисловые и пустые значения откатываются к дефолтам', () => {
    const s = core.withDefaults({ intervalSec: 'быстро', batchSize: 0, maxAgeHours: null });
    expect(s.intervalSec).toBe(120);
    expect(s.batchSize).toBe(20);
    expect(s.maxAgeHours).toBe(72);
  });

  it('URL без хвостовых слэшей, токен и белый список чистятся', () => {
    const s = core.withDefaults({
      serverUrl: '  https://pop-utka.app///  ',
      token: '  secret-token \n',
      whitelist: ['Чат водителей', '', '   ', 42, null, 't.me/pl_by'],
    });
    expect(s.serverUrl).toBe('https://pop-utka.app');
    expect(s.token).toBe('secret-token');
    expect(s.whitelist).toEqual(['Чат водителей', 't.me/pl_by']);
  });

  it('флаги приводятся строго к boolean (paused по умолчанию выключен)', () => {
    expect(core.withDefaults({ paused: 'yes' }).paused).toBe(false);
    expect(core.withDefaults({ paused: true }).paused).toBe(true);
    expect(core.withDefaults({ confirmMode: 0 }).confirmMode).toBe(true);
    expect(core.withDefaults({ confirmMode: false }).confirmMode).toBe(false);
    expect(core.withDefaults({ requireContact: true }).requireContact).toBe(true);
  });
});

describe('адрес сервера: https всегда, http — только локально', () => {
  it('https принимается (прод, workers.dev, демо-песочница)', () => {
    for (const url of ['https://pop-utka.app', 'https://8790-abc123.e2b.app', 'https://parcel.poputchka.workers.dev']) {
      expect(core.serverUrlProblem(url)).toBeNull();
    }
  });

  it('локальный http для отладки принимается', () => {
    for (const url of ['http://127.0.0.1:8790', 'http://localhost:8787', 'http://127.0.0.1']) {
      expect(core.serverUrlProblem(url)).toBeNull();
    }
  });

  it('пусто — понятная просьба указать адрес', () => {
    expect(core.serverUrlProblem('')).toContain('Укажите базовый URL сервера');
    expect(core.serverUrlProblem('   ')).toContain('Укажите базовый URL сервера');
  });

  it('обычный http отклоняется: страница Telegram Web открыта по https', () => {
    for (const url of ['http://pop-utka.app', 'http://192.168.1.10:8790', 'pop-utka.app', 'ftp://x']) {
      const err = core.serverUrlProblem(url);
      expect(err).toContain('https://');
      expect(err).toContain('mixed content');
    }
  });
});

describe('белый список чатов: всё остальное не читается вовсе', () => {
  it('ссылка, @username и название — три способа задать чат', () => {
    expect(core.normalizeWhitelist(['https://t.me/s/drivers_pl_by', '@Drivers_PL_BY', 'Водители Польша–Беларусь']))
      .toEqual([
        { kind: 'username', value: 'drivers_pl_by' },
        { kind: 'username', value: 'drivers_pl_by' },
        { kind: 'title', value: 'водители польша-беларусь' },
      ]);
  });

  it('пустой белый список — ничего не собираем (защита от лишнего чтения)', () => {
    expect(core.matchesWhitelist({ title: 'Водители', username: 'drivers_pl_by' }, [])).toBe(false);
    expect(core.matchesWhitelist({ title: 'Водители' }, undefined)).toBe(false);
  });

  it('совпадение по юзернейму, по названию и по подстроке', () => {
    const wl = ['t.me/drivers_pl_by'];
    expect(core.matchesWhitelist({ username: 'drivers_pl_by', title: 'Какой-то заголовок' }, wl)).toBe(true);
    expect(core.matchesWhitelist({ username: 'other_chat' }, wl)).toBe(false);
    expect(core.matchesWhitelist({ title: 'Водители Польша-Беларусь' }, ['Водители Польша–Беларусь'])).toBe(true);
    expect(core.matchesWhitelist({ title: 'Польша' }, ['Водители Польша–Беларусь'])).toBe(true);
  });

  it('ё/е и регистр не мешают совпадению названия', () => {
    expect(core.matchesWhitelist({ title: 'ПОСЫЛКИ   Гродно' }, ['посылки гродно'])).toBe(true);
    expect(core.matchesWhitelist({ title: 'Перевозка вещей' }, ['перевозка вешей'])).toBe(false);
    expect(core.squashTitle('  Ёлки   Палки ')).toBe('елки палки');
  });

  it('название чата, содержащее юзернейм из списка, тоже проходит', () => {
    expect(core.matchesWhitelist({ title: 'drivers_pl_by • Водители' }, ['@drivers_pl_by'])).toBe(true);
  });
});

describe('chatId: один ключ на публичный чат у серверного сборщика и у расширения', () => {
  it('публичный чат → web:<username> (совпадает с ключом collect.ts)', () => {
    expect(core.chatKeyOf({ username: 'drivers_pl_by', title: 'Водители' })).toBe('web:drivers_pl_by');
    expect(core.chatKeyOf({ username: '@drivers_pl_by' })).toBe('web:drivers_pl_by');
  });

  it('приватный чат → ext:<peer-id>, иначе ext:<хэш названия>', () => {
    expect(core.chatKeyOf({ id: '-1001234567890' })).toBe('ext:-1001234567890');
    expect(core.chatKeyOf({ title: 'Семейный чат' })).toMatch(/^ext:\d+$/);
    expect(core.chatKeyOf(null)).toBeNull();
    expect(core.chatKeyOf({})).toBeNull();
  });

  it('ключ по названию детерминирован и различается для разных чатов', () => {
    const a = core.chatKeyOf({ title: 'Семейный чат' });
    const b = core.chatKeyOf({ title: 'семейный  чат' });
    const c = core.chatKeyOf({ title: 'Рабочий чат' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('синтетический messageId (когда DOM не отдаёт числовой id)', () => {
  it('положительное целое в int31, устойчивое к пробелам в тексте', () => {
    const id = core.syntheticMessageId('web:x', OFFER, NOW);
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
    expect(core.syntheticMessageId('web:x', OFFER.replace(/ /g, '  '), NOW)).toBe(id);
  });

  it('разные чат/текст/дата дают разные id', () => {
    const base = core.syntheticMessageId('web:x', OFFER, NOW);
    expect(core.syntheticMessageId('web:y', OFFER, NOW)).not.toBe(base);
    expect(core.syntheticMessageId('web:x', REQUEST, NOW)).not.toBe(base);
    expect(core.syntheticMessageId('web:x', OFFER, NOW + 60_000)).not.toBe(base);
  });

  it('stableId не возвращает 0 и одинаков для одинаковой строки', () => {
    expect(core.stableId('')).toBeGreaterThan(0);
    expect(core.stableId('abc')).toBe(core.stableId('abc'));
    expect(core.stableId('abc')).not.toBe(core.stableId('abd'));
  });
});

describe('клиентский детект: пассажирские и болтовня отсеиваются в вкладке', () => {
  it('объявления о посылках идут на сервер', () => {
    const offer = core.detect(OFFER, parser, {});
    expect(offer.send).toBe(true);
    expect(offer.reason).toBe('ok');
    expect(offer.hasContact).toBe(true);
    expect(offer.parsed?.fromCity).toBe('Варшава');
    expect(offer.parsed?.toCity).toBe('Брест');
    expect(core.detect(REQUEST, parser, {}).send).toBe(true);
  });

  it('болтовня, пассажирские и сервисные строки не идут', () => {
    expect(core.detect(CHATTER, parser, {})).toMatchObject({ send: false, reason: 'chatter' });
    expect(core.detect(PASSENGER, parser, {})).toMatchObject({ send: false, reason: 'passenger' });
    expect(core.detect(SERVICE, parser, {}).send).toBe(false);
  });

  it('слишком короткие и слишком длинные сообщения отсекаются до парсера', () => {
    expect(core.detect('ок', parser, {})).toMatchObject({ send: false, reason: 'short' });
    expect(core.detect('а'.repeat(4001), parser, {})).toMatchObject({ send: false, reason: 'too_long' });
    expect(core.detect('', parser, {})).toMatchObject({ send: false, reason: 'short' });
  });

  it('requireContact оставляет только сообщения с контактом', () => {
    expect(core.detect(NO_CONTACT, parser, { requireContact: true })).toMatchObject({ send: false, reason: 'no_contact' });
    expect(core.detect(OFFER, parser, { requireContact: true }).send).toBe(true);
    expect(core.detect(NO_CONTACT, parser, { requireContact: false }).send).toBe(true);
  });

  it('без бандла парсера работает запасной детект по ключевым словам', () => {
    expect(core.detect(OFFER, undefined, {}).send).toBe(true);
    expect(core.detect(PASSENGER, undefined, {}).send).toBe(false);
    expect(core.detect(CHATTER, undefined, {})).toMatchObject({ send: false, reason: 'chatter' });
  });

  it('неразрывные пробелы и лишние переносы не ломают детект', () => {
    const messy = OFFER.replace(/ /g, '\u00a0');
    expect(core.detect(messy, parser, {}).send).toBe(true);
  });
});

describe('возраст сообщения', () => {
  it('в пределах maxAgeHours — отправляем, старше — нет', () => {
    expect(core.withinAge(NOW - 3600_000, 72, NOW)).toBe(true);
    expect(core.withinAge(NOW - 71 * 3600_000, 72, NOW)).toBe(true);
    expect(core.withinAge(NOW - 100 * 3600_000, 72, NOW)).toBe(false);
  });

  it('дату не достали → решит сервер (свой INGEST_MAX_AGE_DAYS)', () => {
    expect(core.withinAge(null, 72, NOW)).toBe(true);
    expect(core.withinAge(undefined, 72, NOW)).toBe(true);
  });

  it('дата далеко в будущем — явный мусор разметки', () => {
    expect(core.withinAge(NOW + 5 * 24 * 3600_000, 72, NOW)).toBe(false);
    expect(core.withinAge(NOW + 3600_000, 72, NOW)).toBe(true);
  });
});

describe('локальная дедупликация и батчи', () => {
  const msgs = [
    { chatId: 'web:a', messageId: 1, text: 'первое' },
    { chatId: 'web:a', messageId: 2, text: 'второе' },
    { chatId: 'web:a', messageId: 1, text: 'первое (повтор в пачке)' },
    { chatId: 'web:b', messageId: 1, text: 'из другого чата' },
  ];

  it('sentKey — пара chatId:messageId', () => {
    expect(core.sentKey('web:a', 12)).toBe('web:a:12');
  });

  it('уже отправленные отсеиваются, повторы внутри пачки — тоже', () => {
    const out = core.filterUnsent(msgs, ['web:a:1']);
    expect(out.map((m) => m.text)).toEqual(['второе', 'из другого чата']);
    expect(core.filterUnsent(msgs, []).map((m) => m.messageId)).toEqual([1, 2, 1]);
  });

  it('пустой/битый лог отправленного не роняет отсев', () => {
    expect(core.filterUnsent(msgs, undefined as unknown as string[])).toHaveLength(3);
  });

  it('батчи не больше batchSize, порядок сохраняется', () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ chatId: 'web:a', messageId: i + 1 }));
    const batches = core.chunk(many, 20);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(batches[0]![0]!.messageId).toBe(1);
    expect(batches[2]![4]!.messageId).toBe(45);
  });

  it('размер батча ограничен 1..100 (предел сервера — 100 сообщений)', () => {
    const many = Array.from({ length: 250 }, (_, i) => i);
    expect(core.chunk(many, 500).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(core.chunk(many, 0).map((b) => b.length)).toEqual([20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10]);
    expect(core.chunk([], 20)).toEqual([]);
  });

  it('takeRecent берёт N последних по возрастанию времени', () => {
    const list = [
      { messageId: 3, dateMs: NOW },
      { messageId: 1, dateMs: NOW - 2000 },
      { messageId: 2, dateMs: NOW - 1000 },
      { messageId: 4, dateMs: null },
    ];
    expect(core.takeRecent(list, 2).map((m) => m.messageId)).toEqual([2, 3]);
    expect(core.takeRecent(list, 10)).toHaveLength(4);
  });

  it('лог отправленного обрезается до лимита, свежие ключи остаются', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `web:a:${i}`);
    expect(core.pruneSentLog(keys, 4)).toEqual(['web:a:6', 'web:a:7', 'web:a:8', 'web:a:9']);
    expect(core.pruneSentLog(keys)).toHaveLength(10);
    expect(core.SENT_LOG_LIMIT).toBe(3000);
    expect(core.pruneSentLog('не массив' as unknown as string[])).toEqual([]);
  });
});

describe('backoff и классификация ошибок (ТЗ п. 4.5)', () => {
  it('401/403 и 503 — остановиться и показать ошибку', () => {
    expect(core.classifyStatus(401)).toBe('stop_auth');
    expect(core.classifyStatus(403)).toBe('stop_auth');
    expect(core.classifyStatus(503)).toBe('stop_disabled');
  });

  it('429 и 5xx — backoff и повтор; 400/413 — чинить контракт', () => {
    expect(core.classifyStatus(429)).toBe('backoff');
    expect(core.classifyStatus(500)).toBe('backoff');
    expect(core.classifyStatus(502)).toBe('backoff');
    expect(core.classifyStatus(400)).toBe('stop_payload');
    expect(core.classifyStatus(413)).toBe('stop_payload');
    expect(core.classifyStatus(200)).toBe('ok');
    expect(core.classifyStatus(418)).toBe('unknown');
  });

  it('экспоненциальный рост с джиттером и потолком', () => {
    const first = core.backoffMs(1, 5000, 60_000);
    const second = core.backoffMs(2, 5000, 60_000);
    const third = core.backoffMs(3, 5000, 60_000);
    expect(first).toBeGreaterThanOrEqual(5000);
    expect(first).toBeLessThanOrEqual(6000);
    expect(second).toBeGreaterThanOrEqual(10_000);
    expect(second).toBeLessThanOrEqual(12_000);
    expect(third).toBeGreaterThan(second);
    expect(core.backoffMs(50, 5000, 60_000)).toBeLessThanOrEqual(60_000);
    expect(core.backoffMs(0, 5000, 60_000)).toBeLessThanOrEqual(6000);
  });
});

describe('тело запроса строго по контракту POST /api/ingest (ТЗ п. 4.3)', () => {
  const raw = {
    text: OFFER,
    messageId: 528,
    idSource: 'attr',
    dateMs: NOW,
    authorName: 'Сергей',
    authorUsername: '@sergei_i',
    chat: { chatId: 'web:drivers_pl_by', title: 'Водители Польша–Беларусь', username: 'drivers_pl_by' },
  };

  it('DOM-сообщение → элемент контракта', () => {
    const m: PayloadMessage = core.toPayloadMessage(raw, {});
    expect(m.chatId).toBe('web:drivers_pl_by');
    expect(m.messageId).toBe(528);
    expect(m.idSource).toBe('dom');
    expect(m.date).toBe(Math.floor(NOW / 1000)); // unix-секунды, как ждёт сервер
    expect(m.chatUrl).toBe('https://t.me/drivers_pl_by');
    expect(m.chatTitle).toBe('Водители Польша–Беларусь');
    expect(m.authorUsername).toBe('@sergei_i');
  });

  it('без числового id в DOM — синтетический, но положительный и устойчивый', () => {
    const noId = core.toPayloadMessage({ ...raw, messageId: null }, {});
    expect(noId.idSource).toBe('synthetic');
    expect(noId.messageId).toBe(core.syntheticMessageId('web:drivers_pl_by', OFFER, NOW));
    expect(noId.messageId).toBeGreaterThan(0);
    const zeroId = core.toPayloadMessage({ ...raw, messageId: 0 }, {});
    expect(zeroId.idSource).toBe('synthetic');
  });

  it('приватный чат: chatId ext:…, публичной ссылки нет', () => {
    const m = core.toPayloadMessage({ ...raw, messageId: null, chat: { id: '-1001234567890', title: 'Семья' } }, {});
    expect(m.chatId).toBe('ext:-1001234567890');
    expect(m.chatUrl).toBeNull();
    expect(m.chatTitle).toBe('Семья');
  });

  it('дату не достали → date: null (сервер решит по своему maxAgeDays)', () => {
    const m = core.toPayloadMessage({ ...raw, messageId: 1, dateMs: null }, {});
    expect(m.date).toBeNull();
  });

  it('текст режется до 4000 символов, заголовок до 120', () => {
    const m = core.toPayloadMessage({
      ...raw,
      messageId: 1,
      text: 'б'.repeat(5000),
      chat: { chatId: 'web:x', title: 'в'.repeat(300) },
    }, {});
    expect(m.text).toHaveLength(4000);
    expect(m.chatTitle).toHaveLength(120);
  });

  it('buildPayload: collector, dryRun и только поля контракта', () => {
    const messages = [core.toPayloadMessage(raw, {})];
    const payload = core.buildPayload(messages, { dryRun: true });
    expect(payload.collector).toBe(core.COLLECTOR);
    expect(payload.dryRun).toBe(true);
    expect(payload.messages).toHaveLength(1);
    expect(Object.keys(payload.messages[0]!).sort())
      .toEqual(['authorName', 'authorUsername', 'chatId', 'chatTitle', 'chatUrl', 'date', 'messageId', 'text']);
    // служебные поля клиента (dateMs, idSource) на сервер не уходят
    expect(payload.messages[0]).not.toHaveProperty('idSource');
    expect(payload.messages[0]).not.toHaveProperty('dateMs');
  });

  it('пустые поля в тело не добавляются, dryRun по умолчанию false', () => {
    const payload = core.buildPayload([core.toPayloadMessage({
      text: OFFER, messageId: 7, dateMs: null, chat: { chatId: 'web:x' },
    }, {})]);
    expect(payload.dryRun).toBe(false);
    expect(Object.keys(payload.messages[0]!).sort()).toEqual(['chatId', 'messageId', 'text']);
  });
});

describe('счётчики по ответу сервера', () => {
  const body = {
    ok: true,
    dryRun: false,
    summary: { received: 4, created: 1, duplicate: 1, skipped: 2, invalid: 0, listings: 1 },
    results: [
      { chatId: 'web:a', messageId: 1, status: 'created', listings: [{ id: 'l1', origin: 'extension' }] },
      { chatId: 'web:a', messageId: 2, status: 'duplicate', listingId: 'l1' },
      { chatId: 'web:a', messageId: 3, status: 'skipped', reason: 'passenger' },
      { chatId: 'web:a', messageId: 4, status: 'invalid', reason: 'bad_payload' },
    ],
    cursors: { 'web:a': 4 },
  };

  it('summary переносится один в один', () => {
    const s = core.summarizeResponse(body);
    expect(s).toMatchObject({ received: 4, created: 1, duplicate: 1, skipped: 2, invalid: 0, listings: 1 });
  });

  it('в локальный лог идут обработанные сообщения, кроме invalid (их можно переслать)', () => {
    expect(core.summarizeResponse(body).sentKeys).toEqual(['web:a:1', 'web:a:2', 'web:a:3']);
  });

  it('пустой или битый ответ не роняет клиент', () => {
    expect(core.summarizeResponse(null).sentKeys).toEqual([]);
    expect(core.summarizeResponse('мусор').received).toBe(0);
    expect(core.summarizeResponse({ results: [{ status: 'created' }] }).sentKeys).toEqual([]);
  });

  it('mergeCounters складывает проходы и помнит последнюю ошибку', () => {
    const merged = core.mergeCounters(
      { found: 10, sent: 4, created: 1, runs: 1, lastError: null },
      { found: 5, sent: 2, created: 2, runs: 1, lastRunAt: '2026-09-15T12:00:00Z', lastError: '429' },
    );
    expect(merged).toMatchObject({ found: 15, sent: 6, created: 3, runs: 2, lastError: '429' });
    expect(merged.lastRunAt).toBe('2026-09-15T12:00:00Z');
    expect(core.mergeCounters(undefined, undefined)).toMatchObject({ found: 0, runs: 0, lastError: null });
    // ошибка снята (undefined не передали) — предыдущая остаётся видимой
    expect(core.mergeCounters({ lastError: '401' }, {}).lastError).toBe('401');
  });
});

describe('диагностика: честно сообщаем, когда разметка не читается', () => {
  it('отчёт содержит чат, стратегию и счётчики', () => {
    const text = core.diagnostic({
      url: 'https://web.telegram.org/k/#@drivers_pl_by',
      chat: { title: 'Водители', username: 'drivers_pl_by' } as ChatRef,
      chatKey: 'web:drivers_pl_by',
      whitelisted: true,
      total: 30,
      strategy: '.bubbles .bubble',
      toSend: 3,
      alreadySent: 12,
      filtered: 15,
      reasons: { chatter: 10, passenger: 5 },
    });
    expect(text).toContain('web:drivers_pl_by');
    expect(text).toContain('В белом списке: да');
    expect(text).toContain('.bubbles .bubble');
    expect(text).toContain('chatter 10');
    expect(text).not.toContain('НЕ МОГУ ПРОЧИТАТЬ');
  });

  it('unreadable → явное предупреждение, а не молчаливая работа вхолостую', () => {
    const text = core.diagnostic({ chat: null, chatKey: null, whitelisted: false, total: 0, unreadable: true });
    expect(text).toContain('НЕ МОГУ ПРОЧИТАТЬ СООБЩЕНИЯ');
    expect(text).toContain('В белом списке: нет');
    expect(core.diagnostic(undefined)).toContain('URL: —');
  });
});

describe('бандл extension/vendor/parser.js (детект на тех же правилах, что и сервер)', () => {
  const code = readFileSync(new URL('../extension/vendor/parser.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({}) as Record<string, unknown>;
  vm.runInContext(code, ctx);
  interface BundledParser {
    parseTelegramMessage: (text: string) => any;
    isPassengerOnly: (text: string) => boolean;
    worthAiCheck: (text: string) => boolean;
  }
  const bundled = ctx.PoputkaParser as BundledParser | undefined;

  it('собран и кладёт API в globalThis.PoputkaParser', () => {
    expect(bundled).toBeTruthy();
    expect(code.length).toBeGreaterThan(10_000);
  });

  it('экспортирует всё, что использует detect()', () => {
    for (const name of ['parseTelegramMessage', 'isPassengerOnly', 'worthAiCheck']) {
      expect(typeof bundled?.[name as keyof BundledParser]).toBe('function');
    }
  });

  it('вердикты бандла совпадают с вердиктами src/parser.ts', () => {
    for (const text of [OFFER, REQUEST, CHATTER, PASSENGER, NO_CONTACT, SERVICE]) {
      expect(core.detect(text, bundled, {}).send).toBe(core.detect(text, parser, {}).send);
      expect(core.detect(text, bundled, {}).reason).toBe(core.detect(text, parser, {}).reason);
    }
  });

  it('бандл разбирает маршрут и контакт так же, как серверный парсер', () => {
    const bundledParsed = bundled!.parseTelegramMessage(OFFER);
    const srcParsed = parser.parseTelegramMessage(OFFER);
    expect(bundledParsed.fromCity).toBe(srcParsed.fromCity);
    expect(bundledParsed.toCity).toBe(srcParsed.toCity);
    expect(bundledParsed.phone).toBe(srcParsed.phone);
    expect(bundledParsed.confidence).toBe(srcParsed.confidence);
  });
});
