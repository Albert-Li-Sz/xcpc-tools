import path from 'node:path';
import { Context } from 'cordis';
import { BadRequestError, Handler, ValidationError } from '@hydrooj/framework';
import { ConvertCodeToPDF } from '../client/printer';
import { config } from '../config';
import { pagination } from '../service/history';
import { fs, Logger } from '../utils';
import {
    MAX_CODE_SIZE, parsePrintSubmission, readPrintCode, storePrintCode,
} from '../utils/printFiles';
import { AuthHandler } from './misc';
import {
    CLIENT_ONLINE_WINDOW,
    clientHasTargetPrinter,
    collectPrinterTargets,
    printCandidates,
    resolvePrinterTarget,
} from './printRouting';

const logger = new Logger('handler/print');

class PrintAdminHandler extends AuthHandler {
    async get(params) {
        let paging;
        try { paging = pagination(params); } catch (error) { throw new BadRequestError(error.message); }
        const { page, pageSize, search } = paging;
        const status = params.status || 'all';
        if (!['all', 'new', 'sent', 'needs_review', 'failed', 'done'].includes(status)) throw new BadRequestError('Invalid print status');
        if (params.group !== undefined && typeof params.group !== 'string') throw new BadRequestError('Invalid print group');
        const clients = (await this.ctx.db.client.find({}).sort({ createAt: 1 }))
            .filter((client) => Array.isArray(client.type) && client.type.includes('printer'));
        const now = Date.now();
        const clientStates = new Map(clients.map((client) => [client.id, client]));
        const printerTargets = collectPrinterTargets(clients as any[]);
        const routes = printerTargets.map((target) => {
            const client = clients.find((item) => item.id === target.clientId);
            const printerInfo = client?.printersInfo?.find((item) => item.printer === target.printer);
            const online = Boolean(client?.updateAt && client.updateAt >= now - CLIENT_ONLINE_WINDOW);
            const enabled = Boolean(client?.printers?.includes(target.printer));
            const healthy = clientHasTargetPrinter(client, target.printer, now);
            let reason = 'ready';
            if (!online) reason = 'client-offline';
            else if (!enabled) reason = 'printer-disabled';
            else if (!printerInfo) reason = 'printer-not-reported';
            else if (!healthy) reason = `printer-${printerInfo.status || 'unknown'}`;
            return {
                clientId: target.clientId,
                clientName: target.clientName,
                group: target.group,
                printer: target.printer,
                online,
                enabled,
                healthy,
                printerStatus: printerInfo?.status || 'unknown',
                reason,
            };
        });
        const clientsWithTasks = await Promise.all(clients.map(async (client) => ({
            ...client,
            online: Boolean(client.updateAt && client.updateAt >= now - CLIENT_ONLINE_WINDOW),
            activeTasks: await this.ctx.db.code.count({ deleted: { $ne: 1 }, done: { $ne: 1 }, printer: client.id }),
            completedTasks: await this.ctx.db.code.count({ deleted: { $ne: 1 }, done: 1, printer: client.id }),
        })));
        const routeCode = (code) => {
            if (code.printer) {
                const assignedClient = clients.find((client) => client.id === code.printer);
                const assignedTarget = printCandidates(
                    printerTargets,
                    code.group,
                    code.location,
                )
                    .find((target) => target.clientId === code.printer && target.printer === code.targetPrinter);
                return {
                    ...code,
                    matchedGroup: code.group || assignedTarget?.group || 'All',
                    targetClient: code.printer,
                    targetClientName: assignedClient?.name || code.printer,
                };
            }
            const candidates = printCandidates(
                printerTargets,
                code.group,
                code.location,
            );
            const target = resolvePrinterTarget(
                printerTargets,
                clientStates as any,
                code.group,
                code.location,
                '',
                now,
            );
            const configured = target || candidates[0];
            if (!configured) return code;
            return {
                ...code,
                matchedGroup: code.group || configured.group || 'All',
                targetClient: configured.clientId,
                targetClientName: configured.clientName,
                targetPrinter: configured.printer,
                routeAvailable: Boolean(target),
            };
        };
        const needle = search.toLowerCase();
        const query: any = {
            deleted: { $ne: 1 },
            $where: function matchesPrint() {
                const taskStatus = this.done ? 'done' : ['needs_review', 'failed'].includes(this.stage) ? this.stage : this.printer ? 'sent' : 'new';
                if (status !== 'all' && status !== taskStatus) return false;
                if (!needle && (!params.group || params.group === 'all')) return true;
                const task = routeCode(this);
                const group = task.group || task.matchedGroup;
                if (params.group && params.group !== 'all' && group !== params.group) return false;
                return !needle || [task._id, task.team, task.location, group, task.filename, task.lang,
                    task.targetClient, task.targetClientName, task.targetPrinter].join(' ').toLowerCase().includes(needle);
            },
        };
        const total = await this.ctx.db.code.count(query);
        const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
        const codes = await this.ctx.db.code.find(query).sort({ createAt: -1, _id: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize);
        const groups = await this.ctx.db.code.find({ deleted: { $ne: 1 }, group: { $exists: true } }, { group: 1 });
        this.response.body = {
            codes: codes.map(routeCode),
            total,
            page: currentPage,
            pageSize,
            groups: [...new Set(['All', ...routes.map((route) => route.group), ...groups.map((item) => item.group)].filter(Boolean))].sort(),
            clients: clientsWithTasks,
            routing: { routes },
        };
    }

    async postView(params) {
        const code = await this.ctx.db.code.findOne({ _id: params._id });
        if (!code) {
            logger.info(code, params._id);
            throw new ValidationError('Code', null, 'Code not found');
        }
        fs.ensureDirSync(path.resolve(process.cwd(), 'data/.pdf'));
        const content = readPrintCode(code);
        const doc = await ConvertCodeToPDF(
            content,
            code.lang,
            code.filename,
            code.team,
            code.location,
            code.createAt,
            params.color ?? true,
        );
        this.response.type = 'application/pdf';
        this.response.disposition = 'attachment; filename="code.pdf"';
        this.response.body = Buffer.from(doc);
    }

    async postReprint(params) {
        const code = await this.ctx.db.code.findOne({ _id: params._id });
        if (!code) {
            logger.info(code, params._id);
            throw new ValidationError('Code', null, 'Code not found');
        }
        await this.ctx.db.code.updateOne({ _id: params._id }, {
            $set: {
                done: 0,
                printer: '',
                receivedAt: null,
                doneAt: null,
                remoteDoneAt: null,
                targetPrinter: '',
                claimId: '',
                stage: 'queued',
                attemptCount: 0,
                lastError: '',
            },
        } as any);
        this.response.body = { success: true };
    }

    async postDone(params) {
        const code = await this.ctx.db.code.findOne({ _id: params._id });
        if (!code) {
            logger.info(code, params._id);
            throw new ValidationError('Code', null, 'Code not found');
        }
        if (!code.done && code.printer && code.stage !== 'needs_review') throw new BadRequestError('Print task is currently assigned');
        await this.ctx.db.code.updateOne({ _id: params._id }, {
            $set: {
                done: 1,
                stage: 'done',
                lastError: '',
                ...(!code.done && { doneAt: Date.now() }),
            },
        } as any);
        this.response.body = { success: true };
    }

    async postRemove(params) {
        const code = await this.ctx.db.code.findOne({ _id: params._id });
        if (!code) {
            logger.info(code, params._id);
            throw new ValidationError('Code', null, 'Code not found');
        }
        if (!code.done && code.printer && code.stage !== 'needs_review') throw new BadRequestError('Print task is currently assigned');
        await this.ctx.db.code.updateOne({ _id: params._id }, { $set: { deleted: 1 } });
        this.response.body = { success: true };
    }
}

export class CodeHandler extends Handler {
    async post(params) {
        const uploadedFile = this.request.files?.file;
        let metadata;
        let content: Buffer;
        try {
            metadata = parsePrintSubmission(params, uploadedFile?.originalFilename || 'code.txt');
            if (params.code !== undefined && typeof params.code !== 'string') throw new Error('Code must be text');
            if (!params.code && !uploadedFile) throw new Error('Code is required');
            if (uploadedFile && fs.statSync(uploadedFile.filepath).size > MAX_CODE_SIZE) throw new Error('Code is larger than 256KB');
            content = params.code ? Buffer.from(params.code) : fs.readFileSync(uploadedFile.filepath);
            if (!content.length || content.length > MAX_CODE_SIZE) throw new Error('Code must contain between 1 and 262144 bytes');
        } catch (error) {
            throw new BadRequestError(error.message);
        }
        const res = await storePrintCode(this.ctx.db.code, {
            ...metadata, createAt: Date.now(), printer: '', done: 0,
        }, content);
        this.response.body = `The code has been submitted. Code Print ID: ${metadata.tid}#${res._id}`;
        logger.info(`Team(${metadata.tid}) submitted code. Code Print ID: ${res._id}`);
        await this.ctx.parallel('print/newTask', 1);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('print_admin', '/print', PrintAdminHandler);
    ctx.Route('receive_code', `/print/${config.secretRoute}`, CodeHandler);
    logger.info(`Code Print Route: /print/${config.secretRoute}`);
}
