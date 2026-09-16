/**
 * Локальное «зеркало» t.me/s/ для сквозной проверки скраппера без интернета.
 * Отдаёт сохранённые фикстуры: /s/<username>[?before=<id>] → tests/fixtures/*.html
 *
 * Запуск отдельно:      node local/mock-tme.mjs [port]
 * Внутри другого сервера (демо админки): import { handlePreviewRequest } from './mock-tme.mjs'
 * Сборщик переключается на зеркало переменной COLLECT_PREVIEW_BASE.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(here, '..', 'tests', 'fixtures');

export const MAP = {
  durov: 'tme-s-durov.html',
  drivers_pl_by: 'tme-s-supergroup.html',
  gone_channel: 'tme-s-missing.html',
  broken_channel: null, // 200, но разметка чужая — проверка «markup_changed»
};

/**
 * Обработать GET /s/<username>[?before=<id>] — как это делает t.me.
 * `prefix` — часть пути перед /s/ (в демо-сервере зеркало живёт на /mirror/s/).
 */
export function handlePreviewRequest(req, res, prefix = '') {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const username = url.pathname.replace(new RegExp(`^${prefix}/s/?`), '');
  if (!username) { res.writeHead(404).end('not found'); return true; }

  if (username === 'gone_channel') {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(readFileSync(resolve(FIXTURES_DIR, MAP.gone_channel)));
    return true;
  }
  if (username === 'broken_channel') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Telegram поменял вёрстку</body></html>');
    return true;
  }

  const before = url.searchParams.get('before');
  let file = MAP[username];
  if (username === 'durov' && before) file = 'tme-s-durov-before-528.html';
  const path = file ? resolve(FIXTURES_DIR, file) : null;
  if (!path || !existsSync(path)) { res.writeHead(404).end('no such channel'); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(path));
  return true;
}

/** Поднять зеркало отдельным сервером (нужно для CLI-проверок). */
export function startMockTme(port = 8899, host = '0.0.0.0') {
  const server = createServer((req, res) => handlePreviewRequest(req, res));
  return new Promise((ok) => {
    server.listen(port, host, () => {
      console.log(`mock t.me/s/ на http://${host}:${port}/s/<username>`);
      ok(server);
    });
  });
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) await startMockTme(Number(process.argv[2] ?? 8899));
