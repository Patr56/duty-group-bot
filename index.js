const { Telegraf } = require('telegraf');

const help = `Общие команды:
/duty - выбрать дежурных.
/reg - стать участником.
/unreg - уйти из участников.
/list - список участников.
/reset - очистить участников.
/help - очистить участников.
Управление:
/set 2 - выставляет количество дежурных.
/add @employer[, @employerN] - добавить участников.
/remove @employer - удалить участника.
`

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.start((ctx) => ctx.reply(help))
bot.help((ctx) => ctx.reply(help))

bot.on('sticker', (ctx) => ctx.reply('👍'))
bot.hears('hi', (ctx) => ctx.reply('Hey there'))

bot.command('oldschool', (ctx) => ctx.reply('Hello'))
bot.command('modern', ({ reply }) => reply('Yo'))
bot.command('hipster', Telegraf.reply('λ'))

module.exports.handler = async function (event, context) {
    console.log("incomming event.body", event.body);

    try {
        const message = JSON.parse(event.body); 
        await bot.handleUpdate(message)
    } catch(error) {    
        console.error(error.message);
    }

    return {
        statusCode: 200,
        body: ''
    };
};
