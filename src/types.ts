export interface DomainChat {
    id: number | string;
    type: string;
    username?: string;
    title?: string;
}

export interface Properties {
    dutyCount: number;
    roundServed: string[];
}

export interface Trigger {
    time: number;
}

export interface YcMessageEvent {
    messages: unknown[];
}

export interface YcHttpEvent {
    body?: string;
    httpMethod?: string;
    headers?: Record<string, string>;
}

export type YcEvent = YcMessageEvent | YcHttpEvent;

export interface YcFunctionContext {
    functionVersion: string;
    requestId?: string;
}

export interface HandlerResponse {
    statusCode: number;
    body: string;
}
