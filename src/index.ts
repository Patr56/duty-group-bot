import { S3Client } from '@aws-sdk/client-s3';

import { Service } from './service';
import { Controller } from './controller';
import { createHandler } from './handler';
import type { YcFunctionContext } from './types';

const token = process.env.BOT_TOKEN;
const ownerId = process.env.OWNER_ID;
if (!token || !ownerId) {
    throw new Error('BOT_TOKEN and OWNER_ID env vars are required');
}

const s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'ru-central1',
    endpoint: 'https://storage.yandexcloud.net',
    forcePathStyle: true,
});

let controller: Controller | undefined;

export const handler = async (event: unknown, functionContext: YcFunctionContext) => {
    if (!controller) {
        const service = new Service(s3);
        controller = new Controller(service, token, ownerId, functionContext);
    }
    return createHandler({ controller })(event as Parameters<ReturnType<typeof createHandler>>[0], functionContext);
};
