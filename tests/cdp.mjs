// أداة تشغيل متصفّح بلا واجهة عبر بروتوكول DevTools، مع خادم ملفات ثابت مدمج.
// بلا أي حزم خارجية: تعتمد على WebSocket المدمج في Node 22 فأحدث.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- إيجاد متصفّح Chrome على أي نظام ---------- */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const byPlatform = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ]
  };
  const candidates = byPlatform[process.platform] || [];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('لم يُعثر على متصفّح Chrome. حدّد مساره في المتغيّر CHROME_PATH');
}

/* ---------- خادم ملفات ثابت ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8'
};

// يقبل عدّة مجلّدات جذر: الأول يفوز عند التطابق
export function startServer(roots) {
  const dirs = Array.isArray(roots) ? roots : [roots];
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const safe = path.normalize(rel).replace(/^(\.\.[\\/])+/, '');
    for (const dir of dirs) {
      const file = path.join(dir, safe || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        // localhost وليس 127.0.0.1 لأن WebAuthn يرفض عناوين IP كنطاق
        url: 'http://localhost:' + port,
        // نقطع الاتصالات المفتوحة أولاً، وإلا انتظر الإغلاق إلى الأبد
        close: () => new Promise(r => {
          if (server.closeAllConnections) server.closeAllConnections();
          server.close(r);
          setTimeout(r, 3000);
        })
      });
    });
  });
}

/* ---------- تشغيل المتصفّح والتحكّم به ---------- */
async function fetchJson(url, tries) {
  for (let i = 0; i < (tries || 80); i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* المتصفّح لم يجهز بعد */ }
    await sleep(250);
  }
  throw new Error('تعذّر الاتصال بالمتصفّح على ' + url);
}

export async function launch(url, opts) {
  const options = opts || {};
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-test-'));
  const port = 9200 + Math.floor(Math.random() * 700);

  const args = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=440,950'
  ];
  if (process.platform === 'linux') args.push('--no-sandbox');
  if (options.fakeCamera) {
    args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
  }
  args.push(url);

  const proc = spawn(chrome, args, { stdio: 'ignore' });

  const targets = await fetchJson('http://127.0.0.1:' + port + '/json/list');
  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('لم يُعثر على صفحة في المتصفّح');
  // قد يفتح المتصفّح صفحة فارغة إضافية، فنفضّل الصفحة التي تحمل رابطنا
  const page = pages.find(t => t.url && t.url.startsWith(url)) || pages[0];

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
  });

  function send(method, params) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(msgId)) {
          pending.delete(msgId);
          reject(new Error('انتهت مهلة ' + method));
        }
      }, options.timeout || 240000);
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) {
      const e = res.exceptionDetails;
      const detail = (e.exception && e.exception.description) || e.text;
      throw new Error('خطأ في الصفحة: ' + detail);
    }
    return res.result.value;
  }

  async function waitReady() {
    for (let i = 0; i < 160; i++) {
      const state = await evaluate('return document.readyState');
      if (state === 'complete') return true;
      await sleep(250);
    }
    throw new Error('لم تكتمل الصفحة');
  }

  async function goto(target) {
    await send('Page.navigate', { url: target });
    await sleep(600);
    await waitReady();
  }

  async function screenshot(file, mobile) {
    if (mobile) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 400, height: 860, deviceScaleFactor: 2, mobile: true
      });
      await sleep(350);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    if (mobile) await send('Emulation.clearDeviceMetricsOverride');
    return file;
  }

  async function close() {
    try { ws.close(); } catch (e) {}
    // المتصفّح يفرّخ عمليات فرعية، وقتل العملية الأصل وحدها يتركها معلّقة
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch (e) { /* نكمل بالطريقة العادية */ }
    }
    try { proc.kill(); } catch (e) {}
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  // ننتقل للرابط صراحةً حتى لو اتصلنا بصفحة فارغة، فلا نعتمد على ترتيب الأهداف
  await goto(url);
  return { evaluate, goto, screenshot, close, send, sleep };
}

/* ---------- مساعد التأكيدات ---------- */
export function createChecker() {
  const lines = [];
  let pass = 0, fail = 0;
  return {
    check(name, got, want) {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      lines.push((ok ? 'PASS  ' : 'FAIL  ') + name +
        (ok ? '' : '\n        got=' + JSON.stringify(got) + '  want=' + JSON.stringify(want)));
      if (ok) pass++; else fail++;
      return ok;
    },
    note(text) { lines.push('      · ' + text); },
    crash(msg) { lines.push('CRASH ' + msg); fail++; },
    report() {
      console.log(lines.join('\n'));
      console.log('\n' + pass + ' passed, ' + fail + ' failed');
      return fail;
    }
  };
}
