const { ServiceError } = require('./errors')

const PROPERTIES_NAME = 'properties.json';
const BUCKET_NAME = 'duty-group-bot-storage';

const INIT_PROPERTIES = {
    "dutyCount": 2,
    "countPeople": 0,
    "lastDuty": []
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
        const propertiesKey = this._getPropertiesKey(chat);
        const params = {
            Bucket: BUCKET_NAME,
            Key: propertiesKey,
            ContentType: "application/json",
            Body: JSON.stringify(INIT_PROPERTIES, null, 2)
        };

        return this._objectExist(propertiesKey).then(hasProperties => {
            return new Promise((resolve, reject) => {
                const readableName = this._getChatReadableName(chat);

                if (hasProperties) {
                    resolve(`Хранилище для "${readableName}" уже создано.`);
                } else {
                    this.s3.upload(params, (err, data) => {
                        if (err) {
                            reject(new ServiceError(`Ошибка при создании хранилища для "${readableName}".`, err));
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
                        ...dutyUsers,
                        PROPERTIES_NAME
                    ].map(objKey => {
                        return {
                            Key: `${this._getChatKey(chat)}/${objKey}`
                        }
                    })
                }
            }

            return new Promise((resolve, reject) => {
                this.s3.deleteObjects(props, (err, data) => {
                    if (err) {
                        reject(new ServiceError(`Ошибка при очистке хранилища для "${this._getChatReadableName(chat)}".`, err));
                    } else {
                        resolve();
                    }
                })
            })
        })
    }

    setDutyCount(chat, dutyCount) {
        return this._getProperties(chat).then(properties => {
            const newProperties = { ...properties, dutyCount }
            return this._updateProperties(chat, newProperties)
        }).then(newProperties => newProperties.dutyCount)
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
                    this.s3.upload(params, (err, data) => {
                        if (err) {
                            reject(new ServiceError(`Ошибка при регистрации пользователя @${username}.`, err));
                        } else {
                            resolve(`@${username} добавлен в дежурные.`);
                        }
                    });
                }).then(msg => this._incrementUser(chat).then(properties => {
                    return `${msg}\nКоличество дежурных: ${properties.countPeople}`;
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
                    this.s3.deleteObject(params, (err, data) => {
                        if (err) {
                            reject(new ServiceError(`Ошибка при удалении пользователя ${username}.`, err));
                        } else {
                            resolve(`@${username} удалён из дежурные.`);
                        }
                    });
                }).then(msg => this._decrementUser(chat).then(properties => {
                    return `${msg}\nКоличество дежурных: ${properties.countPeople}`;
                }));
            } else {
                return `Пользователь @${username} уже удалён.`
            }
        })
    }

    duty(chat) {

    }

    list(chat) {
        const keyPrefix = `${this._getChatKey(chat)}/`;
        const params = {
            Bucket: BUCKET_NAME,
            Delimiter: "/",
            Prefix: keyPrefix,
        };

        return new Promise((resolve, reject) => {
            this.s3.listObjectsV2(params, (err, data) => {
                if (err) {
                    reject(new ServiceError(`Ошибка при запросе списка дежурных для ${this._getChatReadableName(chat)}.`, err));
                } else {
                    const dutyUsers = data.Contents.map(object => {
                        return object.Key.replace(keyPrefix, "");
                    }).filter(user => user != PROPERTIES_NAME)

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

    _getPropertiesKey(chat) {
        return `${this._getChatKey(chat)}/${PROPERTIES_NAME}`;
    }

    _objectExist(key, errMsg) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: key
        };

        return new Promise((resolve, reject) => {
            this.s3.headObject(params, (err, data) => {
                if (err) {
                    if (err.statusCode === 404) {
                        resolve(false)
                    } else {
                        reject(new ServiceError(errMsg, err));
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

    _getProperties(chat) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getPropertiesKey(chat)
        };

        return new Promise((resolve, reject) => {
            this.s3.getObject(params, (err, data) => {
                if (err) {
                    reject(new ServiceError(`Ошибка при получении настроек для чата ${this._getPropertiesKey(chat)}.`, err));
                } else {
                    try {
                        resolve(JSON.parse(data.Body));
                    } catch (err) {
                        reject(new ServiceError(`Ошибка при парсинге настроек.`, err));
                    }
                }
            });
        })
    }

    _updateProperties(chat, newProperties) {
        const params = {
            Bucket: BUCKET_NAME,
            Key: this._getPropertiesKey(chat),
            ContentType: "application/json",
            Body: JSON.stringify(newProperties, null, 2)
        };

        return new Promise((resolve, reject) => {
            this.s3.upload(params, (err, data) => {
                if (err) {
                    reject(new ServiceError(`Ошибка при обновлении настроек хранилища для ${chat.id}.`, err));
                } else {
                    resolve(newProperties);
                }
            });
        })
    }

    _incrementUser(chat) {
        return this._getProperties(chat).then(properties => {
            const newProperties = { ...properties, countPeople: properties.countPeople + 1 }
            return this._updateProperties(chat, newProperties)
        })
    }

    _decrementUser(chat) {
        return this._getProperties(chat).then(properties => {
            if (properties.countPeople > 0) {
                const newProperties = { ...properties, countPeople: properties.countPeople - 1 }
                return this._updateProperties(chat, newProperties)
            }
        })
    }
}

module.exports = Service
