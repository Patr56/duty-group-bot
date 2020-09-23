const { nanoid } = require('nanoid');

module.exports.prepareError = (text, error) => {
    const id = nanoid();
    console.error(id, text, error)
    return `${text}\n\nid: "${id}"`
}

module.exports.chatExtractor = (ctx) => {
    return new Promise((resolve, reject) => {
        ctx.getChat().then(chat => {
            resolve(chat)
        }).catch(error => {
            ctx.reply(prepareError("Ошибка при получении информации о чате.", error));
            reject();
        })
    })
}
