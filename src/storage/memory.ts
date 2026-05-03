import type { DomainChat, Member, Properties } from '../types';
import type { ChatState, Storage } from './types';

interface ChatRow {
    props?: Properties;
    members: Map<string, Member>;
}

interface TriggerRow {
    chat: DomainChat;
    hour: number;
}

const DEFAULT_PROPS: Properties = { dutyCount: 1 };

function chatPk(chat: DomainChat): string {
    return `${chat.type}#${chat.id}`;
}

function cloneProps(p: Properties): Properties {
    return { dutyCount: p.dutyCount };
}

function cloneMember(m: Member): Member {
    return { username: m.username, servedCount: m.servedCount };
}

export class InMemoryStorage implements Storage {
    private readonly chats = new Map<string, ChatRow>();
    private readonly triggers = new Map<string, TriggerRow>();

    private _ensure(chat: DomainChat): ChatRow {
        const pk = chatPk(chat);
        let row = this.chats.get(pk);
        if (!row) {
            row = { members: new Map() };
            this.chats.set(pk, row);
        }
        return row;
    }

    async getChatState(chat: DomainChat): Promise<ChatState> {
        const row = this.chats.get(chatPk(chat));
        return {
            props: row?.props ? cloneProps(row.props) : cloneProps(DEFAULT_PROPS),
            members: row ? [...row.members.values()].map(cloneMember) : [],
        };
    }

    async setProperties(chat: DomainChat, props: Properties): Promise<void> {
        this._ensure(chat).props = cloneProps(props);
    }

    async incrementServeCounts(chat: DomainChat, usernames: string[]): Promise<void> {
        const row = this.chats.get(chatPk(chat));
        if (!row) return;
        for (const u of usernames) {
            const m = row.members.get(u);
            if (m) m.servedCount += 1;
        }
    }

    async propsExists(chat: DomainChat): Promise<boolean> {
        return Boolean(this.chats.get(chatPk(chat))?.props);
    }

    async memberExists(chat: DomainChat, username: string): Promise<boolean> {
        return this.chats.get(chatPk(chat))?.members.has(username) ?? false;
    }

    async addMember(chat: DomainChat, username: string): Promise<void> {
        const row = this._ensure(chat);
        if (!row.members.has(username)) {
            row.members.set(username, { username, servedCount: 0 });
        }
    }

    async removeMember(chat: DomainChat, username: string): Promise<void> {
        this.chats.get(chatPk(chat))?.members.delete(username);
    }

    async setTrigger(chat: DomainChat, hour: number): Promise<void> {
        this.triggers.set(chatPk(chat), { chat: { id: chat.id, type: chat.type }, hour });
    }

    async removeTrigger(chat: DomainChat): Promise<void> {
        this.triggers.delete(chatPk(chat));
    }

    async listTriggers(): Promise<DomainChat[]> {
        return [...this.triggers.values()].map((t) => ({ id: t.chat.id, type: t.chat.type }));
    }

    async clearChat(chat: DomainChat): Promise<void> {
        this.chats.delete(chatPk(chat));
    }
}
