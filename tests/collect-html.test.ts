import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractMessageText,
  htmlToText,
  maxMessageId,
  messageIdFromDataPost,
  messageIdFromPermalink,
  nextBefore,
  parseChannelTitle,
  parsePreviewHtml,
  parsePreviewMessages,
  parseVisibleDate,
  MAX_MESSAGE_TEXT,
} from '../src/preview-html';
import { diagnosePage, looksLikeBlocked, looksLikeMissingChannel, looksLikePreviewMarkup, normalizeUsername, previewUrl } from '../src/preview';
import { FIXTURES } from './fixtures';

const NOW = new Date('2026-09-15T12:00:00Z');

describe('parsePreviewHtml: канал (фикстура t.me/s/durov)', () => {
  const { messages, title } = parsePreviewHtml(FIXTURES.channel(), 'durov', NOW);

  it('находит все сообщения страницы и сортирует по возрастанию id', () => {
    expect(messages.map((m) => m.messageId)).toEqual([528, 529, 531]);
  });

  it('заголовок канала — из og:title', () => {
    expect(title).toBe('Pavel Durov');
    expect(parseChannelTitle('<html><head><title>Some Chat – Telegram</title></head></html>')).toBe('Some Chat');
  });

  it('messageId — из data-post', () => {
    expect(messages[0]!.idSource).toBe('data-post');
    expect(messages[0]!.url).toBe('https://t.me/durov/528');
  });

  it('дата — из <time datetime>', () => {
    expect(messages[0]!.date).toBe('2026-06-15T14:58:00.000Z');
    expect(messages[1]!.date).toBe('2026-06-16T11:05:00.000Z');
  });

  it('текст: <br> → \\n, сущности раскрыты, обвязка «VIEW IN TELEGRAM» выброшена', () => {
    const text = messages[0]!.text;
    // два <br><br> между абзацами — авторские пустые строки сообщения сохраняются
    expect(text.split('\n').filter((l) => l.trim()).length).toBe(3);
    expect(text).toContain('🛡'); // &#128737;
    expect(text).toContain('India & not the insiders'); // &amp;
    expect(text).not.toMatch(/VIEW IN TELEGRAM/i);
    expect(text).not.toMatch(/Please open Telegram to view this post/i);
    expect(text).not.toMatch(/<[^>]+>/); // тегов в тексте нет
  });

  it('hasMedia: фото/видео-блок виден, текст без медиа — false', () => {
    expect(messages[0]!.hasMedia).toBe(false);
    expect(messages[1]!.hasMedia).toBe(true);
    expect(messages[2]!.hasMedia).toBe(true);
  });

  it('многострочный пост сохраняет переносы', () => {
    expect(messages[2]!.text.split('\n').length).toBeGreaterThanOrEqual(3);
    expect(messages[2]!.text).toContain('Rich Text Editor');
  });

  it('не падает и не выдумывает id на незнакомой разметке', () => {
    expect(parsePreviewMessages('<html><body>ничего похожего</body></html>', 'durov')).toEqual([]);
    expect(parsePreviewHtml('', 'durov')).toEqual({ messages: [], title: null });
  });
});

describe('parsePreviewHtml: публичная супергруппа', () => {
  const { messages } = parsePreviewHtml(FIXTURES.supergroup(), 'drivers_pl_by', NOW);

  it('сервисные сообщения («X joined the group») пропускаются', () => {
    expect(messages.map((m) => m.messageId)).toEqual([9001, 9003, 9004]);
    const serviceOnly = '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message tgme_widget_message_service" ' +
      'data-post="drivers_pl_by/9002"><div class="tgme_widget_message_text">Maksim joined the group</div></div></div>';
    expect(parsePreviewMessages(serviceOnly, 'drivers_pl_by', NOW)).toEqual([]);
  });

  it('автор сообщения — из подписи', () => {
    expect(messages[0]!.author).toBe('Adelina Yasiuchenia');
  });

  it('форвард: видно, откуда переслано', () => {
    const forwarded = messages.find((m) => m.messageId === 9003)!;
    expect(forwarded.forwardedFrom).toContain('Sergei Ivanov');
    expect(forwarded.text).toContain('Кто-нибудь едет завтра из Кракова в Минск');
  });

  it('текст объявления доходит до парсера дословно (телефон, @username, дата)', () => {
    expect(messages[0]!.text).toContain('+48 579 264 254');
    expect(messages[0]!.text).toContain('@adelina_y');
    expect(messages.find((m) => m.messageId === 9004)!.text).toContain('Vb +375256663703');
  });
});

describe('parsePreviewHtml: пагинация ?before=', () => {
  const { messages } = parsePreviewHtml(FIXTURES.older(), 'durov', NOW);

  it('возвращает более старые сообщения', () => {
    expect(messages.map((m) => m.messageId)).toEqual([526, 527]);
    expect(nextBefore(messages)).toBe(526);
    expect(maxMessageId(messages)).toBe(527);
  });
});

describe('parsePreviewHtml: битая разметка не роняет сбор', () => {
  it('пустой ответ → []', () => {
    expect(parsePreviewMessages(FIXTURES.empty(), 'durov', NOW)).toEqual([]);
  });

  it('обрезанный HTML → целые сообщения разбираются, хвост отбрасывается', () => {
    const messages = parsePreviewMessages(FIXTURES.truncated(), 'durov', NOW);
    expect(messages.map((m) => m.messageId)).toEqual([528]);
    expect(messages[0]!.text).toContain('150 million');
  });

  it('страница «чат не найден» → [] и диагноз missing', () => {
    const html = FIXTURES.missing();
    expect(parsePreviewMessages(html, 'no_such_channel_here', NOW)).toEqual([]);
    expect(looksLikeMissingChannel(html)).toBe(true);
    expect(diagnosePage({ status: 200, html, messages: [] })).toBe('missing');
  });

  it('капча/бан-стена → диагноз blocked, а не markup_changed', () => {
    const html = FIXTURES.blocked();
    expect(looksLikeBlocked(html)).toBe(true);
    expect(diagnosePage({ status: 200, html, messages: [] })).toBe('blocked');
  });

  it('200, но контейнеров сообщений нет вовсе → markup_changed', () => {
    const html = '<html><body><div class="something_new">Telegram поменял вёрстку</div></body></html>';
    expect(looksLikePreviewMarkup(html)).toBe(false);
    expect(diagnosePage({ status: 200, html, messages: [] })).toBe('markup_changed');
  });

  it('не-200 → http_<code>', () => {
    expect(diagnosePage({ status: 503, html: '', messages: [] })).toBe('http_503');
  });

  it('знакомая разметка, но сообщений нет → empty (пустой чат)', () => {
    const html = '<div class="tgme_widget_message_wrap"></div>';
    expect(diagnosePage({ status: 200, html, messages: [] })).toBe('empty');
  });
});

describe('messageId: два независимых источника', () => {
  it('data-post с дефисом/точкой в юзернейме режется по последнему слэшу', () => {
    expect(messageIdFromDataPost('durov/528')).toBe(528);
    expect(messageIdFromDataPost('drivers-pl.by/9001')).toBe(9001);
    expect(messageIdFromDataPost('')).toBeNull();
    expect(messageIdFromDataPost('durov/abc')).toBeNull();
    expect(messageIdFromDataPost(null)).toBeNull();
  });

  it('permalink https://t.me/<username>/<id>', () => {
    expect(messageIdFromPermalink('https://t.me/durov/528')).toBe(528);
    expect(messageIdFromPermalink('https://t.me/s/durov/528')).toBe(528);
    expect(messageIdFromPermalink('https://t.me/durov')).toBeNull();
  });

  it('разметка без data-post: id берётся из permalink', () => {
    const { messages } = parsePreviewHtml(FIXTURES.noDataPost(), 'durov', NOW);
    expect(messages.map((m) => m.messageId)).toEqual([528, 529, 531]);
    expect(messages.every((m) => m.idSource === 'permalink')).toBe(true);
  });
});

describe('дата: запасной разбор видимой подписи', () => {
  it('«June 15» → ISO текущего года', () => {
    expect(parseVisibleDate('June 15', NOW)).toBe('2026-06-15T00:00:00Z');
  });

  it('«May 10, 2025» → с явным годом', () => {
    expect(parseVisibleDate('May 10, 2025', NOW)).toBe('2025-05-10T00:00:00Z');
  });

  it('дата + время из меты', () => {
    expect(parseVisibleDate('14:58 June 15', NOW)).toBe('2026-06-15T14:58:00Z');
  });

  it('«Dec 31» в январе — прошлый год', () => {
    expect(parseVisibleDate('Dec 31', new Date('2026-01-05T00:00:00Z'))).toBe('2025-12-31T00:00:00Z');
  });

  it('мусор → null', () => {
    expect(parseVisibleDate('18.8M views Pavel Durov', NOW)).toBeNull();
    expect(parseVisibleDate('', NOW)).toBeNull();
  });

  it('нет <time datetime> — дата берётся из видимой подписи', () => {
    const html = FIXTURES.channel().replace(/<time class="time" datetime="[^"]*">/g, '<time class="time">');
    const { messages } = parsePreviewHtml(html, 'durov', NOW);
    expect(messages[0]!.date).toBe('2026-06-15T14:58:00.000Z');
  });
});

describe('текст: переносы, сущности, обрезка', () => {
  it('htmlToText: <br> → \\n, блочные теги → граница строк, nbsp/zero-width вычищены', () => {
    expect(htmlToText('a<br>b')).toBe('a\nb');
    // закрывающий и открывающий блочные теги дают по \n — пустая строка между блоками
    expect(htmlToText('<div>one</div><div>two</div>')).toBe('one\n\ntwo');
    expect(htmlToText('a&nbsp;b\u200b c')).toBe('a b c');
    expect(htmlToText('<a href="x">ссылка</a>')).toBe('ссылка');
  });

  it('decodeEntities: именованные и числовые (в том числе emoji)', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;')).toBe('&<>"\' ');
    expect(decodeEntities('&#128737;')).toBe('🛡');
    expect(decodeEntities('&#x1F6E1;')).toBe('🛡');
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });

  it('текст длиннее 4000 символов обрезается', () => {
    const long = 'посылка '.repeat(900);
    const html = `<div class="tgme_widget_message" data-post="x/1"><div class="tgme_widget_message_text">${long}</div>` +
      `<div class="tgme_widget_message_date"><time datetime="2026-09-10T10:00:00+00:00">10:00</time></div></div>`;
    const messages = parsePreviewMessages(html, 'x', NOW);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text.length).toBe(MAX_MESSAGE_TEXT);
  });

  it('сообщение без текста пропускается (только медиа)', () => {
    const html = `<div class="tgme_widget_message" data-post="x/2"><div class="tgme_widget_message_photo_wrap"></div></div>`;
    expect(parsePreviewMessages(html, 'x', NOW)).toEqual([]);
  });

  it('extractMessageText не цепляет чужой класс (…_text_signed — не текст)', () => {
    const html = '<div class="tgme_widget_message_text">настоящий текст</div>' +
      '<div class="tgme_widget_message_text_signed">подпись</div>';
    expect(extractMessageText(html)).toBe('настоящий текст');
    expect(extractMessageText('<div class="tgme_widget_message_text_signed">только подпись</div>')).toBeNull();
  });
});

describe('normalizeUsername / previewUrl', () => {
  it('принимает юзернейм, @юзернейм и ссылку', () => {
    expect(normalizeUsername('durov')).toBe('durov');
    expect(normalizeUsername('@drivers_pl_by')).toBe('drivers_pl_by');
    expect(normalizeUsername('https://t.me/s/durov')).toBe('durov');
    expect(normalizeUsername('https://t.me/durov/528')).toBe('durov');
  });

  it('отклоняет мусор', () => {
    expect(normalizeUsername('')).toBeNull();
    expect(normalizeUsername('t.me/+invite')).toBeNull();
    expect(normalizeUsername('12345')).toBeNull();
    expect(normalizeUsername('a'.repeat(40))).toBeNull();
  });

  it('URL превью и пагинации', () => {
    expect(previewUrl('durov')).toBe('https://t.me/s/durov');
    expect(previewUrl('durov', 528)).toBe('https://t.me/s/durov?before=528');
  });
});
