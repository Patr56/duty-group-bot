const { nanoid } = require('nanoid');

module.exports.prepareError = (msg, error) => {
    const id = nanoid();

    console.error("id:", id, "msg:", msg);
    console.error("id:", id, "error:", error);

    return `${msg}\n\nid: "${id}"`
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
