const { Telegraf } = require('telegraf');
const { chatExtractor } = require('./helper');

class Controller {
    constructor(service, token) {
        this.bot = new Telegraf(token)
        this.service = service;
    }

    getBot() {

        // this.bot.catch((err, ctx) => {
        //     ctx.reply(prepareError("Произошла ошибка.", err))
        // })

        this.bot.start((ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.init(chat).then(msg => ctx.reply(msg))
            })
        });

        this.bot.help((ctx) => ctx.reply(this.service.help()));

        this.bot.command("reg", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.reg(chat, ctx.from.username).then(msg => ctx.reply(msg))
            })
        });

        this.bot.command("unreg", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.unreg(chat, ctx.from.username).then(msg => ctx.reply(msg))
            })
        });

        this.bot.command("list", (ctx) => {
            chatExtractor(ctx).then(chat => {
                this.service.list(chat, ctx.from.username).then(msg => ctx.reply(msg))
            })
        });

        return this.bot;
    }
}

module.exports = Controller
