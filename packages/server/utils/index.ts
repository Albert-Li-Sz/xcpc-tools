import { gunzipSync } from 'node:zlib';
import { decode } from 'base16384';

export { Logger, sleep, randomstring } from '@hydrooj/utils';

// https://github.com/andrasq/node-mongoid-js/blob/master/mongoid.js
export function mongoId(idstring: string) {
    if (typeof idstring !== 'string') idstring = String(idstring);
    return {
        timestamp: parseInt(idstring.slice(0, 0 + 8), 16),
        machineid: parseInt(idstring.slice(8, 8 + 6), 16),
        pid: parseInt(idstring.slice(14, 14 + 4), 16),
        sequence: parseInt(idstring.slice(18, 18 + 6), 16),
    };
}

export * as fs from 'fs-extra';
export * as yaml from 'js-yaml';

export function StaticHTML(context, randomHash) {
    const safeContext = JSON.stringify(context)
        .replace(/&/g, '\\u0026')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    // eslint-disable-next-line max-len
    const favicon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" rx="7" fill="%232281e0"/%3E%3Cpath d="m10 9 12 14M22 9 10 23" stroke="white" stroke-width="4"/%3E%3C/svg%3E';
    return `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href='${favicon}'><title>@Hydro/XCPC-TOOLS</title></head><body><div id="root"></div><script>window.Context=${safeContext}</script><script src="/main.js?${randomHash}"></script></body></html>`;
}

export function decodeBinary(file: string | Buffer, name: string) {
    if (process.env.NODE_ENV === 'development') return Buffer.from(file as string, 'base64');
    if ('Deno' in globalThis) return globalThis.Deno.readFileSync(name);
    if (typeof file === 'string') return gunzipSync(decode(file));
    return file;
}

export * from './commandRunner';
export * from './printers';
export * from './color';
export * from './receipt';
export * from './metrics';
