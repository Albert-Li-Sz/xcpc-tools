import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PrintCodeDoc } from '../interface';
import { writeAtomicFile } from '../utils/atomicFile';
import { sanitizedError } from './status';

export type PrintJournalStage = 'received' | 'submitting' | 'confirming' | 'release' | 'needs_review';
export interface PrintJournalEntry {
    doc: Pick<PrintCodeDoc, '_id' | 'claimId' | 'filename' | 'location'>;
    stage: PrintJournalStage;
    printer: string;
    error?: string;
}

export class PrintJournal {
    private entries: Record<string, PrintJournalEntry> = {};
    pendingRequest: { id: string; printer: string } | null = null;
    readonly filename: string;

    constructor(server: string, token: string, root = process.cwd()) {
        const identity = createHash('sha256').update(`${server}\0${token}`).digest('hex');
        this.filename = path.join(root, 'data/print-journal', `${identity}.json`);
        if (!fs.existsSync(this.filename)) return;
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (![1, 2].includes(saved.version) || !Array.isArray(saved.entries)) throw new Error('Invalid print journal; preserve it for recovery');
        if (saved.pendingRequest) {
            if (!/^[a-f0-9]{32}$/.test(saved.pendingRequest.id) || typeof saved.pendingRequest.printer !== 'string') {
                throw new Error('Invalid pending print request; preserve it for recovery');
            }
            this.pendingRequest = saved.pendingRequest;
        }
        for (const entry of saved.entries) {
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry?.doc?._id) || !/^[a-f0-9]{32}$/.test(entry?.doc?.claimId)
                || !['received', 'submitting', 'confirming', 'release', 'needs_review'].includes(entry.stage)) {
                throw new Error('Invalid print journal entry; manual recovery is required');
            }
            this.entries[entry.doc.claimId] = entry;
        }
    }

    list() { return Object.values(this.entries); }

    beginRequest(printer: string) {
        if (this.pendingRequest) return this.pendingRequest;
        const request = { id: randomBytes(16).toString('hex'), printer };
        this.persist(this.entries, request);
        return request;
    }

    acceptRequest(entry?: PrintJournalEntry) {
        const next = { ...this.entries };
        if (entry) next[entry.doc.claimId!] = entry;
        this.persist(next, null);
    }

    save(entries: PrintJournalEntry[]) {
        const next = { ...this.entries };
        for (const entry of entries) next[entry.doc.claimId!] = entry;
        this.persist(next);
    }

    remove(claimId: string) {
        const next = { ...this.entries };
        delete next[claimId];
        this.persist(next);
    }

    private persist(next: Record<string, PrintJournalEntry>, pendingRequest = this.pendingRequest) {
        const entries = Object.values(next).map((entry) => ({
            doc: {
                _id: entry.doc._id,
                claimId: entry.doc.claimId,
                filename: entry.doc.filename,
                location: entry.doc.location,
            },
            stage: entry.stage,
            printer: entry.printer,
            error: entry.error ? sanitizedError(entry.error) : undefined,
        }));
        writeAtomicFile(this.filename, JSON.stringify({ version: 2, entries, pendingRequest }));
        this.entries = Object.fromEntries(entries.map((entry) => [entry.doc.claimId!, entry]));
        this.pendingRequest = pendingRequest;
    }
}

export function recoveredPrintStage(stage: PrintJournalStage): PrintJournalStage {
    if (stage === 'received') return 'release';
    if (stage === 'submitting') return 'needs_review';
    return stage;
}
