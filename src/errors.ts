export class ServiceError extends Error {
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'ServiceError';
        this.cause = cause;
    }
}
