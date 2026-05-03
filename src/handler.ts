import type { Update } from 'telegraf/types';

import type { Controller } from './controller';
import type { HandlerResponse, YcEvent, YcFunctionContext } from './types';
import { formatError } from './controller';

export interface HandlerDeps {
    controller: Controller;
}

export type Handler = (event: YcEvent, ctx: YcFunctionContext) => Promise<HandlerResponse>;

export function createHandler(deps: HandlerDeps): Handler {
    return async (event, _ctx) => {
        if ('messages' in event) {
            await deps.controller.trigger();
            return { statusCode: 200, body: '' };
        }

        if (event.body) {
            try {
                const update = JSON.parse(event.body) as Update;
                await deps.controller.handleUpdate(update);
            } catch (e) {
                console.error('handleUpdate failed:', formatError(e));
            }
        }

        return { statusCode: 200, body: '' };
    };
}
