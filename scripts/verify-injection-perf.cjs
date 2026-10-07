/**
 * [lc-1282/1283] 注入层性能修复 双向验证（零 CPU，vm 沙箱，不起浏览器）。
 *
 * 被测文件按源码用 typescript.transpileModule 转译后在 vm 沙箱加载，
 * 依赖(electron/hooks/logger/DOM/定时器)全部打桩；同一套断言分别跑
 * 【修复版(工作区)】与【未修复版(git HEAD)】：
 *   修复版必须 PASS；未修复版必须 FAIL（带 oldMayPass 标记的回归护栏行除外，
 *   该类行用于确认旧版兼容行为未被误伤）。
 *
 * 覆盖：
 *   1. playButton 轮询空转指数退避（1.2s→封顶10s；实效/页面活跃回高频档）
 *   2. playButton OnDomChange 200ms 防抖（30次变动只注入1次）
 *   3. playButton textContent 识别（沙箱按钮无 innerText，旧实现应找不到候选）
 *   4. preload logger 批量合流（窗口内合并为一次 'log-message-batch'，error 立即冲刷，
 *      主进程无批量通道时逐条回退老通道）
 *   5. 主进程批量通道注册(useHandle) + beginBatch/endBatch 整批只落盘一次
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

const ROOT = path.join(__dirname, '..');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

function transpile(source, filename) {
    return ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        fileName: filename,
    }).outputText;
}

function runInSandbox(js, sandbox, filename) {
    sandbox.module = { exports: {} };
    sandbox.exports = sandbox.module.exports;
    sandbox.__dirname = '/virtual';
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename });
    return sandbox.module.exports;
}

// ───────────────────────── playButton ─────────────────────────

function makeBtn(text) {
    const attrs = {};
    return {
        textContent: text || '播放',
        // 故意不给 innerText：旧实现读 innerText 应识别失败 → 双向验证 textContent 改造
        offsetParent: {},
        classList: { contains: c => c === 'semi-button-primary' },
        getAttribute: n => (n === 'class' ? 'semi-button semi-button-primary' : (n in attrs ? attrs[n] : null)),
        setAttribute: (n, v) => { attrs[n] = String(v); },
        removeAttribute: n => { delete attrs[n]; },
        hasAttribute: n => n in attrs,
        closest: () => null,
        querySelector: () => null,
        addEventListener: () => {},
        cloneNode: () => makeBtn(text),
        parentNode: { insertBefore: () => {} },
    };
}

function makePlayButtonEnv() {
    const state = { buttons: [], customPlay: null, marked: null };
    const timers = [];
    let idSeq = 1;
    const document = {
        querySelectorAll: sel => (sel === 'button' ? state.buttons : []),
        querySelector: sel => (sel === '[data-custom-play]' ? state.customPlay
            : sel === 'button[data-mpv-btn]' ? state.marked : null),
    };
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {} },
        document,
        setTimeout: (fn, ms) => { const t = { id: idSeq++, fn, ms: ms || 0, kind: 't', cleared: false, ran: false, runs: 0 }; timers.push(t); return t.id; },
        clearTimeout: id => { timers.forEach(t => { if (t.kind === 't' && t.id === id) t.cleared = true; }); },
        setInterval: (fn, ms) => { const t = { id: idSeq++, fn, ms: ms || 0, kind: 'i', cleared: false, ran: false, runs: 0 }; timers.push(t); return t.id; },
        clearInterval: id => { timers.forEach(t => { if (t.kind === 'i' && t.id === id) t.cleared = true; }); },
        window: { addEventListener() {} },
    };
    return { state, timers, sandbox };
}

function loadPlayButton(source, env) {
    const hooks = { onReady: [], onDomChange: [] };
    const counters = { configCalls: 0 };
    env.sandbox.require = name => {
        if (name === 'electron') return { ipcRenderer: { send() {} } };
        if (name === '../core/hooks') return {
            HookType: { OnReady: 'onReady', OnDomChange: 'onDomChange' },
            registerHook: (t, f) => hooks[t].push(f),
        };
        if (name === '../core/logger') return { info() {}, warn() {}, error() {}, debug() {} }; // __importDefault 自动包 default
        if (name === '../core/utils') return { getCookie: () => 'tok' };
        if (name === './playChoice') return {
            getPlayButtonConfig: () => { counters.configCalls++; return Promise.resolve({ hideOriginalPlayButton: false, defaultPlayer: 'mpv', potPath: '' }); },
            createPlayModal() {},
        };
        if (name === './playMaskButton') return { getItemGuidFromDOM: () => 'guid-1', tryGetItemGuidFromOriginalLogic: async () => null };
        throw new Error('unexpected require: ' + name);
    };
    runInSandbox(transpile(source, 'playButton.ts'), env.sandbox, 'playButton.ts');
    return { hooks, counters };
}

// 跑定时器：timeout 只跑一次，interval 至多 steps 次；记录每次触发的 ms
async function fireTimers(timers, steps) {
    const fired = [];
    for (let i = 0; i < steps; i++) {
        const t = timers.find(x => !x.cleared && (x.kind === 't' ? !x.ran : x.runs < steps));
        if (!t) break;
        t.runs++;
        if (t.kind === 't') t.ran = true;
        fired.push({ kind: t.kind, ms: t.ms });
        t.fn();
        await settle();
    }
    return fired;
}

async function verifyPlayButton(source, label) {
    const results = [];

    // 1) 空转退避：无按钮的空页面，调度间隔应指数涨到 >=10s
    {
        const env = makePlayButtonEnv();
        const { hooks } = loadPlayButton(source, env);
        hooks.onReady[1](); // startInjectionPoll（onReady 注册顺序：inject, poll）
        const fired = (await fireTimers(env.timers, 8)).filter(x => x.kind === 't');
        const maxDelay = fired.length ? Math.max(...fired.map(x => x.ms)) : 0;
        results.push({
            name: `${label}: 空转退避到封顶10s`,
            pass: fired.length >= 6 && maxDelay >= 10000,
            detail: `timeouts=${JSON.stringify(fired.map(x => x.ms))}`,
        });
    }

    // 2) OnDomChange 防抖：30 次变动只应产生 1 次注入，且在 200ms 定时器到期后才发生
    {
        const env = makePlayButtonEnv();
        env.state.buttons = [makeBtn('播放')];
        const { hooks, counters } = loadPlayButton(source, env);
        const handler = hooks.onDomChange[0];
        for (let i = 0; i < 30; i++) handler();
        const before = counters.configCalls;
        const pending = env.timers.filter(t => t.kind === 't' && !t.cleared && !t.ran);
        results.push({
            name: `${label}: OnDomChange 防抖(30次变动→0次立发+1个200ms定时器)`,
            pass: before === 0 && pending.length === 1 && pending[0].ms === 200,
            detail: `立即注入=${before} 待触发定时器=${pending.length} ms=${pending[0] && pending[0].ms}`,
        });
        if (pending[0]) { pending[0].fn(); await settle(); }
        results.push({
            name: `${label}: 防抖到期后只注入1次`,
            pass: counters.configCalls === 1,
            oldMayPass: false,
            detail: `configCalls=${counters.configCalls}`,
        });
    }

    // 3) textContent 识别 + 实效回高频：有候选时首轮即注入(data-mpv-btn 被标记)，间隔保持 1.2s
    {
        const env = makePlayButtonEnv();
        env.state.buttons = [makeBtn('播放')];
        const { hooks } = loadPlayButton(source, env);
        hooks.onReady[1](); // 仅启动轮询，隔离首轮由 poll 完成
        const fired = await fireTimers(env.timers, 2); // 不滤 kind：新版=timeout链、旧版=interval
        const injected = env.state.buttons[0].hasAttribute('data-mpv-btn');
        results.push({
            name: `${label}: textContent 识别候选并注入`,
            pass: injected,
            detail: `data-mpv-btn=${injected}`,
        });
        results.push({
            name: `${label}: 注入后下一轮保持1.2s高频`,
            pass: fired.length >= 2 && fired.every(x => x.ms === 1200), // 新版=timeout链、旧版=interval，均应为固定 1.2s
            oldMayPass: true, // 旧版固定 1.2s 间隔，此行为本就成立（回归护栏）
            detail: `fired=${JSON.stringify(fired.map(x => x.ms))}`,
        });
    }

    // 4) 退避后页面重新活跃(OnDomChange) → 轮询下一档回到 1.2s
    {
        const env = makePlayButtonEnv();
        const { hooks } = loadPlayButton(source, env);
        hooks.onReady[1]();
        await fireTimers(env.timers, 5); // 退避中：1200→2400→4800→9600→10000
        const knownIds = new Set(env.timers.map(t => t.id));
        hooks.onDomChange[0](); // 页面活跃：立即重置 pollDelay=1200
        await fireTimers(env.timers, 4);
        const newSchedules = env.timers.filter(t => t.kind === 't' && !knownIds.has(t.id)).map(t => t.ms);
        results.push({
            name: `${label}: 页面活跃重置轮询回1.2s`,
            pass: newSchedules.some(ms => ms === 1200),
            detail: `活跃后新调度=${JSON.stringify(newSchedules)}`,
        });
    }

    return results;
}

// ───────────────────────── preload logger ─────────────────────────

function makeLoggerEnv(rejectBatch) {
    const invocations = [];
    const timers = [];
    let idSeq = 1;
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        process: { env: { NODE_ENV: 'production' } },
        setTimeout: (fn, ms) => { const t = { id: idSeq++, fn, ms: ms || 0, cleared: false }; timers.push(t); return t.id; },
        clearTimeout: id => { timers.forEach(t => { if (t.id === id) t.cleared = true; }); },
        window: { addEventListener() {} },
    };
    sandbox.require = name => {
        if (name === 'electron') return {
            ipcRenderer: {
                invoke: (channel, ...a) => {
                    invocations.push({ channel, args: a });
                    if (rejectBatch && channel === 'log-message-batch') return Promise.reject(new Error('No handler registered'));
                    return Promise.resolve();
                },
            },
        };
        if (name === './types') return {};
        throw new Error('unexpected require: ' + name);
    };
    return { invocations, timers, sandbox };
}

async function verifyPreloadLogger(source, label) {
    const results = [];

    // 4a) 批量合流：低级别日志在窗口内不发 IPC，到期一次批量发送
    {
        const env = makeLoggerEnv(false);
        const logger = runInSandbox(transpile(source, 'logger.ts'), env.sandbox, 'logger.ts').default;
        logger.info('x', 1);
        logger.warn('y');
        logger.debug('z');
        const before = env.invocations.length;
        const pending = env.timers.filter(t => !t.cleared);
        let batchPayload = null;
        if (pending.length === 1) { pending[0].fn(); await settle(); batchPayload = env.invocations[0]; }
        const ok = before === 0 && batchPayload && batchPayload.channel === 'log-message-batch'
            && JSON.stringify(batchPayload.args[0]) === JSON.stringify([['info', 'x', 1], ['warn', 'y'], ['debug', 'z']]);
        results.push({ name: `${label}: 窗口内合流为一次批量IPC`, pass: ok, detail: `before=${before} inv=${JSON.stringify(env.invocations)}` });
    }

    // 4b) error 级不等窗口：立即冲刷
    {
        const env = makeLoggerEnv(false);
        const logger = runInSandbox(transpile(source, 'logger.ts'), env.sandbox, 'logger.ts').default;
        logger.error('boom');
        results.push({ name: `${label}: error 立即冲刷`, pass: env.invocations.length === 1, oldMayPass: true, detail: JSON.stringify(env.invocations) });
    }

    // 4c) 主进程无批量通道 → 逐条回退老通道，不丢日志
    {
        const env = makeLoggerEnv(true);
        const logger = runInSandbox(transpile(source, 'logger.ts'), env.sandbox, 'logger.ts').default;
        logger.info('a');
        logger.warn('b');
        const pending = env.timers.filter(t => !t.cleared);
        if (pending[0]) { pending[0].fn(); await settle(); await settle(); }
        const perLine = env.invocations.filter(i => i.channel === 'log-message');
        const ok = perLine.length === 2 && perLine[0].args[0] === 'info' && perLine[1].args[0] === 'warn';
        results.push({ name: `${label}: 批量通道缺失时逐条回退`, pass: ok, oldMayPass: true, detail: JSON.stringify(env.invocations.map(i => i.channel)) });
    }

    return results;
}

// ───────────────────────── main handler + Logger 落盘 ─────────────────────────

function verifyMainHandler(source, label) {
    const registered = [];
    const calls = { begin: 0, end: 0, logC: 0, debug: 0, info: 0, warn: 0, error: 0 };
    const fakeLoggerInstance = {
        beginBatch: () => { calls.begin++; },
        endBatch: () => { calls.end++; },
        logC: () => { calls.logC++; },
        debug: () => { calls.debug++; },
        info: () => { calls.info++; },
        warn: () => { calls.warn++; },
        error: () => { calls.error++; },
    };
    const fakeLog = {
        getLogger: () => fakeLoggerInstance,
        debug: () => { calls.debug++; },
        info: () => { calls.info++; },
        warn: () => { calls.warn++; },
        error: () => { calls.error++; },
    };
    const sandbox = { console };
    sandbox.require = name => {
        if (name === 'electron') return { ipcMain: { handle() {}, on() {} }, IpcMainEvent: class {}, IpcMainInvokeEvent: class {} };
        if (name === '../core/ipcHandler') return { registerHandler: (ch, fn, opts) => registered.push({ ch, fn, opts }) };
        if (name === '../../../modules/logger') return fakeLog;
        throw new Error('unexpected require: ' + name);
    };
    const exports_ = runInSandbox(transpile(source, 'logger.handler.ts'), sandbox, 'logger.handler.ts');
    exports_.init();
    const batchReg = registered.find(r => r.ch === 'log-message-batch');
    const oldReg = registered.find(r => r.ch === 'log-message');
    let routeOk = false;
    if (batchReg) {
        batchReg.fn({}, [['info', '[EmbyWall]', 'hello'], ['error', 'plain', 1], ['debug', 'dbg']]);
        routeOk = calls.begin === 1 && calls.end === 1 && calls.logC === 1 && calls.error === 1 && calls.debug === 1;
    }
    return [
        { name: `${label}: 注册 log-message-batch(useHandle)`, pass: !!(batchReg && batchReg.opts && batchReg.opts.useHandle === true) && !!oldReg, detail: JSON.stringify(registered.map(r => r.ch)) },
        { name: `${label}: 批处理 begin/end 恰好各一次且逐条路由`, pass: routeOk, detail: JSON.stringify(calls) },
    ];
}

function verifyMainLoggerCoalesce(source, label) {
    const appends = [];
    const fsStub = {
        existsSync: () => true,
        mkdirSync: () => {},
        readdirSync: () => [],
        statSync: () => ({ size: 0, mtime: new Date(0), isDirectory: () => false }),
        readFileSync: () => '{}',
        appendFileSync: (p, data) => appends.push({ file: String(p).split(/[\\/]/).pop(), data }),
        renameSync: () => {},
        unlinkSync: () => {},
    };
    const configStub = {
        logConfig: { maxFileSize: 1 << 30, maxFiles: 5, consoleOutput: false, dedupEnabled: false, dedupWindowMs: 3000 },
        getLogLevel: () => 0, // DEBUG
        LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NOFORMAT: 4 },
    };
    const maskingStub = {
        maskLogArguments: (msg, ...args) => [msg, ...args],
        maskError: e => e,
    };
    const sandbox = {
        console: { log() {}, info() {}, warn() {}, error() {} },
        process: { cwd: () => '/proj', env: {} },
        setInterval: () => 0,
        clearInterval: () => {},
    };
    sandbox.require = name => {
        if (name === 'fs') return fsStub;
        if (name === 'path') return path;
        if (name === './config') return configStub;
        if (name === './masking') return maskingStub;
        if (name === 'electron') return {};
        throw new Error('unexpected require: ' + name);
    };
    const exports_ = runInSandbox(transpile(source, 'logger.ts'), sandbox, 'logger.ts');
    const logger = exports_.logger;
    const out = [];

    // 整批合并：批内 0 次落盘，endBatch 一次写 app.log(3行) + 一次写 app-error.log(1行)
    let batchOk = false;
    try {
        logger.beginBatch();
        logger.info('a');
        logger.info('b');
        logger.warn('w');
        const duringBatch = appends.length;
        logger.endBatch();
        const appLog = appends.filter(x => x.file === 'app.log');
        const errLog = appends.filter(x => x.file === 'app-error.log');
        batchOk = duringBatch === 0 && appLog.length === 1 && appLog[0].data.split('\n').filter(Boolean).length === 3
            && errLog.length === 1 && errLog[0].data.split('\n').filter(Boolean).length === 1;
    } catch (e) {
        batchOk = false;
        out.push({ name: `${label}: beginBatch 可调用`, pass: false, detail: String(e.message || e) });
    }
    out.push({ name: `${label}: 批内缓存、endBatch 单次落盘`, pass: batchOk, detail: JSON.stringify(appends.map(a => ({ f: a.file, lines: a.data.split('\n').filter(Boolean).length }))) });

    // 非批量路径保持逐行
    appends.length = 0;
    logger.info('solo');
    out.push({ name: `${label}: 非批量路径仍逐行落盘`, pass: appends.length === 1 && appends[0].file === 'app.log', oldMayPass: true, detail: JSON.stringify(appends) });
    return out;
}

// ───────────────────────── 驱动 ─────────────────────────

async function main() {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const head = p => execSync(`git show HEAD:${p}`, { cwd: ROOT, encoding: 'utf8' });

    const playNew = read('src/preload/plugins/playButton.ts');
    const playOld = head('src/preload/plugins/playButton.ts');
    const plogNew = read('src/preload/core/logger.ts');
    const plogOld = head('src/preload/core/logger.ts');
    const mhNew = read('src/main/handlers/plugins/logger.ts');
    const mhOld = head('src/main/handlers/plugins/logger.ts');
    const mlogNew = read('src/modules/logger/logger.ts');
    const mlogOld = head('src/modules/logger/logger.ts');

    const sections = [];

    const pb = [];
    for (const r of await verifyPlayButton(playNew, '新版')) pb.push({ ...r, expectPass: true });
    for (const r of await verifyPlayButton(playOld, '旧版')) pb.push({ ...r, expectPass: r.oldMayPass === true });
    { // 旧版差异敏感性专项：旧版 OnDomChange 无防抖 → 30次变动立发30次注入
        const env = makePlayButtonEnv();
        env.state.buttons = [makeBtn('播放')];
        const { hooks, counters } = loadPlayButton(playOld, env);
        for (let i = 0; i < 30; i++) hooks.onDomChange[0]();
        await settle();
        pb.push({ name: '旧版: OnDomChange 无防抖·敏感性指标(应=30)', pass: counters.configCalls === 30, expectPass: true, detail: `旧版立即注入=${counters.configCalls}次` });
    }
    sections.push(['playButton 轮询退避+防抖+textContent', pb]);

    const pl = [];
    for (const r of await verifyPreloadLogger(plogNew, '新版')) pl.push({ ...r, expectPass: true });
    {
        // 旧版敏感性：info 立即走单条 IPC（新版要求窗口内 0 次 → 旧版必 fail 4a）
        const env = makeLoggerEnv(false);
        const logger = runInSandbox(transpile(plogOld, 'logger.ts'), env.sandbox, 'logger.ts').default;
        logger.info('x', 1);
        const immediate = env.invocations.length;
        pl.push({ name: '旧版: info 立即单发·敏感性指标(应=1)', pass: immediate === 1, expectPass: true, detail: `旧版立即IPC=${immediate}` });
    }
    sections.push(['preload logger 批量合流', pl]);

    sections.push(['主进程批量通道', [
        ...verifyMainHandler(mhNew, '新版').map(r => ({ ...r, expectPass: true })),
        ...verifyMainHandler(mhOld, '旧版').map(r => ({ ...r, expectPass: r.oldMayPass === true })),
    ]]);

    sections.push(['主进程 Logger 整批单次落盘', [
        ...verifyMainLoggerCoalesce(mlogNew, '新版').map(r => ({ ...r, expectPass: true })),
        ...verifyMainLoggerCoalesce(mlogOld, '旧版').map(r => ({ ...r, expectPass: r.oldMayPass === true })),
    ]]);

    let failed = 0;
    for (const [title, rows] of sections) {
        console.log(`\n== ${title} ==`);
        for (const r of rows) {
            const ok = r.pass === r.expectPass; // 结果须符合预期(新版pass/旧版fail/护栏行oldMayPass)
            if (!ok) failed++;
            const verdict = r.pass === r.expectPass ? (r.pass ? 'PASS' : 'FAIL(旧·符合预期)') : '异常';
            console.log(`  [${ok ? 'OK ' : 'NG '}] ${verdict} | ${r.name}${r.detail ? '  —— ' + r.detail : ''}`);
        }
    }
    console.log(`\n${failed === 0 ? '全部通过：新版 PASS + 旧版 FAIL（双向验证成立）' : `有 ${failed} 项不符合预期`}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
