/**
 * Rotation analysis tests.
 *
 * These tests use a stateful in-memory S3 mock to simulate multi-day rotations
 * end-to-end, so we can characterise the actual behaviour of `Service.duty`
 * across rounds — not just a single call.
 */
import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const chat: DomainChat = { id: -100, type: 'group', title: 'TestChat' };

function jsonBody(text: string) {
    const stream = new Readable();
    stream.push(text);
    stream.push(null);
    return sdkStreamMixin(stream);
}

function notFound(): Error {
    const e = new Error('NoSuchKey');
    e.name = 'NoSuchKey';
    (e as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return e;
}

const s3Mock = mockClient(S3Client);

/**
 * Wires the s3Mock so that all commands read/write a shared in-memory Map.
 * Returns the Map so tests can inspect post-state.
 */
function makeBucket(initial: Record<string, string>): Map<string, string> {
    const bucket = new Map(Object.entries(initial));

    s3Mock.on(GetObjectCommand).callsFake((input) => {
        const key = input.Key as string;
        if (!bucket.has(key)) throw notFound();
        return { Body: jsonBody(bucket.get(key) ?? '') };
    });
    s3Mock.on(PutObjectCommand).callsFake((input) => {
        bucket.set(input.Key as string, String(input.Body ?? ''));
        return {};
    });
    s3Mock.on(HeadObjectCommand).callsFake((input) => {
        if (!bucket.has(input.Key as string)) throw notFound();
        return {};
    });
    s3Mock.on(DeleteObjectCommand).callsFake((input) => {
        bucket.delete(input.Key as string);
        return {};
    });
    s3Mock.on(DeleteObjectsCommand).callsFake((input) => {
        for (const o of input.Delete?.Objects ?? []) bucket.delete(o.Key as string);
        return {};
    });
    s3Mock.on(ListObjectsV2Command).callsFake((input) => {
        const prefix = (input.Prefix as string) ?? '';
        const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { Contents: keys.map((k) => ({ Key: k })) };
    });

    return bucket;
}

const chatKey = (name: string) => `${chat.type}/${chat.id}/${name}`;

const readProps = (bucket: Map<string, string>): Properties =>
    JSON.parse(bucket.get(chatKey('properties.json')) ?? '{}');

beforeEach(() => {
    s3Mock.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ──────────────────────────────────────────────────────────────────────────
 * BUG #1 — dutyCount=2 with 3 users locks into a [pair]/[solo] cycle forever.
 *          The third user is never paired. Independent of shuffle.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation BUG: dutyCount=2 with 3 users locks pair/solo (real Math.random)', () => {
    it('only ONE pair is ever produced over 50 days — whichever was randomly chosen on day 1', async () => {
        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, lastDuty: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const seenPairs = new Set<string>();
        for (let day = 0; day < 50; day++) {
            const duty = await service.duty(chat);
            if (duty.length === 2) seenPairs.add([...duty].sort().join(','));
        }

        // Smoking gun: after day-1 picks any random pair, the third person
        // becomes the *only* user not in lastDuty, so day 2 forces a solo on them.
        // Day 3 then forces the original pair back. Cycle locks forever.
        expect(seenPairs.size).toBe(1);
    });
});

describe('rotation BUG: dutyCount=2 with 3 users — deterministic day-by-day trace', () => {
    it('produces [a,b] / [c] / [a,b] / [c] when shuffle is frozen', async () => {
        // sort comparator returns 0 → stable order → deterministic trace.
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, lastDuty: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const picks: string[][] = [];
        for (let day = 0; day < 4; day++) picks.push([...(await service.duty(chat))]);

        expect(picks[0]).toEqual(['@alice', '@bob']);
        expect(picks[1]).toEqual(['@carol']);
        expect(picks[2]).toEqual(['@alice', '@bob']);
        expect(picks[3]).toEqual(['@carol']);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * USER-REPORTED scenario: 3 people, one /unreg's for vacation, then /reg's back.
 * After the return the third person is (allegedly) "не участвует".
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: user-reported vacation scenario (dutyCount=2)', () => {
    it('@carol unreg + re-reg → carol is only ever picked solo, never re-paired', async () => {
        // Pre-state: bot has been running with @alice, @bob, @carol; dutyCount=2;
        // last batch was [@alice, @bob]; @carol is on vacation, so registry has only a/b.
        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, lastDuty: ['@alice', '@bob'] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
        });
        const service = new Service(new S3Client({}));

        // @carol is back from vacation
        await service.reg(chat, 'carol');

        const seenPairs = new Set<string>();
        let carolSolos = 0;
        for (let day = 0; day < 30; day++) {
            const duty = await service.duty(chat);
            if (duty.length === 2) seenPairs.add([...duty].sort().join(','));
            if (duty.length === 1 && duty[0] === '@carol') carolSolos++;
        }

        // @carol is permanently the solo; @alice + @bob are permanently the pair.
        expect(seenPairs).toEqual(new Set(['@alice,@bob']));
        expect(carolSolos).toBeGreaterThan(0);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * BUG #2 — `unreg` does not clean the user out of `lastDuty`.
 *          Doesn't break correctness today (filter is by name), but is a smell.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation BUG: unreg leaves stale entry in lastDuty', () => {
    it('after unreg, properties.lastDuty still references the removed user', async () => {
        const bucket = makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 1, lastDuty: ['@alice'] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
        });
        const service = new Service(new S3Client({}));

        await service.unreg(chat, 'alice');

        expect(readProps(bucket).lastDuty).toContain('@alice');
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount=1 with 3 users — fairness analysis.
 * No deterministic lock-in (filter always leaves 2 candidates, real shuffle picks 1).
 * But the algorithm has NO long-term memory, so a streak of bad luck CAN starve
 * one user. With real Math.random, the chain is symmetric → uniform on average.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount=1 with 3 users — fairness depends on real randomness', () => {
    it('with shuffle frozen, @carol is never picked over 30 days (NO fairness guarantee)', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 1, lastDuty: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const counts: Record<string, number> = { '@alice': 0, '@bob': 0, '@carol': 0 };
        for (let day = 0; day < 30; day++) {
            const [pick] = await service.duty(chat);
            if (pick) counts[pick] = (counts[pick] ?? 0) + 1;
        }

        // The algorithm only remembers the *last* pick. With deterministic shuffle,
        // the filtered list is always alphabetical; slice(0,1) always takes the
        // smallest non-lastDuty user → rotation oscillates a → b → a → b, never c.
        expect(counts['@carol']).toBe(0);
        expect((counts['@alice'] ?? 0) + (counts['@bob'] ?? 0)).toBe(30);
    });

    it('with REAL Math.random, all three users are picked over 100 days (Markov-fair on average)', async () => {
        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 1, lastDuty: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const counts: Record<string, number> = { '@alice': 0, '@bob': 0, '@carol': 0 };
        for (let day = 0; day < 100; day++) {
            const [pick] = await service.duty(chat);
            if (pick) counts[pick] = (counts[pick] ?? 0) + 1;
        }

        // Symmetric 2-state-per-step Markov chain → stationary distribution is ~uniform.
        expect(counts['@alice']).toBeGreaterThan(0);
        expect(counts['@bob']).toBeGreaterThan(0);
        expect(counts['@carol']).toBeGreaterThan(0);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * Healthy rotation cases — confirm the algorithm is fine when dutyCount==users.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount == users — round-complete branch returns the same set', () => {
    it('does not re-pick when dutyCount equals user count (and writes nothing)', async () => {
        const bucket = makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 3, lastDuty: ['@alice', '@bob', '@carol'] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const before = bucket.get(chatKey('properties.json'));
        const duty = await service.duty(chat);
        const after = bucket.get(chatKey('properties.json'));

        expect([...duty].sort()).toEqual(['@alice', '@bob', '@carol']);
        expect(after).toBe(before); // round-complete branch must NOT write
    });
});
