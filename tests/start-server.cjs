const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcpc-browser-test-'));
fs.writeFileSync(path.join(root, 'config.server.yaml'), `type: server
port: 15983
viewPass: test-view-password
secretRoute: test-print-route
clients:
  - token: test-printer-client-token
    name: Test printer
    type: [printer]
monitor:
  reportToken: test-probe-token
`);
const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/xcpc-tools.js')], { cwd: root, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(code || 0);
});
