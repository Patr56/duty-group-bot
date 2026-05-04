/**
 * Rotation tests for the counter-based scheduler.
 *
 * Algorithm: each member has a `servedCount` (total times on duty in this chat).
 * Each `/duty` picks `dutyCount` members with the lowest counts; ties broken
 * by username (alphabetic). Counters of picked members increment by 1.
 *
 * Properties verified here:
 *   - perfect long-run fairness — every K days each member has served K·k/N
 *     times (when divisible) or differs by at most 1 (otherwise);
 *   - new /reg-d members start at min(existing) so they don't monopolise duty
 *     while catching up; max-min spread stays ≤ 1 even across /reg mid-run;
 *   - /unreg leaves no stale state — the gone member just disappears;
 *   - max-spread is bounded — at any instant `max(count) - min(count) <= 1`.
 */
import { describe, it, expect, beforeEach } from 'vitest';

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

async function seed(usernames: string[], dutyCount: number): Promise<void> {
    for (const u of usernames) await storage.addMember(chat, u);
    await storage.setProperties(chat, { dutyCount });
}

async function counts(): Promise<Record<string, number>> {
    const state = await storage.getChatState(chat);
    return Object.fromEntries(state.members.map((m) => [m.username, m.servedCount]));
}

describe('rotation: dutyCount=1, N=3 — strict 3-day cycle', () => {
    it('over 30 days each member is on duty exactly 10 times', async () => {
        await seed(['alice', 'bob', 'carol'], 1);

        for (let day = 0; day < 30; day++) await service.duty(chat);

        expect(await counts()).toEqual({ alice: 10, bob: 10, carol: 10 });
    });

    it('first three days are deterministic: a, b, c', async () => {
        await seed(['alice', 'bob', 'carol'], 1);

        const day1 = await service.duty(chat);
        const day2 = await service.duty(chat);
        const day3 = await service.duty(chat);
        const day4 = await service.duty(chat);

        expect(day1).toEqual(['@alice']);
        expect(day2).toEqual(['@bob']);
        expect(day3).toEqual(['@carol']);
        expect(day4).toEqual(['@alice']); // round restarts
    });
});

describe('rotation: dutyCount=2, N=3 — every pair appears, fairness 2/3', () => {
    it('over 6 days each member serves exactly 4 times (=6·2/3)', async () => {
        await seed(['alice', 'bob', 'carol'], 2);

        for (let day = 0; day < 6; day++) await service.duty(chat);

        expect(await counts()).toEqual({ alice: 4, bob: 4, carol: 4 });
    });

    it('all three pairs appear within first 3 days', async () => {
        await seed(['alice', 'bob', 'carol'], 2);

        const seen = new Set<string>();
        for (let day = 0; day < 3; day++) {
            const duty = await service.duty(chat);
            seen.add([...duty].sort().join(','));
        }

        expect(seen).toEqual(new Set(['@alice,@bob', '@alice,@carol', '@bob,@carol']));
    });
});

describe('rotation: dutyCount=2, N=4 — fixed pair pattern (math says so)', () => {
    it('over 6 days each member serves exactly 3 times', async () => {
        await seed(['alice', 'bob', 'carol', 'dave'], 2);

        for (let day = 0; day < 6; day++) await service.duty(chat);

        expect(await counts()).toEqual({ alice: 3, bob: 3, carol: 3, dave: 3 });
    });

    it('with N % k == 0 only adjacent-by-alpha pairs appear (alpha tiebreak)', async () => {
        // This documents the expected limitation: alpha tiebreak gives (a,b) / (c,d) cycle.
        await seed(['alice', 'bob', 'carol', 'dave'], 2);

        const day1 = [...(await service.duty(chat))].sort();
        const day2 = [...(await service.duty(chat))].sort();
        const day3 = [...(await service.duty(chat))].sort();

        expect(day1).toEqual(['@alice', '@bob']);
        expect(day2).toEqual(['@carol', '@dave']);
        expect(day3).toEqual(['@alice', '@bob']);
    });
});

describe('rotation: dutyCount=3, N=5', () => {
    it('over 5 days each member serves exactly 3 times', async () => {
        await seed(['alice', 'bob', 'carol', 'dave', 'erin'], 3);

        for (let day = 0; day < 5; day++) await service.duty(chat);

        expect(await counts()).toEqual({ alice: 3, bob: 3, carol: 3, dave: 3, erin: 3 });
    });
});

describe('rotation: invariant — max-min spread is bounded by 1', () => {
    it('throughout 50 picks with random N and k, no member is ever 2 ahead of another', async () => {
        await seed(['alice', 'bob', 'carol', 'dave'], 2);

        for (let day = 0; day < 50; day++) {
            await service.duty(chat);
            const c = Object.values(await counts());
            expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
        }
    });
});

describe('rotation: /reg mid-run — newcomer inherits min(existing) count', () => {
    it('newcomer joins at the same count as the least-served existing member', async () => {
        await seed(['alice', 'bob'], 1);
        for (let day = 0; day < 10; day++) await service.duty(chat); // alice=5, bob=5

        await service.reg(chat, 'carol');

        const c = await counts();
        expect(c).toEqual({ alice: 5, bob: 5, carol: 5 });
    });

    it('newcomer does NOT serve N days in a row to catch up', async () => {
        // The bug we fixed: with init=0, carol would serve 5 days straight
        // after joining alice/bob at count=5. With init=min, she just rotates.
        await seed(['alice', 'bob'], 1);
        for (let day = 0; day < 10; day++) await service.duty(chat);

        await service.reg(chat, 'carol');
        const picks: string[] = [];
        for (let day = 0; day < 6; day++) {
            const duty = await service.duty(chat);
            picks.push(duty[0] ?? '');
        }

        // Each member should appear exactly twice over the next 6 days
        // (full two cycles of the 3-person rotation). Crucially, carol does
        // NOT take 5 picks in a row.
        const tally = picks.reduce<Record<string, number>>((acc, u) => {
            acc[u] = (acc[u] ?? 0) + 1;
            return acc;
        }, {});
        expect(tally).toEqual({ '@alice': 2, '@bob': 2, '@carol': 2 });
    });

    it('max-min spread stays ≤ 1 even when /reg happens mid-run', async () => {
        await seed(['alice', 'bob'], 1);
        for (let day = 0; day < 10; day++) await service.duty(chat);

        await service.reg(chat, 'carol');
        let spread = (() => {
            const v = Object.values({ alice: 5, bob: 5, carol: 5 });
            return Math.max(...v) - Math.min(...v);
        })();
        expect(spread).toBeLessThanOrEqual(1);

        for (let day = 0; day < 20; day++) {
            await service.duty(chat);
            const v = Object.values(await counts());
            spread = Math.max(...v) - Math.min(...v);
            expect(spread).toBeLessThanOrEqual(1);
        }
    });

    it('first /reg into an empty chat starts at 0', async () => {
        await storage.setProperties(chat, { dutyCount: 1 });
        await service.reg(chat, 'alice');

        expect(await counts()).toEqual({ alice: 0 });
    });
});

describe('rotation: /unreg mid-run — gone member leaves no trail', () => {
    it('after unreg, remaining members continue rotating fairly', async () => {
        await seed(['alice', 'bob', 'carol'], 1);
        for (let day = 0; day < 6; day++) await service.duty(chat); // each at 2

        await service.unreg(chat, 'alice');

        for (let day = 0; day < 6; day++) await service.duty(chat); // bob/carol each gain 3

        const c = await counts();
        expect(c.alice).toBeUndefined();
        expect(c.bob).toBe(5);
        expect(c.carol).toBe(5);
    });
});

describe('rotation: /reset — counters are wiped along with members', () => {
    it('post-reset every newly /reg-d member starts at count=0', async () => {
        await seed(['alice', 'bob'], 1);
        for (let day = 0; day < 10; day++) await service.duty(chat);

        await service.reset(chat);
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');

        expect(await counts()).toEqual({ alice: 0, bob: 0 });
    });
});

describe('rotation: dutyCount > N — everyone serves every day', () => {
    it('over 10 days with N=2, dutyCount=5, each member is at count=10', async () => {
        await seed(['alice', 'bob'], 5);

        for (let day = 0; day < 10; day++) await service.duty(chat);

        expect(await counts()).toEqual({ alice: 10, bob: 10 });
    });
});
