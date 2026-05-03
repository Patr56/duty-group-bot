/**
 * Rotation behaviour tests — verifies the fairness guarantees of `Service.duty`
 * after the round-accumulator fix.
 *
 * `properties.roundServed` accumulates everyone who served in the current round.
 * When the eligible set drains, the round resets and the next pick comes from
 * the full user list. This guarantees, for any dutyCount and user count:
 *   - within `ceil(N/dutyCount)` calls each user has served at least once
 *   - across enough rounds, every pair (or k-subset) eventually appears
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
import type { DomainChat } from '../src/types';

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

beforeEach(() => {
    s3Mock.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount=2 with 3 users — the historic pair/solo lock-in is gone.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount=2 with 3 users — all pairs eventually appear', () => {
    it('over 60 days with real Math.random, more than one distinct pair is produced', async () => {
        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, roundServed: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const seenPairs = new Set<string>();
        for (let day = 0; day < 60; day++) {
            const duty = await service.duty(chat);
            if (duty.length === 2) seenPairs.add([...duty].sort().join(','));
        }

        // Pre-fix: only one pair (lock-in). Post-fix: at least 2 distinct pairs
        // across 60 days (probability of seeing only one is ~3·(1/3)^20 ≈ 1e-9).
        expect(seenPairs.size).toBeGreaterThan(1);
    });
});

describe('rotation: dutyCount=2 with 3 users — round closes in 2 days', () => {
    it('with frozen shuffle, picks are [a,b] / [c] / [a,b] / [c] but each user is picked', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5); // freeze shuffle for a deterministic trace

        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, roundServed: [] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const counts: Record<string, number> = { '@alice': 0, '@bob': 0, '@carol': 0 };
        for (let day = 0; day < 6; day++) {
            const duty = await service.duty(chat);
            for (const u of duty) counts[u] = (counts[u] ?? 0) + 1;
        }

        // Even with shuffle disabled, the round-reset guarantees @carol is picked.
        // 6 days = 3 rounds of (pair + solo) = pair picked 3×, solo picked 3×.
        expect(counts['@alice']).toBe(3);
        expect(counts['@bob']).toBe(3);
        expect(counts['@carol']).toBe(3);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * USER-REPORTED scenario: 3 people, one /unreg's, then /reg's back.
 * Post-fix the returnee shows up in pairs, not just solo.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: user-reported vacation scenario (dutyCount=2)', () => {
    it('after /unreg + /reg, @carol appears in pairs across rounds', async () => {
        // Pre-state mirrors what the user observed: 2 active users, @carol is on
        // vacation, last batch was [@alice, @bob] (pre-fix schema migration: stored
        // as `lastDuty` in legacy state — back-compat covers it).
        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 2, lastDuty: ['@alice', '@bob'] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
        });
        const service = new Service(new S3Client({}));

        await service.reg(chat, 'carol');

        const seenPairs = new Set<string>();
        let carolInAnyPair = false;
        for (let day = 0; day < 60; day++) {
            const duty = await service.duty(chat);
            if (duty.length === 2) {
                seenPairs.add([...duty].sort().join(','));
                if (duty.includes('@carol')) carolInAnyPair = true;
            }
        }

        expect(seenPairs.size).toBeGreaterThan(1); // multiple pair compositions over time
        expect(carolInAnyPair).toBe(true);          // carol is paired, not just solo
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount=1 fairness: each user picked exactly once per N-day round.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount=1 with 3 users — every user picked each round', () => {
    it('over 30 days with frozen shuffle, picks are exactly 10 / 10 / 10', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 1, roundServed: [] }),
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

        // Pre-fix: @carol got 0 picks under frozen shuffle.
        // Post-fix: round-reset guarantees uniform distribution regardless of shuffle.
        expect(counts).toEqual({ '@alice': 10, '@bob': 10, '@carol': 10 });
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * data hygiene: /unreg still leaves the user's name in roundServed.
 * Harmless because the duty filter narrows by user-list membership,
 * and a stale name in roundServed only ever shrinks `eligible`, which
 * triggers an earlier round reset — not a correctness issue.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: /unreg leaves stale entry in roundServed (harmless)', () => {
    it('post-unreg the name remains in properties.roundServed; next /duty resets cleanly', async () => {
        const bucket = makeBucket({
            [chatKey('properties.json')]: JSON.stringify({ dutyCount: 1, roundServed: ['@alice'] }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
        });
        const service = new Service(new S3Client({}));

        await service.unreg(chat, 'alice');

        const propsRaw = bucket.get(chatKey('properties.json'));
        expect(propsRaw).toBeDefined();
        const props = JSON.parse(propsRaw ?? '{}') as { roundServed: string[] };
        expect(props.roundServed).toContain('@alice'); // stale, but harmless

        // Sanity: next /duty handles the stale entry — only @bob is left, gets picked,
        // and on the call after that the round resets.
        const day1 = await service.duty(chat);
        expect(day1).toEqual(['@bob']);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount == userCount — exhausted-round path, single common code path.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount == users — round resets and picks all again', () => {
    it('returns the full user list and writes properties.json (single code path now)', async () => {
        const bucket = makeBucket({
            [chatKey('properties.json')]: JSON.stringify({
                dutyCount: 3,
                roundServed: ['@alice', '@bob', '@carol'],
            }),
            [chatKey('@alice')]: '',
            [chatKey('@bob')]: '',
            [chatKey('@carol')]: '',
        });
        const service = new Service(new S3Client({}));

        const before = bucket.get(chatKey('properties.json'));
        const duty = await service.duty(chat);
        const after = bucket.get(chatKey('properties.json'));

        expect([...duty].sort()).toEqual(['@alice', '@bob', '@carol']);
        // Always writes — the previous "no-write round-complete" optimisation is gone.
        expect(after).not.toBe(before);
    });
});
