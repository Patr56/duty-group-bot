/**
 * One-shot migration: copy chat/member/trigger state from the S3 bucket
 * `duty-group-bot-storage` into YDB Serverless. Idempotent — re-runnable.
 *
 * Behaviour:
 *   - Creates the four tables in YDB if missing (chat_props, chat_members,
 *     round_served, triggers).
 *   - For each chat in S3, compares against YDB:
 *       - YDB empty → copy from S3.
 *       - YDB equal to S3 → skip.
 *       - YDB differs → WARN and skip (refuses to overwrite live state).
 *   - Strips the leading `@` from usernames (DB stores them bare).
 *   - Reads legacy `lastDuty` field as `roundServed` (back-compat).
 *
 * Required env:
 *   YDB_ENDPOINT, YDB_DATABASE              — target DB
 *   YDB_ACCESS_TOKEN_CREDENTIALS            — IAM token (from `yc iam create-token`)
 *     OR YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS — path to SA key JSON
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY — Yandex S3 static keys (read-only is enough)
 *
 * Optional:
 *   S3_BUCKET   (default: duty-group-bot-storage)
 *   S3_ENDPOINT (default: https://storage.yandexcloud.net)
 *
 * Flags:
 *   --dry-run   plan only, no writes to YDB
 *   --verbose   per-chat trace
 *   --schema-only  create tables, then exit
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { Driver, getCredentialsFromEnv } from 'ydb-sdk';

import { YdbStorage, TABLE_DDL } from '../src/storage/ydb';
import type { DomainChat, Properties } from '../src/types';

const BUCKET = process.env.S3_BUCKET ?? 'duty-group-bot-storage';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'https://storage.yandexcloud.net';

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const VERBOSE = argv.has('--verbose');
const SCHEMA_ONLY = argv.has('--schema-only');

interface ChatBundle {
    chat: DomainChat;
    propsKey: string;
    memberKeys: string[];
}

interface TriggerBundle {
    chat: DomainChat;
    key: string;
}

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} env var is required`);
    return v;
}

function stripAt(s: string): string {
    return s.startsWith('@') ? s.slice(1) : s;
}

function parseChatId(raw: string): number | string {
    const n = Number(raw);
    return Number.isFinite(n) && String(n) === raw ? n : raw;
}

async function listAllKeys(s3: S3Client, bucket: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

function group(keys: string[]): { chats: Map<string, ChatBundle>; triggers: TriggerBundle[] } {
    const chats = new Map<string, ChatBundle>();
    const triggers: TriggerBundle[] = [];

    for (const key of keys) {
        if (key.startsWith('trigger/')) {
            const tail = key.slice('trigger/'.length);
            const [type, idStr] = tail.split('@');
            if (!type || !idStr) continue;
            triggers.push({
                chat: { type, id: parseChatId(idStr) },
                key,
            });
            continue;
        }

        // {type}/{id}/{name}
        const parts = key.split('/');
        if (parts.length < 3) continue;
        const [type, idStr, name] = parts;
        if (!type || !idStr || !name) continue;
        const pk = `${type}#${idStr}`;
        const chat: DomainChat = { type, id: parseChatId(idStr) };
        let bundle = chats.get(pk);
        if (!bundle) {
            bundle = { chat, propsKey: `${type}/${idStr}/properties.json`, memberKeys: [] };
            chats.set(pk, bundle);
        }
        if (name === 'properties.json') continue;
        bundle.memberKeys.push(name);
    }

    return { chats, triggers };
}

function isNotFound(e: unknown): boolean {
    if (typeof e !== 'object' || e === null) return false;
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

async function readPropsFromS3(s3: S3Client, key: string): Promise<Properties> {
    try {
        const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const raw = await got.Body!.transformToString();
        const parsed = JSON.parse(raw) as Partial<Properties> & { lastDuty?: string[] };
        const roundServed = (parsed.roundServed ?? parsed.lastDuty ?? []).map(stripAt);
        return {
            dutyCount: parsed.dutyCount ?? 1,
            roundServed,
        };
    } catch (e) {
        if (isNotFound(e)) return { dutyCount: 1, roundServed: [] };
        throw e;
    }
}

async function readTriggerFromS3(s3: S3Client, key: string): Promise<{ hour: number }> {
    try {
        const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const raw = await got.Body!.transformToString();
        const parsed = JSON.parse(raw) as { time?: number };
        return { hour: parsed.time ?? 9 };
    } catch (e) {
        if (isNotFound(e)) return { hour: 9 };
        throw e;
    }
}

async function ensureTables(driver: Driver): Promise<void> {
    // YQL DDL via QueryClient — tables created through `session.createTable` API
    // are not visible to YQL queries on this YDB Serverless instance, so we use
    // raw YQL `CREATE TABLE IF NOT EXISTS` instead. Idempotent.
    for (const [name, ddl] of Object.entries(TABLE_DDL)) {
        await driver.queryClient.do({
            fn: async (session) => {
                await session.execute({ text: ddl });
            },
        });
        console.log(`Ensured table ${name}`);
    }
}

function chatKey(chat: DomainChat): string {
    return `${chat.type}#${chat.id}`;
}

function sortedJson(arr: readonly string[]): string {
    return JSON.stringify([...arr].sort());
}

async function main() {
    const ydbEndpoint = required('YDB_ENDPOINT');
    const ydbDatabase = required('YDB_DATABASE');
    required('AWS_ACCESS_KEY_ID');
    required('AWS_SECRET_ACCESS_KEY');

    console.log(`Target YDB:  ${ydbEndpoint} ${ydbDatabase}`);
    console.log(`Source S3:   ${S3_ENDPOINT}/${BUCKET}`);
    console.log(`Mode:        ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}${SCHEMA_ONLY ? ' (schema only)' : ''}`);
    console.log('');

    const driver = new Driver({
        endpoint: ydbEndpoint,
        database: ydbDatabase,
        authService: getCredentialsFromEnv(),
    });
    const ready = await driver.ready(15_000);
    if (!ready) throw new Error('YDB driver not ready (auth or network issue)');

    try {
        await ensureTables(driver);
        if (SCHEMA_ONLY) {
            console.log('Schema-only run complete.');
            return;
        }

        const s3 = new S3Client({
            region: 'ru-central1',
            endpoint: S3_ENDPOINT,
            forcePathStyle: true,
        });

        console.log('Listing S3 bucket...');
        const keys = await listAllKeys(s3, BUCKET);
        console.log(`Found ${keys.length} keys`);

        const { chats, triggers } = group(keys);
        console.log(`Discovered ${chats.size} chat(s) and ${triggers.length} trigger(s)`);
        console.log('');

        const ydb = new YdbStorage(driver);

        let cWritten = 0;
        let cSkipped = 0;
        let cWarned = 0;
        for (const bundle of chats.values()) {
            const pk = chatKey(bundle.chat);
            const s3Props = await readPropsFromS3(s3, bundle.propsKey);
            const s3Members = bundle.memberKeys.map(stripAt).sort();

            const existingState = await ydb.getChatState(bundle.chat);
            const existingPropsExists = await ydb.propsExists(bundle.chat);
            const ydbHasAnything = existingPropsExists || existingState.members.length > 0;

            if (ydbHasAnything) {
                const sameMembers = sortedJson(existingState.members) === JSON.stringify(s3Members);
                const sameRound = sortedJson(existingState.props.roundServed) === sortedJson(s3Props.roundServed);
                const sameDc = existingState.props.dutyCount === s3Props.dutyCount;
                if (sameMembers && sameRound && sameDc) {
                    cSkipped++;
                    if (VERBOSE) console.log(`= ${pk} (identical)`);
                    continue;
                }
                cWarned++;
                console.warn(`! ${pk} DIFFERS in YDB:`);
                console.warn(`    S3:  dutyCount=${s3Props.dutyCount}, members=${s3Members.length}, round=${s3Props.roundServed.length}`);
                console.warn(`    YDB: dutyCount=${existingState.props.dutyCount}, members=${existingState.members.length}, round=${existingState.props.roundServed.length}`);
                console.warn(`    → keeping YDB state. Resolve manually if S3 is the source of truth.`);
                continue;
            }

            if (DRY_RUN) {
                cWritten++;
                if (VERBOSE) console.log(`+ ${pk} (would write: ${s3Members.length} members, dutyCount=${s3Props.dutyCount})`);
                continue;
            }

            await ydb.setChatState(bundle.chat, s3Props);
            for (const m of s3Members) await ydb.addMember(bundle.chat, m);
            cWritten++;
            if (VERBOSE) console.log(`+ ${pk} (wrote: ${s3Members.length} members, dutyCount=${s3Props.dutyCount})`);
        }

        let tWritten = 0;
        let tSkipped = 0;
        const existingTriggers = await ydb.listTriggers();
        const haveTrigger = new Set(existingTriggers.map((c) => chatKey(c)));
        for (const t of triggers) {
            const pk = chatKey(t.chat);
            if (haveTrigger.has(pk)) {
                tSkipped++;
                if (VERBOSE) console.log(`= trigger ${pk} (exists)`);
                continue;
            }
            const { hour } = await readTriggerFromS3(s3, t.key);
            if (DRY_RUN) {
                tWritten++;
                if (VERBOSE) console.log(`+ trigger ${pk} (would write: hour=${hour})`);
                continue;
            }
            await ydb.setTrigger(t.chat, hour);
            tWritten++;
            if (VERBOSE) console.log(`+ trigger ${pk} (wrote: hour=${hour})`);
        }

        console.log('');
        console.log('Summary');
        console.log(`  Chats:    ${cWritten} written, ${cSkipped} skipped, ${cWarned} warned`);
        console.log(`  Triggers: ${tWritten} written, ${tSkipped} skipped`);
        if (cWarned > 0) {
            console.warn('Some chats differ between S3 and YDB. Inspect logs above and reconcile manually before deploy.');
        }
    } finally {
        await driver.destroy();
    }
}

main().catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
});
