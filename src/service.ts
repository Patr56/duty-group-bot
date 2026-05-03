import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import { ServiceError } from './errors';
import { readJson } from './util/stream';
import type { DomainChat, Properties } from './types';

const PROPERTIES_NAME = 'properties.json';
const TRIGGER_FOLDER_NAME = 'trigger';
const BUCKET_NAME = 'duty-group-bot-storage';

const INIT_TRIGGER = { time: 9 };
const INIT_PROPERTIES: Properties = { dutyCount: 1, lastDuty: [] };

export class Service {
    constructor(private readonly s3: S3Client) {}

    async init(chat: DomainChat): Promise<string> {
        const propertiesKey = this._getPropertiesKey(chat);
        const readableName = this._getChatReadableName(chat);
        const exists = await this._objectExist(propertiesKey, `Ошибка при проверке хранилища для "${readableName}".`);

        if (exists) {
            return `Хранилище для "${readableName}" уже создано.`;
        }

        try {
            await this.s3.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: propertiesKey,
                ContentType: 'application/json',
                Body: JSON.stringify(INIT_PROPERTIES, null, 2),
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при создании хранилища для "${readableName}".`, e);
        }

        return `Хранилище для "${readableName}" создано, дежурные могут регистрироваться.`;
    }

    async getChats(): Promise<DomainChat[]> {
        const keyPrefix = `${TRIGGER_FOLDER_NAME}/`;
        let response;
        try {
            response = await this.s3.send(new ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                Delimiter: '/',
                Prefix: keyPrefix,
            }));
        } catch (e) {
            throw new ServiceError('Ошибка при запросе списка тригеров.', e);
        }

        const contents = response.Contents ?? [];
        const chats: DomainChat[] = [];
        for (const obj of contents) {
            if (!obj.Key) continue;
            const tail = obj.Key.slice(keyPrefix.length);
            const [type, idStr] = tail.split('@');
            if (!type || !idStr) continue;
            const idNum = Number(idStr);
            chats.push({
                id: Number.isFinite(idNum) ? idNum : idStr,
                type,
            });
        }
        return chats;
    }

    async triggerOn(chat: DomainChat): Promise<string> {
        const triggerKey = this._getTriggerKey(chat);
        const readableName = this._getChatReadableName(chat);
        try {
            await this.s3.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: triggerKey,
                ContentType: 'application/json',
                Body: JSON.stringify(INIT_TRIGGER, null, 2),
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при создании триггера для "${readableName}".`, e);
        }
        return `Триггер для "${readableName}" создан.`;
    }

    async triggerOff(chat: DomainChat): Promise<string> {
        const triggerKey = this._getTriggerKey(chat);
        const readableName = this._getChatReadableName(chat);
        try {
            await this.s3.send(new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: triggerKey,
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при удалении триггера для "${readableName}".`, e);
        }
        return `Триггер для "${readableName}" удалён.`;
    }

    async reset(chat: DomainChat): Promise<string> {
        await this.clear(chat);
        return this.init(chat);
    }

    async clear(chat: DomainChat): Promise<void> {
        const dutyUsers = await this.list(chat);
        const chatPrefix = this._getChatKey(chat);
        const keys = [...dutyUsers, PROPERTIES_NAME].map((name) => ({ Key: `${chatPrefix}/${name}` }));

        if (keys.length > 0) {
            try {
                await this.s3.send(new DeleteObjectsCommand({
                    Bucket: BUCKET_NAME,
                    Delete: { Objects: keys },
                }));
            } catch (e) {
                throw new ServiceError(`Ошибка при очистке хранилища для "${this._getChatReadableName(chat)}".`, e);
            }
        }

        await this.triggerOff(chat).catch(() => undefined);
    }

    async setDutyCount(chat: DomainChat, dutyCount: number): Promise<number> {
        const properties = await this._getProperties(chat);
        const updated = await this._updateProperties(chat, { ...properties, dutyCount });
        return updated.dutyCount;
    }

    async reg(chat: DomainChat, username: string): Promise<string> {
        const userExists = await this._userExist(chat, username);
        if (userExists) {
            return `Пользователь @${username} уже добавлен.`;
        }
        try {
            await this.s3.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: this._getFullKey(chat, username),
                ContentType: 'application/json',
                Body: '',
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при регистрации пользователя @${username}.`, e);
        }
        const count = (await this.list(chat)).length;
        return `@${username} добавлен в дежурные.\nКоличество дежурных: ${count}`;
    }

    async unreg(chat: DomainChat, username: string): Promise<string> {
        const userExists = await this._userExist(chat, username);
        if (!userExists) {
            return `Пользователь @${username} уже удалён.`;
        }
        try {
            await this.s3.send(new DeleteObjectCommand({
                Bucket: BUCKET_NAME,
                Key: this._getFullKey(chat, username),
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при удалении пользователя ${username}.`, e);
        }
        const count = (await this.list(chat)).length;
        return `@${username} удалён из дежурных.\nКоличество дежурных: ${count}`;
    }

    async duty(chat: DomainChat): Promise<string[]> {
        const dutyUsers = await this.list(chat);
        const properties = await this._getProperties(chat);

        if (this._compareList(dutyUsers, properties.lastDuty)) {
            return dutyUsers;
        }

        const lastDuty = dutyUsers
            .filter((u) => !properties.lastDuty.includes(u))
            .sort(() => Math.random() - 0.5)
            .slice(0, properties.dutyCount);

        const updated = await this._updateProperties(chat, { ...properties, lastDuty });
        return updated.lastDuty;
    }

    async list(chat: DomainChat): Promise<string[]> {
        const keyPrefix = `${this._getChatKey(chat)}/`;
        let response;
        try {
            response = await this.s3.send(new ListObjectsV2Command({
                Bucket: BUCKET_NAME,
                Delimiter: '/',
                Prefix: keyPrefix,
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при запросе списка дежурных для ${this._getChatReadableName(chat)}.`, e);
        }

        const contents = response.Contents ?? [];
        const users: string[] = [];
        for (const obj of contents) {
            if (!obj.Key) continue;
            const name = obj.Key.slice(keyPrefix.length);
            if (name && name !== PROPERTIES_NAME) users.push(name);
        }
        return users;
    }

    private _compareList(a: readonly string[], b: readonly string[]): boolean {
        if (a.length !== b.length) return false;
        const aSorted = [...a].sort();
        const bSorted = [...b].sort();
        return aSorted.every((v, i) => v === bSorted[i]);
    }

    private _getChatReadableName(chat: DomainChat): string {
        return `${chat.username ?? chat.title ?? chat.id}`;
    }

    private _getChatKey(chat: DomainChat): string {
        return `${chat.type}/${chat.id}`;
    }

    private _getFullKey(chat: DomainChat, username: string): string {
        return `${this._getChatKey(chat)}/@${username}`;
    }

    private _getTriggerKey(chat: DomainChat): string {
        return `${TRIGGER_FOLDER_NAME}/${chat.type}@${chat.id}`;
    }

    private _getPropertiesKey(chat: DomainChat): string {
        return `${this._getChatKey(chat)}/${PROPERTIES_NAME}`;
    }

    private async _objectExist(key: string, errMsg: string): Promise<boolean> {
        try {
            await this.s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
            return true;
        } catch (e) {
            if (isNotFound(e)) return false;
            throw new ServiceError(errMsg, e);
        }
    }

    private _userExist(chat: DomainChat, username: string): Promise<boolean> {
        const userKey = this._getFullKey(chat, username);
        return this._objectExist(userKey, `Ошибка при проверке наличия пользователя ${userKey}.`);
    }

    private async _getProperties(chat: DomainChat): Promise<Properties> {
        const key = this._getPropertiesKey(chat);
        try {
            const response = await this.s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
            return await readJson<Properties>(response.Body);
        } catch (e) {
            if (isNotFound(e)) return { ...INIT_PROPERTIES };
            if (e instanceof ServiceError) throw e;
            throw new ServiceError(`Ошибка при получении настроек для чата ${key}.`, e);
        }
    }

    private async _updateProperties(chat: DomainChat, newProperties: Properties): Promise<Properties> {
        try {
            await this.s3.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: this._getPropertiesKey(chat),
                ContentType: 'application/json',
                Body: JSON.stringify(newProperties, null, 2),
            }));
        } catch (e) {
            throw new ServiceError(`Ошибка при обновлении настроек хранилища для ${chat.id}.`, e);
        }
        return newProperties;
    }

}

function isNotFound(e: unknown): boolean {
    if (typeof e !== 'object' || e === null) return false;
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
}
