import fs from 'node:fs';
import path from 'node:path';

export const RESTORE_MARKER = '.xcpc-restore-pending.json';

export function assertNoInterruptedRestore(root = process.cwd()) {
    if (fs.existsSync(path.join(root, RESTORE_MARKER))) {
        throw new Error('An interrupted restore requires recovery. Stop the server and run xcpc-tools --recover-restore to recover the previous data.');
    }
}

export function acquireDataLock(root = process.cwd(), recovering = false) {
    const filename = path.join(root, '.xcpc-tools.lock');
    if (fs.existsSync(filename)) {
        const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid data lock; inspect it before removing it');
        let active = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') active = false; }
        if (active) throw new Error(`Stop the server before backup/restore; data is in use by PID ${owner.pid}`);
        fs.unlinkSync(filename);
    }
    fs.writeFileSync(filename, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    const release = () => {
        if (fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).pid === process.pid) fs.unlinkSync(filename);
    };
    try {
        if (!recovering) assertNoInterruptedRestore(root);
    } catch (error) {
        release();
        throw error;
    }
    return release;
}
