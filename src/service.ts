import { ServiceError } from './errors';
import type { Storage } from './storage/types';
import type { ChatState } from './storage/types';
import type { DomainChat, Properties } from './types';

const DEFAULT_PROPS: Properties = { dutyCount: 1 };
const INIT_TRIGGER_HOUR = 9;

/**
 * Storage stores BARE usernames + per-member `servedCount`. Service prefixes
 * `@` only when speaking to the Controller.
 *
 * `/duty` is a non-atomic read-modify-write: between `getChatState()` and
 * `incrementServeCounts()` another concurrent `/duty` in the same chat could
 * pick the same set. Accepted risk — traffic is one-cron-per-day plus rare
 * manual calls.
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
            await this.storage.setProperties(chat, { ...DEFAULT_PROPS });
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
        try {
            await this.storage.setProperties(chat, { dutyCount });
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

    /**
     * Picks `dutyCount` members with the lowest `servedCount`. Ties broken by
     * username (alphabetic). Increments their counters before returning.
     *
     * Newly registered members start at `servedCount = 0` and naturally go
     * to the front of the queue. Removed members vanish without leaving stale
     * state. No "round" bookkeeping needed.
     */
    async duty(chat: DomainChat): Promise<string[]> {
        const state = await this._getChatState(chat);
        const members = state.members;
        if (members.length === 0) return [];

        const sorted = [...members].sort(
            (a, b) => a.servedCount - b.servedCount || a.username.localeCompare(b.username),
        );
        const k = Math.min(state.props.dutyCount, members.length);
        const pick = sorted.slice(0, k).map((m) => m.username);

        try {
            await this.storage.incrementServeCounts(chat, pick);
        } catch (e) {
            throw new ServiceError(`Ошибка при обновлении счётчиков дежурных для ${chat.id}.`, e);
        }
        return pick.map((u) => `@${u}`);
    }

    /**
     * Returns members in `@username (count)` format, sorted alphabetically.
     * Counts make perekos visible at a glance.
     */
    async list(chat: DomainChat): Promise<string[]> {
        const state = await this._getChatState(
            chat,
            `Ошибка при запросе списка дежурных для ${this._readableName(chat)}.`,
        );
        return [...state.members]
            .sort((a, b) => a.username.localeCompare(b.username))
            .map((m) => `@${m.username} (${m.servedCount})`);
    }

    private async _getChatState(chat: DomainChat, errMsg?: string): Promise<ChatState> {
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
