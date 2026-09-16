import { parsePreviewHtml, TYPICAL_PAGE_SIZE, type PreviewMessage } from './preview-html.ts';

export { TYPICAL_PAGE_SIZE };

/**
 * Сетевая часть варианта A: GET https://t.me/s/<username>.
 *
 * Страница открывается без логина, пагинация вглубь истории —
 * `?before=<message_id>`. Здесь только fetch + разбор: ни D1, ни KV,
 * ни курсоров — поэтому модуль одинаково работает в воркере и в Node.
 */

/** Результат одного обращения к веб-превью. */
export interface PreviewPage {
  /** HTTP-статус (400 — не прошли валидацию юзернейма, запрос не уходил). */
  status: number;
  /** Сырой HTML — для логов и диагностики «разметка изменилась». */
  html: string;
  messages: PreviewMessage[];
  title: string | null;
  url: string;
  /** Минимальный id на странице — значение для следующего ?before=. */
  nextBefore: number | null;
  /** Максимальный id на странице — кандидат в курсор. */
  maxId: number | null;
}

export interface FetchPreviewOptions {
  /** Значение для ?before= (страница сообщений СТАРШЕ этого id). */
  before?: number | null;
  /** Инжект fetch — для тестов и для локального прокси. */
  fetchImpl?: typeof fetch;
  /** Таймаут запроса, мс (по умолчанию 15 000). */
  timeoutMs?: number;
  /** Свой User-Agent (по умолчанию — обычный браузерный). */
  userAgent?: string;
  /** Базовый URL превью (по умолчанию https://t.me/s) — для тестов/зеркала. */
  baseUrl?: string;
}

/** Публичные юзернеймы Telegram: 5–32 знака, начинаются с буквы. */
export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** Юзернейм как в t.me/<username>: срезаем @, ссылку и хвост после слэша. */
export function normalizeUsername(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // приняли ссылку вместо юзернейма — вытащим его
  const fromUrl = /t\.me\/(?:s\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})/i.exec(s);
  if (fromUrl) s = fromUrl[1]!;
  s = s.replace(/^@/, '').replace(/\/.*$/, '').trim();
  return USERNAME_RE.test(s) ? s : null;
}

/** Заголовки обычного браузера: Telegram отдаёт урезанную страницу ботам. */
export function browserHeaders(userAgent?: string): Record<string, string> {
  return {
    'User-Agent': userAgent ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
  };
}

export function previewUrl(username: string, before?: number | null, baseUrl = 'https://t.me/s'): string {
  const base = baseUrl.replace(/\/+$/, '');
  return before != null ? `${base}/${username}?before=${before}` : `${base}/${username}`;
}

/** Признаки «чата нет / превью недоступно» вместо списка сообщений. */
/**
 * Признаки страницы-заглушки «чат не найден» вместо превью.
 *
 * ВАЖНО: `tgme_page_wrap` и `tgme_page_background` есть и у ЖИВОЙ страницы
 * t.me/s/<username>, поэтому по ним отличить заглушку нельзя. Иначе любая
 * смена разметки (контейнеры на месте, а сообщения не разобрались)диагностировалась бы
 * как «чат удалён» — и collect.ts сразу выключал бы чат вместо трёх попыток
 * с алертом, как при markup_changed.
 */
export function looksLikeMissingChannel(html: string): boolean {
  if (!html) return false;
  if (/If you have <strong>Telegram<\/strong>, you can contact/i.test(html)) return true;
  if (/tgme_(?:notfound|error)/i.test(html)) return true;
  if (/can&#39;t be found|can't be found|не найден|does not exist/i.test(html)) return true;
  // заглушка рисуется блоками tgme_page_title/tgme_page_description,
  // а у живой страницы превью их нет (зато есть контейнеры сообщений)
  if (/tgme_page_(?:title|description)/i.test(html) && !/tgme_widget_message/i.test(html)) return true;
  return false;
}

/** Признаки капчи/бан-стены (Cloudflare и подобное) — не надо считать их «сменой разметки». */
export function looksLikeBlocked(html: string): boolean {
  if (!html) return false;
  return /cf-browser-verification|challenge-platform|Just a moment\.\.\.|cf_chl_opt|Enable JavaScript and cookies/i.test(html);
}

/** Похоже ли на настоящую страницу превью (есть контейнеры сообщений). */
export function looksLikePreviewMarkup(html: string): boolean {
  return /tgme_widget_message/i.test(html ?? '');
}

/**
 * Есть ли на странице СОДЕРЖИМОЕ сообщений (текст, дата, data-post), а не только
 * пустые обёртки. Нужно, чтобы отличить «чат пустой» от «разметка изменилась и
 * разбор сломался»: во втором случае collect.ts делает три попытки и шлёт алерт,
 * а в первом — спокойно продолжает обход.
 */
export function looksLikeMessagePayload(html: string): boolean {
  return /tgme_widget_message_text|tgme_widget_message_date|data-post="/i.test(html ?? '');
}

/**
 * Диагноз страницы для логов и last_error:
 *   ok             — сообщения разобрались
 *   empty          — 200, но сообщений нет (разметка изменилась или чат пустой)
 *   missing        — чат не найден / удалён / переименован
 *   blocked        — капча или бан-стена (стоит увеличить интервал обхода)
 *   markup_changed — 200, но знакомых контейнеров нет вовсе
 *   http_<code>    — не-200 ответ
 */
export function diagnosePage(page: { status: number; html: string; messages: PreviewMessage[] }): string {
  if (page.status !== 200) return `http_${page.status}`;
  if (page.messages.length > 0) return 'ok';
  if (looksLikeMissingChannel(page.html)) return 'missing';
  if (looksLikeBlocked(page.html)) return 'blocked';
  if (!looksLikePreviewMarkup(page.html)) return 'markup_changed';
  // обёртки и содержимое на месте, но ничего не разобрали → сломался парсер,
  // а не «пустой чат» (у пустого канала нет ни текстов, ни data-post)
  if (looksLikeMessagePayload(page.html)) return 'markup_changed';
  return 'empty';
}

/**
 * Прочитать веб-превью публичного чата.
 *
 * Не бросает исключения на сетевых ошибках: status=0 + html='' означает
 * «не дошли» (таймаут/DNS/сброс соединения), а вызывающий код сам решает,
 * что делать (не двигать курсор, error_count++).
 */
export async function fetchPreview(username: string, opts: FetchPreviewOptions = {}): Promise<PreviewPage> {
  const name = normalizeUsername(username);
  const url = name ? previewUrl(name, opts.before, opts.baseUrl) : '';
  if (!name) {
    return { status: 400, html: '', messages: [], title: null, url, nextBefore: null, maxId: null };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let status = 0;
  let html = '';
  try {
    const res = await doFetch(url, {
      headers: browserHeaders(opts.userAgent),
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    status = res.status;
    html = status === 200 ? await res.text() : (await res.text().catch(() => '')) ?? '';
  } catch (e) {
    console.error('fetchPreview failed', url, e);
    return { status: 0, html: '', messages: [], title: null, url, nextBefore: null, maxId: null };
  }

  const { messages, title } = parsePreviewHtml(html, name);
  const ids = messages.map((m) => m.messageId);
  return {
    status,
    html,
    messages,
    title,
    url,
    nextBefore: ids.length ? Math.min(...ids) : null,
    maxId: ids.length ? Math.max(...ids) : null,
  };
}

/** Пауза между запросами к разным чатам (ТЗ п. 3.4.5: 200–500 мс). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
