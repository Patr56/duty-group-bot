const { Telegraf } = require('telegraf');
const commandParts = require('telegraf-command-parts');
const { nanoid } = require('nanoid');

const { ServiceError } = require('./errors')

const MAX_MESSAGE_SIZE = 4000;

class Controller {
    constructor(service, token, ownerId, functionContext) {
        this.bot = new Telegraf(token)
        this.service = service;
        this.functionContext = functionContext;
        this.ownerId = ownerId;
    }

    getBot() {

        this.bot.use(commandParts());

        this.bot.catch((err, ctx) => {
            this._onError(ctx)(new ServiceError('В сервисе произошла ошибка.', err));
        })

        this.bot.start((ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.init(chat)
                    .then(
                        msg => this._replyMessage(ctx, msg),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.help((ctx) => {
            const help = [
                "<b>Общие команды:</b>",
                "/duty - выбрать дежурных.",
                "/reg - стать участником.",
                "/unreg - уйти из участников.",
                "/list - список участников.",
                "/reset - очистить участников.",
                "/help - очистить участников.",
                "",
                "<b>Управление:</b>",
                "/set 2 - выставляет количество дежурных.",
                "/add @employer[, @employerN] - добавить участников.",
                "/remove @employer - удалить участника.",
                "",
                "",
                `<i>Версия:</i> <b>${this.functionContext.functionVersion}</b>`
            ].join('\n');

            this._replyMessage(ctx, help)
        });

        this.bot.command("reset", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.reset(chat)
                    .then(
                        msg => this._replyMessage(ctx, 'Дежурные удалены, а настройки чата сброшены.'),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("set", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                if (ctx.state.command && ctx.state.command.splitArgs && ctx.state.command.splitArgs.length > 0) {

                    var dutyCount = 0;
                    try {
                        dutyCount = parseInt(ctx.state.command.splitArgs[0], 10);
                    } catch (err) {

                    }

                    if (dutyCount > 0) {
                        this.service.setDutyCount(chat, dutyCount)
                            .then(
                                newDutycount => this._replyMessage(ctx, `Количество дежурных на день: ${newDutycount}.`),
                                this._onError(ctx)
                            )
                    } else {
                        this._onErrorInArg(ctx, '/set 2');
                    }

                } else {
                    this._onErrorInArg(ctx, '/set 2');
                }

            })
        });

        this.bot.command("clear", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.clear(chat)
                    .then(
                        msg => this._replyMessage(ctx, 'Данные о чате удалены из хранилища.'),
                        this._onError(ctx)
                    )

            })
        });

        this.bot.command("reg", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.reg(chat, ctx.from.username)
                    .then(
                        msg => this._replyMessage(ctx, msg),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("unreg", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.unreg(chat, ctx.from.username)
                    .then(
                        msg => this._replyMessage(ctx, msg),
                        this._onError(ctx)
                    )

            })
        });

        this.bot.command("list", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.list(chat, ctx.from.username)
                    .then(
                        dutyUsers => {
                            if (dutyUsers.length > 0) {
                                const msg = [
                                    'Список дежурных:',
                                    dutyUsers.join(", "),
                                    `Всего ${dutyUsers.length}`
                                ].join('\n')

                                ctx.getChatMembersCount().then(memberCount => {
                                    this._replyMessage(ctx, `${msg} из ${memberCount}`);
                                }).catch(() => {
                                    this._replyMessage(ctx, msg);
                                })

                            } else {
                                this._replyMessage(ctx, 'Дежурных нет.');
                            }
                        },
                        this._onError(ctx)
                    )
            })
        });

        return this.bot;
    }

    _sendMessageToOwner(ctx, msg) {
        ctx.telegram.sendMessage(this.ownerId, this._prepareMessage(msg));
    }

    _replyMessage(ctx, msg) {
        ctx.replyWithHTML(this._prepareMessage(msg))
    }

    _prepareMessage(msg) {
        if (msg.length > MAX_MESSAGE_SIZE) {
            return msg.slice(0, MAX_MESSAGE_SIZE) + '...'
        } else {
            return msg
        }
    }

    _onErrorInArg(ctx, example) {
        this._onError(ctx)(new ServiceError(`Ошибка в аргументах. Ожидается: <code>${example}</code>`, new Error()));
    }

    _onError(ctx) {
        return (error) => {
            if (error instanceof ServiceError) {
                const id = nanoid();

                const { msg, err } = error;

                const errorMsg = [
                    `ID: ${id}`,
                    '',
                    `Сообщение в чат: ${msg}`,
                    '',
                    `Ошибка: ${err.message}`,
                    '',
                    "Stack:",
                    err.stack
                ]

                console.error(JSON.stringify(errorMsg.filter(el => el != "")));

                this._sendMessageToOwner(ctx, errorMsg.join('\n'));
                this._replyMessage(ctx, `${msg}\n\n<b>id:</b> <code>${id}</code>`);

            } else {
                this._onError(ctx)(new ServiceError('В сервисе произошла ошибка.', error));
            }
        }
    }

    _chatExtractor(ctx) {
        return new Promise((resolve, reject) => {
            ctx.getChat().then(chat => {
                resolve(chat)
            }).catch(error => {
                reject(new ServiceError("Ошибка при получении информации о чате.", error));
            })
        })
    }
}

module.exports = Controller
