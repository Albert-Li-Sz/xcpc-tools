import fs from 'node:fs';
import path from 'node:path';
import { Context } from 'cordis';
import { BadRequestError } from '@hydrooj/framework';
import { config, version } from '../config';
import { getPresentationRoster } from '../service/presentationRoster';
import { SystemCheck, systemChecks } from '../service/systemChecks';
import { parsePrintSubmission, storePrintCode } from '../utils/printFiles';
import { AuthHandler } from './misc';

class OperationsHandler extends AuthHandler {
    async report() {
        const [monitors, clients, codes] = await Promise.all([
            this.ctx.db.monitor.find({}), this.ctx.db.client.find({}), this.ctx.db.code.find({ done: 0 }),
        ]);
        const checks = systemChecks(config, monitors, clients, getPresentationRoster().teams, this.ctx.fetcher);
        let writable = true;
        try { fs.accessSync(path.resolve(process.cwd(), 'data'), fs.constants.W_OK); } catch { writable = false; }
        checks.push({
            id: 'storage',
            name: 'Data directory',
            status: writable ? 'pass' : 'fail',
            detail: writable ? 'Data directory is writable' : 'Data directory is not writable',
        } as SystemCheck);
        const review = codes.filter((code) => code.stage === 'needs_review').length;
        const stalled = codes.filter((code) => ['assigned', 'printing'].includes(code.stage)
            && code.receivedAt < Date.now() - 5 * 60_000).length;
        checks.push({
            id: 'print-review',
            name: 'Print recovery',
            status: review || stalled ? 'warn' : 'pass',
            detail: `${review} print tasks require physical verification; ${stalled} assigned tasks have been waiting over 5 minutes`,
        });
        return {
            generatedAt: new Date().toISOString(),
            version,
            runtime: { node: process.version, platform: process.platform, uptime: Math.floor(process.uptime()) },
            checks,
            counts: { machines: monitors.length, clients: clients.length, pendingPrints: codes.length },
            printerGroups: [...new Set(clients.flatMap((client) => (client.printersInfo || []).map((printer) => String(printer.group || ''))))],
        };
    }

    async get(params) {
        this.response.addHeader('Cache-Control', 'no-store');
        this.response.body = await this.report();
        if (params.download) this.response.disposition = 'attachment; filename="xcpc-diagnostics.json"';
    }

    async postTestPrint({ group }) {
        let metadata;
        try {
            metadata = parsePrintSubmission({
                team: 'SELFTEST', tname: 'Pre-contest printer check', filename: 'test-page.txt', group,
            });
        } catch (error) { throw new BadRequestError(error.message); }
        const content = [
            'XCPC Tools printer test',
            `Generated: ${new Date().toISOString()}`,
            'Verify readable text and complete output.',
            '打印测试：请核对中文、英文及完整页面。',
            '',
        ].join('\n');
        const task = await storePrintCode(this.ctx.db.code, {
            ...metadata, createAt: Date.now(), done: 0, printer: '',
        }, Buffer.from(content));
        await this.ctx.parallel('print/newTask', 1);
        this.response.body = { success: true, id: task._id };
    }
}

export function apply(ctx: Context) {
    ctx.Route('operations', '/operations', OperationsHandler);
}
