# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Команды

- `npm run build` — esbuild собирает `src/index.ts` в один CJS-бандл `dist/index.js` (target node22), без `node_modules` снаружи.
- `npm run check` — `tsc --noEmit` (strict, `noUncheckedIndexedAccess`).
- `npm run lint` — ESLint v9 (flat config, плагины `typescript-eslint`).
- `npm test` — `vitest run` по `tests/**/*.test.ts`. Алгоритм Service тестируется против `InMemoryStorage` (in-process порт). Адаптер `YdbStorage` тестируется отдельно: вместо реального YDB подсовывается фейковый `Driver` с заглушкой `tableClient.withSession(cb)` — фиксируем YQL+params, возвращаем canned `IResultSet`. Handler-тесты используют DI через `createHandler({controller})` с подменённым контроллером.
- `npm run upgrade-schema` — one-shot upgrade схемы YDB через `tsx` (`scripts/upgrade-to-counter.ts`). Идемпотентный. См. раздел «Эволюция схемы».
- Для деплоя в Yandex Cloud Function упаковывается только `dist/` + `package.json`. Точка входа — `dist/index.handler`.

## CI/CD

GitHub Actions (`.github/workflows/`):
- `ci.yml` — на `pull_request` в `master`: `npm ci`, `npm run check`, `npm run lint`, `npm test`, `npm run build`.
- `deploy.yml` — `workflow_dispatch` с input-ом `ref` (ветка/тег/SHA). Делает `npm ci` (с devDeps — нужен esbuild), `npm run build`, затем `yc-actions/yc-sls-function@v3` упаковывает только `dist/**` + `package.json` и создаёт новую версию функции `duty-group-bot` в фолдере `b1givfkfh806tp641l6l`. Тэг `$latest` автоматически переезжает на свежую версию, существующий cron-триггер сразу подхватывает новый код.
- Action закреплён на `@v3` сознательно; миграцию на `@v4` делать отдельным PR.

Секреты, которые должны быть в репозитории GitHub:
- `YC_SA_JSON_CREDENTIALS` — JSON-ключ сервисного аккаунта-деплойера (роли `functions.editor` на фолдер + `iam.serviceAccounts.user` на runtime-SA `ajerdikcv0fdb1s370uf`).
- `BOT_TOKEN`, `OWNER_ID` — Telegram-токен и chat-id владельца. Пробрасываются в env функции.

## Окружение

Функция ожидает переменные окружения (handler падает без них):
- `BOT_TOKEN` — токен Telegram-бота.
- `OWNER_ID` — Telegram chat id владельца (отчёты об ошибках через `_sendMessageToOwner`).
- `YDB_ENDPOINT` — `grpcs://ydb.serverless.yandexcloud.net:2135`.
- `YDB_DATABASE` — `/ru-central1/b1gajed7j3siebj0fo72/etn60ekt1utfffalau5j`.

Никаких `AWS_*` или статических ключей в env функции **нет**. YDB-доступ обеспечивает runtime service account `ajerdikcv0fdb1s370uf` с ролью `ydb.editor` на фолдере, привязанный к функции в deploy.yml. `ydb-sdk` через `MetadataAuthService` подхватывает IAM-токен у YC metadata-сервиса.

## Архитектура

Yandex Cloud Function (`nodejs22`, entrypoint `dist/index.handler`) с двумя режимами запуска:

1. **Webhook от Telegram** — `event.body` содержит апдейт, парсится и передаётся в `controller.handleUpdate(...)` (Telegraf 4).
2. **Cron-триггер** — событие имеет поле `event.messages` (формат Yandex таймера). `controller.trigger()` обходит все чаты с включённым автоназначением и рассылает «Дежурные на сегодня». Handler **дожидается** завершения trigger-а — `execution-timeout` поднят до 60s.

Слои:

- `src/index.ts` — production wiring: env-guard, YDB `Driver` + `MetadataAuthService`, `YdbStorage`, `Service`, `Controller`, экспорт `handler`. `driver.ready(...)` вызывается лениво при первом запуске и кешируется.
- `src/handler.ts` — фабрика `createHandler({controller})` для DI; используется и в проде, и в тестах.
- `src/controller.ts` — Telegraf 4: команды (`/duty`, `/reg`, `/unreg`, `/list`, `/set`, `/add`, `/remove`, `/reset`, `/clear`, `/triggerOn`, `/triggerOff`, `/help`, `/start`), форматирование, обработка ошибок.
- `src/service.ts` — бизнес-логика. **Зависит только от порта `Storage`**, не от конкретного хранилища. `@`-префикс в username — чисто презентационный: внутри `Service` и в `Storage` имена хранятся bare; `Service.list/duty` дописывают `@` на выходе, `reg/unreg/add/remove` принимают bare на входе.
- `src/storage/types.ts` — порт `Storage` + `ChatState`.
- `src/storage/memory.ts` — `InMemoryStorage` для тестов алгоритма.
- `src/storage/ydb.ts` — `YdbStorage` поверх `ydb-sdk`. Также экспортирует `TABLE_DDL` (YQL `CREATE TABLE IF NOT EXISTS`).
- `src/errors.ts` — `ServiceError extends Error` с полем `cause: unknown`.
- `src/util/{command,concurrency}.ts` — `parseCommandArgs` + `stripAt`, `mapWithConcurrency` (bounded fan-out для trigger-а, лимит 5).
- `src/types.ts` — доменные типы. `DomainChat.id: number | string` — `listTriggers()` восстанавливает id как строку, если не парсится в число.
- `scripts/upgrade-to-counter.ts` — one-shot upgrade схемы (v1 → v2). Запускается через `tsx`. **Не входит в production-бандл.**

### Раскладка YDB (schema v2)

Три таблицы в БД `duty-group-bot-db` (databaseId `etn60ekt1utfffalau5j`):

- `chat_props (chat_pk Utf8 PK, duty_count Uint64, schema_v Uint32)` — настройки чата. `chat_pk = "{type}#{id}"`.
- `chat_members (chat_pk Utf8, username Utf8, served_count Uint64, PRIMARY KEY (chat_pk, username))` — зарегистрированные участники + сколько раз каждый отдежурил. **Username хранится bare, без `@`.** `served_count` nullable: `NULL` читается как `0` через `COALESCE(served_count, 0u)`.
- `triggers (chat_pk Utf8 PK, chat_type Utf8, chat_id Utf8, trigger_hour Uint8, schema_v Uint32)` — флаг автоназначения. Существование строки = автоназначение ВКЛ.

Поле `schema_v` пишется в каждый item — для будущих миграций.

**Gotcha — таблицы создавать только через YQL DDL.** Если создать таблицу через `session.createTable(path, TableDescription)` (Table API), YQL-запросы (`SELECT/UPSERT FROM table`) на неё падают с `SchemeError: Cannot find table`, хотя `describeTable` и `bulkUpsert` к ней успешны. Воспроизводится на YDB Serverless 5.11.x. Отсюда в `TABLE_DDL` использовано `CREATE TABLE IF NOT EXISTS` через `QueryClient.do(...)` — единственный способ зарегистрировать таблицу для YQL-плана. Для будущих миграций схемы — тоже только DDL.

`Storage.getChatState(chat)` — единственный read-метод для `Service.duty/list/reg/unreg`: одной транзакцией читает props + members с counts (`SELECT chat_props; SELECT chat_members WITH COALESCE(served_count, 0u);`). `Storage.incrementServeCounts(chat, usernames[])` атомарно бампает счётчики — `UPDATE ... SET served_count = COALESCE(...) + 1u WHERE username IN $list`.

### Алгоритм выбора дежурных (counter / least-served)

`Service.duty(chat)`:
1. `getChatState(chat)` → `{ props: {dutyCount}, members: [{username, servedCount}] }` (одна TX, одно RTT).
2. Сортировка: `servedCount ASC, username ASC` (alpha tiebreak).
3. Берём первые `min(dutyCount, members.length)` → `newDuty`.
4. `incrementServeCounts(chat, newDuty)`. Возвращаем `newDuty.map(u => '@'+u)`.

**Свойства алгоритма (доказаны тестами в `tests/rotation.test.ts`):**
- Долгосрочно каждый дежурит ровно `total_picks · k / N` раз; разница между max и min count в любой момент ≤ 1.
- Новый `/reg`-нутый член имеет `servedCount=0` → автоматически попадает первым в очередь.
- `/unreg` не оставляет stale-state: строка участника удаляется со счётчиком вместе.
- При `N % k == 0` (например 4 человек, k=2) пары становятся фиксированными `(a,b)/(c,d)/(a,b)/...` из-за alpha tiebreak — это математическое свойство, не баг алгоритма. Для `N=3, k=2` все три пары `(a,b),(a,c),(b,c)` появляются за 3 дня.

`/list` показывает счётчики в формате `@alice (3), @bob (5), @carol (1)` — сразу видно перекосы.

**Accepted risk: `/duty` неатомарно.** Между `getChatState` и `incrementServeCounts` две конкурентные `/duty` в одном чате могут не «увидеть» друг друга и забампать счётчик +1 вместо +2. Трафик ≈ 1 cron в день + редкие ручные вызовы — гонка маловероятна и не повреждает данные (только небольшая потеря фейрности на следующих днях). Если когда-то понадобится строгая атомарность — оборачиваем в interactive TX (`withChatTransaction(chat, fn)` API в `Storage`).

### Эволюция схемы

Версионирование через `scripts/upgrade-to-counter.ts` (и подобные one-shot скрипты в будущем). Запуск:

```bash
YDB_ENDPOINT=... YDB_DATABASE=... YDB_ACCESS_TOKEN_CREDENTIALS=$(yc iam create-token) npm run upgrade-schema
```

История изменений:
- **v1 → v2** (текущая): `chat_members` получает колонку `served_count Uint64`; таблица `round_served` удалена. Алгоритм сменился с round-tracking на счётчик. Старый `roundServed` data discarded by design — counter стартует с нуля.

Required env для локального запуска:
- `YDB_ENDPOINT`, `YDB_DATABASE` — те же, что у функции.
- `YDB_ACCESS_TOKEN_CREDENTIALS=$(yc iam create-token)` ИЛИ `YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=path-to-json` — auth для локального запуска (в YC Functions используется `MetadataAuthService`, локально — нет).

S3-бакет `duty-group-bot-storage` оставлен как backup ранней схемы; через ~неделю без инцидентов снести вместе с ролью `storage.editor`.
