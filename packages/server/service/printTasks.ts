import { createHash, randomBytes } from 'node:crypto';
import { Context } from 'cordis';
import { collectPrinterTargets, resolvePrinterTarget } from '../handler/printRouting';
import { readPrintCode } from '../utils/printFiles';

export const MAX_PRINT_ATTEMPTS = 3;

async function ownedPrint(db, params) {
    if (typeof params.claimId !== 'string' || !/^[a-f0-9]{32}$/.test(params.claimId)) throw new Error('Invalid print claim');
    const code = await db.findOne({ _id: params.tid });
    if (!code || code.printer !== params.cid || code.claimId !== params.claimId) throw new Error('Print task changed');
    return code;
}

const claimFilter = (params) => ({
    _id: params.tid, printer: params.cid, claimId: params.claimId, done: 0,
});

export async function finishPrintTask(db, params) {
    const code = await ownedPrint(db, params);
    if (code.targetPrinter !== params.printer) throw new Error('Physical printer does not match the assigned route');
    if (code.done) return false;
    const changed = await db.updateOne(claimFilter(params), {
        $set: {
            done: 1, stage: 'done', doneAt: Date.now(), lastError: '',
        },
    });
    if (!changed) throw new Error('Print task changed');
    return true;
}

export async function releasePrintTask(db, params) {
    const code = await ownedPrint(db, params);
    if (code.done || code.stage !== 'assigned') throw new Error('Submitted print tasks must be reviewed before reprinting');
    const changed = await db.updateOne({ ...claimFilter(params), stage: 'assigned' }, {
        $set: {
            printer: '',
            receivedAt: null,
            targetPrinter: '',
            stage: code.attemptCount >= MAX_PRINT_ATTEMPTS ? 'failed' : 'queued',
            lastError: String(params.error || 'Print preparation failed').slice(0, 500),
        },
    });
    if (!changed) throw new Error('Print task changed');
}

export async function updatePrintProgress(db, params) {
    const code = await ownedPrint(db, params);
    if (code.done) throw new Error('Print task already completed');
    if (!['printing', 'needs_review'].includes(params.stage)) throw new Error('Invalid print stage');
    if (params.stage === 'printing' && !['assigned', 'printing'].includes(code.stage)) throw new Error('Print task requires review');
    const changed = await db.updateOne({
        ...claimFilter(params),
        ...(params.stage === 'printing' ? { stage: { $in: ['assigned', 'printing'] } } : {}),
    }, { $set: { stage: params.stage, lastError: String(params.error || '').slice(0, 500) } });
    if (!changed) throw new Error('Print task changed');
}

export async function claimPrintTask(ctx: Context, client: any, preferredTargetPrinter: string, root = process.cwd(), allocationId?: string) {
    const candidates = await ctx.db.code.find({
        printer: '', done: 0, deleted: { $ne: 1 }, stage: { $nin: ['needs_review', 'failed'] },
    }).sort({ createAt: 1 });
    if (!candidates.length) return null;
    const clientStates = new Map((await ctx.db.client.find({})).map((item: any) => [item.id, item]));
    clientStates.set(client.id, client);
    const printerTargets = collectPrinterTargets([...clientStates.values()] as any[]);
    for (const code of candidates as any[]) {
        const target = resolvePrinterTarget(
            printerTargets,
            clientStates as any,
            code.group,
            code.location,
            preferredTargetPrinter,
        );
        if (!target || target.clientId !== client.id) continue;
        let content: string;
        try {
            content = readPrintCode(code, root).toString('base64');
        } catch (error) {
            ctx.logger('print').error(`Unable to read print task ${code._id}`, error);
            await ctx.db.code.updateOne({ _id: code._id, printer: '', done: 0 }, {
                $set: { stage: 'failed', lastError: 'Source file is missing or unreadable; restore the file before reprinting.' },
            });
            continue;
        }
        const receivedAt = Date.now();
        const claimId = randomBytes(16).toString('hex');
        const claimed = await ctx.db.code.updateOne(
            {
                _id: code._id, printer: '', done: 0, deleted: { $ne: 1 }, stage: { $nin: ['needs_review', 'failed'] },
            },
            {
                $set: {
                    printer: client.id,
                    claimId,
                    stage: 'assigned',
                    receivedAt,
                    targetPrinter: target.printer,
                    ...(allocationId && { allocationId }),
                },
                $inc: { attemptCount: 1 },
            } as any,
        );
        if (claimed) {
            return {
                ...code,
                printer: client.id,
                claimId,
                stage: 'assigned',
                receivedAt,
                targetPrinter: target.printer,
                code: content,
            };
        }
    }
    return null;
}

const allocationQueues = new WeakMap<object, Promise<unknown>>();

// The receipt is written before allocation. If the process dies between writes,
// allocationId on the task lets a retry finish the receipt without claiming again.
export async function allocatePrintRequest(ctx: Context, client: any, requestId: string, preferredPrinter = '', root = process.cwd()) {
    if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('Invalid print request ID');
    const receipts = ctx.db.printRequest;
    const allocationId = createHash('sha256').update(`${client.id}\0${requestId}`).digest('hex');
    const previous = allocationQueues.get(receipts) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
        let receipt = await receipts.findOne({ _id: allocationId });
        if (!receipt && !await ctx.db.code.count({
            printer: '', done: 0, deleted: { $ne: 1 }, stage: { $nin: ['needs_review', 'failed'] },
        })) return { doc: null };
        receipt ||= await receipts.insert({ _id: allocationId, state: 'pending', createdAt: Date.now() });
        if (receipt.state === 'empty') return { doc: null };
        let doc = await ctx.db.code.findOne({ allocationId });
        if (!doc && receipt.state === 'pending') {
            doc = await claimPrintTask(ctx, client, preferredPrinter, root, allocationId);
            if (!doc) {
                await receipts.removeOne({ _id: allocationId }, {});
                return { doc: null };
            }
        }
        if (doc) await receipts.updateOne({ _id: allocationId }, { $set: { state: 'allocated', taskId: doc._id } });
        if (!doc || doc.printer !== client.id || doc.done || doc.stage !== 'assigned') return { doc: null, retired: true };
        try {
            return { doc: { ...doc, code: readPrintCode(doc, root).toString('base64') } };
        } catch {
            await updatePrintProgress(ctx.db.code, {
                cid: client.id, tid: doc._id, claimId: doc.claimId, stage: 'needs_review', error: 'Allocated source file is unreadable.',
            });
            return { doc: null, retired: true };
        }
    });
    allocationQueues.set(receipts, current);
    try { return await current; } finally { if (allocationQueues.get(receipts) === current) allocationQueues.delete(receipts); }
}
