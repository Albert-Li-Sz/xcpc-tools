import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PrintCodeDoc } from '../interface';

export const MAX_CODE_SIZE = 256 * 1024;

function field(value: unknown, name: string, max: number, required = false) {
    if (value === undefined || value === null) {
        if (required) throw new Error(`${name} is required`);
        return '';
    }
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`${name} must be text`);
    }
    const text = String(value).trim();
    if ((required && !text) || text.length > max || Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        throw new Error(`${name} is empty, too long, or contains control characters`);
    }
    return text;
}

export function parsePrintSubmission(input: Record<string, unknown>, fallbackFilename = 'code.txt') {
    const tid = field(input.team, 'Team ID', 128, true);
    const name = field(input.tname, 'Team name', 256, true);
    const filename = field(input.filename ?? fallbackFilename, 'Filename', 255, true);
    if (/[\\/]/.test(tid) || /[\\/]/.test(filename)) throw new Error('Team ID and filename cannot contain path separators');
    return {
        tid,
        team: `${tid}: ${name}`,
        filename,
        lang: field(input.lang, 'Language', 32) || 'txt',
        location: field(input.location, 'Location', 128),
        group: field(input.group, 'Group', 64).toUpperCase(),
    };
}

export function printCodePath(id: string, root = process.cwd()) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid print task ID');
    return path.resolve(root, 'data/codes', `${id}.code`);
}

export function readPrintCode(doc: Pick<PrintCodeDoc, '_id' | 'tid'>, root = process.cwd()) {
    const current = printCodePath(doc._id, root);
    if (fs.existsSync(current)) return fs.readFileSync(current);
    const legacy = `${doc.tid}#${doc._id}`;
    if (/[\\/]/.test(legacy) || legacy.includes('\0')) throw new Error('Unsafe legacy print filename');
    return fs.readFileSync(path.join(path.dirname(current), legacy));
}

export async function storePrintCode(db, metadata: Omit<PrintCodeDoc, '_id'>, content: Buffer, root = process.cwd()) {
    if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_CODE_SIZE) {
        throw new Error('Code must contain between 1 and 262144 bytes');
    }
    const _id = randomBytes(12).toString('hex');
    const filename = printCodePath(_id, root);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
    try {
        return await db.insert({
            ...metadata, _id, stage: metadata.done ? 'done' : 'queued', attemptCount: 0,
        });
    } catch (error) {
        fs.unlinkSync(filename);
        throw error;
    }
}
