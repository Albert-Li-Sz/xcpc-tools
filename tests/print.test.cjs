const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Datastore = require('nedb-promises');
const { parsePrintSubmission, storePrintCode, readPrintCode, MAX_CODE_SIZE } = require('../packages/server/utils/printFiles.ts');
const { claimPrintTask, finishPrintTask, releasePrintTask, updatePrintProgress } = require('../packages/server/service/printTasks.ts');
const { PrintJournal, recoveredPrintStage } = require('../packages/server/client/printJournal.ts');
const { resolvePrinterTarget } = require('../packages/server/handler/printRouting.ts');

const metadata = () => ({ ...parsePrintSubmission({ team: 1, tname: '测试队', filename: 'main.cpp', location: 'A01' }), createAt: 1, done: 0, printer: '' });
const temporary = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcpc-print-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
};

test('reject malformed fields before writing; support numeric team IDs and Unicode', () => {
    assert.equal(metadata().tid, '1');
    for (const input of [{ team: '../escape', tname: 'test' }, { team: '..\\escape', tname: 'test' }, { team: 1 },
        { team: {}, tname: 'test' }, { team: 1, tname: 'test', group: {} }, { team: 1, tname: 'test', filename: 'x\0.cpp' }]) {
        assert.throws(() => parsePrintSubmission(input));
    }
});

test('store by generated ID, roll back failed inserts, and read safe legacy files', async (t) => {
    const root = temporary(t);
    const db = Datastore.create({ inMemoryOnly: true });
    const doc = await storePrintCode(db, metadata(), Buffer.from('hello'), root);
    assert.equal(readPrintCode(doc, root).toString(), 'hello');
    assert.deepEqual(fs.readdirSync(path.join(root, 'data/codes')), [`${doc._id}.code`]);
    await assert.rejects(storePrintCode({ insert: async () => { throw new Error('disk error'); } }, metadata(), Buffer.from('x'), root));
    assert.equal(fs.readdirSync(path.join(root, 'data/codes')).length, 1);
    await assert.rejects(storePrintCode(db, metadata(), Buffer.alloc(MAX_CODE_SIZE + 1), root));
    fs.writeFileSync(path.join(root, 'data/codes/old#legacy'), 'old');
    assert.equal(readPrintCode({ tid: 'old', _id: 'legacy' }, root).toString(), 'old');
    assert.throws(() => readPrintCode({ tid: '../escape', _id: 'legacy' }, root));
});

test('concurrent claims have one owner, completion is idempotent, and old claims cannot finish a reprint', async (t) => {
    const root = temporary(t);
    const code = Datastore.create({ inMemoryOnly: true });
    const client = Datastore.create({ inMemoryOnly: true });
    const printer = { id: 'client-1', name: 'P', type: ['printer'], printers: ['HP'], printersInfo: [{ printer: 'HP', status: 'idle' }], updateAt: Date.now() };
    await client.insert(printer);
    const doc = await storePrintCode(code, metadata(), Buffer.from('x'), root);
    const ctx = { db: { code, client }, logger: () => ({ error() {} }) };
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimPrintTask(ctx, printer, '', root)));
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    const params = { cid: printer.id, tid: doc._id, claimId: claim.claimId, printer: 'HP' };
    await updatePrintProgress(code, { ...params, stage: 'printing' });
    await assert.rejects(releasePrintTask(code, params), /review/);
    assert.equal(await finishPrintTask(code, params), true);
    assert.equal(await finishPrintTask(code, params), false);
    await code.updateOne({ _id: doc._id }, { $set: { printer: '', done: 0, stage: 'queued', claimId: '' } });
    const replacement = await claimPrintTask(ctx, printer, '', root);
    assert.notEqual(replacement.claimId, claim.claimId);
    await assert.rejects(finishPrintTask(code, params), /changed/);
    assert.equal((await code.findOne({ _id: doc._id })).done, 0);
});

test('preparation failures stop after three attempts and review tasks remain held', async (t) => {
    const root = temporary(t);
    const code = Datastore.create({ inMemoryOnly: true });
    const client = Datastore.create({ inMemoryOnly: true });
    const printer = { id: 'p', type: ['printer'], printers: ['HP'], printersInfo: [{ printer: 'HP', status: 'idle' }], updateAt: Date.now() };
    await client.insert(printer);
    const ctx = { db: { code, client }, logger: () => ({ error() {} }) };
    const doc = await storePrintCode(code, metadata(), Buffer.from('x'), root);
    for (let attempt = 0; attempt < 3; attempt++) {
        const claim = await claimPrintTask(ctx, printer, '', root);
        await releasePrintTask(code, { cid: 'p', tid: doc._id, claimId: claim.claimId, error: 'invalid PDF' });
    }
    assert.equal((await code.findOne({ _id: doc._id })).stage, 'failed');
    assert.equal(await claimPrintTask(ctx, printer, '', root), null);
    await code.updateOne({ _id: doc._id }, { $set: { stage: 'needs_review' } });
    assert.equal(await claimPrintTask(ctx, printer, '', root), null);
});

test('routing uses explicit groups, longest seat prefix, and healthy global fallback', () => {
    const targets = ['A', 'AB', ''].map((group, i) => ({ clientId: String(i), printer: `P${i}`, group, clientName: String(i) }));
    const states = new Map(targets.map((target) => [target.clientId, { id: target.clientId, updateAt: Date.now(), printers: [target.printer], printersInfo: [{ printer: target.printer, status: 'idle' }] }]));
    assert.equal(resolvePrinterTarget(targets, states, '', 'AB01').group, 'AB');
    assert.equal(resolvePrinterTarget(targets, states, 'A', 'AB01').group, 'A');
    states.get('1').printersInfo[0].status = 'error';
    assert.equal(resolvePrinterTarget(targets, states, 'AB', 'AB01').group, '');
});

test('restart recovery preserves uncertain and confirmed work without storing credentials', (t) => {
    const root = temporary(t);
    const journal = new PrintJournal('https://example.invalid/', 'secret-token', root);
    const entries = ['received', 'submitting', 'confirming'].map((stage, index) => ({
        doc: { _id: `id${index}`, claimId: String(index).repeat(32), printer: 'secret-token', code: 'source-code' },
        stage, printer: 'HP', error: 'https://user:secret-password@example.invalid/client/secret-token/print?token=secret-token',
    }));
    journal.save(entries);
    const reopened = new PrintJournal('https://example.invalid/', 'secret-token', root);
    assert.deepEqual(reopened.list().map((entry) => recoveredPrintStage(entry.stage)), ['release', 'needs_review', 'confirming']);
    assert.ok(!fs.readFileSync(journal.filename, 'utf8').includes('secret-token'));
    assert.ok(!fs.readFileSync(journal.filename, 'utf8').includes('secret-password'));
    assert.ok(!fs.readFileSync(journal.filename, 'utf8').includes('source-code'));
    reopened.remove('2'.repeat(32));
    assert.equal(new PrintJournal('https://example.invalid/', 'secret-token', root).list().length, 2);
    fs.writeFileSync(journal.filename, '{broken');
    assert.throws(() => new PrintJournal('https://example.invalid/', 'secret-token', root));
});

const { allocatePrintRequest } = require('../packages/server/service/printTasks.ts');

test('lost allocation responses and concurrent retries recover one durable claim across restarts', async (t) => {
    const root = temporary(t);
    const open = (name) => Datastore.create(path.join(root, `${name}.db`));
    let ctx = { db: { code: open('code'), client: open('client'), printRequest: open('requests') }, logger: () => ({ error() {} }) };
    const client = { id: 'test-client', type: ['printer'], printers: ['HP'], printersInfo: [{ printer: 'HP', status: 'idle' }], updateAt: Date.now() };
    await ctx.db.client.insert(client);
    await storePrintCode(ctx.db.code, metadata(), Buffer.from('original'), root);
    await storePrintCode(ctx.db.code, metadata(), Buffer.from('next'), root);
    let journal = new PrintJournal('https://example.invalid/', client.id, root);
    const request = journal.beginRequest('');
    const allocated = await allocatePrintRequest(ctx, client, request.id, '', root);
    // Both processes restart after allocation, before the response reaches the client.
    ctx = { ...ctx, db: { code: open('code'), client: open('client'), printRequest: open('requests') } };
    journal = new PrintJournal('https://example.invalid/', client.id, root);
    assert.equal(journal.pendingRequest.id, request.id);
    const retries = await Promise.all(Array.from({ length: 12 }, () => allocatePrintRequest(ctx, client, request.id, '', root)));
    assert.ok(retries.every(({ doc }) => doc.claimId === allocated.doc.claimId));
    assert.equal(await ctx.db.code.count({ printer: client.id }), 1);
    assert.equal((await ctx.db.code.findOne({ _id: allocated.doc._id })).attemptCount, 1);
    journal.acceptRequest({ doc: retries[0].doc, printer: 'HP', stage: 'received' });
    journal = new PrintJournal('https://example.invalid/', client.id, root);
    assert.equal(journal.pendingRequest, null);
    assert.equal(journal.list().length, 1);
    await updatePrintProgress(ctx.db.code, { cid: client.id, tid: allocated.doc._id, claimId: allocated.doc.claimId, stage: 'printing' });
    assert.equal((await allocatePrintRequest(ctx, client, request.id, '', root)).retired, true);
    assert.equal(await ctx.db.code.count({ printer: client.id }), 1);
});

test('allocation recovers a crash after the task write but before its receipt is finalized', async (t) => {
    const root = temporary(t);
    const code = Datastore.create({ inMemoryOnly: true });
    const clientDb = Datastore.create({ inMemoryOnly: true });
    const receipts = Datastore.create({ inMemoryOnly: true });
    const client = { id: 'p', type: ['printer'], printers: ['HP'], printersInfo: [{ printer: 'HP', status: 'idle' }], updateAt: Date.now() };
    await clientDb.insert(client);
    await storePrintCode(code, metadata(), Buffer.from('test'), root);
    const ctx = { db: { code, client: clientDb, printRequest: receipts }, logger: () => ({ error() {} }) };
    const original = receipts.updateOne.bind(receipts);
    receipts.updateOne = async () => { throw new Error('interrupted receipt write'); };
    await assert.rejects(allocatePrintRequest(ctx, client, 'a'.repeat(32), '', root), /interrupted/);
    receipts.updateOne = original;
    const retry = await allocatePrintRequest(ctx, client, 'a'.repeat(32), '', root);
    assert.equal(retry.doc.attemptCount, 1);
    await releasePrintTask(code, { cid: client.id, tid: retry.doc._id, claimId: retry.doc.claimId });
    const replacement = await allocatePrintRequest(ctx, client, 'b'.repeat(32), '', root);
    assert.notEqual(replacement.doc.claimId, retry.doc.claimId);
    assert.equal((await allocatePrintRequest(ctx, client, 'a'.repeat(32), '', root)).retired, true);
});
