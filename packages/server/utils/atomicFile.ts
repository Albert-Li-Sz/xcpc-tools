import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function syncDirectory(directory: string) {
    if (process.platform === 'win32') return;
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function writeAtomicFile(filename: string, content: string | Buffer) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filename);
        syncDirectory(path.dirname(filename));
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
