import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Упаковка расширения. Здесь проверяется то, что нельзя увидеть тестами логики,
 * но что ломает сбор целиком в живом Chrome:
 *
 *   «Invalid script mime type: Не удалось загрузить файл core.cjs для скрипта
 *    обработки контента»
 *
 * Chrome определяет тип файла контент-скрипта по расширению, `.cjs` JavaScript-файлом
 * не считает — и тогда не внедряется НИ ОДИН файл из списка: попап пишет
 * «контент-скрипт не подключён», а обновление страницы не помогает.
 */

const EXT = new URL('../extension/', import.meta.url);
const read = (url: URL) => readFileSync(url, 'utf8');

const manifest = JSON.parse(read(new URL('manifest.json', EXT))) as {
  version: string;
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ matches: string[]; js: string[] }>;
};

describe('упаковка расширения: Chrome должен суметь внедрить контент-скрипт', () => {
  const files = manifest.content_scripts[0]!.js;

  it('файлы контент-скрипта существуют и все с расширением .js', () => {
    expect(files).toEqual(['vendor/parser.js', 'core.js', 'dom.js', 'content.js']);
    for (const f of files) {
      expect(existsSync(new URL(f, EXT)), `${f}: файла нет в папке extension/`).toBe(true);
      expect(f.endsWith('.js'), `${f}: Chrome откажется грузить не-.js как контент-скрипт`).toBe(true);
    }
  });

  it('в папке расширения не осталось .cjs-файлов', () => {
    expect(existsSync(new URL('core.cjs', EXT))).toBe(false);
    expect(existsSync(new URL('dom.cjs', EXT))).toBe(false);
  });

  it('разрешения: storage для настроек, scripting для подключения к вкладке из попапа', () => {
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.host_permissions).toContain('https://web.telegram.org/*');
    expect(manifest.content_scripts[0]!.matches).toContain('https://web.telegram.org/*');
  });

  it('попап внедряет тот же список файлов, что и манифест', () => {
    const popup = read(new URL('popup.js', EXT));
    const list = /CONTENT_FILES = \[[^\]]*\]/.exec(popup);
    expect(list, 'в popup.js нет CONTENT_FILES').toBeTruthy();
    for (const f of files) expect(list![0], `${f} отсутствует в CONTENT_FILES`).toContain(`'${f}'`);
  });

  it('popup.html подключает core.js, а не core.cjs', () => {
    const html = read(new URL('popup.html', EXT));
    expect(html).toContain('<script src="core.js">');
    expect(html).not.toContain('.cjs');
  });

  it('extension/package.json держит эти файлы в CommonJS — иначе тесты их не подключат', () => {
    // в корневом package.json "type": "module"; без этой заглушки createRequire
    // отказался бы грузить UMD-файлы как CommonJS
    const pkg = JSON.parse(read(new URL('package.json', EXT))) as { type: string };
    expect(pkg.type).toBe('commonjs');
  });

  it('версии не разъезжаются: манифест, boot в content.js, юзерскрипт', () => {
    const boot = /version: '([\d.]+)'/.exec(read(new URL('content.js', EXT)));
    expect(boot, 'в content.js нет boot.version').toBeTruthy();
    expect(manifest.version).toBe(boot![1]);

    const userscript = read(new URL('../userscript/poputchka-collector.user.js', import.meta.url));
    expect(userscript).toContain(`// @version      ${manifest.version}`);
  });

  it('юзерскрипт собран из тех же файлов (без .cjs в путях)', () => {
    const userscript = read(new URL('../userscript/poputchka-collector.user.js', import.meta.url));
    for (const f of files) expect(userscript, `${f} не вошёл в юзерскрипт`).toContain(`/* ---- extension/${f} ---- */`);
    expect(userscript).not.toContain('extension/core.cjs');
    expect(userscript).not.toContain('extension/dom.cjs');
  });
});
