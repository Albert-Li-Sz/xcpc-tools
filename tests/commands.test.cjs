const assert = require('node:assert/strict');
const { test } = require('node:test');
const Datastore = require('nedb-promises');
const { claimNextCommand, settleWaitingCommands, commandResult, saveCommandResult, commandSummary, commandResults } = require('../packages/server/service/commandTasks.ts');

const task = (extra = {}) => ({ time: 100, expiresAt: 1000, command: 'true', target: ['A', 'B'], pending: ['A', 'B'], dispatched: [], executionResult: {}, results: {}, ...extra });

test('expiry and cancellation affect waiting targets, never already dispatched commands', async () => {
    const db = Datastore.create({ inMemoryOnly: true });
    const doc = await db.insert(task());
    assert.equal((await claimNextCommand(db, 'A', 500))._id, doc._id);
    await settleWaitingCommands(db, 'expired', undefined, 2000);
    const current = await db.findOne({ _id: doc._id });
    assert.deepEqual(current.pending, ['A']);
    assert.equal(current.results.B.status, 'expired');
    assert.equal((await claimNextCommand(db, 'A', 2000))._id, doc._id);
    await settleWaitingCommands(db, 'cancelled', doc._id, 2000);
    assert.deepEqual((await db.findOne({ _id: doc._id })).pending, ['A']);
    const result = commandResult({ exitCode: 0, stdout: 'ok' }, 2001);
    assert.equal(await saveCommandResult(db, doc._id, 'A', result), 1);
    assert.equal(await saveCommandResult(db, doc._id, 'A', result), 0);
});

test('cancel/dispatch races have one outcome and cancelled work cannot be redispatched', async () => {
    for (let i = 0; i < 10; i++) {
        const db = Datastore.create({ inMemoryOnly: true });
        const doc = await db.insert(task({ target: ['A'], pending: ['A'] }));
        const [claimed] = await Promise.all([claimNextCommand(db, 'A', 500), settleWaitingCommands(db, 'cancelled', doc._id, 500)]);
        const current = await db.findOne({ _id: doc._id });
        if (current.results.A) { assert.equal(claimed, null); assert.deepEqual(current.pending, []); }
        else { assert.ok(claimed); assert.deepEqual(current.dispatched, ['A']); }
    }
});

test('structured results distinguish nonzero exit, timeouts and legacy output', () => {
    assert.equal(commandResult({ exitCode: 1 }).status, 'failed');
    assert.equal(commandResult({ exitCode: 124, timedOut: true }).status, 'timed_out');
    assert.equal(commandResult({ exitCode: 124, timedOut: false, stderr: 'Command timed out after 600 seconds' }).status, 'failed');
    assert.throws(() => commandResult({ exitCode: '0' }));
    const old = task({ pending: [], executionResult: { A: 'exitCode: 0\nstdout:\nok', B: 'exitCode: -1\nstderr:\nCommand timed out after 600 seconds' } });
    assert.equal(commandResults(old).B.status, 'timed_out');
    const summary = commandSummary(old);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.timedOut, 1);
    assert.equal(summary.pending, 0);
});
