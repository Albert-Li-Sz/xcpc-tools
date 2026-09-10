import type { CommandResult, CommandTask } from '../interface';

export const DEFAULT_COMMAND_TTL = 15 * 60_000;
export const commandDeadline = (task: CommandTask) => task.expiresAt ?? task.time + DEFAULT_COMMAND_TTL;

export function commandResult(payload, now = Date.now()): CommandResult {
    if (!Number.isInteger(payload.exitCode)) throw new Error('Command exit code must be an integer');
    const stdout = String(payload.stdout || '').slice(0, 64 * 1024);
    const stderr = String(payload.stderr || '').slice(0, 64 * 1024);
    const timedOut = payload.timedOut === true
        || (payload.timedOut === undefined && /Command timed out after \d+ seconds/.test(stderr));
    return {
        status: payload.expired === true ? 'expired' : timedOut ? 'timed_out' : payload.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: payload.exitCode,
        stdout,
        stderr,
        finishedAt: now,
    };
}

export const resultText = (result: CommandResult) => [
    `status: ${result.status}`, `exitCode: ${result.exitCode ?? '-'}`,
    result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`,
].filter(Boolean).join('\n');

export function commandResults(task: CommandTask): Record<string, CommandResult> {
    const results = { ...task.results };
    for (const [mac, text] of Object.entries(task.executionResult || {})) {
        if (results[mac]) continue;
        const exit = /^exitCode: (-?\d+)/m.exec(text);
        results[mac] = commandResult({ exitCode: exit ? Number(exit[1]) : -1, stderr: text }, task.time);
    }
    return results;
}

export function commandSummary(task: CommandTask) {
    const results = Object.values(commandResults(task));
    const pending = task.pending || [];
    return {
        total: task.target.length,
        completed: results.length,
        pending: pending.length,
        running: pending.filter((mac) => task.dispatched?.includes(mac)).length,
        succeeded: results.filter((result) => result.status === 'succeeded').length,
        failed: results.filter((result) => result.status === 'failed').length,
        timedOut: results.filter((result) => result.status === 'timed_out').length,
        cancelled: results.filter((result) => result.status === 'cancelled').length,
        expired: results.filter((result) => result.status === 'expired').length,
    };
}

export async function ensureCommandSummary(db, task: CommandTask) {
    if (task.summary) return;
    await db.updateOne({ _id: task._id, summary: { $exists: false } }, { $set: { summary: commandSummary(task) } });
}

export async function settleWaitingCommands(db, status: 'expired' | 'cancelled', taskId?: string, now = Date.now()) {
    const tasks: CommandTask[] = await db.find({
        $not: { pending: { $size: 0 } },
        ...(taskId ? { _id: taskId } : {
            $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false }, time: { $lte: now - DEFAULT_COMMAND_TTL } }],
        }),
    });
    for (const task of tasks) {
        if (status === 'expired' && commandDeadline(task) > now) continue;
        await ensureCommandSummary(db, task);
        for (const mac of task.pending || []) {
            if (task.dispatched?.includes(mac)) continue;
            const result: CommandResult = {
                status,
                exitCode: null,
                stdout: '',
                stderr: status === 'expired' ? 'Command expired before dispatch' : 'Cancelled before dispatch',
                finishedAt: now,
            };
            await db.updateOne({ _id: task._id, pending: mac, $not: { dispatched: mac } }, {
                $pull: { pending: mac },
                $set: { [`results.${mac}`]: result, [`executionResult.${mac}`]: resultText(result) },
                $inc: { 'summary.pending': -1, 'summary.completed': 1, [`summary.${status}`]: 1 },
            });
        }
    }
}

export async function claimNextCommand(db, mac: string, now = Date.now()): Promise<CommandTask | null> {
    await settleWaitingCommands(db, 'expired', undefined, now);
    const tasks: CommandTask[] = await db.find({ pending: mac }).sort({ time: 1 });
    for (const task of tasks) {
        if (task.dispatched?.includes(mac)) return task;
        if (commandDeadline(task) <= now) continue;
        await ensureCommandSummary(db, task);
        const claimed = await db.updateOne({ _id: task._id, pending: mac, $not: { dispatched: mac } }, {
            $addToSet: { dispatched: mac },
            $inc: { 'summary.running': 1 },
        });
        if (claimed) return task;
    }
    return null;
}

export async function saveCommandResult(db, id: string, mac: string, result: CommandResult) {
    const task = await db.findOne({ _id: id });
    if (!task || !task.pending?.includes(mac) || !task.dispatched?.includes(mac)) return 0;
    await ensureCommandSummary(db, task);
    const statusKey = result.status === 'timed_out' ? 'timedOut' : result.status;
    return db.updateOne({
        _id: id, target: mac, pending: mac, dispatched: mac,
    }, {
        $set: { [`results.${mac}`]: result, [`executionResult.${mac}`]: resultText(result) },
        $pull: { pending: mac },
        $inc: {
            'summary.pending': -1,
            'summary.completed': 1,
            'summary.running': -1,
            [`summary.${statusKey}`]: 1,
        },
    });
}
