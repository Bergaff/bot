# Воркфайлы GitHub Actions

Здесь лежат два готовых воркфайла. Они **не** в `.github/workflows/`, потому что бот,
которым работает эта песочница, не имеет права `workflows` — GitHub отклоняет push с
сообщением:

```
! [remote rejected] refusing to allow a GitHub App to create or update workflow
  `.github/workflows/ci.yml` without `workflows` permission
```

Поэтому файлы версионируются тут, а включить их нужно одним движением (или дать приложению
право `workflows` в настройках репозитория/организации и перенести файлы самим).

## Установка

```bash
cd <клон репозитория>
mkdir -p .github/workflows
cp docs/ci/ci.yml docs/ci/monitor.yml .github/workflows/
git add .github/workflows && git commit -m "CI и мониторинг авто-сбора" && git push
```

Проверить, что воркфайлы подхватились: вкладка **Actions** → слева «CI» и
«Мониторинг авто-сбора».

---

## `ci.yml` — проверка каждого push и pull request

| Job | Что делает |
|---|---|
| `test` | `npm ci` → `npm run typecheck` → `npm test` (321 тест); затем `npm run build:ext` и требование пустого `git diff` по `extension/vendor/parser.js` и `userscript/poputchka-collector.user.js` — то есть бандл клиента не отстал от `src/parser.ts` |
| `smoke` | сквозной прогон **без интернета**: поднимает зеркало фикстур `local/mock-tme.mjs`, прогоняет разведку чатов (`scripts/probe-chats.mjs`) и полный цикл обхода — dry run (не сдвинул курсор, не создал заявок) → боевой прогон (3 заявки, 0 ошибок) → сброс курсора → повтор (0 заявок, 3 дубля по `tg_seen`) |

`smoke` повторяет «День 0» из [`docs/rollout.md`](../rollout.md), поэтому зелёный job —
признак, что серверная часть собрана правильно. Выводы прогонов пишутся в `.data/`
(каталог в `.gitignore`).

## `monitor.yml` — сводка состояния по расписанию

`node scripts/collect-report.mjs` каждые 3 часа (`25 */3 * * *`, через ~8 минут после
обхода воркера при `COLLECT_CRON=17 */2 * * *`) и вручную через «Run workflow»
(там же меняются `--stale-hours` и список `--fail-on`).

Отчёт кладётся в job summary, а при проблемах job падает → GitHub присылает письмо.
`npm ci` не нужен: скрипт работает на чистом Node.

Включается двумя настройками (Settings → Secrets and variables → Actions):

| Что | Где | Значение |
|---|---|---|
| `COLLECT_REPORT_URL` | Variables | `https://<ваш-домен>` — адрес сервера parcel |
| `COLLECT_ADMIN_TOKEN` | Secrets | значение `ADMIN_API_TOKEN` сервера |

Пока переменной `COLLECT_REPORT_URL` нет, job пропускается (`if: vars.COLLECT_REPORT_URL != ''`) —
воркфайл безопасен до настройки. Расписание работает **только из default-ветки**, то есть
после слияния в `main`; до этого запускайте руками.

Что считается проблемой и предупреждением — в [`docs/rollout.md`](../rollout.md), раздел 4.2.
