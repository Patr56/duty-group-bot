/**
 * Adapter-level tests for YdbStorage. We don't run real YDB here — instead we
 * stub `tableClient.withSession(cb)` so the callback gets a fake `Session`
 * whose `executeQuery` returns canned ResultSets, and we capture the YQL
 * + params the adapter actually sends.
 */
import { describe, it, expect } from 'vitest';
import type { Driver, Session } from 'ydb-sdk';

import { YdbStorage, TABLES } from '../../src/storage/ydb';

interface ExecCall {
    query: string;
    params: Record<string, unknown>;
}

interface FakeDriverState {
    calls: ExecCall[];
    responses: Array<{ resultSets?: unknown[] }>;
    driver: Driver;
}

function makeFakeDriver(): FakeDriverState {
    const calls: ExecCall[] = [];
    const responses: Array<{ resultSets?: unknown[] }> = [];

    const fakeSession: Pick<Session, 'executeQuery'> = {
        executeQuery: (async (
            query: string,
            params: Record<string, unknown>,
        ) => {
            calls.push({ query, params });
            return responses.shift() ?? { resultSets: [] };
        }) as Session['executeQuery'],
    };

    const driver = {
        tableClient: {
            withSession: async <T>(cb: (s: Session) => Promise<T>): Promise<T> => cb(fakeSession as Session),
        },
    } as unknown as Driver;

    return { calls, responses, driver };
}

describe('YdbStorage.getChatState', () => {
    it('returns defaults when chat is unknown (both result sets empty)', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [] }, { rows: [] }] });
        const storage = new YdbStorage(fake.driver);

        const state = await storage.getChatState({ id: -100, type: 'group' });

        expect(state.props).toEqual({ dutyCount: 1 });
        expect(state.members).toEqual([]);
    });

    it('parses props + members from two result sets', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({
            resultSets: [
                { rows: [{ items: [{ uint64Value: '5' }] }] },
                {
                    rows: [
                        { items: [{ textValue: 'alice' }, { uint64Value: '3' }] },
                        { items: [{ textValue: 'bob' }, { uint64Value: '7' }] },
                    ],
                },
            ],
        });
        const storage = new YdbStorage(fake.driver);

        const state = await storage.getChatState({ id: -100, type: 'group' });

        expect(state.props.dutyCount).toBe(5);
        expect(state.members).toEqual([
            { username: 'alice', servedCount: 3 },
            { username: 'bob', servedCount: 7 },
        ]);

        // Sanity: pk built as "type#id"
        expect(JSON.stringify(fake.calls[0]?.params)).toContain('group#-100');
    });

    it('uses COALESCE so NULL served_count is read as 0', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [] }, { rows: [] }] });
        const storage = new YdbStorage(fake.driver);

        await storage.getChatState({ id: 1, type: 'private' });

        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain('COALESCE(served_count');
    });

    it('queries both tables in a single executeQuery (one round-trip)', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [] }, { rows: [] }] });
        const storage = new YdbStorage(fake.driver);

        await storage.getChatState({ id: 1, type: 'private' });

        expect(fake.calls).toHaveLength(1);
        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain(TABLES.chatProps);
        expect(q).toContain(TABLES.chatMembers);
    });
});

describe('YdbStorage.setProperties', () => {
    it('UPSERTs chat_props with dutyCount only (no roundServed anymore)', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.setProperties({ id: -100, type: 'group' }, { dutyCount: 3 });

        expect(fake.calls).toHaveLength(1);
        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain(`UPSERT INTO ${TABLES.chatProps}`);
        expect(q).not.toContain('round_served');
    });
});

describe('YdbStorage.incrementServeCounts', () => {
    it('issues an UPDATE with COALESCE + IN clause for the given usernames', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.incrementServeCounts({ id: -100, type: 'group' }, ['alice', 'carol']);

        expect(fake.calls).toHaveLength(1);
        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain(`UPDATE ${TABLES.chatMembers}`);
        expect(q).toContain('COALESCE(served_count');
        expect(q).toContain('IN $usernames');
    });

    it('is a no-op for empty username list (does not touch the driver)', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.incrementServeCounts({ id: -100, type: 'group' }, []);

        expect(fake.calls).toHaveLength(0);
    });
});

describe('YdbStorage.propsExists', () => {
    it('true when at least one row returned', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [{ items: [{ uint32Value: 1 }] }] }] });
        const storage = new YdbStorage(fake.driver);

        await expect(storage.propsExists({ id: 1, type: 'group' })).resolves.toBe(true);
    });

    it('false when result set has no rows', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [] }] });
        const storage = new YdbStorage(fake.driver);

        await expect(storage.propsExists({ id: 1, type: 'group' })).resolves.toBe(false);
    });
});

describe('YdbStorage.memberExists', () => {
    it('passes username as a parameter, not interpolated into YQL', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [{ items: [{ uint32Value: 1 }] }] }] });
        const storage = new YdbStorage(fake.driver);

        await storage.memberExists({ id: -100, type: 'group' }, "alice'); DROP TABLE chat_members; --");

        const params = fake.calls[0]?.params as Record<string, { value?: { textValue?: string } }>;
        expect(params['$username']?.value?.textValue).toContain('DROP TABLE');
        expect(fake.calls[0]?.query).not.toContain('DROP TABLE');
    });
});

describe('YdbStorage.addMember / removeMember', () => {
    it('addMember INSERTs into chat_members with served_count=0u', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.addMember({ id: -100, type: 'group' }, 'alice');

        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain(`INSERT INTO ${TABLES.chatMembers}`);
        expect(q).toContain('0u');
    });

    it('addMember swallows duplicate-key conflicts (idempotent re-add)', async () => {
        const conflictDriver = {
            tableClient: {
                async withSession<T>(cb: (s: Session) => Promise<T>): Promise<T> {
                    return cb({
                        executeQuery: (async () => {
                            throw new Error('Conflict with existing key.');
                        }) as Session['executeQuery'],
                    } as Session);
                },
            },
        } as unknown as Driver;
        const s = new YdbStorage(conflictDriver);

        await expect(s.addMember({ id: 1, type: 'group' }, 'alice')).resolves.toBeUndefined();
    });

    it('removeMember DELETEs from chat_members', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.removeMember({ id: -100, type: 'group' }, 'alice');

        expect(fake.calls[0]?.query).toContain(`DELETE FROM ${TABLES.chatMembers}`);
    });
});

describe('YdbStorage.listTriggers', () => {
    it('parses chat_type + chat_id; numeric id becomes number, non-numeric stays string', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({
            resultSets: [
                {
                    rows: [
                        { items: [{ textValue: 'group' }, { textValue: '-100123' }] },
                        { items: [{ textValue: 'supergroup' }, { textValue: 'abc-xyz' }] },
                        { items: [{ textValue: 'private' }, { textValue: '77' }] },
                    ],
                },
            ],
        });
        const storage = new YdbStorage(fake.driver);

        const triggers = await storage.listTriggers();

        expect(triggers).toEqual([
            { type: 'group', id: -100123 },
            { type: 'supergroup', id: 'abc-xyz' },
            { type: 'private', id: 77 },
        ]);
    });

    it('returns [] when no triggers', async () => {
        const fake = makeFakeDriver();
        fake.responses.push({ resultSets: [{ rows: [] }] });
        const storage = new YdbStorage(fake.driver);

        await expect(storage.listTriggers()).resolves.toEqual([]);
    });
});

describe('YdbStorage.clearChat', () => {
    it('issues two DELETEs in a single statement (no round_served any more)', async () => {
        const fake = makeFakeDriver();
        const storage = new YdbStorage(fake.driver);

        await storage.clearChat({ id: -100, type: 'group' });

        expect(fake.calls).toHaveLength(1);
        const q = fake.calls[0]?.query ?? '';
        expect(q).toContain(`DELETE FROM ${TABLES.chatMembers}`);
        expect(q).toContain(`DELETE FROM ${TABLES.chatProps}`);
        expect(q).not.toContain('round_served');
    });
});
