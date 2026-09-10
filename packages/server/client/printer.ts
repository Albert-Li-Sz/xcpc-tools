/* eslint-disable no-await-in-loop */
import path from 'node:path';
import chardet from 'chardet';
import * as iconv from 'iconv-lite';
import { PDFDocument } from 'pdf-lib';
import superagent from 'superagent';
import { config } from '../config';
import {
    fs, getPrinters, initWinPrinter, Logger, print, randomstring, sleep,
} from '../utils';
import { acquireDataLock } from '../utils/instanceLock';
import { PrintJournal, PrintJournalEntry, recoveredPrintStage } from './printJournal';
import {
    sanitizedError, setClientConnection, setPrinterStatus, updateClientTask,
} from './status';
import { createTypstCompiler, generateTypst } from './typst';

let compiler;

const post = (url: string) => superagent.post(new URL(url, config.server).toString())
    .set('Accept', 'application/json').timeout({ response: 10000, deadline: 15000 });
const logger = new Logger('printer');

let timer = null;
const CLIENT_PROTOCOL_VERSION = 4;
let journal: PrintJournal;

const configuredPrinters = () => {
    const printers = (config.printers || []).map((item: any) => (
        typeof item === 'string'
            ? { printer: item, group: '' }
            : { printer: String(item.printer || ''), group: String(item.group || '').trim().toUpperCase() }
    )).filter((item) => item.printer);
    const names = new Set<string>();
    for (const item of printers) {
        if (names.has(item.printer)) throw new Error(`Printer is configured more than once: ${item.printer}`);
        names.add(item.printer);
    }
    return printers;
};

const mergePDFs = async (files: string[], output: string) => {
    const pdf = await PDFDocument.create();
    pdf.setProducer('pdf-merger-js');
    pdf.setCreationDate(new Date());
    for (const file of files) {
        const srcDoc = await PDFDocument.load(fs.readFileSync(file));
        const srcPageCount = srcDoc.getPageCount();
        logger.info(`${file} has ${srcPageCount} pages`);
        const copiedPages = await pdf.copyPages(
            srcDoc,
            Array.from({ length: config.printPageMax > srcPageCount ? srcPageCount : config.printPageMax }, (_, i) => i),
        );
        for (const page of copiedPages) {
            pdf.addPage(page);
        }
    }
    logger.info(`Merged ${files.length} files into ${output}`);
    return fs.writeFileSync(output, await pdf.save());
};

function toUtf8(code: Buffer) {
    const info = chardet.detect(code);
    logger.debug(`detected as ${info}`);
    if (!info) return code.toString('utf8');
    return iconv.decode(code, info).toString();
}

function escapeText(s: string) {
    let res = '';
    for (const c of Array.from(s)) {
        res += /^[\p{L}\p{M}\p{N}\p{P}\p{S}\r\n\t ]$/u.test(c)
            ? c
            : (c.length === 1 && c.codePointAt(0) <= 0x7F)
                ? c.charCodeAt(0).toString(16).padStart(2, '0')
                : `U+${c.codePointAt(0).toString(16).toUpperCase()}`;
    }
    return res;
}

export async function ConvertCodeToPDF(code: Buffer, lang, filename, team, location, createAt, codeColor = false) {
    compiler ||= await createTypstCompiler();
    const fakeFilename = randomstring(8); // cubercsl: do not trust filename from user
    const typst = generateTypst(team, location, fakeFilename, filename, lang, createAt, codeColor);
    compiler.addSource('/main.typst', typst);
    compiler.addSource(`/${fakeFilename}`, escapeText(toUtf8(code)));
    logger.info(`Convert ${filename} to PDF`);
    try {
        return await compiler.compile({
            format: 'pdf',
            mainFilePath: '/main.typst',
        });
    } catch (e) {
        logger.error(e);
        compiler = await createTypstCompiler();
        throw e;
    } finally {
        compiler.addSource(`/${fakeFilename}`, '');
    }
}

export async function printFile(docs, targetPrinter = '', beforeSubmit: () => Promise<void> = async () => {}, afterSubmit: () => void = () => {}) {
    let finalFile = null;
    const files = [];
    for (const doc of docs) {
        const {
            _id, tid, code, lang, filename, team, location, createAt,
        } = doc;
        if (!code) throw new Error(`Print task ${tid}#${_id} has no source content`);
        updateClientTask('print', _id, `${location || 'Unknown seat'} · ${filename}`, 'converting', { printer: targetPrinter });
        const pdf = await ConvertCodeToPDF(
            Buffer.from(code, 'base64'),
            lang,
            filename,
            team,
            location,
            createAt,
            config.printColor,
        );
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(_id)) throw new Error('Invalid print task ID');
        const pdfPath = path.resolve(process.cwd(), 'data', `${_id}.pdf`);
        fs.writeFileSync(pdfPath, pdf, { mode: 0o600 });
        files.push(pdfPath);
    }
    if (files.length === 1) {
        finalFile = files[0];
    } else {
        finalFile = path.resolve(process.cwd(), `data${path.sep}${new Date().getTime()}-merged.pdf`);
        await mergePDFs(files, finalFile);
    }
    const enabledPrinters = configuredPrinters().map((item) => item.printer);
    if (targetPrinter && !enabledPrinters.includes(targetPrinter)) {
        throw new Error(`Assigned printer is not enabled locally: ${targetPrinter}`);
    }
    while (enabledPrinters.length) {
        const printersInfo: any[] = await getPrinters();
        setPrinterStatus(printersInfo, enabledPrinters);
        const printers = printersInfo.filter((p) => (
            enabledPrinters.includes(p.printer)
            && (!targetPrinter || p.printer === targetPrinter)
            && p.status === 'idle'
        ));
        if (printers.length) {
            const randomP = targetPrinter ? printers[0] : printers[Math.floor(Math.random() * printers.length)];
            logger.info(`Printing ${finalFile} on ${randomP.printer}`);
            for (const doc of docs) {
                updateClientTask('print', doc._id, `${doc.location || 'Unknown seat'} · ${doc.filename}`, 'printing', { printer: randomP.printer });
            }
            await beforeSubmit();
            await print(finalFile, randomP.printer, 1, files.length > 1 ? undefined : config.printPageMax);
            afterSubmit();
            return randomP.printer;
        }
        logger.info(`No idle ${targetPrinter || 'enabled'} printer found, sleeping...`);
        await sleep(3000);
    }
    throw new Error('No Printer Configured');
}

async function reconcileJournal(c) {
    for (const entry of journal.list()) {
        const stage = recoveredPrintStage(entry.stage);
        const current = { ...entry, stage };
        if (stage !== entry.stage) journal.save([current]);
        const { doc, printer } = current;
        const label = `${doc.location || 'Unknown seat'} · ${doc.filename}`;
        try {
            const params = { claimId: doc.claimId, printer, error: current.error || 'Client restarted before task completion' };
            if (stage === 'confirming') {
                await post(`${c.server}client/${c.token}/doneprint/${doc._id}`).send(params);
                updateClientTask('print', doc._id, label, 'done', { printer });
                journal.remove(doc.claimId!);
            } else if (stage === 'release') {
                await post(`${c.server}client/${c.token}/releaseprint/${doc._id}`).send(params);
                updateClientTask('print', doc._id, label, 'failed', { printer, error: params.error });
                journal.remove(doc.claimId!);
            } else {
                await post(`${c.server}client/${c.token}/progressprint/${doc._id}`).send({ ...params, stage: 'needs_review' });
                updateClientTask('print', doc._id, label, 'needs_review', { printer, error: params.error });
            }
            setClientConnection('print', true);
        } catch (error) {
            if ([400, 404].includes(Number((error as any)?.status))) {
                journal.remove(doc.claimId!);
                updateClientTask('print', doc._id, label, 'failed', {
                    printer, error: 'Task changed on server; local job retired without reprinting',
                });
            } else {
                setClientConnection('print', false, error);
                logger.error('Unable to reconcile persisted print progress', error);
            }
        }
    }
}

async function fetchTask(c) {
    if (timer) clearTimeout(timer);
    try {
        await reconcileJournal(c);
        const printerConfigs = configuredPrinters();
        const printerGroups = new Map(printerConfigs.map((item) => [item.printer, item.group]));
        const enabledPrinters = printerConfigs.map((item) => item.printer);
        const printersInfo: any[] = await getPrinters();
        setPrinterStatus(printersInfo, enabledPrinters);
        const entries: PrintJournalEntry[] = [];
        let targetPrinter = '';
        for (let i = 0; i < config.printMergeQueue; i++) {
            const request = journal.beginRequest(targetPrinter);
            const { body } = await post(`${c.server}client/${c.token}/print`).send({
                protocolVersion: CLIENT_PROTOCOL_VERSION,
                requestId: request.id,
                printers: enabledPrinters,
                printersInfo: printersInfo.map((p) => ({ ...p, group: printerGroups.get(p.printer) || undefined })),
                preferredTargetPrinter: request.printer || undefined,
            });
            setClientConnection('print', true);
            if (!body.doc) { journal.acceptRequest(); break; }
            if (!body.doc.claimId) throw new Error('Server did not return a print claim; upgrade the server');
            const printer = String(body.targetPrinter || body.doc.targetPrinter || '');
            const entry: PrintJournalEntry = { doc: body.doc, printer, stage: 'received' };
            journal.acceptRequest(entry);
            if (targetPrinter && printer !== targetPrinter) throw new Error('Server mixed physical printers in one queue');
            targetPrinter = printer;
            entries.push(entry);
            updateClientTask('print', entry.doc._id, entry.doc.filename, 'received', { printer });
        }
        if (entries.length) {
            try {
                await printFile(entries.map((entry) => entry.doc), targetPrinter, async () => {
                    journal.save(entries.map((entry) => ({ ...entry, stage: 'submitting' })));
                    for (const entry of entries) {
                        await post(`${c.server}client/${c.token}/progressprint/${entry.doc._id}`).send({
                            claimId: entry.doc.claimId, stage: 'printing',
                        });
                    }
                }, () => {
                    journal.save(entries.map((entry) => ({ ...entry, stage: 'confirming' })));
                });
            } catch (error) {
                const claims = new Set(entries.map((entry) => entry.doc.claimId));
                journal.save(journal.list().filter((entry) => claims.has(entry.doc.claimId)).map((entry) => ({
                    ...entry,
                    stage: recoveredPrintStage(entry.stage),
                    error: sanitizedError(error),
                })));
                logger.error(error);
            }
            await reconcileJournal(c);
        }
    } catch (error) {
        setClientConnection('print', false, error);
        logger.error(error);
    }
    timer = setTimeout(() => fetchTask(c), 5000);
}

export async function apply() {
    const directory = path.resolve(process.cwd(), 'data/print-journal');
    fs.ensureDirSync(directory);
    const release = acquireDataLock(directory);
    process.once('exit', release);
    journal = new PrintJournal(config.server, config.token);
    compiler = await createTypstCompiler();
    const printers = configuredPrinters();
    if (process.platform === 'win32') {
        try {
            initWinPrinter();
        } catch (e) {
            logger.error(e);
            process.exit(1);
        }
    }
    if (config.token && config.server && printers.length) await fetchTask(config);
    else logger.error('Config not found, please check the config.client.yaml');
}
