import path from 'path';
import { Context } from 'cordis';
import fs from 'fs-extra';
import {
    BadRequestError, ConnectionHandler, ForbiddenError, Handler,
} from '@hydrooj/framework';
import { config } from '../config';
import {
    claimNextCommand, commandDeadline, commandResult, saveCommandResult,
} from '../service/commandTasks';
import { applyMonitorEdit, serializeMonitorEdit } from '../service/monitorEditing';
import { Logger } from '../utils';
import { validReportToken } from '../utils/security';
import { AuthHandler } from './misc';

const logger = new Logger('monitor');
const actions = fs.createWriteStream(path.join(process.cwd(), 'data/actions.log'), { flags: 'a' });
const activeProbes = new Map<string, MachineProbeConnectionHandler>();

export function getActiveProbeMacs() {
    return Array.from(activeProbes.keys());
}

export async function dispatchPendingProbeCommands(targets: string[] = []) {
    const requested = new Set(targets);
    const handlers = Array.from(activeProbes.entries())
        .filter(([mac]) => !requested.size || requested.has(mac))
        .map(([, handler]) => handler);
    await Promise.allSettled(handlers.map((handler) => handler.dispatchCommands()));
}

class MonitorAdminHandler extends AuthHandler {
    async get(params) {
        const { nogroup } = params;
        const monitors = await this.ctx.db.monitor.find({}).sort({ name: 1 });
        const monitorDict = Object.create(null);
        const groups = Object.create(null);
        groups['#ErrMachine'] = [];
        for (const monitor of monitors) {
            monitorDict[monitor._id] = monitor;
            if (!nogroup && monitor.group) {
                groups[monitor.group] ||= [];
                groups[monitor.group].push(monitor._id);
            }
            if (monitor.updateAt < new Date().getTime() - 120 * 1000) {
                groups['#ErrMachine'].push(monitor._id);
            }
        }
        this.response.body = { monitors: monitorDict };
        if (!nogroup) this.response.body.groups = groups;
    }

    async postUpdate(params) {
        if (typeof params._id !== 'string' || !params._id) throw new BadRequestError();
        try { this.response.body = await applyMonitorEdit(this.ctx.db.monitor, params); } catch (error) { throw new BadRequestError(error.message); }
    }

    async postDelete(params) {
        const { _id } = params;
        if (!_id) throw new BadRequestError();
        const m = await this.ctx.db.monitor.findOne({ _id });
        if (!m) throw new BadRequestError();
        await serializeMonitorEdit(this.ctx.db.monitor, () => this.ctx.db.monitor.remove({ _id }, {}));
        this.response.body = { success: true };
    }

    async postCleanAll() {
        await serializeMonitorEdit(this.ctx.db.monitor, () => this.ctx.db.monitor.remove({}, { multi: true }));
        this.response.body = { success: true };
    }

    async postUpdateAll(params) {
        try { this.response.body = await applyMonitorEdit(this.ctx.db.monitor, { ...params, _id: undefined }); } catch (error) { throw new BadRequestError(error.message); }
    }

    async postPreviewAll(params) {
        try { this.response.body = await applyMonitorEdit(this.ctx.db.monitor, { ...params, _id: undefined }, true); } catch (error) { throw new BadRequestError(error.message); }
    }
}

const escape = (str = '') => str.trim().replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n');

async function saveMonitorInfo(ctx: Context, monitor: any) {
    const {
        mac, version, uptime, seats, ip,
        protocol,
        os, kernel, cpu, cpuused, mem, memused, load,
        wifi_signal, wifi_bssid,
        window_cmdline, window_exe, window_name,
    } = monitor;
    logger.debug('save monitor info %o', monitor);
    actions.write(`${Date.now()},${seats},"${escape(window_cmdline)}","${escape(window_exe)}","${escape(window_name)}"\n`);
    const monitors = await ctx.db.monitor.find({ mac });
    const warn = monitors.length > 1 || (monitors.length && monitors[0].ip !== ip);
    if (warn) ctx.logger('monitor').warn(`Duplicate monitor ${mac} from (${ip}, ${monitors.length ? monitors[0].ip : 'null'})`);
    const hasWifiSignal = wifi_signal !== undefined && wifi_signal !== '';
    const wifiSignalValue = hasWifiSignal ? Number.parseFloat(String(wifi_signal)) : Number.NaN;
    const normalizedBssid = typeof wifi_bssid === 'string' ? wifi_bssid.trim() : '';
    const shouldSetBssid = normalizedBssid && !/^not-?associated$/i.test(normalizedBssid);
    const autoPayload: Record<string, string> = {};
    const templateValues = { ...monitor, hostname: seats };
    for (const field of ['name', 'group', 'camera', 'desktop'] as const) {
        const template = config.monitor.auto?.[field];
        if (field === 'group' && (template === true || typeof template === 'number')) {
            const hostname = String(seats || '').trim().toUpperCase();
            const group = template === true
                ? hostname.match(/^[A-Z]+/)?.[0] || ''
                : hostname.slice(0, template);
            if (group) autoPayload.group = group;
        } else if (typeof template === 'string' && template) {
            autoPayload[field] = template.replace(/\[(.+?)]/g, (_, key) => {
                const [source, length] = key.split(':');
                const value = String(templateValues[source] ?? '');
                return length ? value.substring(0, Number(length)) : value;
            });
        }
    }
    const setPayload: Record<string, any> = {
        mac,
        ip,
        version,
        uptime,
        hostname: seats,
        oldMonitor: true,
        updateAt: new Date().getTime(),
        ...protocol && { protocol },
        ...os && { os },
        ...kernel && { kernel },
        ...cpu && { cpu: cpu.replaceAll('_', ' ') },
        ...(cpuused !== undefined && cpuused !== '' && { cpuUsed: cpuused }),
        ...mem && { mem },
        ...mem && { memUsed: memused },
        ...load && { load },
        ...(hasWifiSignal && !Number.isNaN(wifiSignalValue) && { wifiSignal: wifiSignalValue }),
        ...(shouldSetBssid && { wifiBssid: normalizedBssid.toUpperCase() }),
        ...(window_name !== undefined && { windowName: window_name }),
        ...(window_exe !== undefined && { windowExe: window_exe }),
        ...(window_cmdline !== undefined && { windowCommand: window_cmdline }),
        ...autoPayload,
    };
    const unsetPayload: Record<string, 1> = {};
    if (!hasWifiSignal || Number.isNaN(wifiSignalValue)) unsetPayload.wifiSignal = 1;
    if (!shouldSetBssid) unsetPayload.wifiBssid = 1;
    const updateDoc: Record<string, any> = { $set: setPayload };
    if (Object.keys(unsetPayload).length) updateDoc.$unset = unsetPayload;
    await serializeMonitorEdit(ctx.db.monitor, () => ctx.db.monitor.updateOne({ mac }, updateDoc, { upsert: true }));
}

class MachineProbeConnectionHandler extends ConnectionHandler<Context> {
    mac = '';
    inFlightCommandId = '';
    dispatchQueue = Promise.resolve();

    async prepare() {
        const expected = String(config.monitor.reportToken || '');
        if (!validReportToken(expected, this.request.query?.token)) {
            throw new ForbiddenError('Invalid report token');
        }
    }

    async dispatchNextCommand() {
        if (!this.mac) return;
        if (this.inFlightCommandId) {
            const inFlight = await this.ctx.db.command.findOne({ _id: this.inFlightCommandId });
            if (inFlight && (inFlight.pending || []).includes(this.mac)) return;
            this.inFlightCommandId = '';
        }
        const command = await claimNextCommand(this.ctx.db.command, this.mac);
        if (!command) return;
        this.inFlightCommandId = command._id;
        this.send({
            type: 'command', id: command._id, command: command.command, expiresAt: commandDeadline(command),
        });
    }

    dispatchCommands() {
        const current = this.dispatchQueue.catch(() => undefined).then(() => this.dispatchNextCommand());
        this.dispatchQueue = current.then(() => undefined, () => undefined);
        return current;
    }

    async saveProbe(probe) {
        if (!probe || typeof probe !== 'object' || !probe.mac) throw new BadRequestError('Invalid probe payload');
        const requestedMac = String(probe.mac).replace(/:/g, '').toUpperCase();
        if (!/^[0-9A-F]{12}$/.test(requestedMac) || requestedMac === '000000000000') throw new BadRequestError('Invalid MAC address');
        if (this.mac && requestedMac !== this.mac) throw new ForbiddenError('Probe MAC changed during the connection');
        if (!this.mac) {
            const active = activeProbes.get(requestedMac);
            if (active && active !== this) active.close(4001, 'Replaced by a new connection');
            this.mac = requestedMac;
            activeProbes.set(requestedMac, this);
        }
        await saveMonitorInfo(this.ctx, {
            mac: this.mac,
            protocol: 'v2',
            version: probe.version || 'machine-tools',
            uptime: probe.uptime || 0,
            seats: probe.hostname || this.mac,
            ip: this.request.ip.replace('::ffff:', ''),
            os: probe.os,
            kernel: probe.kernel,
            cpu: probe.cpu,
            cpuused: probe.cpuUsed,
            mem: probe.memory,
            memused: probe.memoryUsed,
            load: probe.load,
            wifi_signal: probe.wifiSignal,
            wifi_bssid: probe.wifiBssid,
            window_name: probe.windowName,
            window_exe: probe.windowExe,
            window_cmdline: probe.windowCommand,
        });
        await this.dispatchCommands();
    }

    async saveResult(payload) {
        if (!this.mac || !payload.id) throw new BadRequestError('Probe has not reported its machine identity');
        const command = await this.ctx.db.command.findOne({ _id: payload.id });
        if (!command) {
            if (this.inFlightCommandId === payload.id) this.inFlightCommandId = '';
            this.send({ type: 'result-ack', id: payload.id });
            await this.dispatchCommands();
            return;
        }
        if (!(command.target || []).includes(this.mac)) {
            throw new ForbiddenError('Command target mismatch');
        }
        if (!(command.pending || []).includes(this.mac)) {
            if (this.inFlightCommandId === command._id) this.inFlightCommandId = '';
            this.send({ type: 'result-ack', id: command._id });
            await this.dispatchCommands();
            return;
        }
        if (!command.dispatched?.includes(this.mac)) throw new ForbiddenError('Command was not dispatched to this probe');
        await saveCommandResult(this.ctx.db.command, command._id, this.mac, commandResult(payload));
        if (this.inFlightCommandId === command._id) this.inFlightCommandId = '';
        this.send({ type: 'result-ack', id: command._id });
        await this.dispatchCommands();
    }

    async message(payload) {
        if (!payload || typeof payload !== 'object') throw new BadRequestError('Invalid probe message');
        if (payload.type === 'test') {
            this.send({ type: 'test-ok' });
            return;
        }
        if (payload.type === 'hello' || payload.type === 'report') {
            await this.saveProbe(payload.probe);
            if (payload.type === 'hello') this.send({ type: 'welcome' });
            return;
        }
        if (payload.type === 'result') {
            await this.saveResult(payload);
            return;
        }
        throw new BadRequestError('Unknown probe message');
    }

    async cleanup() {
        if (activeProbes.get(this.mac) === this) activeProbes.delete(this.mac);
    }
}

class MonitorReportHandler extends Handler {
    async get() {
        this.response.body = 'Monitor server is running';
    }

    async post(params) {
        const expected = String(config.monitor.reportToken || '');
        if (!validReportToken(expected, this.request.query?.token)) {
            throw new ForbiddenError('Invalid report token');
        }
        if (!params.mac) throw new BadRequestError();
        params.ip = this.request.ip.replace('::ffff:', '');
        params.mac = String(params.mac).replace(/:/g, '').toUpperCase();
        if (!/^[0-9A-F]{12}$/.test(params.mac) || params.mac === '000000000000') throw new BadRequestError('Invalid MAC address');
        params.protocol = 'v1';
        await saveMonitorInfo(this.ctx, params);
        this.response.body = 'Report accepted';
    }
}

class MonitorPrometheusSDHandler extends AuthHandler {
    notUsage = true;

    async get() {
        const exporters = config.monitor.exporters?.length
            ? config.monitor.exporters
            : [{ job: 'node', port: 9100 }];
        const monitors = await this.ctx.db.monitor.find({});
        this.response.body = exporters.flatMap((exporter) => monitors
            .filter((monitor) => monitor.ip)
            .map((monitor) => ({
                targets: [`${monitor.ip}:${exporter.port}`],
                labels: {
                    __meta_prometheus_job: exporter.job,
                    __meta_prometheus_nodename: String(monitor.name || monitor._id),
                },
            })));
        this.response.type = 'application/json';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('monitor_report', '/report', MonitorReportHandler);
    ctx.Route('monitor_admin', '/monitor', MonitorAdminHandler);
    ctx.Route('monitor_prometheus_sd', '/sd', MonitorPrometheusSDHandler);
    ctx.Connection('machine_probe', '/probe', MachineProbeConnectionHandler);
}
