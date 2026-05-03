import { describe, it, expect, vi } from 'vitest';

import { Controller, formatError } from '../src/controller';
import { ServiceError } from '../src/errors';
import type { Service } from '../src/service';
import type { DomainChat } from '../src/types';

const TOKEN = '123:fake';
const OWNER_ID = '999';

interface SendCall {
    chatId: number | string;
    text: string;
}

function makeController(serviceOverrides: Partial<Service> = {}): {
    controller: Controller;
    service: Partial<Service>;
    sentMessages: SendCall[];
} {
    const sentMessages: SendCall[] = [];
    const service = {
        getChats: vi.fn(async () => [] as DomainChat[]),
        duty: vi.fn(async () => [] as string[]),
        ...serviceOverrides,
    } as Partial<Service>;

    const controller = new Controller(service as Service, TOKEN, OWNER_ID, { functionVersion: 'test' });

    // Stub out the network: we want to capture sent messages, not hit Telegram.
    const bot = controller.getBot();
    bot.telegram.sendMessage = (async (chatId: number | string, text: string) => {
        sentMessages.push({ chatId, text });
        return { message_id: sentMessages.length };
    }) as unknown as typeof bot.telegram.sendMessage;

    return { controller, service, sentMessages };
}

describe('formatError', () => {
    it('returns "<no error>" for null/undefined', () => {
        expect(formatError(undefined)).toBe('<no error>');
        expect(formatError(null)).toBe('<no error>');
    });

    it('formats Error with name, message, and stack', () => {
        const err = new Error('boom');
        const out = formatError(err);
        expect(out).toContain('Error');
        expect(out).toContain('boom');
    });

    it('returns string input as-is', () => {
        expect(formatError('something failed')).toBe('something failed');
    });

    it('JSON-stringifies plain objects', () => {
        expect(formatError({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    });

    it('falls back to String() on circular structures (JSON.stringify throws)', () => {
        const obj: Record<string, unknown> = { name: 'circ' };
        obj.self = obj;
        const out = formatError(obj);
        // Either way, it must not throw and must produce *something* string-ish.
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
    });

    it('formats ServiceError with cause via .stack/.message of the outer error (cause not unwrapped)', () => {
        const err = new ServiceError('outer', new Error('inner'));
        const out = formatError(err);
        expect(out).toContain('ServiceError');
        expect(out).toContain('outer');
    });
});

describe('Controller.pt — pluralizer', () => {
    const { controller } = makeController();

    it('returns single form for 1 item', () => {
        expect(controller.pt(['a'], 'plural', 'single')).toBe('single');
    });

    it('returns plural form for >1 items', () => {
        expect(controller.pt(['a', 'b'], 'plural', 'single')).toBe('plural');
    });

    it('returns single form for empty / undefined', () => {
        expect(controller.pt([], 'plural', 'single')).toBe('single');
        expect(controller.pt(undefined, 'plural', 'single')).toBe('single');
    });
});

describe('Controller.trigger', () => {
    it('returns early without sending anything when getChats returns no chats', async () => {
        const { controller, service, sentMessages } = makeController();

        await controller.trigger();

        expect(service.getChats).toHaveBeenCalledOnce();
        expect(service.duty).not.toHaveBeenCalled();
        expect(sentMessages).toHaveLength(0);
    });

    it('sends "Дежурный на сегодня" with single duty for each chat', async () => {
        const chats: DomainChat[] = [
            { id: -100, type: 'group' },
            { id: -200, type: 'supergroup' },
        ];
        const dutyByChat = new Map<DomainChat['id'], string[]>([
            [-100, ['@alice']],
            [-200, ['@bob', '@carol']],
        ]);
        const { controller, sentMessages } = makeController({
            getChats: vi.fn(async () => chats),
            duty: vi.fn(async (chat: DomainChat) => dutyByChat.get(chat.id) ?? []),
        });

        await controller.trigger();

        expect(sentMessages).toHaveLength(2);
        const byId = new Map(sentMessages.map((m) => [m.chatId, m.text]));

        expect(byId.get(-100)).toBe('Дежурный на сегодня: @alice');
        // For >1 duty, the join uses '\n', so the listing goes on new lines.
        expect(byId.get(-200)).toBe('Дежурные на сегодня: \n@bob\n@carol');
    });

    it('sends fallback "Дежурных нет" when service.duty returns []', async () => {
        const chats: DomainChat[] = [{ id: -100, type: 'group' }];
        const { controller, sentMessages } = makeController({
            getChats: vi.fn(async () => chats),
            duty: vi.fn(async () => []),
        });

        await controller.trigger();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.text).toBe('Дежурных нет. Добавьте людей в список.');
    });

    it('notifies owner and skips chat-level send when getChats throws', async () => {
        const { controller, sentMessages } = makeController({
            getChats: vi.fn(async () => {
                throw new Error('list-failed');
            }),
        });

        await controller.trigger();

        // Only the owner notification is sent, no chat sends.
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]?.chatId).toBe(OWNER_ID);
        expect(sentMessages[0]?.text).toContain('обработке тригера');
    });

    it('isolates per-chat failures: notifies owner for the bad one, still delivers to the good one', async () => {
        const chats: DomainChat[] = [
            { id: -100, type: 'group' },
            { id: -200, type: 'group' },
        ];
        const { controller, sentMessages } = makeController({
            getChats: vi.fn(async () => chats),
            duty: vi.fn(async (chat: DomainChat) => {
                if (chat.id === -100) throw new Error('duty-failed');
                return ['@bob'];
            }),
        });

        await controller.trigger();

        // Owner gets one error notification + chat -200 gets its delivery.
        const ownerMsgs = sentMessages.filter((m) => m.chatId === OWNER_ID);
        const chatMsgs = sentMessages.filter((m) => m.chatId !== OWNER_ID);

        expect(ownerMsgs).toHaveLength(1);
        expect(ownerMsgs[0]?.text).toContain('рассылке тригера для чата -100');

        expect(chatMsgs).toHaveLength(1);
        expect(chatMsgs[0]?.chatId).toBe(-200);
        expect(chatMsgs[0]?.text).toBe('Дежурный на сегодня: @bob');
    });
});
