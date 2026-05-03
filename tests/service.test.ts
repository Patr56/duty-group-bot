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
        expect(writes[0]?.lastDuty).toEqual(duty);
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
        expect(written?.lastDuty).toEqual([]);
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
    it('reads dutyCount from existing properties and avoids re-picking the same people in a round', async () => {
        s3Mock.on(ListObjectsV2Command, { Bucket: BUCKET, Prefix: chatPrefix }).resolves({
            Contents: [
                { Key: `${chatPrefix}@alice` },
                { Key: `${chatPrefix}@bob` },
                { Key: `${chatPrefix}@carol` },
                { Key: `${chatPrefix}properties.json` },
            ],
        });
        s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).resolves({
            Body: jsonBody({ dutyCount: 2, lastDuty: ['@alice'] }),
        });
        const writes: Properties[] = [];
        s3Mock.on(PutObjectCommand, { Bucket: BUCKET, Key: propertiesKey }).callsFake((input) => {
            writes.push(JSON.parse(input.Body as string));
            return {};
        });

        const service = makeService();
        const duty = await service.duty(chat);

        expect(duty).toHaveLength(2);
        expect(duty).not.toContain('@alice'); // alice was in lastDuty, must be excluded
        expect(writes[0]?.dutyCount).toBe(2);
    });
});
