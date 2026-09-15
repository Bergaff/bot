/**
 * Разбор HTML веб-превью публичного чата Telegram: https://t.me/s/<username>
 *
 * Страница отдаётся БЕЗ авторизации и содержит ~16–20 последних сообщений,
 * пагинация вглубь истории — `?before=<message_id>`.
 *
 * Модуль — ЧИСТЫЕ функции (только строки на входе и выходе), без fetch,
 * без Worker API и без DOMParser (его в Workers нет). Работает одинаково
 * в воркере, в Node (CLI-скраппер) и в vitest на фикстурах.
 *
 * Разметка (сверено на живой t.me/s/durov и на публичных разборах):
 *   <div class="tgme_widget_message_wrap">
 *     <div class="tgme_widget_message" data-post="durov/528">
 *       <div class="tgme_widget_message_content">
 *         <div class="tgme_widget_message_text" dir="auto">…текст…</div>
 *         <div class="tgme_widget_message_date">
 *           <a href="https://t.me/durov/528"><time datetime="2026-06-15T14:58:00+00:00">14:58</time></a>
 *         </div>
 *       </div>
 *     </div>
 *   </div>
 *
 * Никакой признак не хардкодится в единственном числе: messageId берётся
 * сначала из data-post, потом из permalink'а https://t.me/<username>/<id>;
 * дата — сначала из <time datetime>, потом из видимой подписи («June 15»).
 * На незнакомой/обрезанной разметке функции возвращают [], а не падают.
 */

/** Одно сообщение веб-превью (ТЗ п. 3.3). */
export interface PreviewMessage {
  /** id сообщения в чате — из data-post или permalink'а. */
  messageId: number;
  /** Текст с переносами строк, без «VIEW IN TELEGRAM»-обвязки, ≤ 4000 символов. */
  text: string;
  /** ISO-дата публикации. Не удалось разобрать — null (сообщение тогда пропускаем). */
  date: string | null;
  /** Автор (в супергруппах — имя отправителя), иначе подпись/название канала. */
  author: string | null;
  /** Есть ли медиа-блок (фото/видео/файл/опрос). */
  hasMedia: boolean;
  /** Перmalink на сообщение: https://t.me/<username>/<id>. */
  url: string;
  /** Откуда переслано (у форвардов в супергруппах). */
  forwardedFrom: string | null;
  /** Подпись под постом канала («P. Durov»). */
  signature: string | null;
  /** id найден из запасного источника (permalink), а не из data-post. */
  idSource: 'data-post' | 'permalink';
}

/** Максимальная длина текста — как в боте: длиннее не обрабатываем. */
export const MAX_MESSAGE_TEXT = 4000;

/** Сколько последних сообщений обычно лежит на одной странице превью. */
export const TYPICAL_PAGE_SIZE = 20;

/* ------------------------------------------------------------------ */
/* Мелкие помощники по разметке                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb',
  reg: '\u00ae', copy: '\u00a9', trade: '\u2122', bull: '\u2022', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
};

/** HTML-сущности → символы (&amp; &lt; &#39; &#8212; &#x2014;). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Значение атрибута из строки одного тега. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? m[4] ?? '';
  return decodeEntities(raw);
}

/** Токены class="…" (с учётом того, что в HTML классы могут быть разделены &nbsp;). */
function classTokens(tag: string): string[] {
  const value = attr(tag, 'class');
  if (!value) return [];
  return value.split(/[\s\u00a0]+/).filter(Boolean);
}

/** Есть ли у тега конкретный класс (токеном, не подстрокой:
 *  `tgme_widget_message` не должен матчить `tgme_widget_message_text`). */
function hasClass(tag: string, cls: string): boolean {
  return classTokens(tag).includes(cls);
}

const BLOCK_TAGS = /^(div|p|section|article|li|ul|ol|table|tr|h[1-6]|blockquote|pre|figure|figcaption|span)$/i;

/** Строка → безопасный фрагмент регулярки. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Вложенный HTML → текст с переносами строк. */
export function htmlToText(html: string): string {
  let s = html;
  // <br> — это перенос строки сообщения, а не пробел
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // блочные теги — граница строк (открывающий и закрывающий дают по \n,
  // лишние пустые строки схлопнем ниже)
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name: string) =>
    BLOCK_TAGS.test(name) ? '\n' : ''
  );
  s = decodeEntities(s);
  // невидимые пробельные символы Telegram (zero-width, nbsp) → обычный пробел
  s = s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  s = s.replace(/[ \t\r]+/g, ' ');
  s = s.replace(/ ?\n ?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Обвязка веб-превью, которой нет в самом сообщении. */
const WRAPPER_LINES = /^(?:view in telegram|please open telegram to view this post|this media is not supported in your browser|leave a comment|add a comment|open telegram)$/i;

function stripWrapperLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !WRAPPER_LINES.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Границы блока, начинающегося с `<div` на позиции start: возвращает срез
 * вместе с закрывающим `</div>`. Считаем глубину по `<div`/`</div`,
 * поэтому вложенные блоки не обрезают сообщение.
 * Обрезанный HTML — не ошибка: возвращаем всё, что есть до конца строки.
 */
function sliceDivBlock(html: string, start: number): string {
  const re = /<\/?div\b/gi;
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return html.slice(start, re.lastIndex);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

/** Первый элемент с классом cls внутри куска — его текст (или null). */
function textOfFirstWithClass(chunk: string, cls: string): string | null {
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (!hasClass(m[2] ?? '', cls)) continue;
    const block = sliceTagBlock(chunk, m.index, m[1]!);
    const text = htmlToText(block.replace(/^<[^>]*>/, '').replace(/<\/[a-zA-Z][^>]*>$/, ''));
    return text || null;
  }
  return null;
}

/** То же, что sliceDivBlock, но для произвольного тега (div/a/span/time…). */
function sliceTagBlock(html: string, start: number, tagName: string): string {
  const re = new RegExp(`<(/?)${tagName}\\b`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      depth--;
      if (depth === 0) {
        const close = html.indexOf('>', re.lastIndex);
        return html.slice(start, close === -1 ? html.length : close + 1);
      }
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

/* ------------------------------------------------------------------ */
/* messageId: два независимых источника                                */
/* ------------------------------------------------------------------ */

/** id из data-post="<username>/<id>": юзернейм может содержать дефис и точки,
 *  поэтому режем по ПОСЛЕДНЕМУ слэшу. */
export function messageIdFromDataPost(value: string | null | undefined): number | null {
  if (!value) return null;
  const clean = value.trim();
  const idx = clean.lastIndexOf('/');
  const tail = idx === -1 ? clean : clean.slice(idx + 1);
  const id = Number(tail);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** id из ссылки на сообщение: https://t.me/<username>/<id> (или ?single). */
export function messageIdFromPermalink(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /t\.me\/(?:s\/)?([A-Za-z][A-Za-z0-9_]*)\/(\d+)/i.exec(value);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* ------------------------------------------------------------------ */
/* Дата: <time datetime> → видимая подпись                             */
/* ------------------------------------------------------------------ */

const MONTHS_EN: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function iso(y: number, m: number, d: number, time?: string | null): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const t = time && /^\d{1,2}:\d{2}/.test(time) ? `${time}:00` : '00:00:00';
  return `${y}-${mm}-${dd}T${t}Z`;
}

/**
 * Запасной разбор даты: «June 15», «May 10, 2025», «15.06.2026», «14:42».
 * Нужен, если Telegram уберёт <time datetime> — иначе все сообщения
 * потеряют дату и сбор встанет. Год без явного указания — текущий,
 * а дата больше чем на месяц в будущем считается прошлогодней.
 */
export function parseVisibleDate(text: string, now: Date = new Date()): string | null {
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const timeMatch = /(\d{1,2}):(\d{2})/.exec(s);
  const time = timeMatch ? `${timeMatch[1]!.padStart(2, '0')}:${timeMatch[2]}` : null;

  // «15.06.2026» / «15.06»
  // (?!\s*[KMBkKмК]) — «18.8M views» это просмотры, а не 18 августа
  const numeric = /(\d{1,2})[.\/](\d{1,2})(?![\s]*[KMBkKмКa-zA-Z])(?:[.\/](\d{2,4}))?/.exec(s);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = numeric[3] ? Number(numeric[3]) : now.getUTCFullYear();
      if (year < 100) year += 2000;
      return iso(year, month, day, time);
    }
  }

  // «June 15» / «Jun 15, 2026»
  const named = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(s);
  if (named) {
    const month = MONTHS_EN[named[1]!.toLowerCase()];
    const day = Number(named[2]);
    if (month && day >= 1 && day <= 31) {
      let year = named[3] ? Number(named[3]) : now.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, month - 1, day));
      // без года: «Dec 31» в январе — это прошлый год
      if (!named[3] && candidate.getTime() > now.getTime() + 31 * 86400_000) year -= 1;
      return iso(year, month, day, time);
    }
  }

  // только время («14:42») — сегодняшняя дата
  if (time) return iso(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), time);
  return null;
}

/** ISO-дата сообщения: сначала <time datetime>, потом видимая подпись. */
export function extractMessageDate(chunk: string, now: Date = new Date()): string | null {
  // 1) <time datetime="2026-06-15T14:58:00+00:00">
  const times = [...chunk.matchAll(/<time\b[^>]*>/gi)].map((m) => attr(m[0], 'datetime')).filter(Boolean);
  // дата сообщения — в блоке .tgme_widget_message_date: если он есть, берём <time> из него
  const dateBlockRe = /<[a-zA-Z][^>]*\bclass\s*=\s*"[^"]*tgme_widget_message_date[^"]*"[^>]*>/i;
  const dateBlock = dateBlockRe.exec(chunk);
  const scoped = dateBlock ? sliceTagBlock(chunk, dateBlock.index, dateBlock[0].slice(1).split(/[\s>]/)[0]!) : null;
  const candidates = (scoped ? [...scoped.matchAll(/<time\b[^>]*>/gi)].map((m) => attr(m[0], 'datetime')).filter(Boolean) : []);
  for (const raw of (candidates.length ? candidates : times)) {
    const value = String(raw);
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }

  // 2) видимая подпись: «June 15» (дата-разделитель) + «14:58» внутри ссылки на пост
  const visible = textOfFirstWithClass(chunk, 'tgme_widget_message_date');
  const meta = textOfFirstWithClass(chunk, 'tgme_widget_message_meta');
  const fromVisible = parseVisibleDate(`${visible ?? ''} ${meta ?? ''}`.trim(), now);
  if (fromVisible) return new Date(fromVisible).toISOString();

  // 3) совсем запасной вариант: подпись вида «Pavel Durov, 14:58 / June 15»
  const last = parseVisibleDate(htmlToText(chunk.slice(-400)), now);
  return last ? new Date(last).toISOString() : null;
}

/* ------------------------------------------------------------------ */
/* Один блок сообщения → PreviewMessage                                */
/* ------------------------------------------------------------------ */

const MEDIA_RE = /class\s*=\s*"[^"]*(?:tgme_widget_message_(?:photo_wrap|video_wrap|video_player|document_wrap|voice_wrap|audio_wrap|sticker_wrap|round_wrap|poll|location_wrap|venue_wrap|dice|webpage_wrap)|js-video|tgme_widget_message_photo)/i;

function hasMedia(chunk: string): boolean {
  if (MEDIA_RE.test(chunk)) return true;
  return /<(?:video|audio|img|picture|iframe)\b/i.test(chunk);
}

/** Текст сообщения: .tgme_widget_message_text → строки, без обвязки превью. */
export function extractMessageText(chunk: string): string | null {
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const cls = attr(m[2] ?? '', 'class') ?? '';
    // именно tgme_widget_message_text: соседние …_text_signed / …_text_link — не текст
    if (!/(?:^|[\s\u00a0])tgme_widget_message_text(?:[\s\u00a0]|$)/.test(cls)) continue;
    const block = sliceTagBlock(chunk, m.index, m[1]!);
    const inner = block.slice(m[0].length).replace(/<\/[a-zA-Z][^>]*>$/, '');
    const text = stripWrapperLines(htmlToText(inner));
    if (!text) return null;
    return text.length > MAX_MESSAGE_TEXT ? text.slice(0, MAX_MESSAGE_TEXT) : text;
  }
  return null;
}

/** Сообщение из одного блока разметки. Нет id или нет текста — null (пропускаем). */
function messageFromBlock(
  block: string,
  fallbackUsername: string,
  now: Date = new Date()
): PreviewMessage | null {
  // сервисные сообщения («X joined the group», «пин закрепил сообщение») — не объявления;
  // класс висит на вложенном контейнере, поэтому проверяем весь блок
  if (/<[a-zA-Z][^>]*\bclass\s*=\s*"[^"]*\btgme_widget_message_service\b[^"]*"/i.test(block)) return null;
  // data-post может висеть как на самом контейнере сообщения, так и на вложенном
  let messageId = messageIdFromDataPost(/data-post\s*=\s*"([^"]*)"/i.exec(block)?.[1]);
  let idSource: PreviewMessage['idSource'] = 'data-post';

  // запасной источник id — permalink на ЭТОТ чат внутри блока.
  // Ссылки на чужие посты (t.me/contest/456 в тексте) не годятся: username сверяем.
  if (messageId === null) {
    const own = new RegExp(`href\\s*=\\s*"(?:https?://)?t\\.me/(?:s/)?${escapeRe(fallbackUsername)}/(\\d+)"`, 'i');
    const m = own.exec(block);
    const id = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(id) || id <= 0) return null;
    messageId = id;
    idSource = 'permalink';
  }

  const text = extractMessageText(block);
  if (!text) return null; // сервисные сообщения («X joined the group») и посты без текста

  const username = /data-post\s*=\s*"([^"/]+)\//i.exec(block)?.[1] ?? fallbackUsername;
  const author =
    textOfFirstWithClass(block, 'tgme_widget_message_from_name')?.replace(/,\s*$/, '') ??
    textOfFirstWithClass(block, 'tgme_widget_message_author_name') ??
    textOfFirstWithClass(block, 'tgme_widget_message_signed') ??
    null;
  const forwardedFrom = textOfFirstWithClass(block, 'tgme_widget_message_forwarded_from');
  const signature = textOfFirstWithClass(block, 'tgme_widget_message_sign');

  return {
    messageId,
    text,
    date: extractMessageDate(block, now),
    author,
    hasMedia: hasMedia(block),
    url: `https://t.me/${username}/${messageId}`,
    forwardedFrom,
    signature,
    idSource,
  };
}

/* ------------------------------------------------------------------ */
/* Страница целиком                                                    */
/* ------------------------------------------------------------------ */

/** Классы-контейнеры одного сообщения (переживаем смену одного из них). */
const MESSAGE_CONTAINER_CLASSES = ['tgme_widget_message', 'tgme_widget_message_wrap', 'tgme_message_block'];

/** Все открывающие теги контейнеров сообщений, в порядке появления. */
function findMessageBlocks(html: string): Array<{ start: number; tag: string }> {
  const found: Array<{ start: number; tag: string }> = [];
  const re = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\bclass\s*=\s*"[^"]*"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tokens = classTokens(m[0]);
    if (!tokens.some((t) => MESSAGE_CONTAINER_CLASSES.includes(t))) continue;
    if (tokens.includes('tgme_widget_message_service')) continue; // «X joined the group»
    if (tokens.includes('tgme_widget_message_text')) continue;
    found.push({ start: m.index, tag: m[0] });
  }
  return found;
}

/**
 * Сообщения страницы превью. Порядок — как в разметке (сначала старые).
 * Дубли (когда и wrap, и внутренний блок попали в список) схлопываются
 * по messageId: остаётся блок с наибольшим количеством текста.
 */
export function parsePreviewMessages(html: string, username: string, now: Date = new Date()): PreviewMessage[] {
  if (typeof html !== 'string' || html.length < 32) return [];
  const blocks = findMessageBlocks(html);
  if (blocks.length === 0) return [];

  const byId = new Map<number, PreviewMessage>();
  for (const { start } of blocks) {
    let message: PreviewMessage | null = null;
    try {
      message = messageFromBlock(sliceDivBlock(html, start), username, now);
    } catch {
      message = null; // кусок битый — пропускаем, не роняем весь разбор
    }
    if (!message) continue;
    const prev = byId.get(message.messageId);
    if (!prev || message.text.length > prev.text.length) byId.set(message.messageId, message);
  }

  return [...byId.values()].sort((a, b) => a.messageId - b.messageId);
}

/**
 * Разбор страницы превью: сообщения + заголовок канала.
 * Пустой/обрезанный ответ → `{ messages: [], title: null }`, без исключений.
 */
export function parsePreviewHtml(html: string, username: string, now: Date = new Date()): {
  messages: PreviewMessage[];
  title: string | null;
} {
  return { messages: parsePreviewMessages(html, username, now), title: parseChannelTitle(html) };
}

/** Название канала/чата из шапки превью (og:title → заголовок страницы → шапка). */
export function parseChannelTitle(html: string): string | null {
  if (typeof html !== 'string' || !html) return null;
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html);
  if (og) {
    const value = attr(og[0], 'content');
    if (value && value.trim()) return cleanTitle(value);
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const value = decodeEntities(title[1] ?? '').replace(/\s*[-–|]\s*Telegram\s*$/i, '').trim();
    if (value) return cleanTitle(value);
  }
  const header =
    textOfFirstWithClass(html, 'tgme_channel_info_header_title') ??
    textOfFirstWithClass(html, 'tgme_header_title');
  return header ? cleanTitle(header) : null;
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*[-–|]\s*Telegram\s*$/i, '').trim().slice(0, 120) || null!;
}

/**
 * Курсор для пагинации вглубь: минимальный id на странице —
 * следующий запрос будет `?before=<это число>`.
 */
export function nextBefore(messages: Array<{ messageId: number }>): number | null {
  if (messages.length === 0) return null;
  return messages.reduce((min, m) => (m.messageId < min ? m.messageId : min), messages[0]!.messageId);
}

/** Максимальный id на странице — на него ставим курсор «обработано до». */
export function maxMessageId(messages: Array<{ messageId: number }>): number | null {
  if (messages.length === 0) return null;
  return messages.reduce((max, m) => (m.messageId > max ? m.messageId : max), messages[0]!.messageId);
}
