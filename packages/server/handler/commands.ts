import { Context } from 'cordis';
import { BadRequestError, NotFoundError } from '@hydrooj/framework';
import { config } from '../config';
import {
    commandSummary, settleWaitingCommands,
} from '../service/commandTasks';
import { commandDetail, listCommands } from '../service/history';
import { executeOnHost } from '../utils';
import { AuthHandler } from './misc';
import { dispatchPendingProbeCommands, getActiveProbeMacs } from './monitor';

class CommandsHandler extends AuthHandler {
    async get(params) {
        await settleWaitingCommands(this.ctx.db.command, 'expired');
        const monitors = await this.ctx.db.monitor.find({}, {
            mac: 1, name: 1, hostname: 1, protocol: 1, updateAt: 1,
        });
        let history;
        try {
            history = params.id ? await commandDetail(this.ctx.db.command, monitors, params) : await listCommands(this.ctx.db.command, monitors, params);
        } catch (error) { throw new BadRequestError(error.message); }
        if (params.id) {
            if (!history) throw new NotFoundError();
            this.response.body = history;
            return;
        }
        const activeProbeMacs = new Set(getActiveProbeMacs());
        const v1OnlyCount = monitors
            .filter((monitor) => (
                monitor.protocol === 'v1'
                && monitor.updateAt > Date.now() - 120_000
                && !activeProbeMacs.has(monitor.mac)
            )).length;
        const targets = monitors
            .filter((monitor) => monitor.protocol === 'v2' || activeProbeMacs.has(monitor.mac))
            .map((monitor) => ({
                mac: monitor.mac,
                name: monitor.name || '',
                hostname: monitor.hostname || '',
                connected: activeProbeMacs.has(monitor.mac),
            }));
        this.response.body = { ...history, targets, v1OnlyCount };
    }

    async postCommand({
        command, target, broadcast = false, mode = 'heartbeat', ttlMinutes = 15, delivery = 'online',
    }) {
        if (!command || typeof command !== 'string') throw new BadRequestError('Command', null, 'Command is required');
        if (command.length > 64000) throw new BadRequestError('Command exceeds 64000 characters');
        if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) throw new BadRequestError('Validity must be 1–1440 minutes');
        if (!['online', 'reconnect'].includes(delivery)) throw new BadRequestError('Invalid delivery mode');
        if (mode !== 'heartbeat' && mode !== 'ssh') throw new BadRequestError('Invalid command mode');
        if (broadcast === true) {
            if (mode === 'heartbeat') {
                const activeProbeMacs = getActiveProbeMacs();
                const knownV2Macs = (await this.ctx.db.monitor.find({}))
                    .filter((monitor) => monitor.protocol === 'v2')
                    .map((monitor) => monitor.mac);
                target = delivery === 'online' ? activeProbeMacs : [...activeProbeMacs, ...knownV2Macs];
            } else {
                target = (await this.ctx.db.monitor.find({ updateAt: { $gt: Date.now() - 120_000 } })).map((monitor) => monitor.mac);
            }
        } else if (!Array.isArray(target) || !target.length) {
            throw new BadRequestError('Select at least one machine');
        }
        if (!target.length) throw new BadRequestError(mode === 'heartbeat' ? 'No v2 machines found' : 'No machines are online');
        target = Array.from(new Set(target.map((mac) => String(mac).replace(/:/g, '').toUpperCase())));
        if (target.some((mac) => !/^[0-9A-F]{12}$/.test(mac) || mac === '000000000000')) {
            throw new BadRequestError('Invalid MAC address');
        }
        if (mode === 'heartbeat') {
            const monitors = await this.ctx.db.monitor.find({});
            const active = new Set(getActiveProbeMacs());
            const supported = new Set(monitors.filter((m) => m.protocol === 'v2' || active.has(m.mac)).map((m) => m.mac));
            if (target.some((mac) => !supported.has(mac))) throw new BadRequestError('Unknown v2 machine');
            if (delivery === 'online' && target.some((mac) => !active.has(mac))) throw new BadRequestError('Some selected machines are offline');
            const res = await this.ctx.db.command.insert({
                command,
                time: Date.now(),
                expiresAt: Date.now() + ttlMinutes * 60000,
                dispatched: [],
                results: {},
                target,
                pending: target,
                executionResult: {},
                summary: commandSummary({
                    target, pending: target, results: {}, executionResult: {},
                } as any),
            });
            await dispatchPendingProbeCommands(target);
            this.response.body = { id: res._id };
        } else {
            this.response.body = await this.executeForTargets(command, target);
        }
    }

    async postCancel({ command }) {
        if (typeof command !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command)) throw new BadRequestError('Command ID is required');
        await settleWaitingCommands(this.ctx.db.command, 'cancelled', command);
        this.response.body = { success: true };
    }

    async postRemove({ command }) {
        if (typeof command !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command)) throw new BadRequestError('Command ID is required');
        const task = await this.ctx.db.command.findOne({ _id: command });
        if (task?.pending?.length) throw new BadRequestError('Cancel waiting targets and wait for running commands before removing history');
        await this.ctx.db.command.deleteOne({ _id: command }, {});
        this.response.body = { success: true };
    }

    async executeForTargets(command: string, target: string[], t = 10000) {
        const selected = new Set(target);
        const allOnline = await this.ctx.db.monitor.find({ updateAt: { $gt: Date.now() - 120_000 } });
        const result = await Promise.allSettled(
            allOnline
                .filter((monitor) => selected.has(monitor.mac))
                .map((monitor) => executeOnHost(monitor.ip, command, t, config.customKeyfile)),
        );
        return {
            success: result.filter((i) => i.status === 'fulfilled').length,
            fail: result.filter((i) => i.status === 'rejected').length,
            result: result.map((i) => (i.status === 'fulfilled' ? i.value : i.reason)),
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('commands', '/commands', CommandsHandler);
}
