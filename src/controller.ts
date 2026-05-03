import { randomUUID } from 'node:crypto';
import { Telegraf, Context } from 'telegraf';
import type { Update } from 'telegraf/types';

import { ServiceError } from './errors';
import { Service } from './service';
import { parseCommandArgs, stripAt } from './util/command';
import { mapWithConcurrency } from './util/concurrency';
import type { DomainChat, YcFunctionContext } from './types';

const MAX_MESSAGE_SIZE = 4000;
const SELF_BOT = 1;
const TRIGGER_CONCURRENCY = 5;

export class Controller {
    private readonly bot: Telegraf;

    constructor(
        private readonly service: Service,
        token: string,
        private readonly ownerId: string,
        private readonly functionContext?: YcFunctionContext,
    ) {
        this.bot = new Telegraf(token);
        this._registerCommands();
    }

    pt<T>(items: readonly T[] | undefined, plural: string, single: string): string {
        return items && items.length > 1 ? plural : single;
    }

    async trigger(): Promise<void> {
        let chats: DomainChat[];
        try {
            chats = await this.service.getChats();
        } catch (e) {
            await this._sendMessageToOwner(`Произошла ошибка, при обработке тригера. ${formatError(e)}`);
            return;
        }
        if (chats.length === 0) return;

        await mapWithConcurrency(chats, TRIGGER_CONCURRENCY, async (chat) => {
            try {
                const duty = await this.service.duty(chat);
                const message = duty.length > 0
                    ? [`Дежурны${this.pt(duty, 'е', 'й')} на сегодня: `, ...duty].join(this.pt(duty, '\n', ''))
                    : 'Дежурных нет. Добавьте людей в список.';
                await this.bot.telegram.sendMessage(chat.id, message, { parse_mode: 'HTML' });
            } catch (e) {
                await this._sendMessageToOwner(
                    `Произошла ошибка, при рассылке тригера для чата ${chat.id}. ${formatError(e)}`,
                );
            }
        });
    }

    getBot(): Telegraf {
        return this.bot;
    }

    private _registerCommands(): void {
        this.bot.catch(async (err, ctx) => {
            await this._handleError(ctx, new ServiceError('В сервисе произошла ошибка.', err));
        });

        this.bot.start(async (ctx) => {
            await this._withChat(ctx, async (chat) => {
                const msg = await this.service.init(chat);
                await this._replyMessage(ctx, msg);
            });
        });

        this.bot.help(async (ctx) => {
            const version = this.functionContext?.functionVersion ?? 'unknown';
            const help = [
                '<b>Общие команды:</b>',
                '/duty - выбрать дежурных.',
                '/triggerOn - включить автоматическое назначение дежурных (будни в 09 МСК).',
                '/triggerOff - отключить автоматическое назначение дежурных.',
                '/reg - стать участником.',
                '/unreg - уйти из участников.',
                '/list - список участников.',
                '/reset - очистить участников.',
                '/help - помощь.',
                '',
                '<b>Управление:</b>',
                '/set 2 - выставляет количество дежурных.',
                '/add @employer[ @employerN] - добавить участников.',
                '/remove @employer[ @employerN] - удалить участников.',
                '',
                '',
                `<i>Версия:</i> <b>${version}</b>`,
            ].join('\n');
            await this._replyMessage(ctx, help);
        });

        this.bot.command('triggerOn', (ctx) => this._withChat(ctx, async (chat) => {
            await this.service.triggerOn(chat);
            await this._replyMessage(ctx, 'Автоназначение включено');
        }));

        this.bot.command('triggerOff', (ctx) => this._withChat(ctx, async (chat) => {
            await this.service.triggerOff(chat);
            await this._replyMessage(ctx, 'Автоназначение отключено');
        }));

        this.bot.command('duty', (ctx) => this._withChat(ctx, async (chat) => {
            const duty = await this.service.duty(chat);
            if (duty.length > 0) {
                await this._replyMessage(
                    ctx,
                    [`Дежурны${this.pt(duty, 'е', 'й')} на сегодня: `, ...duty].join(this.pt(duty, '\n', '')),
                );
            } else {
                await this._replyMessage(ctx, 'Дежурных нет. Добавьте людей в список.');
            }
        }));

        this.bot.command('reset', (ctx) => this._withChat(ctx, async (chat) => {
            await this.service.reset(chat);
            await this._replyMessage(ctx, 'Дежурные и триггеры удалены, а настройки чата сброшены.');
        }));

        this.bot.command('clear', (ctx) => this._withChat(ctx, async (chat) => {
            await this.service.clear(chat);
            await this._replyMessage(ctx, 'Данные о чате удалены из хранилища.');
        }));

        this.bot.command('remove', (ctx) => this._withChat(ctx, async (chat) => {
            const args = parseCommandArgs(ctx.message?.text);
            if (args.length === 0) {
                await this._replyArgError(ctx, '/remove @employer[ @employerN]');
                return;
            }
            await Promise.all(args.map((a) => this.service.unreg(chat, stripAt(a))));
            await this._replyMessage(
                ctx,
                `Дежурны${this.pt(args, 'е', 'й')} удал${this.pt(args, 'е', 'ё')}н${this.pt(args, 'ы', '')}.`,
            );
        }));

        this.bot.command('add', (ctx) => this._withChat(ctx, async (chat) => {
            const args = parseCommandArgs(ctx.message?.text);
            if (args.length === 0) {
                await this._replyArgError(ctx, '/add @employer[ @employerN]');
                return;
            }
            await Promise.all(args.map((a) => this.service.reg(chat, stripAt(a))));
            await this._replyMessage(ctx, `Дежурны${this.pt(args, 'е', 'й')} добавлен${this.pt(args, 'ы', '')}.`);
        }));

        this.bot.command('set', (ctx) => this._withChat(ctx, async (chat) => {
            const args = parseCommandArgs(ctx.message?.text);
            const raw = args[0];
            if (!raw) {
                await this._replyArgError(ctx, '/set 2');
                return;
            }
            const dutyCount = parseInt(raw, 10);
            if (!Number.isFinite(dutyCount) || dutyCount <= 0) {
                await this._replyArgError(ctx, '/set 2', 'Значение должно быть больше 0');
                return;
            }
            const newDutyCount = await this.service.setDutyCount(chat, dutyCount);
            await this._replyMessage(ctx, `Количество дежурных на день: ${newDutyCount}.`);
        }));

        this.bot.command('reg', (ctx) => this._withChat(ctx, async (chat) => {
            const username = ctx.from?.username;
            if (!username) {
                await this._replyMessage(
                    ctx,
                    'Установите username в настройках Telegram, чтобы участвовать.',
                );
                return;
            }
            const msg = await this.service.reg(chat, username);
            await this._replyMessage(ctx, msg);
        }));

        this.bot.command('unreg', (ctx) => this._withChat(ctx, async (chat) => {
            const username = ctx.from?.username;
            if (!username) {
                await this._replyMessage(
                    ctx,
                    'Установите username в настройках Telegram, чтобы выйти из дежурных.',
                );
                return;
            }
            const msg = await this.service.unreg(chat, username);
            await this._replyMessage(ctx, msg);
        }));

        this.bot.command('list', (ctx) => this._withChat(ctx, async (chat) => {
            const dutyUsers = await this.service.list(chat);
            if (dutyUsers.length === 0) {
                await this._replyMessage(ctx, 'Дежурных нет.');
                return;
            }
            const baseMsg = [
                'Список дежурных:',
                dutyUsers.join(', '),
                `Всего ${dutyUsers.length}`,
            ].join('\n');
            try {
                const memberCount = await ctx.telegram.getChatMembersCount(chat.id);
                await this._replyMessage(ctx, `${baseMsg} из ${memberCount - SELF_BOT}`);
            } catch {
                await this._replyMessage(ctx, baseMsg);
            }
        }));
    }

    private async _withChat(ctx: Context, action: (chat: DomainChat) => Promise<void>): Promise<void> {
        try {
            const chat = await this._chatExtractor(ctx);
            await action(chat);
        } catch (e) {
            await this._handleError(ctx, e);
        }
    }

    private async _chatExtractor(ctx: Context): Promise<DomainChat> {
        if (!ctx.chat) {
            throw new ServiceError('Команда доступна только в чате.');
        }
        try {
            const tgChat = await ctx.getChat();
            const username = 'username' in tgChat ? tgChat.username : undefined;
            const title = 'title' in tgChat ? tgChat.title : undefined;
            return { id: tgChat.id, type: tgChat.type, username, title };
        } catch (e) {
            throw new ServiceError('Ошибка при получении информации о чате.', e);
        }
    }

    private async _sendMessageToOwner(msg: string): Promise<void> {
        try {
            await this.bot.telegram.sendMessage(this.ownerId, this._prepareMessage(msg), { parse_mode: 'HTML' });
        } catch (e) {
            console.error('Failed to notify owner:', formatError(e));
        }
    }

    private _replyMessage(ctx: Context, msg: string): Promise<unknown> {
        return ctx.replyWithHTML(this._prepareMessage(msg));
    }

    private _prepareMessage(msg: string): string {
        return msg.length > MAX_MESSAGE_SIZE ? msg.slice(0, MAX_MESSAGE_SIZE) + '...' : msg;
    }

    private _replyArgError(ctx: Context, example: string, extra = ''): Promise<void> {
        const message = `Ошибка в аргументах. ${extra}. Ожидается: <code>${example}</code>`;
        return this._handleError(ctx, new ServiceError(message));
    }

    private _escapeHtml(unsafe: string): string {
        return unsafe
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async _handleError(ctx: Context, error: unknown): Promise<void> {
        const serviceError = error instanceof ServiceError
            ? error
            : new ServiceError('В сервисе произошла ошибка.', error);

        const id = randomUUID().slice(0, 8);
        const causeText = formatError(serviceError.cause);
        const ownerMsg = [
            `<b>ID:</b> ${id}`,
            '',
            `<b>Сообщение в чат:</b> ${serviceError.message}`,
            '',
            `<b>Ошибка:</b>`,
            this._escapeHtml(causeText),
        ].join('\n');

        console.error(JSON.stringify({ id, message: serviceError.message, cause: causeText }));

        await this._sendMessageToOwner(ownerMsg);
        try {
            await this._replyMessage(ctx, `${serviceError.message}\n\n<b>id:</b> <code>${id}</code>`);
        } catch (e) {
            console.error('Failed to reply to user:', formatError(e));
        }
    }

    handleUpdate(update: Update): Promise<void> {
        return this.bot.handleUpdate(update);
    }
}

export function formatError(e: unknown): string {
    if (e === undefined || e === null) return '<no error>';
    if (e instanceof Error) {
        return `${e.name}: ${e.message}\n${e.stack ?? '<no stack>'}`;
    }
    if (typeof e === 'string') return e;
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}
