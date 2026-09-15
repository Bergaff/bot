/**
 * Локальное «зеркало» t.me/s/ для сквозной проверки скраппера без интернета.
 * Отдаёт сохранённые фикстуры: /s/<username>[?before=<id>] → tests/fixtures/*.html
 * Запуск: node local/mock-tme.mjs [port]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '..', 'tests', 'fixtures');
const port = Number(process.argv[2] ?? 8899);

const MAP = {
  durov: 'tme-s-durov.html',
  drivers_pl_by: 'tme-s-supergroup.html',
  gone_channel: 'tme-s-missing.html',
  broken_channel: null, // 200, но разметка чужая — проверка «markup_changed»
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const username = url.pathname.replace(/^\/s\/?/, '');
  if (!username) { res.writeHead(404).end('not found'); return; }

  if (username === 'gone_channel') {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(readFileSync(resolve(fixtures, MAP.gone_channel)));
    return;
  }
  if (username === 'broken_channel') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Telegram поменял вёрстку</body></html>');
    return;
  }

  const before = url.searchParams.get('before');
  let file = MAP[username];
  if (username === 'durov' && before) file = 'tme-s-durov-before-528.html';
  const path = file ? resolve(fixtures, file) : null;
  if (!path || !existsSync(path)) { res.writeHead(404).end('no such channel'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(path));
}).listen(port, '0.0.0.0', () => {
  console.log(`mock t.me/s/ на http://0.0.0.0:${port}/s/<username>`);
});
