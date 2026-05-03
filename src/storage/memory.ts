import type { DomainChat, Properties } from '../types';
import type { ChatState, Storage } from './types';

interface ChatRow {
    props?: Properties;
    members: Set<string>;
}

interface TriggerRow {
    chat: DomainChat;
    hour: number;
}

const DEFAULT_PROPS: Properties = { dutyCount: 1, roundServed: [] };

function chatPk(chat: DomainChat): string {
    return `${chat.type}#${chat.id}`;
}

function cloneProps(p: Properties): Properties {
    return { dutyCount: p.dutyCount, roundServed: [...p.roundServed] };
}

export class InMemoryStorage implements Storage {
    private readonly chats = new Map<string, ChatRow>();
    private readonly triggers = new Map<string, TriggerRow>();

    private _ensure(chat: DomainChat): ChatRow {
        const pk = chatPk(chat);
        let row = this.chats.get(pk);
        if (!row) {
            row = { members: new Set() };
            this.chats.set(pk, row);
        }
        return row;
    }

    async getChatState(chat: DomainChat): Promise<ChatState> {
        const row = this.chats.get(chatPk(chat));
        return {
            props: row?.props ? cloneProps(row.props) : cloneProps(DEFAULT_PROPS),
            members: row ? [...row.members] : [],
        };
    }

    async setChatState(chat: DomainChat, props: Properties): Promise<void> {
        this._ensure(chat).props = cloneProps(props);
    }

    async propsExists(chat: DomainChat): Promise<boolean> {
        return Boolean(this.chats.get(chatPk(chat))?.props);
    }

    async memberExists(chat: DomainChat, username: string): Promise<boolean> {
        return this.chats.get(chatPk(chat))?.members.has(username) ?? false;
    }

    async addMember(chat: DomainChat, username: string): Promise<void> {
        this._ensure(chat).members.add(username);
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
