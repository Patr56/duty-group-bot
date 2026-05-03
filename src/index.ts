import { Driver, MetadataAuthService } from 'ydb-sdk';

import { Service } from './service';
import { Controller } from './controller';
import { createHandler } from './handler';
import { YdbStorage } from './storage/ydb';
import type { YcFunctionContext } from './types';

const token = process.env.BOT_TOKEN;
const ownerId = process.env.OWNER_ID;
const ydbEndpoint = process.env.YDB_ENDPOINT;
const ydbDatabase = process.env.YDB_DATABASE;
if (!token || !ownerId || !ydbEndpoint || !ydbDatabase) {
    throw new Error('BOT_TOKEN, OWNER_ID, YDB_ENDPOINT and YDB_DATABASE env vars are required');
}

const driver = new Driver({
    endpoint: ydbEndpoint,
    database: ydbDatabase,
    authService: new MetadataAuthService(),
});

let controller: Controller | undefined;
let driverReady: Promise<boolean> | undefined;

export const handler = async (event: unknown, functionContext: YcFunctionContext) => {
    if (!driverReady) driverReady = driver.ready(10_000);
    const ready = await driverReady;
    if (!ready) {
        driverReady = undefined;
        throw new Error('YDB driver not ready');
    }

    if (!controller) {
        const storage = new YdbStorage(driver);
        const service = new Service(storage);
        controller = new Controller(service, token, ownerId, functionContext);
    }
    return createHandler({ controller })(event as Parameters<ReturnType<typeof createHandler>>[0], functionContext);
};
