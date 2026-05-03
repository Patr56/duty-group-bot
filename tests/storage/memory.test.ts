import { describe, it, expect } from 'vitest';

import { InMemoryStorage } from '../../src/storage/memory';
import type { DomainChat } from '../../src/types';

const chat: DomainChat = { id: -100, type: 'group' };

describe('InMemoryStorage — defaults and self-heal', () => {
    it('returns default props and empty members for an unseen chat', async () => {
        const s = new InMemoryStorage();

        const state = await s.getChatState(chat);

        expect(state.props).toEqual({ dutyCount: 1, roundServed: [] });
        expect(state.members).toEqual([]);
    });

    it('propsExists is false until setChatState is called', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');

        expect(await s.propsExists(chat)).toBe(false);

        await s.setChatState(chat, { dutyCount: 2, roundServed: [] });
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

    it('addMember is idempotent (Set semantics)', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.addMember(chat, 'alice');

        expect((await s.getChatState(chat)).members).toEqual(['alice']);
    });

    it('returned ChatState is a clone — caller mutations do not affect storage', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.setChatState(chat, { dutyCount: 1, roundServed: ['alice'] });

        const state = await s.getChatState(chat);
        state.members.push('bob');
        state.props.roundServed.push('bob');

        const fresh = await s.getChatState(chat);
        expect(fresh.members).toEqual(['alice']);
        expect(fresh.props.roundServed).toEqual(['alice']);
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
    it('removes members and props but leaves trigger alone', async () => {
        const s = new InMemoryStorage();
        await s.addMember(chat, 'alice');
        await s.setChatState(chat, { dutyCount: 2, roundServed: ['alice'] });
        await s.setTrigger(chat, 9);

        await s.clearChat(chat);

        expect((await s.getChatState(chat)).members).toEqual([]);
        expect(await s.propsExists(chat)).toBe(false);
        expect(await s.listTriggers()).toContainEqual({ id: chat.id, type: chat.type });
    });
});
