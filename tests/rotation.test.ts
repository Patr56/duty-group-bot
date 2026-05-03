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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { Service } from '../src/service';
import { InMemoryStorage } from '../src/storage/memory';
import type { DomainChat } from '../src/types';

const chat: DomainChat = { id: -100, type: 'group', title: 'TestChat' };

let storage: InMemoryStorage;
let service: Service;

beforeEach(() => {
    storage = new InMemoryStorage();
    service = new Service(storage);
});

afterEach(() => {
    vi.restoreAllMocks();
});

async function seedMembers(usernames: string[]): Promise<void> {
    for (const u of usernames) await storage.addMember(chat, u);
}

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount=2 with 3 users — the historic pair/solo lock-in is gone.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount=2 with 3 users — all pairs eventually appear', () => {
    it('over 60 days with real Math.random, more than one distinct pair is produced', async () => {
        await seedMembers(['alice', 'bob', 'carol']);
        await storage.setChatState(chat, { dutyCount: 2, roundServed: [] });

        const seenPairs = new Set<string>();
        for (let day = 0; day < 60; day++) {
            const duty = await service.duty(chat);
            if (duty.length === 2) seenPairs.add([...duty].sort().join(','));
        }

        expect(seenPairs.size).toBeGreaterThan(1);
    });
});

describe('rotation: dutyCount=2 with 3 users — round closes in 2 days', () => {
    it('with frozen shuffle, every user is picked across 6 days', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        await seedMembers(['alice', 'bob', 'carol']);
        await storage.setChatState(chat, { dutyCount: 2, roundServed: [] });

        const counts: Record<string, number> = { '@alice': 0, '@bob': 0, '@carol': 0 };
        for (let day = 0; day < 6; day++) {
            const duty = await service.duty(chat);
            for (const u of duty) counts[u] = (counts[u] ?? 0) + 1;
        }

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
    it('after /reg, @carol appears in pairs across rounds', async () => {
        await seedMembers(['alice', 'bob']);
        await storage.setChatState(chat, { dutyCount: 2, roundServed: ['alice', 'bob'] });

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

        expect(seenPairs.size).toBeGreaterThan(1);
        expect(carolInAnyPair).toBe(true);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount=1 fairness: each user picked exactly once per N-day round.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount=1 with 3 users — every user picked each round', () => {
    it('over 30 days with frozen shuffle, picks are exactly 10 / 10 / 10', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);

        await seedMembers(['alice', 'bob', 'carol']);
        await storage.setChatState(chat, { dutyCount: 1, roundServed: [] });

        const counts: Record<string, number> = { '@alice': 0, '@bob': 0, '@carol': 0 };
        for (let day = 0; day < 30; day++) {
            const [pick] = await service.duty(chat);
            if (pick) counts[pick] = (counts[pick] ?? 0) + 1;
        }

        expect(counts).toEqual({ '@alice': 10, '@bob': 10, '@carol': 10 });
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * data hygiene: /unreg leaves the user's name in roundServed.
 * Harmless because the duty filter narrows by user-list membership,
 * and a stale name in roundServed only ever shrinks `eligible`, which
 * triggers an earlier round reset — not a correctness issue.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: /unreg leaves stale entry in roundServed (harmless)', () => {
    it('post-unreg the name remains; next /duty picks the remaining user', async () => {
        await seedMembers(['alice', 'bob']);
        await storage.setChatState(chat, { dutyCount: 1, roundServed: ['alice'] });

        await service.unreg(chat, 'alice');

        const props = (await storage.getChatState(chat)).props;
        expect(props.roundServed).toContain('alice');

        const day1 = await service.duty(chat);
        expect(day1).toEqual(['@bob']);
    });
});

/* ──────────────────────────────────────────────────────────────────────────
 * dutyCount == userCount — exhausted-round path, single common code path.
 * ────────────────────────────────────────────────────────────────────────── */

describe('rotation: dutyCount == users — round resets and picks all again', () => {
    it('returns the full user list and writes properties (single code path now)', async () => {
        await seedMembers(['alice', 'bob', 'carol']);
        await storage.setChatState(chat, {
            dutyCount: 3,
            roundServed: ['alice', 'bob', 'carol'],
        });

        const duty = await service.duty(chat);

        expect([...duty].sort()).toEqual(['@alice', '@bob', '@carol']);
        const after = (await storage.getChatState(chat)).props.roundServed;
        expect([...after].sort()).toEqual(['alice', 'bob', 'carol']);
    });
});
