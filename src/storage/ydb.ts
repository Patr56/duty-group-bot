import { TypedValues, Types } from 'ydb-sdk';
import type { Ydb } from 'ydb-sdk-proto';
import type { Driver, Session } from 'ydb-sdk';

import type { DomainChat, Member, Properties } from '../types';
import type { ChatState, Storage } from './types';

const SCHEMA_V = 2;
const DEFAULT_DUTY_COUNT = 1;

const TX_RW = {
    beginTx: { serializableReadWrite: {} },
    commitTx: true,
};

export const TABLES = {
    chatProps: 'chat_props',
    chatMembers: 'chat_members',
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

/**
 * Parses a chat_id stored as Utf8 back into a number when it round-trips
 * cleanly. Telegram chat ids are typically negative integers; non-numeric
 * fallbacks (historic) stay as strings.
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
                SELECT username, COALESCE(served_count, 0u) AS served_count
                    FROM ${TABLES.chatMembers}
                    WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );

        const sets = result.resultSets ?? [];
        const propsRow = sets[0]?.rows?.[0];
        const dutyCount = propsRow ? readUint64(propsRow.items?.[0]) || DEFAULT_DUTY_COUNT : DEFAULT_DUTY_COUNT;
        const members: Member[] = (sets[1]?.rows ?? []).map((row) => ({
            username: readText(row.items?.[0]),
            servedCount: readUint64(row.items?.[1]),
        }));

        return {
            props: { dutyCount },
            members,
        };
    }

    async setProperties(chat: DomainChat, props: Properties): Promise<void> {
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $duty_count AS Uint64;
                UPSERT INTO ${TABLES.chatProps} (chat_pk, duty_count, schema_v)
                    VALUES ($chat_pk, $duty_count, ${SCHEMA_V}u);
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $duty_count: TypedValues.uint64(props.dutyCount),
                },
                TX_RW,
            ),
        );
    }

    async incrementServeCounts(chat: DomainChat, usernames: string[]): Promise<void> {
        if (usernames.length === 0) return;
        const pk = chatPk(chat);
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $usernames AS List<Utf8>;
                UPDATE ${TABLES.chatMembers}
                    SET served_count = COALESCE(served_count, 0u) + 1u
                    WHERE chat_pk = $chat_pk AND username IN $usernames;
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $usernames: TypedValues.list(Types.UTF8, usernames),
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
        // INSERT-or-keep: only sets served_count = 0 for genuinely new rows.
        // Existing rows keep whatever counter they had.
        await this._do((session) =>
            session.executeQuery(
                `
                DECLARE $chat_pk AS Utf8;
                DECLARE $username AS Utf8;
                INSERT INTO ${TABLES.chatMembers} (chat_pk, username, served_count)
                    VALUES ($chat_pk, $username, 0u);
                `,
                {
                    $chat_pk: TypedValues.utf8(pk),
                    $username: TypedValues.utf8(username),
                },
                TX_RW,
            ).catch((e: unknown) => {
                // INSERT throws on conflict — re-add of an existing member is a no-op
                // by contract, so swallow the duplicate-key error.
                const msg = (e as { message?: string }).message ?? '';
                if (/Conflict with existing key/i.test(msg) || /duplicate/i.test(msg)) return;
                throw e;
            }),
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
                DELETE FROM ${TABLES.chatProps} WHERE chat_pk = $chat_pk;
                `,
                { $chat_pk: TypedValues.utf8(pk) },
                TX_RW,
            ),
        );
    }
}

/**
 * YQL DDL for the schema. Tables created via `session.createTable` are
 * invisible to YQL queries on YDB Serverless 5.11.x — see CLAUDE.md.
 *
 * Schema v2 (introduced for the counter-based scheduler):
 *   - `chat_members.served_count Uint64` (NULL == 0 via COALESCE in reads);
 *   - `round_served` table dropped (was schema v1).
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
            chat_pk      Utf8 NOT NULL,
            username     Utf8 NOT NULL,
            served_count Uint64,
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
