import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import yaml from 'js-yaml';
import Datastore from 'nedb-promises';
import { syncDirectory, writeAtomicFile } from '../utils/atomicFile';
import { acquireDataLock, RESTORE_MARKER } from '../utils/instanceLock';
import { resultText } from './commandTasks';

const MAX_ARCHIVE_SIZE = 256 * 1024 * 1024;
const MAX_FILES = 20000;
interface BackupEntry { path: string; data: string; sha256: string }
interface Backup { format: 'xcpc-tools-backup'; version: 1; createdAt: string; entries: BackupEntry[] }
const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function validPath(value: string) {
    return typeof value === 'string' && (value === 'config.server.yaml' || value.startsWith('data/'))
        && !value.includes('\\') && !value.includes('\0')
        && value.split('/').every((part) => part && part !== '.' && part !== '..')
        && value !== 'data/.db' && !value.startsWith('data/print-journal/');
}

export function readBackup(filename: string): Backup {
    if (fs.statSync(filename).size > MAX_ARCHIVE_SIZE) throw new Error('Backup exceeds 256MB');
    const raw = gunzipSync(fs.readFileSync(filename), { maxOutputLength: MAX_ARCHIVE_SIZE });
    const backup = JSON.parse(raw.toString('utf8'));
    if (backup.format !== 'xcpc-tools-backup' || backup.version !== 1 || !Array.isArray(backup.entries)
        || backup.entries.length > MAX_FILES) throw new Error('Unsupported or oversized backup');
    const paths = new Set<string>();
    for (const entry of backup.entries) {
        if (!validPath(entry.path) || paths.has(entry.path) || typeof entry.data !== 'string') throw new Error('Invalid or duplicate backup path');
        paths.add(entry.path);
        if (digest(Buffer.from(entry.data, 'base64')) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`);
    }
    if (!paths.has('config.server.yaml')) throw new Error('Backup is missing server configuration');
    const config = yaml.load(Buffer.from(backup.entries.find((entry) => entry.path === 'config.server.yaml').data, 'base64').toString('utf8')) as any;
    if (!config || typeof config !== 'object' || !['server', 'hydro', 'domjudge'].includes(config.type)) {
        throw new Error('Invalid backup configuration');
    }
    return backup;
}

export async function createBackup(destination: string, root = process.cwd()) {
    const release = acquireDataLock(root);
    try {
        const entries: BackupEntry[] = [];
        let bytes = 0;
        const add = (relative: string, content: Buffer) => {
            bytes += content.length;
            if (bytes * 1.4 > MAX_ARCHIVE_SIZE || entries.length >= MAX_FILES) throw new Error('Backup exceeds its size/file limit');
            entries.push({ path: relative, data: content.toString('base64'), sha256: digest(content) });
        };
        const config = yaml.load(fs.readFileSync(path.join(root, 'config.server.yaml'), 'utf8')) as any;
        const arenaFile = path.resolve(root, config.arenaLayouts || 'data/arena-layouts.json');
        const visit = (relative: string) => {
            const absolute = path.join(root, relative);
            const info = fs.lstatSync(absolute);
            if (info.isSymbolicLink()) throw new Error(`Backup cannot include symlinks: ${relative}`);
            if (relative === 'data/print-journal' || relative === 'data/actions.log') return;
            if (info.isDirectory()) {
                for (const entry of fs.readdirSync(absolute).sort()) visit(`${relative}/${entry}`);
            } else if (info.isFile() && relative !== 'data/arena-layouts.json') {
                if (info.size > MAX_ARCHIVE_SIZE) throw new Error(`File exceeds backup limit: ${relative}`);
                add(relative, fs.readFileSync(absolute));
            }
        };
        if (fs.existsSync(path.join(root, 'data'))) visit('data');
        if (fs.existsSync(arenaFile)) {
            if (!fs.lstatSync(arenaFile).isFile()) throw new Error('Arena layout must be a regular file');
            add('data/arena-layouts.json', fs.readFileSync(arenaFile));
        }
        config.arenaLayouts = 'data/arena-layouts.json';
        add('config.server.yaml', Buffer.from(yaml.dump(config)));
        const backup: Backup = {
            format: 'xcpc-tools-backup', version: 1, createdAt: new Date().toISOString(), entries,
        };
        if (fs.existsSync(destination)) throw new Error('Backup destination already exists');
        writeAtomicFile(destination, gzipSync(Buffer.from(JSON.stringify(backup))));
        return { files: entries.length, createdAt: backup.createdAt };
    } finally { release(); }
}

async function quarantineRestoredTasks(dataDirectory: string) {
    const load = async (name: string) => {
        const db = Datastore.create(path.join(dataDirectory, '.db', `${name}.db`)) as Datastore<any>;
        await db.load();
        return db;
    };
    const code = await load('code');
    await code.update({ done: { $ne: 1 } }, {
        $set: {
            stage: 'needs_review',
            printer: '',
            claimId: '',
            lastError: 'Restored from backup. Verify physical output before marking done or reprinting.',
        },
    }, { multi: true });
    const command = await load('command');
    for (const task of await command.find({})) {
        const results = { ...task.results };
        const executionResult = { ...task.executionResult };
        for (const mac of task.pending || []) {
            results[mac] = {
                status: 'cancelled', exitCode: null, stdout: '', stderr: 'Cancelled during backup restoration', finishedAt: Date.now(),
            };
            executionResult[mac] = resultText(results[mac]);
        }
        await command.updateOne({ _id: task._id }, {
            $set: {
                pending: [], dispatched: [], results, executionResult,
            },
            $unset: { summary: 1 },
        });
    }
    const balloon = await load('balloon');
    await balloon.update({ printDone: { $ne: 1 } }, { $set: { restoreReview: true, notifierFailed: true } }, { multi: true });
    for (const name of ['monitor', 'client']) {
        const db = await load(name);
        await db.update({}, { $set: { updateAt: 0 } }, { multi: true });
    }
}

interface RestoreTransaction {
    staging: string;
    previous: string;
    hadData: boolean;
    hadConfig: boolean;
}

function rollbackRestore(root: string, transaction: RestoreTransaction) {
    for (const [name, existed] of [['data', transaction.hadData], ['config.server.yaml', transaction.hadConfig]] as const) {
        const current = path.join(root, name);
        const previous = path.join(root, transaction.previous, name);
        if (fs.existsSync(previous)) {
            fs.rmSync(current, { recursive: true, force: true });
            fs.renameSync(previous, current);
            syncDirectory(root);
            syncDirectory(path.dirname(previous));
        } else if (!existed) {
            fs.rmSync(current, { recursive: true, force: true });
            syncDirectory(root);
        } else if (!fs.existsSync(current)) {
            throw new Error(`Cannot recover missing ${name}; preserve the restore marker and backups for manual recovery`);
        }
    }
    fs.unlinkSync(path.join(root, RESTORE_MARKER));
    syncDirectory(root);
    fs.rmSync(path.join(root, transaction.staging), { recursive: true, force: true });
}

export function recoverRestore(root = process.cwd()) {
    const release = acquireDataLock(root, true);
    try {
        const marker = path.join(root, RESTORE_MARKER);
        if (!fs.existsSync(marker)) return { recovered: false };
        const transaction = JSON.parse(fs.readFileSync(marker, 'utf8')) as RestoreTransaction;
        if (!/^\.xcpc-restore-[A-Za-z0-9]+$/.test(transaction.staging)
            || !/^backups\/before-restore-[A-Za-z0-9-]+$/.test(transaction.previous)
            || typeof transaction.hadData !== 'boolean' || typeof transaction.hadConfig !== 'boolean') {
            throw new Error('Invalid restore marker; preserve it and backups for manual recovery');
        }
        rollbackRestore(root, transaction);
        return { recovered: true };
    } finally { release(); }
}

export async function restoreBackup(filename: string, confirm = false, root = process.cwd()) {
    const backup = readBackup(filename);
    const preview = { createdAt: backup.createdAt, files: backup.entries.length, paths: backup.entries.map((entry) => entry.path) };
    if (!confirm) return { ...preview, restored: false };
    const release = acquireDataLock(root);
    let staging: string | undefined;
    let transaction: RestoreTransaction | undefined;
    try {
        staging = fs.mkdtempSync(path.join(root, '.xcpc-restore-'));
        fs.mkdirSync(path.join(root, 'backups'), { recursive: true, mode: 0o700 });
        const previous = fs.mkdtempSync(path.join(root, 'backups', `before-restore-${Date.now()}-`));
        for (const entry of backup.entries) writeAtomicFile(path.join(staging, entry.path), Buffer.from(entry.data, 'base64'));
        fs.mkdirSync(path.join(staging, 'data/.db'), { recursive: true });
        await quarantineRestoredTasks(path.join(staging, 'data'));
        transaction = {
            staging: path.basename(staging),
            previous: `backups/${path.basename(previous)}`,
            hadData: fs.existsSync(path.join(root, 'data')),
            hadConfig: fs.existsSync(path.join(root, 'config.server.yaml')),
        };
        writeAtomicFile(path.join(root, RESTORE_MARKER), JSON.stringify(transaction));
        if (transaction.hadData) {
            fs.renameSync(path.join(root, 'data'), path.join(previous, 'data'));
        }
        if (transaction.hadConfig) {
            fs.renameSync(path.join(root, 'config.server.yaml'), path.join(previous, 'config.server.yaml'));
        }
        syncDirectory(root);
        syncDirectory(previous);
        syncDirectory(path.dirname(previous));
        fs.renameSync(path.join(staging, 'data'), path.join(root, 'data'));
        fs.renameSync(path.join(staging, 'config.server.yaml'), path.join(root, 'config.server.yaml'));
        syncDirectory(root);
        fs.unlinkSync(path.join(root, RESTORE_MARKER));
        syncDirectory(root);
        return { ...preview, restored: true, previous };
    } catch (error) {
        if (transaction && fs.existsSync(path.join(root, RESTORE_MARKER))) rollbackRestore(root, transaction);
        throw error;
    } finally {
        try {
            if (staging && !fs.existsSync(path.join(root, RESTORE_MARKER))) fs.rmSync(staging, { recursive: true, force: true });
        } finally { release(); }
    }
}

export async function runMaintenance(args = process.argv.slice(2)) {
    const backup = args.indexOf('--backup');
    const restore = args.indexOf('--restore');
    if (args.includes('--recover-restore')) {
        if (backup >= 0 || restore >= 0) throw new Error('Run --recover-restore separately from backup or restore');
        console.log(JSON.stringify(recoverRestore(), null, 2));
        return;
    }
    if ((backup >= 0) === (restore >= 0)) throw new Error('Choose exactly one of --backup or --restore');
    const filename = args[(backup >= 0 ? backup : restore) + 1];
    if (!filename || filename.startsWith('--')) throw new Error('Specify a backup filename');
    const result = backup >= 0
        ? await createBackup(path.resolve(filename))
        : await restoreBackup(path.resolve(filename), args.includes('--confirm-restore'));
    console.log(JSON.stringify(result, null, 2));
    if (restore >= 0 && !args.includes('--confirm-restore')) {
        console.log('Preview only. Repeat with --confirm-restore to apply; current data will be retained under backups/.');
    }
}
