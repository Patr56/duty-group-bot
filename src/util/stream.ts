import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { ServiceError } from '../errors';

type S3Body = GetObjectCommandOutput['Body'];

export async function readJson<T>(body: S3Body): Promise<T> {
    if (!body) {
        throw new ServiceError('Пустое тело ответа S3.');
    }
    const text = await body.transformToString();
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        throw new ServiceError('Ошибка при парсинге JSON из S3.', e);
    }
}
