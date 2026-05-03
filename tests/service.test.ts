import { describe, it, expect, beforeEach } from 'vitest';

import { Service } from '../src/service';
import { ServiceError } from '../src/errors';
import { InMemoryStorage } from '../src/storage/memory';
import type { Storage } from '../src/storage/types';
import type { DomainChat } from '../src/types';

const chat: DomainChat = { id: -100123, type: 'group', title: 'TestChat' };

let storage: InMemoryStorage;
let service: Service;

beforeEach(() => {
    storage = new InMemoryStorage();
    service = new Service(storage);
});

describe('Service.reg — chat WITHOUT properties (self-heal)', () => {
    it('creates user and reports count derived from member list', async () => {
        const result = await service.reg(chat, 'alice');

        expect(result).toContain('@alice');
        expect(result).toContain('Количество дежурных: 1');
    });
});

describe('Service.reg — chat WITH properties', () => {
    it('appends user and reports count = existing users + 1', async () => {
        await service.reg(chat, 'alice');
        const result = await service.reg(chat, 'bob');

        expect(result).toContain('@bob');
        expect(result).toContain('Количество дежурных: 2');
    });

    it('returns "уже добавлен" without storage write when user exists', async () => {
        await service.reg(chat, 'alice');
        const before = (await storage.getChatState(chat)).members.length;

        const result = await service.reg(chat, 'alice');

        expect(result).toBe('Пользователь @alice уже добавлен.');
        expect((await storage.getChatState(chat)).members.length).toBe(before);
    });
});

describe('Service.unreg — chat WITHOUT properties (self-heal)', () => {
    it('removes user and reports count from member list', async () => {
        await service.reg(chat, 'alice');
        const result = await service.unreg(chat, 'alice');

        expect(result).toContain('@alice');
        expect(result).toContain('Количество дежурных: 0');
    });

    it('returns "уже удалён" when user does not exist', async () => {
        const result = await service.unreg(chat, 'ghost');

        expect(result).toBe('Пользователь @ghost уже удалён.');
    });
});

describe('Service.duty — chat WITHOUT properties (self-heal + dutyCount=1 default)', () => {
    it('does not throw, picks 1 person (lowest-count, alpha tiebreak)', async () => {
        await service.reg(chat, 'bob');
        await service.reg(chat, 'alice');
        await service.reg(chat, 'carol');

        const duty = await service.duty(chat);

        // Все при счёте 0, alpha tiebreak → @alice.
        expect(duty).toEqual(['@alice']);
        const counts = Object.fromEntries(
            (await storage.getChatState(chat)).members.map((m) => [m.username, m.servedCount]),
        );
        expect(counts).toEqual({ alice: 1, bob: 0, carol: 0 });
    });
});

describe('Service.setDutyCount', () => {
    it('persists props and does not throw on chat without properties', async () => {
        const result = await service.setDutyCount(chat, 3);

        expect(result).toBe(3);
        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(3);
    });

    it('does not reset existing servedCount when changing dutyCount', async () => {
        await service.reg(chat, 'alice');
        await service.duty(chat); // alice: 1

        await service.setDutyCount(chat, 5);

        const counts = Object.fromEntries(
            (await storage.getChatState(chat)).members.map((m) => [m.username, m.servedCount]),
        );
        expect(counts).toEqual({ alice: 1 });
    });
});

describe('Service.init — defaults', () => {
    it('uses dutyCount=1 by default', async () => {
        await service.init(chat);

        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(1);
    });

    it('returns "уже создано" when properties already exist and does NOT overwrite', async () => {
        await service.init(chat);
        await service.setDutyCount(chat, 7);

        const result = await service.init(chat);

        expect(result).toContain('уже создано');
        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(7);
    });
});

describe('Service.duty — error propagation', () => {
    it('wraps non-ServiceError storage failures from getChatState in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async getChatState() {
                throw new Error('AccessDenied');
            },
        };
        const svc = new Service(failing);

        await expect(svc.duty(chat)).rejects.toThrow(ServiceError);
    });
});

describe('Service.duty — pick by lowest servedCount, alpha tiebreak', () => {
    it('picks the member with the lowest servedCount; among ties, alpha first', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.reg(chat, 'carol');
        await storage.setProperties(chat, { dutyCount: 1 });
        // bump alice and bob; carol stays at 0.
        await storage.incrementServeCounts(chat, ['alice', 'bob']);

        const duty = await service.duty(chat);

        expect(duty).toEqual(['@carol']);
        const counts = Object.fromEntries(
            (await storage.getChatState(chat)).members.map((m) => [m.username, m.servedCount]),
        );
        expect(counts).toEqual({ alice: 1, bob: 1, carol: 1 });
    });

    it('with dutyCount=2 and three at count=0, picks alpha pair and increments only those', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.reg(chat, 'carol');
        await storage.setProperties(chat, { dutyCount: 2 });

        const duty = await service.duty(chat);

        expect([...duty].sort()).toEqual(['@alice', '@bob']);
        const counts = Object.fromEntries(
            (await storage.getChatState(chat)).members.map((m) => [m.username, m.servedCount]),
        );
        expect(counts).toEqual({ alice: 1, bob: 1, carol: 0 });
    });

    it('a freshly /reg-d member has servedCount=0 and goes to the front of the queue', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.setProperties(chat, { dutyCount: 1 });
        // alice and bob have served 5 times each.
        for (let i = 0; i < 5; i++) await storage.incrementServeCounts(chat, ['alice', 'bob']);

        await service.reg(chat, 'carol'); // newcomer

        const duty = await service.duty(chat);
        expect(duty).toEqual(['@carol']);
    });
});

describe('Service.duty — dutyCount > available users', () => {
    it('truncates pick to the entire member set', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.setProperties(chat, { dutyCount: 10 });

        const duty = await service.duty(chat);

        expect([...duty].sort()).toEqual(['@alice', '@bob']);
    });
});

describe('Service.duty — empty user list', () => {
    it('returns [] without writing anything', async () => {
        await storage.setProperties(chat, { dutyCount: 2 });

        const duty = await service.duty(chat);

        expect(duty).toEqual([]);
        expect((await storage.getChatState(chat)).members).toEqual([]);
    });
});

describe('Service.getChats — returns triggers via storage', () => {
    it('returns chats with mixed numeric and string ids', async () => {
        await storage.setTrigger({ id: -100123, type: 'group' }, 9);
        await storage.setTrigger({ id: 'abc-xyz', type: 'supergroup' }, 9);
        await storage.setTrigger({ id: 77, type: 'private' }, 9);

        const chats = await service.getChats();

        expect([...chats].sort((a, b) => String(a.id).localeCompare(String(b.id)))).toEqual(
            [
                { id: -100123, type: 'group' },
                { id: 77, type: 'private' },
                { id: 'abc-xyz', type: 'supergroup' },
            ].sort((a, b) => String(a.id).localeCompare(String(b.id))),
        );
    });

    it('returns [] when there are no triggers', async () => {
        await expect(service.getChats()).resolves.toEqual([]);
    });

    it('wraps storage errors in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async listTriggers() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.getChats()).rejects.toThrow(/тригеров/);
    });
});

describe('Service.triggerOn / triggerOff', () => {
    it('triggerOn writes trigger', async () => {
        const msg = await service.triggerOn(chat);

        expect(msg).toContain('создан');
        const triggers = await storage.listTriggers();
        expect(triggers).toContainEqual({ id: chat.id, type: chat.type });
    });

    it('triggerOn wraps storage errors in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async setTrigger() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.triggerOn(chat)).rejects.toThrow(/триггера/);
    });

    it('triggerOff removes the trigger', async () => {
        await service.triggerOn(chat);
        const msg = await service.triggerOff(chat);

        expect(msg).toContain('удалён');
        expect(await storage.listTriggers()).toEqual([]);
    });

    it('triggerOff wraps storage errors in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async removeTrigger() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.triggerOff(chat)).rejects.toThrow(/удалении триггера/);
    });
});

describe('Service.init — error path', () => {
    it('wraps setProperties failure in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async propsExists() {
                return false;
            },
            async setProperties() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.init(chat)).rejects.toThrow(/создании хранилища/);
    });

    it('wraps propsExists failure in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async propsExists() {
                throw new Error('denied');
            },
        };
        const svc = new Service(failing);

        await expect(svc.init(chat)).rejects.toThrow(/проверке хранилища/);
    });
});

describe('Service.clear', () => {
    it('removes members + props (counters disappear) and the trigger', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.incrementServeCounts(chat, ['alice', 'bob', 'alice']);
        await service.triggerOn(chat);

        await service.clear(chat);

        const state = await storage.getChatState(chat);
        expect(state.members).toEqual([]);
        expect(await storage.propsExists(chat)).toBe(false);
        expect(await storage.listTriggers()).toEqual([]);
    });

    it('tolerates triggerOff failure', async () => {
        await service.reg(chat, 'alice');
        const failing: Storage = {
            ...storage,
            clearChat(c) {
                return storage.clearChat(c);
            },
            async removeTrigger() {
                throw new Error('trigger-off failed');
            },
        };
        const svc = new Service(failing);

        await expect(svc.clear(chat)).resolves.toBeUndefined();
    });

    it('wraps clearChat failure in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async clearChat() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.clear(chat)).rejects.toThrow(/очистке хранилища/);
    });
});

describe('Service.reset', () => {
    it('clears the chat (incl. counters) and re-initialises properties', async () => {
        await service.reg(chat, 'alice');
        await storage.incrementServeCounts(chat, ['alice']);
        await service.setDutyCount(chat, 3);

        const msg = await service.reset(chat);

        expect(msg).toContain('создано');
        const state = await storage.getChatState(chat);
        expect(state.members).toEqual([]);
        expect(state.props.dutyCount).toBe(1);
    });
});

describe('Service.list', () => {
    it('returns @-prefixed names with served counts', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.incrementServeCounts(chat, ['alice', 'alice', 'bob']);

        const users = await service.list(chat);

        expect([...users].sort()).toEqual(['@alice (2)', '@bob (1)']);
    });

    it('wraps storage failure in ServiceError', async () => {
        const failing: Storage = {
            ...new InMemoryStorage(),
            async getChatState() {
                throw new Error('boom');
            },
        };
        const svc = new Service(failing);

        await expect(svc.list(chat)).rejects.toThrow(/списка дежурных/);
    });
});
