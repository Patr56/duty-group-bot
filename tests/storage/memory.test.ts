import { describe, it, expect } from 'vitest';

import { InMemoryStorage } from '../../src/storage/memory';
import type { DomainChat } from '../../src/types';

const chat: DomainChat = { id: -100, type: 'group' };

describe('InMemoryStorage — defaults and self-heal', () => {
    it('returns default props and empty members for an unseen chat', async () => {
        const s = new InMemoryStorage();

        const state = await s.getChatState(chat);

        expect(state.props).toEqual({ dutyCount: 1 });
        expect(state.members).toEqual([]);
    });

    it('propsExists is false until setProperties is called', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');

        expect(await s.propsExists(chat)).toBe(false);

        await s.setProperties(chat, { dutyCount: 2 });
        expect(await s.propsExists(chat)).toBe(true);
    });
});

describe('InMemoryStorage — members', () => {
    it('add/remove/exists round-trip', async () => {
        const s = new InMemoryStorage();

        expect(await s.memberExists(chat, 'alice')).toBe(false);
        await s.addMember(chat, 'alice');
        expect(await s.memberExists(chat, 'alice')).toBe(true);

        await s.removeMember(chat, 'alice');
        expect(await s.memberExists(chat, 'alice')).toBe(false);
    });

    it('addMember initialises servedCount = 0', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');

        const state = await s.getChatState(chat);
        expect(state.members).toEqual([{ username: 'alice', servedCount: 0 }]);
    });

    it('addMember is idempotent (does not reset servedCount of existing member)', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.incrementServeCounts(chat, ['alice']);
        await s.incrementServeCounts(chat, ['alice']);
        await s.addMember(chat, 'alice'); // idempotent re-add

        const state = await s.getChatState(chat);
        expect(state.members).toEqual([{ username: 'alice', servedCount: 2 }]);
    });

    it('returned ChatState is a clone — caller mutations do not affect storage', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.setProperties(chat, { dutyCount: 1 });

        const state = await s.getChatState(chat);
        state.members.push({ username: 'bob', servedCount: 0 });
        state.props.dutyCount = 99;

        const fresh = await s.getChatState(chat);
        expect(fresh.members).toEqual([{ username: 'alice', servedCount: 0 }]);
        expect(fresh.props.dutyCount).toBe(1);
    });
});

describe('InMemoryStorage — incrementServeCounts', () => {
    it('bumps the named members by 1', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.addMember(chat, 'bob');
        await s.addMember(chat, 'carol');

        await s.incrementServeCounts(chat, ['alice', 'carol']);

        const counts = Object.fromEntries(
            (await s.getChatState(chat)).members.map((m) => [m.username, m.servedCount]),
        );
        expect(counts).toEqual({ alice: 1, bob: 0, carol: 1 });
    });

    it('multiple invocations accumulate', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.incrementServeCounts(chat, ['alice']);
        await s.incrementServeCounts(chat, ['alice']);
        await s.incrementServeCounts(chat, ['alice']);

        const state = await s.getChatState(chat);
        expect(state.members[0]?.servedCount).toBe(3);
    });

    it('silently skips usernames that are not members (no INSERT)', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');

        await s.incrementServeCounts(chat, ['alice', 'ghost']);

        const state = await s.getChatState(chat);
        expect(state.members).toEqual([{ username: 'alice', servedCount: 1 }]);
    });

    it('empty username list is a no-op', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');

        await s.incrementServeCounts(chat, []);

        expect((await s.getChatState(chat)).members[0]?.servedCount).toBe(0);
    });
});

describe('InMemoryStorage — triggers', () => {
    it('set/list/remove with mixed numeric and string ids', async () => {
        const s = new InMemoryStorage();
        await s.setTrigger({ id: -100, type: 'group' }, 9);
        await s.setTrigger({ id: 'abc-xyz', type: 'supergroup' }, 9);

        const triggers = await s.listTriggers();
        expect(triggers).toEqual([
            { id: -100, type: 'group' },
            { id: 'abc-xyz', type: 'supergroup' },
        ]);

        await s.removeTrigger({ id: -100, type: 'group' });
        expect(await s.listTriggers()).toEqual([{ id: 'abc-xyz', type: 'supergroup' }]);
    });
});

describe('InMemoryStorage — clearChat', () => {
    it('removes members and props (including served counts) but leaves trigger alone', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.incrementServeCounts(chat, ['alice']);
        await s.setProperties(chat, { dutyCount: 2 });
        await s.setTrigger(chat, 9);

        await s.clearChat(chat);

        expect((await s.getChatState(chat)).members).toEqual([]);
        expect(await s.propsExists(chat)).toBe(false);
        expect(await s.listTriggers()).toContainEqual({ id: chat.id, type: chat.type });
    });
});
