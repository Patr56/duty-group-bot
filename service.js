const SETTINGS_NAME = 'settings.json';
const BUCKET_NAME = 'duty-group-bot-storage';

const INIT_SETTINGS = {
    "duty": 2,
    "countPeople": 0
}

/**
 * Сервис для работы с чат ботом.
 */
class Service {

    constructor(s3, functionContext) {
        this.s3 = s3;
        this.functionContext = functionContext;
    }

    init(chat) {
        const settingsKey = this._getSettingsKey(chat);
        const params = {
            Bucket: BUCKET_NAME,
            Key: settingsKey,
            ContentType: "application/json",
            Body: JSON.stringify(INIT_SETTINGS, null, 2)
        };

        return this._objectExist(settingsKey).then(hasSettings => {
            return new Promise((resolve, reject) => {
                const readableName = this.getChatReadableName(chat);

                if (hasSettings) {
                    resolve(`Хранилище для "${readableName}" уже создано.`);
                } else {
                    this.s3.upload(params, function (err, data) {
                        if (err) {
                            reject({ msg: `Ошибка при создании хранилища для "${readableName}".`, err });
                        } else {
                            resolve(`Хранилище для "${readableName}" создано, дежурные могут регистрироваться.`);
                        }
                    });
                }
            })
        })
    }

    reset(chat) {
        return this.clear(chat).then(() => this.init(chat))
    }

    clear(chat) {
        return this.list(chat).then(dutyUsers => {
            const props = {
                Bucket: BUCKET_NAME,
                Delete: {
                    Objects: [
                        ...dutyUsers.map(dutyUser => {
                            return {
                                ObjectKey: `${this._getChatKey(chat)}/${dutyUser}`
                            }
                        }),
                        this._getSettingsKey(chat)]
                }
            }

            return new Promise((resolve, reject) => {
                this.s3.deleteObjects(props, function (err, data) {
                    if (err) {
                        console.error("clear", `Ошибка при очистке хранилища для "${this.getChatReadableName(chat)}".`, err);
                        reject({ msg: `Ошибка при очистке хранилища для "${this.getChatReadableName(chat)}".`, err });
                    } else {
                        resolve();
                    }
                })
            })
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

    list(chat) {
        const keyPrefix = `${this._getChatKey(chat)}/`;
        const params = {
            Bucket: BUCKET_NAME,
            Delimiter: "/",
            Prefix: keyPrefix,
        };

        return new Promise((resolve, reject) => {
            this.s3.listObjectsV2(params, function (err, data) {
                if (err) {
                    reject({ msg: `Ошибка при запросе списка дежурных для ${this.getChatReadableName(chat)}.`, err });
                } else {
                    const dutyUsers = data.Contents.map(object => {
                        return object.Key.replace(keyPrefix, "");
                    }).filter(user => user != SETTINGS_NAME)

                    resolve(dutyUsers);
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
