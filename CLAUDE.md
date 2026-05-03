# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Команды

- `npm run build` — esbuild собирает `src/index.ts` в один CJS-бандл `dist/index.js` (target node22), без `node_modules` снаружи.
- `npm run check` — `tsc --noEmit` (strict, `noUncheckedIndexedAccess`).
- `npm run lint` — ESLint v9 (flat config, плагины `typescript-eslint`).
- `npm test` — `vitest run` по `tests/**/*.test.ts`. Алгоритм Service тестируется против `InMemoryStorage` (in-process порт). Адаптер `YdbStorage` тестируется отдельно: вместо реального YDB подсовывается фейковый `Driver` с заглушкой `tableClient.withSession(cb)` — фиксируем YQL+params, возвращаем canned `IResultSet`. Handler-тесты используют DI через `createHandler({controller})` с подменённым контроллером.
- `npm run migrate -- --dry-run` / `npm run migrate` — one-shot миграция S3 → YDB (`scripts/migrate-s3-to-ydb.ts` через `tsx`). См. раздел «Миграция и cutover».
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
- `src/storage/ydb.ts` — `YdbStorage` поверх `ydb-sdk`. Также экспортирует `TABLE_DDL` (YQL `CREATE TABLE IF NOT EXISTS` для миграционного скрипта).
- `src/errors.ts` — `ServiceError extends Error` с полем `cause: unknown`.
- `src/util/{command,concurrency}.ts` — `parseCommandArgs` + `stripAt`, `mapWithConcurrency` (bounded fan-out для trigger-а, лимит 5).
- `src/types.ts` — доменные типы. `DomainChat.id: number | string` — `listTriggers()` восстанавливает id как строку, если не парсится в число.
- `scripts/migrate-s3-to-ydb.ts` — one-shot скрипт миграции. Запускается через `tsx`. **Не входит в production-бандл.**

### Раскладка YDB

Четыре таблицы в БД `duty-group-bot-db` (databaseId `etn60ekt1utfffalau5j`):

- `chat_props (chat_pk Utf8 PK, duty_count Uint64, schema_v Uint32)` — настройки чата. `chat_pk = "{type}#{id}"`.
- `chat_members (chat_pk Utf8, username Utf8, PRIMARY KEY (chat_pk, username))` — зарегистрированные участники. **Username хранится bare, без `@`.**
- `round_served (chat_pk Utf8, username Utf8, PRIMARY KEY (chat_pk, username))` — кто уже дежурил в текущем раунде. Пустой раунд = нет строк (без подводных камней с empty-set).
- `triggers (chat_pk Utf8 PK, chat_type Utf8, chat_id Utf8, trigger_hour Uint8, schema_v Uint32)` — флаг автоназначения. Существование строки = автоназначение ВКЛ.

Поле `schema_v` пишется в каждый item. При несовместимом изменении схемы — пишем апгрейд в адаптере по аналогии с прежним `lastDuty → roundServed`.

**Gotcha — таблицы создавать только через YQL DDL.** Если создать таблицу через `session.createTable(path, TableDescription)` (Table API), YQL-запросы (`SELECT/UPSERT FROM table`) на неё падают с `SchemeError: Cannot find table`, хотя `describeTable` и `bulkUpsert` к ней успешны. Воспроизводится на YDB Serverless 5.11.x. Отсюда в `TABLE_DDL` использовано `CREATE TABLE IF NOT EXISTS` через `QueryClient.do(...)` — единственный способ зарегистрировать таблицу для YQL-плана. Для будущих миграций схемы — тоже только DDL.

`Storage.getChatState(chat)` — единственный read-метод для `Service.duty/list/reg/unreg/setDutyCount`: одной транзакцией читает props + members + roundServed (`SELECT ... ; SELECT ... ; SELECT ...`). `Storage.setChatState(chat, props)` пишет props и атомарно перетирает `round_served` (`UPSERT chat_props; DELETE round_served; UPSERT round_served FROM AS_TABLE($served)`).

### Алгоритм выбора дежурных

`Service.duty(chat)`:
1. `getChatState(chat)` → `{ props, members }` (одна TX, одно RTT).
2. `eligible = members \ roundServed`. Если пусто — сброс раунда: `roundServed = []`, `eligible = members`.
3. Перемешать `eligible`, взять `dutyCount` человек → `newDuty`.
4. `setChatState(chat, { dutyCount, roundServed: roundServed ∪ newDuty })`. Возвращаем `newDuty.map(u => '@'+u)`.

`dutyCount > eligible.length` корректно усекается. **Идемпотентности «несколько /duty за день» нет** — каждый вызов выбирает следующих и накапливает раунд.

**Accepted risk: read-modify-write `/duty` неатомарно.** Между `getChatState` и `setChatState` две конкурентные `/duty` в одном чате могут затереть раунд друг друга. Трафик ≈ 1 cron в день + редкие ручные вызовы — гонка маловероятна и не повреждает данные (потеряется один раунд истории). Если когда-то понадобится строгая атомарность — оборачиваем алгоритм в interactive transaction внутри одного `withSession` (потребует callback-style API в `Storage`).

### Миграция и cutover

Скрипт `scripts/migrate-s3-to-ydb.ts` (`npm run migrate`). Идемпотентный compare/skip/warn:
- YDB пусто → копируем из S3.
- YDB равно S3 → skip.
- YDB отличается → WARN + skip (никогда не затираем YDB-state, чтобы повторный запуск не съел свежие изменения).

Username при миграции лишается префикса `@` (S3 хранил `@alice`, YDB хранит `alice`). `roundServed` нормализуется так же. Legacy `lastDuty` подхватывается как `roundServed`.

Скрипт также создаёт таблицы при первом запуске (через `session.describeTable` → `session.createTable`).

Required env для запуска:
- `YDB_ENDPOINT`, `YDB_DATABASE` — те же, что у функции.
- `YDB_ACCESS_TOKEN_CREDENTIALS=$(yc iam create-token)` ИЛИ `YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS=path-to-json` — auth для локального запуска (в YC Functions используется `MetadataAuthService`, локально — нет).
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — статические ключи к Object Storage (read-only достаточно).

Cutover был сделан без freeze-window (трафик ≈ 0). Старый бакет `duty-group-bot-storage` оставлен на 7 дней как backup; ролью runtime-SA `storage.editor` после удаления бакета убрать.

### Конвенции, важные при правках

- `Controller.pt(items, plural, single)` — самописный плюрализатор. При изменении формулировок поправить везде, где собираются строки.
- HTML-режим ответов: `_replyMessage` всегда отправляет `parse_mode: HTML`. Любой пользовательский ввод, попадающий в сообщение, нужно прогонять через `_escapeHtml`.
- Сообщения длиннее `MAX_MESSAGE_SIZE = 4000` обрезаются в `_prepareMessage`.
- `SELF_BOT = 1` в `/list` — поправка на самого бота при выводе «X из N участников чата».
- `chat.username ?? chat.title ?? chat.id` — «человекочитаемое имя» в логах/сообщениях владельцу.
- Username guard в `/reg` и `/unreg`: если у пользователя нет `username` в Telegram — бот отвечает понятным сообщением и не пишет ключ. `/add` и `/remove` принимают username аргументом, там guard не нужен.
- **Self-heal `getChatState`:** если `chat_props` отсутствует, адаптер возвращает дефолты `{dutyCount:1, roundServed:[]}` без записи. Запись материализуется при ближайшем `setChatState` (его делают `setDutyCount`, `duty`, `init`). Это покрывает ситуацию, когда `/add` или `/reg` отрабатывали раньше `/start`. Не-404 ошибки бросаются адаптером как есть, `Service` оборачивает в `ServiceError`.
- `Service.init` различает «уже создано» и «создано» через `Storage.propsExists` — иначе self-heal сделал бы первое сообщение неправдой (props ещё нет, но getChatState отдаст дефолты).
- При изменении `ServiceError` помнить, что `_handleError` форматирует `cause: unknown` через `formatError` — не предполагает наличия `.message`/`.stack`.
