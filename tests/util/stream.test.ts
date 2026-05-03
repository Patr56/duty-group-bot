import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { sdkStreamMixin } from '@smithy/util-stream';

import { readJson } from '../../src/util/stream';
import { ServiceError } from '../../src/errors';

function bodyOf(text: string) {
    const stream = new Readable();
    stream.push(text);
    stream.push(null);
    return sdkStreamMixin(stream);
}

describe('readJson', () => {
    it('parses a JSON body into the typed object', async () => {
        const body = bodyOf(JSON.stringify({ dutyCount: 3, lastDuty: ['@a'] }));
        await expect(readJson<{ dutyCount: number; lastDuty: string[] }>(body))
            .resolves.toEqual({ dutyCount: 3, lastDuty: ['@a'] });
    });

    it('throws ServiceError when body is undefined', async () => {
        await expect(readJson(undefined)).rejects.toBeInstanceOf(ServiceError);
        await expect(readJson(undefined)).rejects.toThrow(/Пустое тело/);
    });

    it('throws ServiceError on invalid JSON', async () => {
        const body = bodyOf('not json');
        await expect(readJson(body)).rejects.toBeInstanceOf(ServiceError);
        await expect(readJson(bodyOf('also not json'))).rejects.toThrow(/парсинге JSON/);
    });
});
