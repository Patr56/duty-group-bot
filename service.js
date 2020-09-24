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
            Key: `${chat.type}/${chat.id}/${SETTINGS_NAME}`,
            ContentType: "application/json",
            Body: JSON.stringify({
                "duty": 2,
                "countPeople": 0
            }, null, 2)
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при создании хранилища для ${chat.id}.`, err });
                } else {
                    resolve(`Хранилище для ${chat.id} создано, дежурные могут регистрироваться.`);
                }
            });
        })
    }

    reg(chat, username) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.id}/@${username}`,
            ContentType: "application/json",
            Body: ""
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при регистрации пользователя ${username}.`, err });
                } else {
                    resolve(`${username} добавлен в дежурные.`);
                }
            });
        }).then(msg => this.increment(chat).then(() => msg));
    }

    unreg(chat, username) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.id}/@${username}`,
        };

        return new Promise((resolve, reject) => {
            this.s3.deleteObject(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при удалении пользователя ${username}.`, err });
                } else {
                    resolve(`${username} удалён из дежурные.`);
                }
            });
        }).then(msg => this.decrement(chat).then(() => msg));
    }

    help() {
        return `${HELP}\nВерсия: ${this.functionContext.functionVersion}`;
    }

    list(chat, username) {
        return new Promise((resolve, reject) => { resolve(`TODO: list for ${chat.id}`) });
    }

    getSettings(chat) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.id}/${SETTINGS_NAME}`
        };

        return new Promise((resolve, reject) => {
            this.s3.getObject(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при получении настроек для чата ${chat.type}/${chat.id}.`, err });
                } else {
                    try {
                        const settings = JSON.parse(data.Body);
                        resolve(settings);
                    } catch (err) {
                        reject({ msg: `Ошибка при парсинге настроек.`, err });
                    }
                }
            });
        })
    }

    updateSettings(chat, settings) {
        var params = {
            Bucket: BUCKET_NAME,
            Key: `${chat.type}/${chat.id}/${SETTINGS_NAME}`,
            ContentType: "application/json",
            Body: JSON.stringify(callback(settings), null, 2)
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при обновлении настроек хранилища для ${chat.id}.`, err });
                } else {
                    resolve(`Хранилище для ${chat.id} создано, дежурные могут регистрироваться.`);
                }
            });
        })
    }

    increment(chat) {
        this.getSettings(chat).then(settings => {
            const newSettings = { ...settings, countPeople: settings.countPeople + 1 }
            return this.updateSettings(chat, newSettings)
        })
    }

    decrement(chat) {
        this.getSettings(chat).then(settings => {
            if (settings.countPeople > 0) {
                const newSettings = { ...settings, countPeople: settings.countPeople - 1 }
                return this.updateSettings(chat, newSettings)
            }
        })
    }
}

module.exports = Service
