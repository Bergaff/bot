import { describe, expect, it } from 'vitest';
import { chatUrlOf, listingSourceLink, originLabel, usernameOfChatId, webChatId } from '../src/links';
import { formatListing } from '../src/telegram';
import type { Listing } from '../src/types';

/** ТЗ п. 2.3 и тест 5: ссылка на исходное сообщение для всех трёх миров. */
describe('listingSourceLink', () => {
  it('публичный чат сборщика: web:<username> + id → t.me/<username>/<id>', () => {
    expect(listingSourceLink('web:durov', 528)).toBe('https://t.me/durov/528');
    expect(listingSourceLink('web:drivers_pl_by', 9001)).toBe('https://t.me/drivers_pl_by/9001');
  });

  it('web:<username> без id → ссылка на чат целиком', () => {
    expect(listingSourceLink('web:durov', null)).toBe('https://t.me/durov');
    expect(listingSourceLink('web:durov', undefined)).toBe('https://t.me/durov');
  });

  it('приватная супергруппа из расширения: ext:-100<id> → служебная t.me/c/<id>/<msg>', () => {
    // открывается у участников чата — именно её просит модератор: открыть и переслать самому
    expect(listingSourceLink('ext:-1001234567890', 528)).toBe('https://t.me/c/1234567890/528');
    expect(listingSourceLink('ext:-1001234567890', null)).toBe('https://t.me/c/1234567890');
  });

  it('обычная группа, личный чат и синтетический ключ из расширения: ссылки на сообщение нет', () => {
    expect(listingSourceLink('ext:-5551234', 12)).toBeNull();   // базовая группа
    expect(listingSourceLink('ext:987654321', 12)).toBeNull();  // личный чат (peer user)
    expect(listingSourceLink('ext:abc123', 12)).toBeNull();     // ключ по заголовку, id неизвестен
  });

  it('ext:* с вручную заданной ссылкой в chat_links → ссылка есть', () => {
    const links = { 'ext:-100123': 'https://t.me/+AbCdEfGhIjK' };
    // пригласительная ссылка не принимает /<message_id> — отдаём как есть
    expect(listingSourceLink('ext:-100123', 5, links)).toBe('https://t.me/+AbCdEfGhIjK');
    expect(listingSourceLink('ext:-100123', null, links)).toBe('https://t.me/+AbCdEfGhIjK');
  });

  it('бот в супергруппе: -100<id> → t.me/c/<id>/<msg> (как раньше)', () => {
    expect(listingSourceLink('-100999', 77)).toBe('https://t.me/c/999/77');
    expect(listingSourceLink('-1001234567890', 12345)).toBe('https://t.me/c/1234567890/12345');
    expect(listingSourceLink('-100999', null)).toBe('https://t.me/c/999');
  });

  it('chat_links важнее автоматической ссылки', () => {
    const links = { 'web:durov': 'https://t.me/durov_chat' };
    expect(listingSourceLink('web:durov', 528, links)).toBe('https://t.me/durov_chat/528');
    expect(listingSourceLink('web:durov', null, links)).toBe('https://t.me/durov_chat');
    // ссылка уже ведёт на сообщение — не добавляем второй id
    expect(listingSourceLink('web:durov', 528, { 'web:durov': 'https://t.me/durov/100' })).toBe('https://t.me/durov/100');
  });

  it('рум (топик) форум-чата: ссылка трёхчастная t.me/<чат>/<рум>/<сообщение>', () => {
    // так Telegram ссылается на сообщение внутри темы форум-супергруппы
    expect(listingSourceLink('web:travelersminsk', 713464, null, 91529))
      .toBe('https://t.me/travelersminsk/91529/713464');
    // приватный форум: служебная ссылка тоже с румом
    expect(listingSourceLink('-1001234567890', 12, null, 7)).toBe('https://t.me/c/1234567890/7/12');
    expect(listingSourceLink('ext:-1001234567890', 12, null, 7)).toBe('https://t.me/c/1234567890/7/12');
    // рум без id сообщения — ссылка на сам рум
    expect(listingSourceLink('web:travelersminsk', null, null, 91529)).toBe('https://t.me/travelersminsk/91529');
    // ссылка, заданная админом, дополняется румом и сообщением
    expect(listingSourceLink('web:durov', 528, { 'web:durov': 'https://t.me/durov_chat' }, 9))
      .toBe('https://t.me/durov_chat/9/528');
    // пригласительная ссылка рум и сообщение не принимает
    expect(listingSourceLink('ext:-100123', 5, { 'ext:-100123': 'https://t.me/+AbCdEfGhIjK' }, 9))
      .toBe('https://t.me/+AbCdEfGhIjK');
    // обычная группа и личный чат: рум ссылки не даёт
    expect(listingSourceLink('ext:-5551234', 12, null, 3)).toBeNull();
    // мусор в topicId игнорируется
    expect(listingSourceLink('web:durov', 528, null, 0)).toBe('https://t.me/durov/528');
    expect(listingSourceLink('web:durov', 528, null, Number.NaN)).toBe('https://t.me/durov/528');
    expect(listingSourceLink('web:durov', 528, null, -91529)).toBe('https://t.me/durov/528');
  });

  it('пересылка от человека, обычная группа, пустые значения → null', () => {
    expect(listingSourceLink('fwd:123456', 601)).toBeNull();
    expect(listingSourceLink('-123456', 5)).toBeNull();
    expect(listingSourceLink('311234567', 601)).toBeNull();
    expect(listingSourceLink(null, 1)).toBeNull();
    expect(listingSourceLink(undefined, undefined)).toBeNull();
  });
});

describe('помощники ключей чата', () => {
  it('webChatId / usernameOfChatId / chatUrlOf', () => {
    expect(webChatId('@durov')).toBe('web:durov');
    expect(usernameOfChatId('web:durov')).toBe('durov');
    expect(usernameOfChatId('ext:-1001')).toBeNull();
    expect(chatUrlOf('web:durov')).toBe('https://t.me/durov');
    expect(chatUrlOf('-100999')).toBeNull();
  });

  it('originLabel: как подписываем источник в админке', () => {
    expect(originLabel('bot')).toBe('бот');
    expect(originLabel('collector')).toBe('сборщик');
    expect(originLabel('extension')).toBe('расширение');
    expect(originLabel(null)).toBe('бот');
    expect(originLabel('что-то новое')).toBe('бот');
  });
});

describe('formatListing: источник и признак origin не ломают карточку', () => {
  function listing(fields: Partial<Listing>): Listing {
    return {
      id: '63367269-0000-0000-0000-000000000000',
      type: 'offer',
      fromCity: 'Варшава',
      toCity: 'Минск',
      departureDate: '2026-09-25',
      weightKg: null,
      price: null,
      description: 'Возьму посылки, домашние переезды. Telegram, Whatsapp.',
      phone: '+48579264254',
      telegram: null,
      status: 'pending',
      source: 'parser',
      sourceChat: 'Водители Польша–Беларусь',
      sourceChatId: 'web:drivers_pl_by',
      sourceMessageId: 9001,
      origin: 'collector',
      createdAt: '2026-09-15T12:00:00.000Z',
      publishedAt: null,
      views: 0,
      ...fields,
    };
  }

  it('карточка сборщика: маршрут, дата, контакты без дублей, ссылка на исходное сообщение', () => {
    const card = formatListing(listing({}));
    expect(card).toContain('#63367269 Водитель везёт');
    expect(card).toContain('Маршрут: Варшава → Минск');
    expect(card).toContain('Дата: 2026-09-25');
    expect(card).toContain('Контакты: +48579264254');
    expect(card).toContain('чат «Водители Польша–Беларусь»');
    expect(card).toContain('<a href="https://t.me/drivers_pl_by/9001">исходное сообщение</a>');
    // один контакт — одна строка
    expect(card.match(/\+48579264254/g)).toHaveLength(1);
  });

  it('карточка из рума форум-чата: ссылка ведёт ровно на найденное сообщение', () => {
    const card = formatListing(listing({
      sourceChat: 'Travelers Minsk',
      sourceChatId: 'web:travelersminsk',
      sourceMessageId: 713464,
      sourceTopicId: 91529,
      origin: 'extension',
    }));
    expect(card).toContain('<a href="https://t.me/travelersminsk/91529/713464">исходное сообщение</a>');
    expect(card).toContain('чат «Travelers Minsk»');
  });

  it('карточка из приватной супергруппы расширения: служебная ссылка и источник на месте', () => {
    // t.me/c/… открывается у участников чата — модератор может открыть и переслать сам
    const card = formatListing(listing({ sourceChatId: 'ext:-100123', origin: 'extension' }));
    expect(card).toContain('<a href="https://t.me/c/123/9001">исходное сообщение</a>');
    expect(card).toContain('чат «Водители Польша–Беларусь»');
  });

  it('карточка из чата расширения без peer-id: ссылки нет, источник остаётся', () => {
    const card = formatListing(listing({ sourceChatId: 'ext:abc123', origin: 'extension' }));
    expect(card).not.toContain('исходное сообщение');
    expect(card).toContain('чат «Водители Польша–Беларусь»');
  });

  it('подпись origin для админки', () => {
    expect(formatListing(listing({}), `Источник данных: ${originLabel('collector')}`))
      .toContain('Источник данных: сборщик');
  });
});
