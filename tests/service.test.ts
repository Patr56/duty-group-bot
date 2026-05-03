import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import {
    S3Client,
    HeadObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import { Service } from '../src/service';
import type { DomainChat, Properties } from '../src/types';

const BUCKET = 'duty-group-bot-storage';
const chat: DomainChat = { id: -100123, type: 'group', title: 'TestChat' };
const propertiesKey = `${chat.type}/${chat.id}/properties.json`;
const chatPrefix = `${chat.type}/${chat.id}/`;

function jsonBody(obj: unknown) {
    const stream = new Readable();
    stream.push(JSON.stringify(obj));
    stream.push(null);
    return sdkStreamMixin(stream);
}

function notFound() {
    const e = new Error('Not found');
    e.name = 'NoSuchKey';
    (e as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return e;
}

const s3Mock = mockClient(S3Client);

beforeEach(() => {
    s3Mock.reset();
});

function makeService() {
    return new Service(new S3Client({}));
}

describe('Service.reg — chat WITHOUT properties.json (self-heal)', () => {
    it('creates user key and reports count derived from list, not from missing properties', async () => {
        // Arrange: properties.json is missing; user does not exist; after PutObject the chat has 1 user.
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@alice` }).rejects(notFound());
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@alice` }).resolves({});
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [{ Key: `${chatPrefix}@alice` }],
        });
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({});

        const service = makeService();

        // Act
        const result = await service.reg(chat, 'alice');

        // Assert: no exception, count comes from real list (1), not from a stale counter (0).
        expect(result).toContain('@alice');
        expect(result).toContain('Количество дежурных: 1');
    });
});

describe('Service.reg — chat WITH properties.json', () => {
    it('appends user and reports count = existing users + 1', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@bob` }).rejects(notFound());
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@bob` }).resolves({});
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}properties.json` },
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
            ],
        });

        const service = makeService();
        const result = await service.reg(chat, 'bob');

        expect(result).toContain('@bob');
        expect(result).toContain('Количество дежурных: 2'); // 2 user-keys, properties.json is filtered
    });

    it('returns "уже добавлен" without PutObject when user exists', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@alice` }).resolves({});

        const service = makeService();
        const result = await service.reg(chat, 'alice');

        expect(result).toBe('Пользователь @alice уже добавлен.');
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });
});

describe('Service.unreg — chat WITHOUT properties.json (self-heal)', () => {
    it('removes user key and reports count from list', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@alice` }).resolves({});
        s3Mock.on(DeleteObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@alice` }).resolves({});
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [], // nobody left
        });
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({});

        const service = makeService();
        const result = await service.unreg(chat, 'alice');

        expect(result).toContain('@alice');
        expect(result).toContain('Количество дежурных: 0');
    });

    it('returns "уже удалён" without DeleteObject when user does not exist', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: `${chatPrefix}@ghost` }).rejects(notFound());

        const service = makeService();
        const result = await service.unreg(chat, 'ghost');

        expect(result).toBe('Пользователь @ghost уже удалён.');
        expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });
});

describe('Service.duty — chat WITHOUT properties.json (self-heal + new dutyCount default)', () => {
    it('does not throw, picks 1 person (new default), and persists properties.json', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: `${chatPrefix}@carol` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());

        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        expect(duty).toHaveLength(1);
        expect(['@alice', '@bob', '@carol']).toContain(duty[0]);

        // properties.json got written with new dutyCount default
        expect(writes).toHaveLength(1);
        expect(writes[0]?.dutyCount).toBe(1);
        expect(writes[0]?.roundServed).toEqual(duty);
    });
});

describe('Service.setDutyCount — chat WITHOUT properties.json (self-heal)', () => {
    it('persists properties with the new dutyCount and does not throw', async () => {
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());

        let written: Properties | undefined;
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            written = JSON.parse(input.Body as string);
            return {};
        });

        const service = makeService();
        const result = await service.setDutyCount(chat, 3);

        expect(result).toBe(3);
        expect(written?.dutyCount).toBe(3);
    });
});

describe('Service.init — defaults', () => {
    it('uses dutyCount=1 by default', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());

        let written: Properties | undefined;
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            written = JSON.parse(input.Body as string);
            return {};
        });

        const service = makeService();
        await service.init(chat);

        expect(written?.dutyCount).toBe(1);
        expect(written?.roundServed).toEqual([]);
    });
});

describe('Service._getProperties via duty — non-404 errors still bubble up', () => {
    it('raises ServiceError when GetObject fails with a non-404 error (e.g. permission denied)', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [{ Key: `${chatPrefix}@alice` }],
        });
        const denied = new Error('AccessDenied');
        denied.name = 'AccessDenied';
        (denied as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 403 };
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(denied);

        const service = makeService();
        await expect(service.duty(chat)).rejects.toThrow(/настроек/);
    });
});

describe('Service.duty — happy path with existing properties.json', () => {
    it('excludes users already served in current round and accumulates new pick into roundServed', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: `${chatPrefix}@carol` },
                { Key: `${chatPrefix}properties.json` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 2, roundServed: ['@alice'] }),
        });
        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        expect(duty).toHaveLength(2);
        expect(duty).not.toContain('@alice'); // alice already in roundServed, must be excluded
        expect(writes[0]?.dutyCount).toBe(2);
        // roundServed accumulates: prior + new pick
        expect([...(writes[0]?.roundServed ?? [])].sort())
            .toEqual(['@alice', '@bob', '@carol']);
    });
});

describe('Service.duty — back-compat with legacy `lastDuty` field', () => {
    it('reads pre-fix properties.json (lastDuty field) as if it were roundServed', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: `${chatPrefix}@carol` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 1, lastDuty: ['@alice'] }), // legacy schema
        });
        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        // legacy lastDuty=[@alice] is honored as roundServed → @alice is excluded
        expect(duty).not.toContain('@alice');
        // and the next write uses the new field name
        expect(writes[0]?.roundServed).toBeDefined();
        expect(writes[0]).not.toHaveProperty('lastDuty');
    });
});

describe('Service.duty — round exhausted: resets and picks again from full list', () => {
    it('when every user has served, resets roundServed and picks fresh', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 2, roundServed: ['@bob', '@alice'] }), // round exhausted
        });
        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        // After reset, eligible == users → pick all 2.
        expect([...duty].sort()).toEqual(['@alice', '@bob']);
        // Properties IS written (round restarts with the new pick).
        expect(writes).toHaveLength(1);
        expect([...(writes[0]?.roundServed ?? [])].sort()).toEqual(['@alice', '@bob']);
    });
});

describe('Service.duty — dutyCount > available users in current round', () => {
    it('truncates pick to the eligible subset', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 10, roundServed: ['@alice'] }),
        });
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({});

        const service = makeService();
        const duty = await service.duty(chat);

        expect(duty).toEqual(['@bob']);
    });
});

describe('Service.duty — empty user list', () => {
    it('returns [] and writes empty roundServed (round resets to clean state)', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [{ Key: `${chatPrefix}properties.json` }],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 1, roundServed: ['@stale'] }),
        });
        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        expect(duty).toEqual([]);
        expect(writes[0]?.roundServed).toEqual([]);
    });
});

describe('Service.getChats — parsing of trigger keys', () => {
    it('parses numeric and string ids, skips malformed entries', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: 'trigger/' }).resolves({
            Contents: [
                { Key: 'trigger/group@-100123' },        // numeric id
                { Key: 'trigger/supergroup@abc-xyz' },   // non-numeric id stays string
                { Key: 'trigger/private@77' },
                { Key: 'trigger/no-separator' },         // malformed — no @
                { Key: 'trigger/' },                     // empty tail
                {},                                       // missing Key entirely
            ],
        });

        const service = makeService();
        const chats = await service.getChats();

        expect(chats).toEqual([
            { id: -100123, type: 'group' },
            { id: 'abc-xyz', type: 'supergroup' },
            { id: 77, type: 'private' },
        ]);
    });

    it('returns [] when bucket has no triggers', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: 'trigger/' }).resolves({});

        const service = makeService();
        await expect(service.getChats()).resolves.toEqual([]);
    });

    it('wraps S3 errors in ServiceError', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: 'trigger/' }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.getChats()).rejects.toThrow(/тригеров/);
    });
});

describe('Service.triggerOn / triggerOff', () => {
    const triggerKey = `trigger/${chat.type}@${chat.id}`;

    it('triggerOn writes trigger key with default time=9', async () => {
        let written: { time?: number } | undefined;
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: triggerKey }).callsFake((input) => {
            written = JSON.parse(input.Body as string);
            return {};
        });

        const service = makeService();
        const msg = await service.triggerOn(chat);

        expect(written?.time).toBe(9);
        expect(msg).toContain('создан');
    });

    it('triggerOn wraps S3 errors in ServiceError', async () => {
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: triggerKey }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.triggerOn(chat)).rejects.toThrow(/триггера/);
    });

    it('triggerOff deletes the trigger key', async () => {
        s3Mock.on(DeleteObjectCommand, { Bucket: BUCKET, Key: triggerKey }).resolves({});

        const service = makeService();
        const msg = await service.triggerOff(chat);

        expect(msg).toContain('удалён');
        expect(s3Mock.commandCalls(DeleteObjectCommand, { Key: triggerKey })).toHaveLength(1);
    });

    it('triggerOff wraps S3 errors in ServiceError', async () => {
        s3Mock.on(DeleteObjectCommand, { Bucket: BUCKET, Key: triggerKey }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.triggerOff(chat)).rejects.toThrow(/удалении триггера/);
    });
});

describe('Service.init — already exists / error', () => {
    it('returns "уже создано" when properties.json exists and does NOT write it', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({});

        const service = makeService();
        const result = await service.init(chat);

        expect(result).toContain('уже создано');
        expect(s3Mock.commandCalls(PutObjectCommand, { Key: propertiesKey })).toHaveLength(0);
    });

    it('wraps PutObject failure in ServiceError', async () => {
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.init(chat)).rejects.toThrow(/создании хранилища/);
    });

    it('wraps non-404 HeadObject failure in ServiceError', async () => {
        const denied = new Error('denied');
        denied.name = 'AccessDenied';
        (denied as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 403 };
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(denied);

        const service = makeService();
        await expect(service.init(chat)).rejects.toThrow(/проверке хранилища/);
    });
});

describe('Service.clear', () => {
    it('deletes user keys + properties.json and tolerates triggerOff failure', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: `${chatPrefix}properties.json` },
            ],
        });
        let deletedKeys: string[] = [];
        s3Mock.on(DeleteObjectsCommand, { Bucket: BUCKET }).callsFake((input) => {
            deletedKeys = (input.Delete?.Objects ?? []).map((o: { Key?: string }) => o.Key ?? '');
            return {};
        });
        // triggerOff is best-effort: even if it fails, clear() must not throw.
        s3Mock.on(DeleteObjectCommand).rejects(new Error('trigger-off failed'));

        const service = makeService();
        await expect(service.clear(chat)).resolves.toBeUndefined();

        expect(deletedKeys.sort()).toEqual([
            `${chatPrefix}@alice`,
            `${chatPrefix}@bob`,
            `${chatPrefix}properties.json`,
        ].sort());
    });

    it('still issues a DeleteObjects (with just properties.json) when no users registered', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({ Contents: [] });
        const calls: string[][] = [];
        s3Mock.on(DeleteObjectsCommand, { Bucket: BUCKET }).callsFake((input) => {
            calls.push((input.Delete?.Objects ?? []).map((o: { Key?: string }) => o.Key ?? ''));
            return {};
        });
        s3Mock.on(DeleteObjectCommand).resolves({});

        const service = makeService();
        await service.clear(chat);

        // Always at least properties.json is queued for deletion.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([`${chatPrefix}properties.json`]);
    });

    it('wraps DeleteObjects failure in ServiceError', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [{ Key: `${chatPrefix}@alice` }],
        });
        s3Mock.on(DeleteObjectsCommand, { Bucket: BUCKET }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.clear(chat)).rejects.toThrow(/очистке хранилища/);
    });
});

describe('Service.reset', () => {
    it('clears the chat and re-initialises properties.json', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [{ Key: `${chatPrefix}@alice` }],
        });
        s3Mock.on(DeleteObjectsCommand, { Bucket: BUCKET }).resolves({});
        s3Mock.on(DeleteObjectCommand).resolves({});
        s3Mock.on(HeadObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).rejects(notFound());

        let initBody: Properties | undefined;
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            initBody = JSON.parse(input.Body as string);
            return {};
        });

        const service = makeService();
        const msg = await service.reset(chat);

        expect(msg).toContain('создано');
        expect(initBody).toEqual({ dutyCount: 1, roundServed: [] });
    });
});

describe('Service.list', () => {
    it('filters out properties.json and returns only user keys', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}properties.json` },
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: chatPrefix }, // empty name (the prefix itself) — must be skipped
                {},                  // missing Key
            ],
        });

        const service = makeService();
        const users = await service.list(chat);

        expect(users.sort()).toEqual(['@alice', '@bob']);
    });

    it('wraps S3 failure in ServiceError', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).rejects(new Error('boom'));

        const service = makeService();
        await expect(service.list(chat)).rejects.toThrow(/списка дежурных/);
    });
});
