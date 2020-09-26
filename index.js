const S3 = require('aws-sdk/clients/s3');

const Service = require('./service');
const Controller = require('./controller');

module.exports.handler = async function (event, functionContext) {
    const s3storage = new S3({ endpoint: 'storage.yandexcloud.net' });
    const service = new Service(s3storage);
    const bot = new Controller(service, process.env.BOT_TOKEN, functionContext).getBot();

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
