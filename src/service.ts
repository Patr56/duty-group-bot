import { ServiceError } from './errors';
import type { Storage } from './storage/types';
import type { DomainChat, Properties } from './types';

const INIT_PROPERTIES: Properties = { dutyCount: 1, roundServed: [] };
const INIT_TRIGGER_HOUR = 9;

/**
 * Storage stores BARE usernames. Service prefixes `@` only when speaking to
 * the Controller. `Properties.roundServed` therefore also contains bare names.
 *
 * `/duty` is a non-atomic read-modify-write: between getChatState() and
 * setChatState() another concurrent /duty in the same chat could clobber the
 * round. Accepted risk — traffic is one-cron-per-day plus rare manual calls.
 */
export class Service {
    constructor(private readonly storage: Storage) {}

    async init(chat: DomainChat): Promise<string> {
        const name = this._readableName(chat);
        let exists: boolean;
        try {
            exists = await this.storage.propsExists(chat);
        } catch (e) {
            throw new ServiceError(`Ошибка при проверке хранилища для "${name}".`, e);
        }
        if (exists) {
            return `Хранилище для "${name}" уже создано.`;
        }
        try {
            await this.storage.setChatState(chat, { ...INIT_PROPERTIES, roundServed: [] });
        } catch (e) {
            throw new ServiceError(`Ошибка при создании хранилища для "${name}".`, e);
        }
        return `Хранилище для "${name}" создано, дежурные могут регистрироваться.`;
    }

    async getChats(): Promise<DomainChat[]> {
        try {
            return await this.storage.listTriggers();
        } catch (e) {
            throw new ServiceError('Ошибка при запросе списка тригеров.', e);
        }
    }

    async triggerOn(chat: DomainChat): Promise<string> {
        const name = this._readableName(chat);
        try {
            await this.storage.setTrigger(chat, INIT_TRIGGER_HOUR);
        } catch (e) {
            throw new ServiceError(`Ошибка при создании триггера для "${name}".`, e);
        }
        return `Триггер для "${name}" создан.`;
    }

    async triggerOff(chat: DomainChat): Promise<string> {
        const name = this._readableName(chat);
        try {
            await this.storage.removeTrigger(chat);
        } catch (e) {
            throw new ServiceError(`Ошибка при удалении триггера для "${name}".`, e);
        }
        return `Триггер для "${name}" удалён.`;
    }

    async reset(chat: DomainChat): Promise<string> {
        await this.clear(chat);
        return this.init(chat);
    }

    async clear(chat: DomainChat): Promise<void> {
        const name = this._readableName(chat);
        try {
            await this.storage.clearChat(chat);
        } catch (e) {
            throw new ServiceError(`Ошибка при очистке хранилища для "${name}".`, e);
        }
        await this.triggerOff(chat).catch(() => undefined);
    }

    async setDutyCount(chat: DomainChat, dutyCount: number): Promise<number> {
        const state = await this._getChatState(chat);
        try {
            await this.storage.setChatState(chat, {
                dutyCount,
                roundServed: state.props.roundServed,
            });
        } catch (e) {
            throw new ServiceError(`Ошибка при обновлении настроек хранилища для ${chat.id}.`, e);
        }
        return dutyCount;
    }

    async reg(chat: DomainChat, username: string): Promise<string> {
        if (await this.storage.memberExists(chat, username)) {
            return `Пользователь @${username} уже добавлен.`;
        }
        try {
            await this.storage.addMember(chat, username);
        } catch (e) {
            throw new ServiceError(`Ошибка при регистрации пользователя @${username}.`, e);
        }
        const count = (await this._getChatState(chat)).members.length;
        return `@${username} добавлен в дежурные.\nКоличество дежурных: ${count}`;
    }

    async unreg(chat: DomainChat, username: string): Promise<string> {
        if (!(await this.storage.memberExists(chat, username))) {
            return `Пользователь @${username} уже удалён.`;
        }
        try {
            await this.storage.removeMember(chat, username);
        } catch (e) {
            throw new ServiceError(`Ошибка при удалении пользователя ${username}.`, e);
        }
        const count = (await this._getChatState(chat)).members.length;
        return `@${username} удалён из дежурных.\nКоличество дежурных: ${count}`;
    }

    async duty(chat: DomainChat): Promise<string[]> {
        const state = await this._getChatState(chat);
        const members = state.members;

        let roundServed = state.props.roundServed;
        let eligible = members.filter((u) => !roundServed.includes(u));
        if (eligible.length === 0) {
            roundServed = [];
            eligible = members;
        }

        const newDuty = eligible
            .slice()
            .sort(() => Math.random() - 0.5)
            .slice(0, state.props.dutyCount);

        try {
            await this.storage.setChatState(chat, {
                dutyCount: state.props.dutyCount,
                roundServed: [...roundServed, ...newDuty],
            });
        } catch (e) {
            throw new ServiceError(`Ошибка при обновлении настроек хранилища для ${chat.id}.`, e);
        }
        return newDuty.map((u) => `@${u}`);
    }

    async list(chat: DomainChat): Promise<string[]> {
        const state = await this._getChatState(chat, `Ошибка при запросе списка дежурных для ${this._readableName(chat)}.`);
        return state.members.map((u) => `@${u}`);
    }

    private async _getChatState(chat: DomainChat, errMsg?: string): Promise<{
        props: Properties;
        members: string[];
    }> {
        try {
            return await this.storage.getChatState(chat);
        } catch (e) {
            if (e instanceof ServiceError) throw e;
            throw new ServiceError(errMsg ?? `Ошибка при получении настроек для чата ${chat.id}.`, e);
        }
    }

    private _readableName(chat: DomainChat): string {
        return `${chat.username ?? chat.title ?? chat.id}`;
    }
}
