import { describe, expect, it, vi } from 'vitest';

import { createHandler } from '../src/handler';
import type { Controller } from '../src/controller';
import type { YcFunctionContext } from '../src/types';

const ctx: YcFunctionContext = { functionVersion: 'test' };

function makeFakeController(overrides: Partial<Pick<Controller, 'trigger' | 'handleUpdate'>> = {}): Controller {
    return {
        trigger: vi.fn(async () => undefined),
        handleUpdate: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as Controller;
}

describe('createHandler', () => {
    it('webhook event with body delegates to controller.handleUpdate and returns 200', async () => {
        const fake = makeFakeController();
        const handler = createHandler({ controller: fake });

        const result = await handler({ body: JSON.stringify({ update_id: 1 }) }, ctx);

        expect(result).toEqual({ statusCode: 200, body: '' });
        expect(fake.handleUpdate).toHaveBeenCalledOnce();
    });

    it('webhook event without body returns 200 without calling handleUpdate', async () => {
        const fake = makeFakeController();
        const handler = createHandler({ controller: fake });

        const result = await handler({}, ctx);

        expect(result).toEqual({ statusCode: 200, body: '' });
        expect(fake.handleUpdate).not.toHaveBeenCalled();
    });

    it('cron event awaits controller.trigger before resolving', async () => {
        let triggerCompleted = false;
        const fake = makeFakeController({
            trigger: vi.fn(async () => {
                await new Promise((resolve) => setImmediate(resolve));
                triggerCompleted = true;
            }),
        });
        const handler = createHandler({ controller: fake });

        const result = await handler({ messages: [] }, ctx);

        expect(triggerCompleted).toBe(true);
        expect(result).toEqual({ statusCode: 200, body: '' });
        expect(fake.trigger).toHaveBeenCalledOnce();
    });

    it('webhook with malformed JSON body does not throw', async () => {
        const fake = makeFakeController();
        const handler = createHandler({ controller: fake });

        const result = await handler({ body: 'not-json' }, ctx);

        expect(result).toEqual({ statusCode: 200, body: '' });
        expect(fake.handleUpdate).not.toHaveBeenCalled();
    });
});
