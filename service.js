const { prepareError } = require('./helper');

const SETTINGS_NAME = 'settings.json';
const BUCKET_NAME = 'duty-group-bot-storage';
const HELP = `Общие команды:
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

/**
 * Сервис для работы с чат ботом.
 */
class Service {

    constructor(s3, functionContext) {
        this.s3 = s3;
        this.functionContext = functionContext;
    }

    init(chat) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.username}/${SETTINGS_NAME}`,
            ContentType: "application/json",
            Body: JSON.stringify({
                "duty": 2,
                "countPeople": 0
            }, null, 2)
        };

        return new Promise((resolve) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    resolve(prepareError(`Ошибка при создании хранилища для ${chat.username}.`, err));
                } else {
                    resolve(`Хранилище для ${chat.username} создано, дежурные могут регистрироваться.`);
                }
            });
        })
    }

    reg(chat, username) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.username}/@${username}`,
            ContentType: "application/json",
            Body: ""
        };

        return new Promise((resolve) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    resolve(prepareError(`Ошибка при регистрации пользователя ${username}.`, err));
                } else {
                    resolve(`${username} добавлен в дежурные.`);
                }
            });
        })
    }

    unreg(chat, username) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.username}/@${username}`,
        };

        return new Promise((resolve) => {
            this.s3.deleteObject(params, function (err, data) {
                if (err) {
                    resolve(prepareError(`Ошибка при удалении пользователя ${username}.`, err));
                } else {
                    resolve(`${username} удалён из дежурные.`);
                }
            });
        })

    }

    help() {
        return `${HELP}\nВерсия: ${this.functionContext.functionVersion}`;
    }

    list(chat, username) {
        return new Promise((resolve) => {resolve(`TODO: list for ${chat.username}`)});
    }
}

module.exports = Service
