const SETTINGS_NAME = 'settings.json';
const BUCKET_NAME = 'duty-group-bot-storage';
const HELP = [
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
].join("\n");


/**
 * Сервис для работы с чат ботом.
 */
class Service {

    constructor(s3, functionContext) {
        this.s3 = s3;
        this.functionContext = functionContext;
    }

    init(chat) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getSettingsKey(chat),
            ContentType: "application/json",
            Body: JSON.stringify({
                "duty": 2,
                "countPeople": 0
            }, null, 2)
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при создании хранилища для "${this.getChatReadableName(chat)}".`, err });
                } else {
                    resolve(`Хранилище для "${this.getChatReadableName(chat)}" создано, дежурные могут регистрироваться.`);
                }
            });
        })
    }

    reg(chat, username) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getFullKey(chat, username),
            ContentType: "application/json",
            Body: ""
        };

        return this._userExist(chat, username).then(userExist => {
            if (userExist === false) {
                return new Promise((resolve, reject) => {
                    this.s3.upload(params, function (err, data) {
                        if (err) {
                            reject({ msg: `Ошибка при регистрации пользователя @${username}.`, err });
                        } else {
                            resolve(`@${username} добавлен в дежурные.`);
                        }
                    });
                }).then(msg => this._incrementUser(chat).then(settings => {
                    return `${msg}\nКоличество дежурных: ${settings.countPeople}`;
                }));
            } else {
                return `Пользователь @${username} уже добавлен.`
            }
        })
    }

    unreg(chat, username) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getFullKey(chat, username),
        };

        return this._userExist(chat, username).then(userExist => {
            if (userExist === true) {
                return new Promise((resolve, reject) => {
                    this.s3.deleteObject(params, function (err, data) {
                        if (err) {
                            reject({ msg: `Ошибка при удалении пользователя ${username}.`, err });
                        } else {
                            resolve(`@${username} удалён из дежурные.`);
                        }
                    });
                }).then(msg => this._decrementUser(chat).then(settings => {
                    return `${msg}\nКоличество дежурных: ${settings.countPeople}`;
                }));
            } else {
                return `Пользователь @${username} уже удалён.`
            }
        })
    }

    help() {
        return `${HELP}\n\n <i>Версия:</i> <b>${this.functionContext.functionVersion}</b>`;
    }

    list(chat) {
        const params = {
            Bucket: BUCKET_NAME,
            Delimiter: "/",
            Prefix: `${this._getChatKey(chat)}/`,
        };

        return new Promise((resolve, reject) => {
            this.s3.listObjectsV2(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при запросе списка дежурных для ${this.getChatReadableName(chat)}.`, err });
                } else {
                    console.log("list data", data)
                    resolve(`Список:\n${JSON.stringify(data, null, 2)}`);
                }
            });
        });
    }

    _getChatReadableName(chat) {
        return `${chat.username ? chat.username : chat.title}`
    }

    _getChatKey(chat) {
        return `${chat.type}/${chat.id}`;
    }

    _getFullKey(chat, username) {
        return `${this._getChatKey(chat)}/@${username}`;
    }

    _getSettingsKey(chat) {
        return `${this._getChatKey(chat)}/${SETTINGS_NAME}`;
    }

    _objectExist(key, errMsg) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: key
        };

        return new Promise((resolve, reject) => {
            this.s3.headObject(params, function (err, data) {
                if (err) {
                    if (err.statusCode === 404) {
                        resolve(false)
                    } else {
                        reject({ msg: errMsg, err });
                    }
                } else {
                    resolve(true)
                }
            });
        })
    }

    _userExist(chat, username) {
        const userKey = this._getFullKey(chat, username)

        return this._objectExist(
            userKey,
            `Ошибка при проверке наличия пользователя ${userKey}.`
        );
    }

    _getSettings(chat) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getSettingsKey(chat)
        };

        return new Promise((resolve, reject) => {
            this.s3.getObject(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при получении настроек для чата ${this.getSettingsKey(chat)}.`, err });
                } else {
                    try {
                        resolve(JSON.parse(data.Body));
                    } catch (err) {
                        reject({ msg: `Ошибка при парсинге настроек.`, err });
                    }
                }
            });
        })
    }

    _updateSettings(chat, newSettings) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getSettingsKey(chat),
            ContentType: "application/json",
            Body: JSON.stringify(newSettings, null, 2)
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при обновлении настроек хранилища для ${chat.id}.`, err });
                } else {
                    resolve(newSettings);
                }
            });
        })
    }

    _incrementUser(chat) {
        return this._getSettings(chat).then(settings => {
            const newSettings = { ...settings, countPeople: settings.countPeople + 1 }
            return this._updateSettings(chat, newSettings)
        })
    }

    _decrementUser(chat) {
        return this._getSettings(chat).then(settings => {
            if (settings.countPeople > 0) {
                const newSettings = { ...settings, countPeople: settings.countPeople - 1 }
                return this._updateSettings(chat, newSettings)
            }
        })
    }
}

module.exports = Service
