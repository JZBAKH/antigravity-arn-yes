const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

let statusBarState = null;
let pollInterval = null;
let lsConnection = null;
let isYesModeActive = false;
const validatedStepsCache = new Map();

/**
 * 🛰️ Discovery Engine (Universal Resilience)
 */
async function discoverLsConnection() {
    const isWin = process.platform === 'win32';

    if (isWin) {
        try {
            const winScript = `
$ProgressPreference = 'SilentlyContinue';
$results = @();
$p = Get-Process | Where-Object { \$_.Name -like "*language_server*" };
foreach (\$proc in \$p) {
    try {
        \$f_id = \$proc.Id;
        \$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=\${f_id}").CommandLine;
        if (\$cmd -match '--csrf_token\\s+([a-f0-9-]+)') {
            \$token = \$matches[1];
            \$netstatLines = netstat -ano | Select-String "LISTENING" | Select-String "\${f_id}";
            foreach (\$mLine in \$netstatLines) {
                \$lineText = \$mLine.Line.Trim();
                if (\$lineText -match ":(\\d+).+LISTENING\\s+\${f_id}") {
                    \$results += @{ Token = \$token; Port = [int]\$matches[1] }
                }
            }
        }
    } catch { }
}
if (\$results.Count -eq 0) { "[]" } else { \$results | ConvertTo-Json -Compress }
            `;
            const scriptPath = path.join(__dirname, 'discover_token.ps1');
            fs.writeFileSync(scriptPath, winScript, 'utf8');

            const output = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`).toString();
            const jsonMatch = output.match(/\[[\s\S]*\]/);
            if (!jsonMatch) return null;

            const candidates = JSON.parse(jsonMatch[0]);
            const list = Array.isArray(candidates) ? candidates : [candidates];

            for (const cand of list) {
                try {
                    const res = await lsRequest(cand.Port, cand.Token, 'GetAllCascadeTrajectories', {}, true);
                    if (res) return { port: cand.Port, csrfToken: cand.Token };
                } catch { }
            }
        } catch (e) { }
    } else {
        // 🍎 macOS / 🐧 Linux logic
        try {
            const psOut = execSync('ps -axww -o pid,command', { encoding: 'utf8', timeout: 5000 });
            const lines = psOut.split('\n');
            const lsLines = lines.filter(l => l.includes('language_server') && l.includes('--csrf_token'));
            for (const line of lsLines) {
                const match = line.trim().match(/^(\d+)\s+(.+)$/);
                if (!match) continue;
                const pid = match[1];
                const cmd = match[2];
                const csrfMatch = cmd.match(/--csrf_token\s+([a-f0-9-]{36})/);
                if (!csrfMatch) continue;
                const token = csrfMatch[1];
                let lsofOut = '';
                try { lsofOut = execSync(`lsof -nP -iTCP -sTCP:LISTEN -p ${pid}`, { encoding: 'utf8', timeout: 5000 }); } catch { }
                const portMatches = lsofOut.match(/:(\d+)\s+\(LISTEN\)/g);
                if (!portMatches) continue;
                for (const addr of portMatches) {
                    const m = addr.match(/:(\d+)/);
                    if (!m) continue;
                    const port = parseInt(m[1], 10);
                    try {
                        const res = await lsRequest(port, token, 'GetAllCascadeTrajectories', {}, true);
                        if (res) return { port, csrfToken: token };
                    } catch { }
                }
            }
        } catch (e) { }
    }
    return null;
}

/**
 * 📡 RPC Transport
 */
function lsRequest(port, token, method, body, useHttps = true) {
    const transport = useHttps ? https : http;
    const service = useHttps ? 'exa.language_server_pb.LanguageServerService' : 'exa.extension_server_pb.ExtensionServerService';

    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const options = {
            hostname: '127.0.0.1', port,
            path: `/${service}/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': token,
                'Content-Length': Buffer.byteLength(payload),
            },
            rejectUnauthorized: false,
        };
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try { resolve(JSON.parse(data)); } catch { resolve(data); }
                } else { reject(new Error(`Status ${res.statusCode}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
        req.write(payload);
        req.end();
    });
}

/**
 * ⚡ Yes Core Logic
 */
async function approveInteraction(cascadeId, stepIndex) {
    if (!lsConnection) return { success: false };
    try {
        const logicPayload = {
            accept: 1, cascadeId, acknowledgementScope: 2,
            codeAcknowledgementRequestInfos: [{ stepIndices: [stepIndex], acknowledgementScope: 2 }]
        };
        const uiPayload = { cascadeId };

        await Promise.all([
            lsRequest(lsConnection.port, lsConnection.csrfToken, 'AcknowledgeCodeActionStep', logicPayload, true),
            lsRequest(60001, '', 'BrowserValidateCascadeOrCancelOverlay', uiPayload, false).catch(() => { })
        ]);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

async function monitorBackgroundActivity() {
    if (!lsConnection) {
        lsConnection = await discoverLsConnection();
        if (!lsConnection) return;
    }
    try {
        const res = await lsRequest(lsConnection.port, lsConnection.csrfToken, 'GetAllCascadeTrajectories', {}, true);
        const summaries = res.trajectory_summaries || res.trajectorySummaries;
        if (!summaries) return;

        for (const [cascadeId, summary] of Object.entries(summaries)) {
            const waitingSteps = summary.waiting_steps || summary.waitingSteps;
            if (!waitingSteps || waitingSteps.length === 0) continue;

            const ws = waitingSteps[waitingSteps.length - 1];
            const stepIndex = ws.step_index ?? ws.stepIndex;
            const stepKey = `${cascadeId}_${stepIndex}`;

            if (validatedStepsCache.has(stepKey)) continue;
            validatedStepsCache.set(stepKey, Date.now());

            const status = await approveInteraction(cascadeId, stepIndex);
            if (status.success) {
                const cmd = ws.command_line ?? ws.summary ?? 'Gemini Command';
                vscode.window.setStatusBarMessage(`ARN Yes ✓ accepted: "${cmd.substring(0, 50)}..."`, 4000);
                await lsRequest(lsConnection.port, lsConnection.csrfToken, 'ResolveOutstandingSteps', { cascadeId }, true);
            }
        }
    } catch (e) {
        if (e.message.includes('Status 403') || e.message.includes('ECONNREFUSED')) {
            lsConnection = null;
        }
    }
}

/**
 * ⚡ Main Lifecycle
 */
async function toggleYesMode() {
    if (isYesModeActive) {
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = null;
        isYesModeActive = false;
        vscode.window.showInformationMessage('ARN Yes: Mode OFF');
    } else {
        lsConnection = await discoverLsConnection();
        if (lsConnection) {
            pollInterval = setInterval(monitorBackgroundActivity, 2000);
            isYesModeActive = true;
            vscode.window.showInformationMessage('ARN Yes: Mode ON — auto-accepting commands.');
        } else {
            vscode.window.showWarningMessage('ARN Yes: Language server not found.');
        }
    }
    updateUI();
}

function updateUI() {
    if (!statusBarState) return;
    statusBarState.text = 'ARN-Yes🚦';
    statusBarState.color = isYesModeActive ? '#4eb326ff' : '#e82929ff';
    statusBarState.tooltip = isYesModeActive ? 'ARN-Yes = ON | Auto-accepting commands.' : 'ARN-Yes = OFF | Click to enable';
    statusBarState.show();
}

function activate(context) {
    statusBarState = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBarState.command = 'antigravity-arn-yes.toggle';
    context.subscriptions.push(statusBarState);
    context.subscriptions.push(vscode.commands.registerCommand('antigravity-arn-yes.toggle', toggleYesMode));
    updateUI();

}

function deactivate() {
    if (pollInterval) clearInterval(pollInterval);
    try {
        const scriptPath = path.join(__dirname, 'discover_token.ps1');
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    } catch (e) { }
}

module.exports = { activate, deactivate };
