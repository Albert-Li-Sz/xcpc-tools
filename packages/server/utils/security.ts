import { timingSafeEqual } from 'node:crypto';

export function validReportToken(expected: unknown, supplied: unknown) {
    if (typeof expected !== 'string' || !expected || typeof supplied !== 'string') return false;
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    return left.length === right.length && timingSafeEqual(left, right);
}

export function stripProxyCredentials(request: { removeHeader(name: string): void }) {
    for (const name of ['authorization', 'proxy-authorization', 'cookie']) request.removeHeader(name);
}
