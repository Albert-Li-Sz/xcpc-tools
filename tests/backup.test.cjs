const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { test } = require('node:test');
const Datastore = require('nedb-promises');
const { createBackup, readBackup, restoreBackup, recoverRestore } = require('../packages/server/service/backup.ts');
const { acquireDataLock, assertNoInterruptedRestore, RESTORE_MARKER } = require('../packages/server/utils/instanceLock.ts');
const { systemChecks } = require('../packages/server/service/systemChecks.ts');

const temporary = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcpc-backup-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'data/.db'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.server.yaml'), 'type: server\nviewPass: secret-password\n');
    return root;
};

test('backup preview is read-only; restoration retains old data and holds physical tasks', async (t) => {
    const root = temporary(t);
    const db = (name) => Datastore.create(path.join(root, `data/.db/${name}.db`));
    await db('code').insert({ _id: 'print', done: 0, printer: 'p', stage: 'printing' });
    await db('command').insert({ _id: 'cmd', pending: ['ABC'], dispatched: ['ABC'], target: ['ABC'] });
    await db('balloon').insert({ _id: 'balloon', printDone: 0 });
    fs.writeFileSync(path.join(root, 'data/payload'), 'original');
    const destination = path.join(root, 'snapshot.gz');
    await createBackup(destination, root);
    fs.writeFileSync(path.join(root, 'data/payload'), 'new data');
    assert.equal((await restoreBackup(destination, false, root)).restored, false);
    assert.equal(fs.readFileSync(path.join(root, 'data/payload'), 'utf8'), 'new data');
    const result = await restoreBackup(destination, true, root);
    assert.equal(result.restored, true);
    assert.equal(fs.readFileSync(path.join(root, 'data/payload'), 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(result.previous, 'data/payload'), 'utf8'), 'new data');
    assert.equal((await db('code').findOne({ _id: 'print' })).stage, 'needs_review');
    assert.deepEqual((await db('command').findOne({ _id: 'cmd' })).pending, []);
    assert.match((await db('command').findOne({ _id: 'cmd' })).executionResult.ABC, /status: cancelled/);
    assert.equal((await db('balloon').findOne({ _id: 'balloon' })).restoreReview, true);
});

test('interrupted restores block startup and recover old data after each rename boundary', async (t) => {
    for (let phase = 0; phase <= 4; phase++) {
        const root = temporary(t);
        fs.writeFileSync(path.join(root, 'data/payload'), 'old data');
        const staging = fs.mkdtempSync(path.join(root, '.xcpc-restore-'));
        const previous = path.join(root, 'backups/before-restore-test');
        fs.mkdirSync(previous, { recursive: true });
        fs.mkdirSync(path.join(staging, 'data'));
        fs.writeFileSync(path.join(staging, 'data/payload'), 'new data');
        fs.writeFileSync(path.join(staging, 'config.server.yaml'), 'type: server\nviewPass: replacement\n');
        fs.writeFileSync(path.join(root, RESTORE_MARKER), JSON.stringify({
            staging: path.basename(staging), previous: 'backups/before-restore-test', hadData: true, hadConfig: true,
        }));
        if (phase >= 1) fs.renameSync(path.join(root, 'data'), path.join(previous, 'data'));
        if (phase >= 2) fs.renameSync(path.join(root, 'config.server.yaml'), path.join(previous, 'config.server.yaml'));
        if (phase >= 3) fs.renameSync(path.join(staging, 'data'), path.join(root, 'data'));
        if (phase >= 4) fs.renameSync(path.join(staging, 'config.server.yaml'), path.join(root, 'config.server.yaml'));
        assert.throws(() => assertNoInterruptedRestore(root), /recover-restore/);
        assert.throws(() => acquireDataLock(root), /recover-restore/);
        assert.equal(recoverRestore(root).recovered, true);
        assert.equal(fs.readFileSync(path.join(root, 'data/payload'), 'utf8'), 'old data');
        assert.match(fs.readFileSync(path.join(root, 'config.server.yaml'), 'utf8'), /secret-password/);
        assert.equal(recoverRestore(root).recovered, false);
        assertNoInterruptedRestore(root);
    }
});

test('reject traversal, tampering, symlinks and concurrent server access without changing data', async (t) => {
    const root = temporary(t);
    const archive = path.join(root, 'snapshot.gz');
    const unlock = acquireDataLock(root);
    await assert.rejects(createBackup(archive, root), /Stop the server/);
    unlock();
    await createBackup(archive, root);
    const original = JSON.parse(gunzipSync(fs.readFileSync(archive)));
    for (const mutate of [
        (value) => { value.entries[0].path = 'data/../../outside'; },
        (value) => { value.entries[0].sha256 = 'bad'; },
        (value) => { value.entries.push(value.entries[0]); },
    ]) {
        const copy = structuredClone(original);
        mutate(copy);
        fs.writeFileSync(path.join(root, 'bad.gz'), gzipSync(Buffer.from(JSON.stringify(copy))));
        assert.throws(() => readBackup(path.join(root, 'bad.gz')));
    }
    fs.symlinkSync(path.join(root, 'config.server.yaml'), path.join(root, 'data/link'));
    await assert.rejects(createBackup(path.join(root, 'linked.gz'), root), /symlink/);
    assert.match(fs.readFileSync(path.join(root, 'config.server.yaml'), 'utf8'), /secret-password/);
});

test('system checks detect seat conflicts and omit configuration secrets', () => {
    const checks = systemChecks({ type: 'server', monitor: { reportToken: 'secret-token' }, clients: [{ type: ['printer'], token: 'another-secret-token' }] },
        [{ name: 'A01', protocol: 'v2', version: '2', updateAt: Date.now() }, { name: 'a01' }], [], [{ seat: 'B01' }], {});
    assert.equal(checks.find((check) => check.id === 'seats').status, 'fail');
    assert.equal(checks.find((check) => check.id === 'roster').status, 'warn');
    assert.ok(!JSON.stringify(checks).includes('secret-token'));
    assert.doesNotThrow(() => systemChecks({ type: 'server' }, [], [], [], undefined));
});
