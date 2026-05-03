import { TypedValues, Types } from 'ydb-sdk';
import type { Ydb } from 'ydb-sdk-proto';
import type { Driver, Session } from 'ydb-sdk';

import type { DomainChat, Properties } from '../types';
import type { ChatState, Storage } from './types';

const SCHEMA_V = 1;
const DEFAULT_DUTY_COUNT = 1;

const TX_RW = {
    beginTx: { serializableReadWrite: {} },
    commitTx: true,
};

export const TABLES = {
    chatProps: 'chat_props',
    chatMembers: 'chat_members',
    roundServed: 'round_served',
    triggers: 'triggers',
} as const;

function chatPk(chat: DomainChat): string {
    return `${chat.type}#${chat.id}`;
}

function readText(value: Ydb.IValue | null | undefined): string {
    return value?.textValue ?? '';
}

function readUint64(value: Ydb.IValue | null | undefined): number {
    const v = value?.uint64Value;
    if (v == null) return 0;
    return typeof v === 'number' ? v : Number(v.toString());
}

function rowsAsStrings(rs: Ydb.IResultSet | undefined | null): string[] {
    return (rs?.rows ?? []).map((row) => readText(row.items?.[0]));
}

/**
 * Parses a chat_id stored as Utf8 back into number when it round-trips cleanly.
 * Telegram chat ids are typically negative integers; we keep a string fallback
 * for non-numeric ids the bot has historically tolerated.
 */
function parseChatId(raw: string): number | string {
    if (raw === '') return raw;
    const n = Number(raw);
    return Number.isFinite(n) && String(n) === raw ? n : raw;
}

export class YdbStorage implements Storage {
    constructor(private readonly driver: Driver) {}

    private async _do<T>(fn: (s: Session) => Promise<T>): Promise<T> {
        return this.driver.tableClient.withSession(fn);
    }

    async getChatState(chat: DomainChat): Promise<ChatState> {
        const pk = chatPk(chat);
        const result = await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                SELECT duty_count FROM ${TABLES.chatProps} WHERE chat_pk = $chat_pk;
                SELECT username FROM ${TABLES.chatMembers} WHERE chat_pk = $chat_pk;
                SELECT username FROM ${TABLES.roundServed} WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );

        const sets = result.resultSets ?? [];
        const propsRow = sets[0]?.rows?.[0];
        const dutyCount = propsRow ? readUint64(propsRow.items?.[0]) || DEFAULT_DUTY_COUNT : DEFAULT_DUTY_COUNT;
        const members = rowsAsStrings(sets[1]);
        const roundServed = rowsAsStrings(sets[2]);

        return {
            props: { dutyCount, roundServed },
            members,
        };
    }

    async setChatState(chat: DomainChat, props: Properties): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $duty_count AS Uint64;
                DECLARE $served AS List<Struct<username:Utf8>>;
                UPSERT INTO ${TABLES.chatProps} (chat_pk, duty_count, schema_v)
                    VALUES ($chat_pk, $duty_count, ${SCHEMA_V}u);
                DELETE FROM ${TABLES.roundServed} WHERE chat_pk = $chat_pk;
                UPSERT INTO ${TABLES.roundServed} (chat_pk, username)
                    SELECT $chat_pk AS chat_pk, username FROM AS_TABLE($served);
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $duty_count: TypedValues.uint64(props.dutyCount),
                    $served: TypedValues.list(
                        Types.struct({ username: Types.UTF8 }),
                        props.roundServed.map((u) => ({ username: u })),
                    ),
                },
                TX_RW,
            ),
        );
    }

    async propsExists(chat: DomainChat): Promise<boolean> {
        const pk = chatPk(chat);
        const result = await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                SELECT 1 AS x FROM ${TABLES.chatProps} WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );
        return Boolean(result.resultSets?.[0]?.rows?.length);
    }

    async memberExists(chat: DomainChat, username: string): Promise<boolean> {
        const pk = chatPk(chat);
        const result = await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $username AS Utf8;
                SELECT 1 AS x FROM ${TABLES.chatMembers}
                    WHERE chat_pk = $chat_pk AND username = $username;
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $username: TypedValues.utf8(username),
                },
                TX_RW,
            ),
        );
        return Boolean(result.resultSets?.[0]?.rows?.length);
    }

    async addMember(chat: DomainChat, username: string): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $username AS Utf8;
                UPSERT INTO ${TABLES.chatMembers} (chat_pk, username)
                    VALUES ($chat_pk, $username);
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $username: TypedValues.utf8(username),
                },
                TX_RW,
            ),
        );
    }

    async removeMember(chat: DomainChat, username: string): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $username AS Utf8;
                DELETE FROM ${TABLES.chatMembers}
                    WHERE chat_pk = $chat_pk AND username = $username;
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $username: TypedValues.utf8(username),
                },
                TX_RW,
            ),
        );
    }

    async setTrigger(chat: DomainChat, hour: number): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $chat_type AS Utf8;
                DECLARE $chat_id AS Utf8;
                DECLARE $trigger_hour AS Uint8;
                UPSERT INTO ${TABLES.triggers} (chat_pk, chat_type, chat_id, trigger_hour, schema_v)
                    VALUES ($chat_pk, $chat_type, $chat_id, $trigger_hour, ${SCHEMA_V}u);
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $chat_type: TypedValues.utf8(chat.type),
                    $chat_id: TypedValues.utf8(String(chat.id)),
                    $trigger_hour: TypedValues.uint8(hour),
                },
                TX_RW,
            ),
        );
    }

    async removeTrigger(chat: DomainChat): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DELETE FROM ${TABLES.triggers} WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );
    }

    async listTriggers(): Promise<DomainChat[]> {
        const result = await this._do((session) =>
            session.executeQuery(
                `SELECT chat_type, chat_id FROM ${TABLES.triggers};`,
                {},
                TX_RW,
            ),
        );
        const rs = result.resultSets?.[0];
        return (rs?.rows ?? []).map((row) => {
            const items = row.items ?? [];
            return {
                type: readText(items[0]),
                id: parseChatId(readText(items[1])),
            };
        });
    }

    async clearChat(chat: DomainChat): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DELETE FROM ${TABLES.chatMembers} WHERE chat_pk = $chat_pk;
                DELETE FROM ${TABLES.roundServed} WHERE chat_pk = $chat_pk;
                DELETE FROM ${TABLES.chatProps} WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );
    }
}

/**
 * YQL DDL for the four-table schema. We use raw YQL `CREATE TABLE` (executed
 * via the QueryClient) instead of `session.createTable(...)`: tables created
 * through the table API aren't registered with the YQL compiler and reads via
 * `executeQuery` fail with "Cannot find table". Discovered the hard way.
 */
export const TABLE_DDL: Record<string, string> = {
    [TABLES.chatProps]: `
        CREATE TABLE IF NOT EXISTS ${TABLES.chatProps} (
            chat_pk    Utf8 NOT NULL,
            duty_count Uint64,
            schema_v   Uint32,
            PRIMARY KEY (chat_pk)
        );
    `,
    [TABLES.chatMembers]: `
        CREATE TABLE IF NOT EXISTS ${TABLES.chatMembers} (
            chat_pk  Utf8 NOT NULL,
            username Utf8 NOT NULL,
            PRIMARY KEY (chat_pk, username)
        );
    `,
    [TABLES.roundServed]: `
        CREATE TABLE IF NOT EXISTS ${TABLES.roundServed} (
            chat_pk  Utf8 NOT NULL,
            username Utf8 NOT NULL,
            PRIMARY KEY (chat_pk, username)
        );
    `,
    [TABLES.triggers]: `
        CREATE TABLE IF NOT EXISTS ${TABLES.triggers} (
            chat_pk      Utf8 NOT NULL,
            chat_type    Utf8,
            chat_id      Utf8,
            trigger_hour Uint8,
            schema_v     Uint32,
            PRIMARY KEY (chat_pk)
        );
    `,
};
