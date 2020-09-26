const { Telegraf } = require('telegraf');
const { nanoid } = require('nanoid');

const { ServiceError } = require('./errors')

class Controller {
    constructor(service, token, ownerId, functionContext) {
        this.bot = new Telegraf(token)
        this.service = service;
        this.functionContext = functionContext;
        this.ownerId = ownerId;
    }

    getBot() {

        this.bot.catch((err, ctx) => {
            this._onError(ctx)(new ServiceError('В сервисе произошла ошибка.', err));
        })

        this.bot.start((ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.init(chat)
                    .then(
                        msg => ctx.reply(msg),
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
            ctx.replyWithHTML(help)
        });

        this.bot.command("reset", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.reset(chat)
                    .then(
                        msg => ctx.reply('Дежурные удалены, а начтройки чата сброшены.'),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("clear", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.clear(chat)
                    .then(
                        msg => ctx.reply('Данные о чате удалены из хранилища.'),
                        this._onError(ctx)
                    )

            })
        });

        this.bot.command("reg", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.reg(chat, ctx.from.username)
                    .then(
                        msg => ctx.reply(msg),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("unreg", (ctx) => {
            this._chatExtractor(ctx).then(chat => {
                this.service.unreg(chat, ctx.from.username)
                    .then(
                        msg => ctx.reply(msg),
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
                                ctx.reply([
                                    'Список дежурных:',
                                    dutyUsers.join(", "),
                                    `Всего: ${dutyUsers.length}`
                                ].join('\n'))
                            } else {
                                ctx.reply('Дежурных нет.');
                            }
                        },
                        this._onError(ctx)
                    )
            })
        });

        return this.bot;
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

                console.error(JSON.stringify(errorMsg));

                ctx.telegram.sendMessage(this.ownerId, errorMsg.join('\n'));

                ctx.replyWithHTML(`<code>${msg}</code>\n\n<b>id:</b> ${id}`);

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
