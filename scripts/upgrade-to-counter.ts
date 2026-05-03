/**
 * One-shot schema upgrade: schema v1 (round_served + roundServed list) →
 * schema v2 (per-member `served_count Uint64`).
 *
 * Operations:
 *   1. ALTER TABLE chat_members ADD COLUMN served_count Uint64 (idempotent —
 *      if column exists already, we catch the error and continue).
 *   2. DROP TABLE round_served (idempotent via IF EXISTS).
 *
 * No data migration. Existing members get `served_count = NULL` which is
 * read as 0 by the application via COALESCE — every chat starts the new
 * counter from a clean slate. The pre-fix `roundServed` data was a
 * round-tracking mechanism that had no equivalent in the new algorithm,
 * so it's discarded by design.
 *
 * Idempotent: re-running is safe.
 *
 * Required env:
 *   YDB_ENDPOINT, YDB_DATABASE
 *   YDB_ACCESS_TOKEN_CREDENTIALS              — IAM token (`yc iam create-token`)
 *     OR YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS — path to SA key JSON
 */
import { Driver, getCredentialsFromEnv } from 'ydb-sdk';

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} env var is required`);
    return v;
}

const STATEMENTS: { label: string; ddl: string }[] = [
    {
        label: 'ALTER TABLE chat_members ADD COLUMN served_count Uint64',
        ddl: 'ALTER TABLE chat_members ADD COLUMN served_count Uint64;',
    },
    {
        label: 'DROP TABLE round_served',
        ddl: 'DROP TABLE IF EXISTS round_served;',
    },
];

function isAlreadyApplied(e: unknown): boolean {
    const msg = (e as { message?: string }).message ?? '';
    // ADD COLUMN of an existing column / DROP of a missing table.
    return /already exists/i.test(msg)
        || /already added/i.test(msg)
        || /Cannot find table/i.test(msg)
        || /Column .+ already exists/i.test(msg)
        || /already in column/i.test(msg);
}

async function main(): Promise<void> {
    const endpoint = required('YDB_ENDPOINT');
    const database = required('YDB_DATABASE');

    console.log(`Target: ${endpoint} ${database}`);

    const driver = new Driver({
        endpoint,
        database,
        authService: getCredentialsFromEnv(),
    });
    const ready = await driver.ready(15_000);
    if (!ready) throw new Error('YDB driver not ready');

    try {
        for (const { label, ddl } of STATEMENTS) {
            try {
                await driver.queryClient.do({
                    fn: async (session) => {
                        await session.execute({ text: ddl });
                    },
                });
                console.log(`✓ ${label}`);
            } catch (e) {
                if (isAlreadyApplied(e)) {
                    console.log(`= ${label} (already applied)`);
                    continue;
                }
                throw e;
            }
        }
        console.log('Schema upgraded to v2.');
    } finally {
        await driver.destroy();
    }
}

main().catch((e) => {
    console.error('Schema upgrade failed:', e);
    process.exit(1);
});
