const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const WebSocket = require('ws');

test.beforeEach(async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    page.runtimeErrors = errors;
});
test.afterEach(async ({ page }) => {
    expect(page.runtimeErrors).toEqual([]);
});

const clientPath = '/client/test-printer-client-token';
const submit = (request, extra = {}) => request.post('/print/test-print-route', { data: { team: 'A01', tname: 'Browser test team', filename: 'main.cpp', code: 'int main() {}', location: 'A01', ...extra } });

test('reject bad print input and display uncertain printing for administrator review', async ({ page, request }) => {
    const original = (await (await request.get('/print')).json()).codes.length;
    expect((await submit(request, { team: '../escape' })).status()).toBe(400);
    expect((await submit(request, { tname: null })).status()).toBe(400);
    expect((await (await request.get('/print')).json()).codes.length).toBe(original);
    expect((await submit(request)).ok()).toBeTruthy();
    const claimResponse = await request.post(`${clientPath}/print`, { data: { protocolVersion: 4, requestId: randomBytes(16).toString('hex'), printers: ['Mock printer'], printersInfo: [{ printer: 'Mock printer', status: 'idle' }] } });
    expect(claimResponse.ok()).toBeTruthy();
    const { doc } = await claimResponse.json();
    expect(doc.claimId).toBeTruthy();
    expect((await request.post(`${clientPath}/progressprint/${doc._id}`, { data: { claimId: doc.claimId, stage: 'printing' } })).ok()).toBeTruthy();
    expect((await request.post(`${clientPath}/releaseprint/${doc._id}`, { data: { claimId: doc.claimId } })).status()).toBe(400);
    await request.post(`${clientPath}/progressprint/${doc._id}`, { data: { claimId: doc.claimId, stage: 'needs_review', error: 'Spooler result unknown' } });
    await page.goto('/#/print');
    await expect(page.getByRole('table').getByText('Needs review', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm physical print' })).toBeVisible();
    await page.getByRole('button', { name: 'Printed', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm physical print' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Done', exact: true })).toBeVisible();
    await expect(page.getByText('Spooler result unknown', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: '/tmp/xcpc-tools-playwright/print-reviewed.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Print file', exact: true }).click();
    const upload = page.getByRole('dialog', { name: 'Print File', exact: true });
    await upload.locator('input[type="file"]').setInputFiles({ name: 'main.cpp', mimeType: 'text/plain', buffer: Buffer.from('int main() {}') });
    await expect(upload.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await upload.getByRole('textbox', { name: 'Team name', exact: true }).fill('Upload test team');
    await upload.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(upload).toHaveCount(0);
    await expect(page.getByRole('table').getByText('Admin: Upload test team', { exact: true })).toBeVisible();
});

test('WebSocket failures render red and waiting offline commands can be cancelled', async ({ page, request }) => {
    const socket = new WebSocket('ws://127.0.0.1:15983/probe?token=test-probe-token');
    const received = [];
    socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        received.push(message);
        if (message.type === 'command') socket.send(JSON.stringify({ type: 'result', id: message.id, exitCode: 1, stderr: 'Expected test failure' }));
    });
    try {
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        socket.send(JSON.stringify({ type: 'hello', probe: { mac: 'AABBCCDDEEFF', hostname: 'A01', version: 'test-probe' } }));
        await expect.poll(() => received.some((message) => message.type === 'welcome')).toBeTruthy();
        const response = await request.post('/commands', { data: { operation: 'command', command: 'false', target: ['AABBCCDDEEFF'], ttlMinutes: 1 } });
        expect(response.ok()).toBeTruthy();
        await expect.poll(async () => (await (await request.get('/commands')).json()).commands[0].status.failed).toBe(1);
        await page.goto('/#/commands');
        await expect(page.getByText('1 failed · 0 timed out')).toBeVisible();
        await page.screenshot({ path: '/tmp/xcpc-tools-playwright/commands-failed.png', fullPage: true, animations: 'disabled' });
        await new Promise((resolve) => { socket.once('close', resolve); socket.close(); });
        await expect.poll(async () => (await (await request.get('/commands')).json()).targets[0].connected).toBeFalsy();
        expect((await request.post('/commands', { data: { operation: 'command', command: 'echo queued', target: ['AABBCCDDEEFF'], delivery: 'reconnect', ttlMinutes: 15 } })).ok()).toBeTruthy();
        await page.reload();
        await page.getByRole('button', { name: 'Cancel waiting targets', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel waiting targets', exact: true }).click();
        await expect(page.getByText('0 expired · 1 cancelled')).toBeVisible();
    } finally { socket.terminate(); }
});

test('system checks, credential-free diagnostics, printer test and mobile layout', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/#/operations');
    await expect(page).toHaveTitle('@Hydro/XCPC-TOOLS');
    await expect(page.getByRole('heading', { name: 'System checks' })).toBeVisible();
    await expect(page.getByText('Seat uniqueness', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run checks', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export diagnostics' }).click();
    const download = await downloadPromise;
    const contents = fs.readFileSync(await download.path(), 'utf8');
    expect(JSON.parse(contents).checks.length).toBeGreaterThan(5);
    for (const secret of ['test-view-password', 'test-probe-token', 'test-printer-client-token', 'test-print-route']) expect(contents).not.toContain(secret);
    await page.getByRole('button', { name: 'Print test page', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit test page', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Test page queued', { exact: true })).toBeVisible();
    expect((await (await request.get('/print')).json()).codes.some((code) => code.tid === 'SELFTEST')).toBeTruthy();
    await page.screenshot({ path: '/tmp/xcpc-tools-playwright/checks-desktop.png', fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'System checks' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('menuitem', { name: 'Checks' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: '/tmp/xcpc-tools-playwright/checks-mobile.png', fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
});

test('machine authentication, stable IDs, batch preview and side-effect-free probe tests', async ({ page, request }) => {
    const report = { mac: '112233445566', seats: 'QA01', window_name: '', window_exe: '', window_cmdline: '' };
    expect((await request.post('/report', { data: report })).status()).toBe(403);
    expect((await request.post('/report?token=wrong', { data: report })).status()).toBe(403);
    expect((await request.post('/report?token=test-probe-token', { data: report })).ok()).toBeTruthy();
    expect((await request.post('/report?token=test-probe-token', { data: { ...report, mac: '112233445577', seats: 'QA02' } })).ok()).toBeTruthy();
    const before = (await (await request.get('/monitor')).json()).monitors;
    for (const [key, monitor] of Object.entries(before)) expect(key).toBe(monitor._id);
    await page.goto('/#/monitor');
    await page.getByRole('button', { name: 'Batch edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Batch Operation' });
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('DUPLICATE');
    await dialog.getByRole('button', { name: 'Preview changes' }).click();
    await expect(dialog.getByText('Duplicate names', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Apply to/ })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'name', exact: true }).fill('[hostname]');
    await dialog.getByRole('button', { name: 'Preview changes' }).click();
    await expect(dialog.getByRole('button', { name: /^Apply to/ })).toBeEnabled();
    await dialog.getByRole('button', { name: /^Apply to/ }).click();
    await expect(dialog).toHaveCount(0);
    const after = (await (await request.get('/monitor')).json()).monitors;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(Object.values(after).some((monitor) => monitor.name === 'QA01')).toBeTruthy();

    const socket = new WebSocket('ws://127.0.0.1:15983/probe?token=test-probe-token');
    const messages = [];
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    try {
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        socket.send(JSON.stringify({ type: 'hello', probe: { mac: report.mac, hostname: 'QA01' } }));
        await expect.poll(() => messages.some((message) => message.type === 'welcome')).toBeTruthy();
        const testSocket = new WebSocket('ws://127.0.0.1:15983/probe?token=test-probe-token');
        try {
            await new Promise((resolve, reject) => { testSocket.once('open', resolve); testSocket.once('error', reject); });
            const response = new Promise((resolve) => testSocket.once('message', (raw) => resolve(JSON.parse(String(raw)))));
            testSocket.send(JSON.stringify({ type: 'test' }));
            expect(await response).toEqual({ type: 'test-ok' });
        } finally { testSocket.terminate(); }
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect((await (await request.get('/commands')).json()).targets.find((target) => target.mac === report.mac).connected).toBeTruthy();
    } finally { socket.terminate(); }
});

test('print allocation retries are idempotent through HTTP and server pagination preserves older jobs', async ({ page, request }) => {
    const input = { protocolVersion: 4, requestId: randomBytes(16).toString('hex'), printers: ['Mock printer'], printersInfo: [{ printer: 'Mock printer', status: 'idle' }] };
    await submit(request, { tname: 'Retry test' });
    const first = await (await request.post(`${clientPath}/print`, { data: input })).json();
    expect(first.doc).toBeTruthy();
    const second = await (await request.post(`${clientPath}/print`, { data: input })).json();
    expect(second.doc._id).toBe(first.doc._id);
    expect(second.doc.claimId).toBe(first.doc.claimId);
    expect((await request.post(`${clientPath}/doneprint/${first.doc._id}`, { data: { claimId: first.doc.claimId, printer: 'Mock printer' } })).ok()).toBeTruthy();
    expect((await (await request.post(`${clientPath}/print`, { data: input })).json()).retired).toBeTruthy();
    for (let start = 0; start < 62; start += 10) {
        const responses = await Promise.all(Array.from({ length: Math.min(10, 62 - start) }, (_, i) => submit(request, { tname: `Pagination QA ${start + i}`, group: 'QA' })));
        expect(responses.every((response) => response.ok())).toBeTruthy();
    }
    const all = await (await request.get('/print?search=Pagination%20QA&page=1')).json();
    const rest = await (await request.get('/print?search=Pagination%20QA&page=2')).json();
    expect(all.total).toBe(62);
    expect(all.codes).toHaveLength(50);
    expect(rest.codes).toHaveLength(12);
    expect(new Set([...all.codes, ...rest.codes].map((task) => task._id)).size).toBe(62);
    expect((await request.get('/print?pageSize=100000')).status()).toBe(400);
    await page.goto('/#/print');
    await page.getByRole('textbox', { name: 'Search print tasks' }).fill('Pagination QA');
    await expect(page.getByText('62 tasks, 50 per page')).toBeVisible();
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(50);
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(12);
});

test('command history fetches output only when opening execution results', async ({ page, request }) => {
    const history = await (await request.get('/commands')).json();
    const failed = history.commands.find((command) => command.status.failed > 0);
    expect(failed).toBeTruthy();
    expect(failed.results).toBeUndefined();
    expect(failed.executionResult).toBeUndefined();
    const details = [];
    page.on('request', (req) => { if (req.url().includes('/commands?id=')) details.push(req.url()); });
    await page.goto('/#/commands');
    await expect(page.getByRole('button', { name: 'View execution results' }).first()).toBeVisible();
    expect(details).toHaveLength(0);
    await page.getByRole('row').filter({ hasText: failed.command }).getByRole('button', { name: 'View execution results' }).click();
    const modal = page.getByRole('dialog', { name: 'Execution Results' });
    await expect(modal.getByText(/target computers/)).toBeVisible();
    expect(details.length).toBeGreaterThan(0);
    await modal.getByRole('button', { name: /1 host:/ }).click();
    await expect(modal.getByText(/Expected test failure/)).toBeVisible();
    await page.screenshot({ path: '/tmp/xcpc-tools-playwright/command-detail.png', fullPage: true, animations: 'disabled' });
});
