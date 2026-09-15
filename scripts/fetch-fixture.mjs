#!/usr/bin/env node
/**
 * Снять живую разметку t.me/s/<username> в tests/fixtures/ (ТЗ п. 5.1).
 *
 *   npm run fixture -- durov
 *   npm run fixture -- drivers_pl_by supergroup
 *   npm run fixture -- durov --before 528
 *
 * Фикстуры в репозитории собраны по реальной структуре веб-превью, но
 * Telegram меняет вёрстку — перед правкой парсера стоит обновить снимки
 * и прогнать `npm test`: если тесты на новых снимках зелёные, парсер жив.
 *
 * Скрипт намеренно на чистом JS (без TS и без сети из src/): снимок страницы
 * сохраняется как есть, ничего не парсится.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'tests', 'fixtures');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const names = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== argFlag('--before'));
const before = argFlag('--before');

if (names.length === 0) {
  console.log('Использование: npm run fixture -- <username> [<username2> …] [--before <message_id>]');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

for (const name of names) {
  const url = before ? `https://t.me/s/${name}?before=${before}` : `https://t.me/s/${name}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const file = resolve(outDir, `tme-s-${name}${before ? `-before-${before}` : ''}.html`);
    writeFileSync(file, html);
    const ids = [...html.matchAll(/data-post="[^"]+\/(\d+)"/g)].map((m) => Number(m[1]));
    console.log(`${url} → HTTP ${res.status}, ${html.length} байт, сообщений ${ids.length}`);
    console.log(`  сохранено: ${file}`);
    if (ids.length) console.log(`  id: ${ids.slice(0, 3).join(', ')} … ${ids.slice(-3).join(', ')}`);
    if (res.status !== 200 || ids.length === 0) {
      console.log('  ⚠ похоже, превью недоступно (приватный чат, капча или смена разметки) — в фикстуры такое не берём');
    }
  } catch (e) {
    console.error(`${url} → ошибка: ${e.message}`);
  }
}
