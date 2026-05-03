import type { DomainChat, Properties } from '../types';

/**
 * Snapshot of a chat: settings + member list. `members` and `props.roundServed`
 * carry BARE usernames (no `@`). Service prefixes `@` only at the boundary
 * with the Controller.
 *
 * If the chat has no settings record yet, `props` is the default
 * `{ dutyCount: 1, roundServed: [] }`. Self-heal lives at the storage layer.
 */
export interface ChatState {
    props: Properties;
    members: string[];
}

export interface Storage {
    /** One read of {chat_props ∪ chat_members ∪ round_served} for the chat. */
    getChatState(chat: DomainChat): Promise<ChatState>;

    /**
     * Atomically replaces both the chat-level properties and the round_served
     * list. Used by `init`, `setDutyCount`, and `duty` (which always writes a
     * fresh roundServed value — including `[]` after a round reset).
     */
    setChatState(chat: DomainChat, props: Properties): Promise<void>;

    /** True iff an explicit chat_props record exists (drives `/start` messaging). */
    propsExists(chat: DomainChat): Promise<boolean>;

    memberExists(chat: DomainChat, username: string): Promise<boolean>;
    addMember(chat: DomainChat, username: string): Promise<void>;
    removeMember(chat: DomainChat, username: string): Promise<void>;

    setTrigger(chat: DomainChat, hour: number): Promise<void>;
    removeTrigger(chat: DomainChat): Promise<void>;
    listTriggers(): Promise<DomainChat[]>;

    /** Deletes chat_props, chat_members and round_served for the chat. Trigger is NOT touched. */
    clearChat(chat: DomainChat): Promise<void>;
}
