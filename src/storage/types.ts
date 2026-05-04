import type { DomainChat, Member, Properties } from '../types';

/**
 * Snapshot of a chat: settings + members with per-user `servedCount`.
 * If the chat has no settings record yet, `props` defaults to `{ dutyCount: 1 }`
 * (self-heal at the storage layer).
 */
export interface ChatState {
    props: Properties;
    members: Member[];
}

export interface Storage {
    /** Single read of {chat_props ∪ chat_members} for the chat. */
    getChatState(chat: DomainChat): Promise<ChatState>;

    /** Write chat-level settings (dutyCount only). Used by `init` and `setDutyCount`. */
    setProperties(chat: DomainChat, props: Properties): Promise<void>;

    /**
     * Atomic `served_count += 1` for the given usernames in this chat.
     * Treats NULL/missing counters as 0. Members not present are silently
     * skipped (no INSERT — only existing rows are bumped).
     */
    incrementServeCounts(chat: DomainChat, usernames: string[]): Promise<void>;

    /** True iff an explicit chat_props record exists (drives `/start` messaging). */
    propsExists(chat: DomainChat): Promise<boolean>;

    memberExists(chat: DomainChat, username: string): Promise<boolean>;
    /**
     * Inserts a new member with `servedCount = min(existing members' counts)`,
     * or `0` if the chat has no members yet. Re-adding an existing member is a
     * no-op (counter is preserved).
     *
     * Why min and not 0: a newcomer joining a chat where existing members have
     * served many times would otherwise stay at the front of the queue for as
     * many days as the gap, dominating duty until they catch up.
     */
    addMember(chat: DomainChat, username: string): Promise<void>;
    removeMember(chat: DomainChat, username: string): Promise<void>;

    setTrigger(chat: DomainChat, hour: number): Promise<void>;
    removeTrigger(chat: DomainChat): Promise<void>;
    listTriggers(): Promise<DomainChat[]>;

    /** Deletes chat_props and chat_members for the chat. Trigger is NOT touched. */
    clearChat(chat: DomainChat): Promise<void>;
}
