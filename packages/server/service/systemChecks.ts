export interface SystemCheck {
    id: string;
    name: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
}

export function systemChecks(config, monitors: any[], clients: any[], roster: any[], fetcher, now = Date.now()): SystemCheck[] {
    const checks: SystemCheck[] = [];
    const serviceClients = (config.clients || []).filter((client) => Array.isArray(client.type));
    const tokens = serviceClients.map((client) => client.token);
    const validClients = tokens.every((token) => typeof token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(token))
        && new Set(tokens).size === tokens.length;
    checks.push({
        id: 'configuration',
        name: 'Client configuration',
        status: validClients ? 'pass' : 'fail',
        detail: validClients
            ? `${tokens.length} configured clients; credentials are valid and unique`
            : 'Client credentials are invalid or duplicated',
    });
    checks.push({
        id: 'report-auth',
        name: 'Probe authentication',
        status: config.monitor?.reportToken ? 'pass' : 'fail',
        detail: config.monitor?.reportToken ? 'Report authentication is enabled' : 'Machine reporting is disabled until a report token is configured',
    });
    const sourceSuccessAt = Number(fetcher?.sourceSuccessAt || 0);
    const sourceErrorAt = Number(fetcher?.sourceErrorAt || 0);
    const sourceReady = sourceSuccessAt > now - 45_000 && sourceSuccessAt >= sourceErrorAt;
    checks.push({
        id: 'oj',
        name: 'Recent OJ synchronization',
        status: config.type === 'server' || sourceReady ? 'pass' : 'fail',
        detail: config.type === 'server' ? 'Standalone mode' : sourceReady
            ? 'OJ synchronization succeeded within the last 45 seconds'
            : 'No recent successful synchronization; check the OJ connection',
    });
    const printerClients = clients.filter((client) => Array.isArray(client.type) && client.type.includes('printer'));
    const printers = printerClients.flatMap((client) => (client.printersInfo || []).map((printer) => ({
        ...printer, ready: client.updateAt > now - 20_000 && client.printers?.includes(printer.printer) && printer.status === 'idle',
    })));
    const ready = printers.filter((printer) => printer.ready).length;
    checks.push({
        id: 'printers',
        name: 'Reported printer availability',
        status: ready ? 'pass' : 'warn',
        detail: `${ready} idle printers out of ${printers.length} reported. Submit a test page to verify physical output.`,
    });
    const online = monitors.filter((monitor) => monitor.updateAt > now - 120_000);
    const legacy = online.filter((monitor) => monitor.protocol !== 'v2');
    const versions = [...new Set(online.map((monitor) => String(monitor.version || 'unknown')))];
    checks.push({
        id: 'probes',
        name: 'Probe versions',
        status: !online.length || legacy.length ? 'warn' : 'pass',
        detail: `${online.length} online; ${legacy.length} use legacy reporting. Versions: ${versions.join(', ') || 'none'}`,
    });
    const seats = monitors.map((monitor) => String(monitor.name || monitor.hostname || '').trim().toUpperCase());
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const seat of seats) {
        if (seat && seen.has(seat)) duplicates.add(seat);
        seen.add(seat);
    }
    checks.push({
        id: 'seats',
        name: 'Seat uniqueness',
        status: duplicates.size ? 'fail' : 'pass',
        detail: duplicates.size ? `Duplicate seats: ${[...duplicates].join(', ')}` : 'No duplicate machine seats',
    });
    const missing = roster.filter((team) => !seen.has(String(team.seat || '').trim().toUpperCase()));
    checks.push({
        id: 'roster',
        name: 'Roster coverage',
        status: !roster.length || missing.length ? 'warn' : 'pass',
        detail: `${roster.length} roster seats; ${missing.length} have no matching machine`,
    });
    return checks;
}
