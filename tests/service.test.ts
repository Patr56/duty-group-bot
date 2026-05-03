import { describe, it, expect, beforeEach } from 'vitest';

import { Service } from '../src/service';
import { ServiceError } from '../src/errors';
import { InMemoryStorage } from '../src/storage/memory';
import type { Storage } from '../src/storage/types';
import type { DomainChat, Properties } from '../src/types';

const chat: DomainChat = { id: -100123, type: 'group', title: 'TestChat' };

let storage: InMemoryStorage;
let service: Service;

beforeEach(() => {
    storage = new InMemoryStorage();
    service = new Service(storage);
});

describe('Service.reg — chat WITHOUT properties (self-heal)', () => {
    it('creates user and reports count derived from member list, not from missing properties', async () => {
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
    it('does not throw, picks 1 person, and persists props with default dutyCount', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.reg(chat, 'carol');

        const duty = await service.duty(chat);

        expect(duty).toHaveLength(1);
        expect(['@alice', '@bob', '@carol']).toContain(duty[0]);

        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(1);
        expect(state.props.roundServed).toEqual(duty.map((u) => u.slice(1)));
    });
});

describe('Service.setDutyCount — chat WITHOUT properties (self-heal)', () => {
    it('persists props with the new dutyCount and does not throw', async () => {
        const result = await service.setDutyCount(chat, 3);

        expect(result).toBe(3);
        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(3);
    });

    it('preserves existing roundServed when changing dutyCount', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.duty(chat); // populates roundServed
        const beforeRound = (await storage.getChatState(chat)).props.roundServed;

        await service.setDutyCount(chat, 5);

        const afterRound = (await storage.getChatState(chat)).props.roundServed;
        expect(afterRound).toEqual(beforeRound);
    });
});

describe('Service.init — defaults', () => {
    it('uses dutyCount=1 by default', async () => {
        await service.init(chat);

        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(1);
        expect(state.props.roundServed).toEqual([]);
    });

    it('returns "уже создано" when properties already exist and does NOT overwrite', async () => {
        await service.init(chat);
        await service.setDutyCount(chat, 7); // mutate to detect overwrite

        const result = await service.init(chat);

        expect(result).toContain('уже создано');
        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(7);
    });
});

describe('Service.duty — storage error propagation', () => {
    it('wraps non-ServiceError storage failures from getChatState in ServiceError', async () => {
        const failing: Pick<Storage, 'getChatState'> = {
            async getChatState() {
                throw new Error('AccessDenied');
            },
        };
        const svc = new Service({ ...new InMemoryStorage(), ...failing } as Storage);

        await expect(svc.duty(chat)).rejects.toThrow(ServiceError);
    });
});

describe('Service.duty — happy path with existing properties', () => {
    it('excludes users already served in current round and accumulates new pick into roundServed', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.reg(chat, 'carol');
        await storage.setChatState(chat, { dutyCount: 2, roundServed: ['alice'] });

        const duty = await service.duty(chat);

        expect(duty).toHaveLength(2);
        expect(duty).not.toContain('@alice');

        const state = await storage.getChatState(chat);
        expect(state.props.dutyCount).toBe(2);
        expect([...state.props.roundServed].sort()).toEqual(['alice', 'bob', 'carol']);
    });
});

describe('Service.duty — round exhausted: resets and picks again from full list', () => {
    it('when every user has served, resets roundServed and picks fresh', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.setChatState(chat, { dutyCount: 2, roundServed: ['bob', 'alice'] });

        const duty = await service.duty(chat);

        expect([...duty].sort()).toEqual(['@alice', '@bob']);
        const state = await storage.getChatState(chat);
        expect([...state.props.roundServed].sort()).toEqual(['alice', 'bob']);
    });
});

describe('Service.duty — dutyCount > available users in current round', () => {
    it('truncates pick to the eligible subset', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await storage.setChatState(chat, { dutyCount: 10, roundServed: ['alice'] });

        const duty = await service.duty(chat);

        expect(duty).toEqual(['@bob']);
    });
});

describe('Service.duty — empty user list', () => {
    it('returns [] and writes empty roundServed (round resets to clean state)', async () => {
        await storage.setChatState(chat, { dutyCount: 1, roundServed: ['stale'] });

        const duty = await service.duty(chat);

        expect(duty).toEqual([]);
        const state = await storage.getChatState(chat);
        expect(state.props.roundServed).toEqual([]);
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
        const failing = {
            ...new InMemoryStorage(),
            async listTriggers(): Promise<DomainChat[]> {
                throw new Error('boom');
            },
        } as Storage;
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
        const failing = {
            ...new InMemoryStorage(),
            async setTrigger(): Promise<void> {
                throw new Error('boom');
            },
        } as Storage;
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
        const failing = {
            ...new InMemoryStorage(),
            async removeTrigger(): Promise<void> {
                throw new Error('boom');
            },
        } as Storage;
        const svc = new Service(failing);

        await expect(svc.triggerOff(chat)).rejects.toThrow(/удалении триггера/);
    });
});

describe('Service.init — error path', () => {
    it('wraps setChatState failure in ServiceError', async () => {
        const failing = {
            ...new InMemoryStorage(),
            async propsExists(): Promise<boolean> {
                return false;
            },
            async setChatState(): Promise<void> {
                throw new Error('boom');
            },
        } as Storage;
        const svc = new Service(failing);

        await expect(svc.init(chat)).rejects.toThrow(/создании хранилища/);
    });

    it('wraps propsExists failure in ServiceError', async () => {
        const failing = {
            ...new InMemoryStorage(),
            async propsExists(): Promise<boolean> {
                throw new Error('denied');
            },
        } as Storage;
        const svc = new Service(failing);

        await expect(svc.init(chat)).rejects.toThrow(/проверке хранилища/);
    });
});

describe('Service.clear', () => {
    it('removes members + props and the trigger', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');
        await service.triggerOn(chat);

        await service.clear(chat);

        const state = await storage.getChatState(chat);
        expect(state.members).toEqual([]);
        expect(await storage.propsExists(chat)).toBe(false);
        expect(await storage.listTriggers()).toEqual([]);
    });

    it('tolerates triggerOff failure', async () => {
        await service.reg(chat, 'alice');
        const failing = {
            ...storage,
            async clearChat(c: DomainChat) {
                return storage.clearChat(c);
            },
            async removeTrigger() {
                throw new Error('trigger-off failed');
            },
        } as unknown as Storage;
        const svc = new Service(failing);

        await expect(svc.clear(chat)).resolves.toBeUndefined();
    });

    it('wraps clearChat failure in ServiceError', async () => {
        const failing = {
            ...new InMemoryStorage(),
            async clearChat(): Promise<void> {
                throw new Error('boom');
            },
        } as Storage;
        const svc = new Service(failing);

        await expect(svc.clear(chat)).rejects.toThrow(/очистке хранилища/);
    });
});

describe('Service.reset', () => {
    it('clears the chat and re-initialises properties', async () => {
        await service.reg(chat, 'alice');
        await service.setDutyCount(chat, 3);

        const msg = await service.reset(chat);

        expect(msg).toContain('создано');
        const state = await storage.getChatState(chat);
        expect(state.members).toEqual([]);
        expect(state.props).toEqual<Properties>({ dutyCount: 1, roundServed: [] });
    });
});

describe('Service.list', () => {
    it('returns @-prefixed usernames from storage', async () => {
        await service.reg(chat, 'alice');
        await service.reg(chat, 'bob');

        const users = await service.list(chat);

        expect([...users].sort()).toEqual(['@alice', '@bob']);
    });

    it('wraps storage failure in ServiceError', async () => {
        const failing = {
            ...new InMemoryStorage(),
            async getChatState(): Promise<never> {
                throw new Error('boom');
            },
        } as Storage;
        const svc = new Service(failing);

        await expect(svc.list(chat)).rejects.toThrow(/списка дежурных/);
    });
});
