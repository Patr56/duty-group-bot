const { Telegraf } = require('telegraf');
const { nanoid } = require('nanoid');

const S3 = require('aws-sdk/clients/s3');

// Set credentials and Region
var s3 = new S3({ endpoint: 'storage.yandexcloud.net' });

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
const BUCKET_NAME = 'duty-group-bot-storage';
const SETTINGS_NAME = 'settings.json';

const bot = new Telegraf(process.env.BOT_TOKEN)

function prepareError(text, error) {
    const id = nanoid();
    console.error(id, text, error)
    return `${text}\n\nid: "${id}"`
}

bot.start((ctx) => {
    ctx.getChat().then(chat => {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.username}/${SETTINGS_NAME}`,
            ContentType: "application/json",
            Metadata: {
                "custom-count": "2"
            },
            Body: JSON.stringify({
                "count": "2"
            }, null, 2)
        };

        s3.upload(params, function (err, data) {
            if (err) {
                ctx.reply(prepareError("Ошибка при создании хранилища.", err));
            } else {
                ctx.reply("Хранилище создано, дежурные могут регистрироваться.");
            }
        });
    }).catch(error => {
        ctx.reply(prepareError("Ошибка при получении информации о чате.", error));
    })
})

bot.help((ctx) => ctx.reply(help))

bot.on('sticker', (ctx) => ctx.reply('👍'))
bot.hears('hi', (ctx) => ctx.reply('Hey there'))

bot.command('oldschool', (ctx) => ctx.reply('Hello'))
bot.command('modern', ({ reply }) => reply('Yo'))
bot.command('hipster', Telegraf.reply('λ'))

bot.command('s3', (ctx) => {
    ctx.getChat().then(chat => {
        console.log("chat.username", chat.username)

        // Call S3 to list the buckets
        // s3.listBuckets(function (err, data) {
        //     if (err) {
        //         console.log("Error", chat.username, err);
        //         ctx.reply(`${chat.username} - Error: ${err}`);
        //     } else {
        //         console.log("Success", chat.username, data.Buckets);
        //         ctx.reply(`${chat.username} - Success: ${data.Buckets.map(b => b.Name).join(", ")}`);
        //     }
        // });

        var params = { Bucket: BUCKET_NAME, Key: `${chat.type}/${chat.id}`, Body: "stream" };
        s3.upload(params, function (err, data) {
            if (err) {
                console.log("Error", chat.username, err);
                ctx.reply(`${chat.username} - Error: ${err}`);
            } else {
                console.log("Success", chat.username, data.Location);
                ctx.reply(`${chat.username} - Success: ${data.Location}`);
            }
        });
    })

})

module.exports.handler = async function (event, context) {
    console.log("incomming event.body", event.body);

    try {
        const message = JSON.parse(event.body);
        await bot.handleUpdate(message)
    } catch (error) {
        console.error(error.message);
    }

    return {
        statusCode: 200,
        body: ''
    };
};
