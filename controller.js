const { Telegraf } = require('telegraf');

const { ServiceError } = require('./errors')
const { chatExtractor, prepareError } = require('./helper');

class Controller {
    constructor(service, token, functionContext) {
        this.bot = new Telegraf(token)
        this.service = service;
        this.functionContext = functionContext;
    }

    getBot() {

        this.bot.catch((err, ctx) => {
            this._onError(ctx)(new ServiceError('В сервисе произошла ошибка.', err ));
        })

        this.bot.start((ctx) => {
            chatExtractor(ctx).then(chat => {
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
            chatExtractor(ctx).then(chat => {
                this.service.reset(chat)
                    .then(
                        msg => ctx.reply('Дежурные удалены, а начтройки чата сброшены.'),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("clear", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.clear(chat)
                    .then(
                        msg => ctx.reply('Данные о чате удалены из хранилища.'),
                        this._onError(ctx)
                    )

            })
        });

        this.bot.command("reg", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.reg(chat, ctx.from.username)
                    .then(
                        msg => ctx.reply(msg),
                        this._onError(ctx)
                    )
            })
        });

        this.bot.command("unreg", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.unreg(chat, ctx.from.username)
                    .then(
                        msg => ctx.reply(msg),
                        this._onError(ctx)
                    )

            })
        });

        this.bot.command("list", (ctx) => {
            chatExtractor(ctx).then(chat => {
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
                ctx.replyWithHTML(prepareError(error.msg, error.err))
            } else {
                this._onError(ctx)(new ServiceError('В сервисе произошла ошибка.', err ));
            }
        }
    }
}

module.exports = Controller
