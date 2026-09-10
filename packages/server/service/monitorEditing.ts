import { createHash } from 'node:crypto';

const fields = ['name', 'group', 'camera', 'desktop'] as const;
const queues = new WeakMap<object, Promise<unknown>>();

export async function serializeMonitorEdit<T>(db: object, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(db) || Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    queues.set(db, current);
    try { return await current; } finally { if (queues.get(db) === current) queues.delete(db); }
}

export function planMonitorEdit(monitors: any[], params: any) {
    for (const field of [...fields, 'ips']) {
        if (params[field] !== undefined && (typeof params[field] !== 'string' || params[field].length > 64000)) {
            throw new Error(`Invalid ${field}`);
        }
    }
    const ips = new Set((params.ips || '').split('\n').map((ip) => ip.trim()).filter(Boolean));
    const ordered = [...monitors].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    const revision = createHash('sha256').update(JSON.stringify({
        machines: ordered.map((monitor) => (
            [monitor._id, monitor.ip, monitor.mac, monitor.hostname, ...fields.map((field) => monitor[field] || '')]
        )),
        input: [params._id || '', ...fields.map((field) => params[field] || ''), [...ips].sort()],
    })).digest('hex');
    const changes = ordered.filter((monitor) => (params._id ? monitor._id === params._id : !ips.size || ips.has(monitor.ip)))
        .map((monitor) => {
            const set: Record<string, string> = {};
            const unset: Record<string, number> = {};
            for (const field of fields) {
                if (!params[field]) continue;
                if (params[field] === 'del') { unset[field] = 1; continue; }
                const expand = (_, key) => {
                    const [source, length] = key.split(':');
                    if (!['hostname', 'ip', 'mac', ...fields].includes(source)
                        || (length !== undefined && !/^[1-9]\d?$/.test(length))) throw new Error(`Invalid template: [${key}]`);
                    const raw = String(monitor[source] || '');
                    return length ? raw.substring(0, Number(length)) : raw;
                };
                const value = (params._id ? params[field] : params[field].replace(/\[(.+?)]/g, expand)).trim();
                if (field === 'name' && !value) throw new Error('A name template produced an empty name');
                if (value.length > 2048) throw new Error(`${field} is too long`);
                set[field] = value;
            }
            return {
                id: monitor._id, before: monitor.name || monitor.hostname || monitor._id, set, unset,
            };
        }).filter((change) => Object.keys(change.set).length || Object.keys(change.unset).length);
    const byId = new Map(changes.map((change) => [change.id, change]));
    const names = new Map<string, string[]>();
    for (const monitor of ordered) {
        const change = byId.get(monitor._id);
        const name = String(change?.unset.name ? '' : change?.set.name ?? monitor.name ?? '').trim().toUpperCase();
        if (name) names.set(name, [...(names.get(name) || []), monitor._id]);
    }
    const conflicts = [...names.entries()].filter(([, ids]) => ids.length > 1
        && ids.some((id) => byId.get(id)?.set.name !== undefined)).map(([name]) => name);
    return { revision, changes, conflicts };
}

export async function applyMonitorEdit(db: any, params: any, preview = false) {
    return serializeMonitorEdit(db, async () => {
        const plan = planMonitorEdit(await db.find({}), params);
        if (preview) {
            return {
                revision: plan.revision,
                count: plan.changes.length,
                conflicts: plan.conflicts,
                changes: plan.changes.slice(0, 100).map((change) => ({
                    id: change.id, before: change.before, values: change.set, cleared: Object.keys(change.unset),
                })),
            };
        }
        if (params.revision && params.revision !== plan.revision) throw new Error('Machines changed. Preview the batch again before applying.');
        if (!params._id && !params.revision) throw new Error('Preview the batch before applying.');
        if (plan.conflicts.length) throw new Error(`Duplicate names: ${plan.conflicts.join(', ')}`);
        if (params._id && !plan.changes.length) throw new Error('Machine not found or no changes supplied');
        let applied = 0;
        try {
            for (const change of plan.changes) {
                // Await persistence before reporting success to the administrator.
                const updated = await db.updateOne({ _id: change.id }, { $set: change.set, $unset: change.unset });
                if (!updated) throw new Error('A machine was removed');
                applied++;
            }
        } catch {
            throw new Error(`Batch stopped after ${applied} of ${plan.changes.length} updates. Inspect the machines and preview again before retrying.`);
        }
        return { success: true, count: plan.changes.length };
    });
}
