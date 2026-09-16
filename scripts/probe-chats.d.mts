/**
 * Типы для scripts/probe-chats.mjs — разведка публичных чатов перед обкаткой.
 * Сам скрипт намеренно .mjs (запускается без сборки: node scripts/probe-chats.mjs),
 * поэтому тесты импортируют его через эту декларацию.
 */

/** Что выяснили про один чат. */
export interface ProbeResult {
  /** Что передали на вход (юзернейм, @username или ссылка). */
  input: string;
  /** Нормализованный юзернейм или null, если ввод не похож на публичный чат. */
  username: string | null;
  /** Ссылка на веб-превью (всегда настоящая t.me, даже при проверке через зеркало). */
  url: string | null;
  /** HTTP-статус; 0 — до t.me не достучаться. */
  status: number;
  /** ok | empty | missing | blocked | markup_changed | http_<code> | network | bad_username. */
  verdict: string;
  title: string | null;
  /** Итоговый тип чата для /api/admin/watch-chats. */
  kind: 'channel' | 'supergroup' | null;
  /** Подсказка типа по доле сообщений с автором. */
  kindHint: 'channel' | 'supergroup' | null;
  messages: number;
  maxId: number | null;
  nextBefore: number | null;
  newestDate: string | null;
  newestAgeDays: number | null;
  withAuthors: number;
  authorShare: number;
  /** Сколько сообщений последней страницы правила признали объявлениями. */
  listings: number;
  passenger: number;
  worthAi: number;
  chatter: number;
  /** Результат проверки ?before= (только с deep: true). */
  pagination: { before: number; status: number; messages: number; verdict: string } | null;
  /** Добавлять | не добавлять | проверить вручную. */
  recommendation: string;
  notes: string[];
}

export interface ProbeOptions {
  /** Зеркало превью вместо https://t.me/s (локальная обкатка). */
  baseUrl?: string;
  /** Инжект fetch — для тестов и прокси. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Проверить ещё и пагинацию ?before=. */
  deep?: boolean;
  /** Пауза между чатами, мс (по умолчанию 1500). */
  delayMs?: number;
  now?: Date | string | number;
}

export declare function probeChat(raw: string, opts?: ProbeOptions): Promise<ProbeResult>;
export declare function probeChats(list: string[], opts?: ProbeOptions): Promise<ProbeResult[]>;
export declare function recommend(r: Partial<ProbeResult>): {
  kind: 'channel' | 'supergroup' | null;
  recommendation: string;
  notes: string[];
};
export declare function formatProbeReport(results: ProbeResult[]): string;
