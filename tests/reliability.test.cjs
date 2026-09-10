const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const Koa = require('koa');
const proxy = require('koa-proxies');
const Datastore = require('nedb-promises');
const { validReportToken, stripProxyCredentials } = require('../packages/server/utils/security.ts');
const { SourceSync } = require('../packages/server/service/sourceSync.ts');
const { planMonitorEdit, applyMonitorEdit } = require('../packages/server/service/monitorEditing.ts');
const { listCommands, commandDetail, initializeCommandSummaries, pagination } = require('../packages/server/service/history.ts');
const { claimNextCommand, saveCommandResult, commandResult, settleWaitingCommands, commandSummary } = require('../packages/server/service/commandTasks.ts');

const memory = () => Datastore.create({ inMemoryOnly: true });

test('report authentication rejects missing configuration, missing tokens and mismatches', () => {
    for (const [expected, supplied] of [['', ''], [undefined, undefined], ['secret', undefined], ['secret', ['secret']], ['secret', 'wrong']]) {
        assert.equal(validReportToken(expected, supplied), false);
    }
    assert.equal(validReportToken('a-long-random-secret', 'a-long-random-secret'), true);
});

test('stream proxy removes credentials before the upstream receives the request', async (t) => {
    let headers;
    const upstream = http.createServer((req, res) => { headers = req.headers; res.end('video'); });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const app = new Koa();
    app.use(proxy('/stream', { target: `http://127.0.0.1:${upstream.address().port}`, changeOrigin: true, events: { proxyReq: stripProxyCredentials } }));
    const gateway = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => gateway.once('listening', resolve));
    t.after(() => { gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close(); });
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/stream/`, {
        headers: { Authorization: 'Basic synthetic-secret', Cookie: 'session=synthetic', 'Proxy-Authorization': 'Basic synthetic-proxy', Range: 'bytes=0-' },
    });
    assert.equal(await response.text(), 'video');
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['proxy-authorization'], undefined);
    assert.equal(headers.range, 'bytes=0-');
});

test('team synchronization retries failures despite an unchanged contest and refreshes periodically', async () => {
    const sync = new SourceSync();
    let teams = 0;
    const balloonModes = [];
    const fetcher = {
        contest: { id: 'same', domainId: 'one' },
        async contestInfo() { return false; },
        async teamInfo() { if (++teams === 1) throw new Error('temporary OJ failure'); },
        async balloonInfo(first) { balloonModes.push(first); }, async printInfo() {},
    };
    await assert.rejects(sync.run(fetcher, 100), /temporary/);
    await sync.run(fetcher, 200);
    await sync.run(fetcher, 300);
    assert.equal(teams, 2);
    assert.deepEqual(balloonModes, [true, false]);
    await sync.run(fetcher, 300201);
    assert.equal(teams, 3);
    fetcher.contest.domainId = 'two';
    await sync.run(fetcher, 300202);
    assert.equal(teams, 4);
    assert.equal(balloonModes.at(-1), true);
});

test('failed initialization remains retryable until all source operations succeed', async () => {
    const sync = new SourceSync();
    let prints = 0;
    const flags = [];
    const source = { contest: { id: 'test' }, async contestInfo() {}, async teamInfo() {},
        async balloonInfo(first) { flags.push(first); }, async printInfo() { if (++prints === 1) throw new Error('print sync failed'); } };
    await assert.rejects(sync.run(source, 100));
    await sync.run(source, 101);
    await sync.run(source, 102);
    assert.deepEqual(flags, [true, true, false]);
});

test('batch names are previewed and conflicts or stale plans cannot write any machines', async () => {
    const db = memory();
    await db.insert([{ _id: 'one', hostname: 'A01', ip: '1', name: 'Old1' }, { _id: 'two', hostname: 'A02', ip: '2', name: 'Old2' }]);
    const conflict = await applyMonitorEdit(db, { name: 'same' }, true);
    assert.deepEqual(conflict.conflicts, ['SAME']);
    await assert.rejects(applyMonitorEdit(db, { name: 'same', revision: conflict.revision }), /Duplicate/);
    assert.equal((await db.findOne({ _id: 'one' })).name, 'Old1');
    const preview = await applyMonitorEdit(db, { name: '[hostname]' }, true);
    await db.updateOne({ _id: 'two' }, { $set: { hostname: 'A03' } });
    await assert.rejects(applyMonitorEdit(db, { name: '[hostname]', revision: preview.revision }), /changed/);
    const refreshed = await applyMonitorEdit(db, { name: '[hostname]', group: '[hostname:1]' }, true);
    const result = await applyMonitorEdit(db, { name: '[hostname]', group: '[hostname:1]', revision: refreshed.revision });
    assert.equal(result.count, 2);
    assert.deepEqual((await db.find({}).sort({ _id: 1 })).map((m) => m.name), ['A01', 'A03']);
    assert.throws(() => planMonitorEdit([], { name: {} }), /Invalid/);
});

test('concurrent single-machine renames cannot introduce duplicates', async () => {
    const db = memory();
    await db.insert([{ _id: 'one', name: 'a' }, { _id: 'two', name: 'b' }]);
    const results = await Promise.allSettled(['one', 'two'].map((_id) => applyMonitorEdit(db, { _id, name: 'same' })));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(await db.count({ name: 'same' }), 1);
});

test('command summaries, pagination, mixed failure filters and on-demand target output remain consistent', async () => {
    const db = memory();
    const targets = Array.from({ length: 24 }, (_, i) => i.toString(16).padStart(12, '0').toUpperCase());
    const docs = Array.from({ length: 125 }, (_, i) => ({ _id: `cmd-${String(i).padStart(3, '0')}`, time: i, expiresAt: Date.now() + 600000,
        command: `echo ${i}`, target: targets, pending: targets, dispatched: [], executionResult: {}, results: {} }));
    await db.insert(docs);
    await initializeCommandSummaries(db);
    const claimed = await claimNextCommand(db, targets[0]);
    await saveCommandResult(db, claimed._id, targets[0], commandResult({ exitCode: 1, stderr: 'failure'.repeat(5000) }));
    const stored = await db.findOne({ _id: claimed._id });
    assert.deepEqual(stored.summary, commandSummary(stored));
    const failed = await listCommands(db, [], { status: 'failed' });
    assert.equal(failed.total, 1);
    assert.equal(failed.commands[0].status.pending, 23);
    assert.equal(failed.commands[0].results, undefined);
    assert.equal(failed.commands[0].executionResult, undefined);
    assert.ok(JSON.stringify(failed).length < 2000);
    const last = await listCommands(db, [], { page: 3, pageSize: 50 });
    assert.equal(last.commands.length, 25);
    assert.equal(last.total, 125);
    const detail = await commandDetail(db, [], { id: claimed._id, pageSize: 10 });
    assert.equal(detail.targetInfo.length, 10);
    assert.equal(detail.results[targets[0]].status, 'failed');
    assert.equal(detail.executionResult, undefined);
    const otherPage = await commandDetail(db, [], { id: claimed._id, page: 2, pageSize: 10 });
    assert.equal(otherPage.results[targets[0]], undefined);
    await settleWaitingCommands(db, 'cancelled', claimed._id);
    const cancelled = await db.findOne({ _id: claimed._id });
    assert.deepEqual(cancelled.summary, commandSummary(cancelled));
    assert.equal((await listCommands(db, [], { search: 'echo 124' })).total, 1);
    assert.equal((await listCommands(db, [], { search: '.*' })).total, 0);
    for (const params of [{ page: 0 }, { pageSize: 10001 }, { page: 'bad' }]) assert.throws(() => pagination(params));
});

test('first-run server configuration generates a persistent nonempty report credential', (t) => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const yaml = require('js-yaml');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcpc-auth-default-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    spawnSync(process.execPath, ['-r', path.resolve('register.js'), '-e', `try { require(${JSON.stringify(path.resolve('packages/server/config.ts'))}); } catch (error) { if(error.message !== 'no-config') throw error; }`], { cwd: root });
    const config = yaml.load(fs.readFileSync(path.join(root, 'config.server.yaml'), 'utf8'));
    assert.match(config.monitor.reportToken, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(config.monitor.reportToken, config.viewPass);
});

test('batch approval is tied to the exact changes and failures report partial progress', async () => {
    const db = memory();
    await db.insert([{ _id: 'one', name: 'A01' }, { _id: 'two', name: 'A02' }]);
    const preview = await applyMonitorEdit(db, { group: 'A' }, true);
    await assert.rejects(applyMonitorEdit(db, { group: 'B', revision: preview.revision }), /preview/i);
    const update = db.updateOne.bind(db);
    let writes = 0;
    db.updateOne = async (...args) => { if (++writes === 2) throw new Error('disk error'); return update(...args); };
    await assert.rejects(applyMonitorEdit(db, { group: 'A', revision: preview.revision }), /stopped after 1 of 2/);
});

test('command counters remain correct under concurrent duplicate completions and cancellation', async () => {
    const db = memory();
    const target = ['A', 'B', 'C'];
    const doc = await db.insert({ command: 'synthetic', time: 1, expiresAt: Date.now() + 10000, target, pending: target, dispatched: [], results: {}, executionResult: {} });
    await initializeCommandSummaries(db);
    assert.equal(await saveCommandResult(db, doc._id, 'C', commandResult({ exitCode: 0 })), 0);
    await Promise.all(['A', 'B'].map((mac) => claimNextCommand(db, mac)));
    await Promise.all([
        saveCommandResult(db, doc._id, 'A', commandResult({ exitCode: 0 })),
        saveCommandResult(db, doc._id, 'A', commandResult({ exitCode: 0 })),
        saveCommandResult(db, doc._id, 'B', commandResult({ exitCode: 1 })),
        settleWaitingCommands(db, 'cancelled', doc._id),
    ]);
    const current = await db.findOne({ _id: doc._id });
    assert.deepEqual(current.summary, commandSummary(current));
    assert.equal(current.summary.completed, 3);
    assert.equal(current.summary.running, 0);
});

test('machine configuration connectivity test sends no machine identity and never joins command dispatch', async () => {
    const { testProbeReport } = require('../packages/machine-tools/frontend/src/utils/probe.ts');
    const sent = [];
    let closed = false;
    const listeners = new Map();
    const socket = {
        addEventListener(name, callback) { listeners.set(name, callback); },
        send(raw) { sent.push(JSON.parse(raw)); queueMicrotask(() => listeners.get('message')({ data: '{"type":"test-ok"}' })); },
        close() { closed = true; },
    };
    const result = testProbeReport('ws://example.invalid/probe', 'synthetic', { mac: 'AABBCCDDEEFF', hostname: 'test' }, () => socket);
    listeners.get('open')();
    await result;
    assert.deepEqual(sent, [{ type: 'test' }]);
    assert.equal(closed, true);
});
