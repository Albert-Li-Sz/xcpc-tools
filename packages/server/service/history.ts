import { commandDeadline, commandResults, ensureCommandSummary } from './commandTasks';

export function pagination(params: any) {
    const page = Number(params.page ?? 1);
    const pageSize = Number(params.pageSize ?? 50);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid pagination');
    if (params.search !== undefined && (typeof params.search !== 'string' || params.search.length > 256)) throw new Error('Invalid search');
    return { page, pageSize, search: String(params.search || '').trim() };
}

const literalPattern = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

export async function initializeCommandSummaries(db: any) {
    for (;;) {
        const task = await db.findOne({ summary: { $exists: false } });
        if (!task) return;
        await ensureCommandSummary(db, task);
    }
}

export async function listCommands(db: any, monitors: any[], params: any) {
    const { page, pageSize, search } = pagination(params);
    const statuses = {
        all: {},
        pending: { 'summary.pending': { $gt: 0 } },
        failed: { $or: [{ 'summary.failed': { $gt: 0 } }, { 'summary.timedOut': { $gt: 0 } }] },
        expired: { 'summary.expired': { $gt: 0 } },
        cancelled: { 'summary.cancelled': { $gt: 0 } },
        completed: {
            'summary.pending': 0, 'summary.failed': 0, 'summary.timedOut': 0, 'summary.expired': 0, 'summary.cancelled': 0,
        },
    };
    if (!Object.hasOwn(statuses, params.status || 'all')) throw new Error('Invalid command status');
    const filters: any[] = [statuses[params.status || 'all']];
    if (search) {
        const pattern = literalPattern(search);
        const macs = monitors.filter((monitor) => [monitor.name, monitor.hostname, monitor.mac].some((v) => pattern.test(v || '')))
            .map((monitor) => monitor.mac);
        filters.push({ $or: [{ _id: pattern }, { command: pattern }, { target: pattern }, { target: { $in: macs } }] });
    }
    const query = { $and: filters };
    const total = await db.count(query);
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const commands = await db.find(query, {
        results: 0, executionResult: 0, target: 0, pending: 0, dispatched: 0,
    })
        .sort({ time: -1, _id: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize);
    return {
        commands: commands.map((task) => ({
            _id: task._id, command: task.command, time: task.time, expiresAt: commandDeadline(task), status: task.summary,
        })),
        total,
        page: currentPage,
        pageSize,
    };
}

export async function commandDetail(db: any, monitors: any[], params: any) {
    if (typeof params.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.id)) throw new Error('Invalid command ID');
    const { page, pageSize } = pagination({ ...params, pageSize: params.pageSize ?? 10 });
    const task = await db.findOne({ _id: params.id }, { results: 0, executionResult: 0 });
    if (!task) return null;
    const currentPage = Math.min(page, Math.max(1, Math.ceil(task.target.length / pageSize)));
    const macs = task.target.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const projection: Record<string, number> = { time: 1 };
    for (const mac of macs) { projection[`results.${mac}`] = 1; projection[`executionResult.${mac}`] = 1; }
    const outputs = await db.findOne({ _id: task._id }, projection);
    const lookup = new Map(monitors.map((monitor) => [monitor.mac, monitor]));
    return {
        _id: task._id,
        command: task.command,
        results: commandResults(outputs || task),
        targetInfo: macs.map((mac) => ({ mac, hostname: lookup.get(mac)?.hostname || mac, name: lookup.get(mac)?.name || '' })),
        total: task.target.length,
        page: currentPage,
        pageSize,
    };
}
