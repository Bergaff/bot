/** Типы для scripts/collect-report.mjs — мониторинг авто-сбора (этап 7). */

export interface ReportProblem {
  /** errors | disabled | stale | token | quota | empty */
  kind: string;
  text: string;
}

export interface ReportSummary {
  ok: boolean;
  problems: ReportProblem[];
  warnings: ReportProblem[];
  failing: ReportProblem[];
  failOn: string[];
  lines: string[];
  chats: number;
  generatedAt: string;
}

export interface SummarizeOptions {
  staleHours?: number;
  failOn?: string;
  now?: Date | string | number;
}

export declare const DEFAULT_STALE_HOURS: number;
export declare function summarize(status: unknown, chats: unknown, opts?: SummarizeOptions): ReportSummary;
export declare function formatReport(summary: ReportSummary): string;
export declare function fetchState(
  url: string,
  token: string,
  fetchImpl?: typeof fetch
): Promise<{ status: any; chats: any[] }>;
