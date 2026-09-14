// اختبار شامل لبوابة التحقّق الثلاثية داخل متصفّح Chrome حقيقي.
// يغطّي: الحساب، رمز TOTP، بصمة الجهاز، الموافقة، بوابة الوجه، العنصر الحي،
// السجل، حذف الواصف، وحماية الصفحة الداخلية.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, createChecker, sleep } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', '.fixtures');

/* ---------- ملفات اختبار تُنزَّل مرة واحدة ولا تُحفظ في المستودع ----------
   نقدّم مكتبة التعرّف ونموذجها محلياً أثناء الاختبار بدل شبكة توصيل المحتوى،
   لأن خوادم التكامل المستمر قد لا تصل إليها فيتعلّق التحميل. الصفحة نفسها
   تبقى تستخدم الشبكة كما هي في الإنتاج، والاختبار يعيد توجيه طلباتها فقط. */
const IMG_BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/examples/images/';
const FACE_LIB = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_BASE = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';

const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'face_landmark_68_tiny_model-weights_manifest.json',
  'face_landmark_68_tiny_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2'
];

const modelDir = path.join(fixtures, 'facemodel');

async function download(url, dest, minSize) {
  if (fs.existsSync(dest) && fs.statSync(dest).size >= (minSize || 1000)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      if (fs.statSync(dest).size >= (minSize || 1000)) return;
      lastErr = 'الملف أصغر من المتوقّع';
    } catch (e) {
      lastErr = e.message;
      await sleep(1500);
    }
  }
  throw new Error('تعذّر تنزيل ' + url + ' (' + lastErr + ')');
}

async function ensureFixtures() {
  fs.mkdirSync(fixtures, { recursive: true });
  for (const [local, remote] of Object.entries(
    { 'amy1.png': 'amy/amy1.png', 'amy2.png': 'amy/amy2.png', 'howard1.png': 'howard/howard1.png' }
  )) {
    await download(IMG_BASE + remote, path.join(fixtures, local));
  }
  await download(FACE_LIB, path.join(modelDir, 'face-api.min.js'), 100000);
  for (const f of MODEL_FILES) {
    await download(MODEL_BASE + '/' + f, path.join(modelDir, f), 100);
  }
}

console.log('تجهيز ملفات الاختبار...');
await ensureFixtures();

const server = await startServer([root, fixtures]);
// مهلة واسعة: تحميل نموذج الوجه على معالج خادم التكامل المستمر أبطأ بكثير من الجهاز المحلي
const B = await launch(server.url + '/index.html', { fakeCamera: true, timeout: 600000 });
const t = createChecker();
const status = () => 'document.getElementById("status-msg").innerText';

try {
  /* ---------- 0) تحضير مكتبة التعرّف محلياً ----------
     يجب أن يتم قبل أي خطوة تستدعي بوابة الوجه، لأن الصفحة تبدأ تحميل المكتبة
     بمجرّد الموافقة على الكاميرا. لو حُقنت النسخة المحلية بعد ذلك لتحمّلت
     المكتبة مرتين فتنشأ نسخة ثانية بنماذج فارغة ويتعلّق التحليل. */
  let r = await B.evaluate(`
    if (typeof faceapi !== 'undefined') return { already: true };

    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf(FACE_MODEL_URL) === 0) {
        return origFetch('/facemodel' + url.slice(FACE_MODEL_URL.length), init);
      }
      return origFetch(input, init);
    };

    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/facemodel/face-api.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('تعذّر تحميل مكتبة التعرّف محلياً'));
      document.head.appendChild(s);
    });
    return { already: false, loaded: typeof faceapi !== 'undefined' };`);
  t.check('تحضير مكتبة التعرّف محلياً', r.already || r.loaded, true);

  /* ---------- 1) تحميل الصفحة ---------- */
  r = await B.evaluate(`
    window.confirm = () => true;
    localStorage.clear(); sessionStorage.clear();
    return {
      dots: document.querySelectorAll('.step-dot').length,
      authVisible: !document.getElementById('step-auth').hidden,
      secure: window.isSecureContext,
      bannerHidden: document.getElementById('insecure-banner').hidden
    };`);
  t.check('مؤشّر الخطوات يعرض خمس خطوات', r.dots, 5);
  t.check('خطوة الحساب تظهر أولاً', r.authVisible, true);
  t.check('السياق آمن', r.secure, true);
  t.check('لا يظهر تحذير HTTPS', r.bannerHidden, true);

  /* ---------- 2) إنشاء حساب ---------- */
  r = await B.evaluate(`
    switchAuthMode('register');
    const set = (id, v) => document.getElementById(id).value = v;
    const out = {};
    set('reg-username','ab'); set('reg-password','1234'); set('reg-confirm','1234');
    await register(); out.shortUser = ${status()};
    set('reg-username','tester'); set('reg-password','12'); set('reg-confirm','12');
    await register(); out.shortPass = ${status()};
    set('reg-username','tester'); set('reg-password','pass1234'); set('reg-confirm','nope');
    await register(); out.mismatch = ${status()};
    set('reg-username','Admin'); set('reg-password','pass1234'); set('reg-confirm','pass1234');
    await register(); out.duplicate = ${status()};
    set('reg-username','tester'); set('reg-password','pass1234'); set('reg-confirm','pass1234');
    await register(); out.success = ${status()};
    const stored = JSON.parse(localStorage.getItem('fv_accounts') || '{}').tester || {};
    out.hashed = String(stored.hash || '').startsWith('sha256:');
    out.plaintextAbsent = JSON.stringify(stored).indexOf('pass1234') === -1;
    out.prefilled = document.getElementById('username').value;
    return out;`);
  t.check('رفض اسم مستخدم قصير', /3 أحرف/.test(r.shortUser), true);
  t.check('رفض كلمة مرور قصيرة', /4 أحرف/.test(r.shortPass), true);
  t.check('رفض عدم تطابق كلمتي المرور', /غير متطابقتين/.test(r.mismatch), true);
  t.check('رفض اسم مستخدم مكرر', /مستخدم مسبقاً/.test(r.duplicate), true);
  t.check('نجاح إنشاء الحساب', /تم إنشاء الحساب بنجاح/.test(r.success), true);
  t.check('كلمة المرور مخزّنة مشفّرة', r.hashed, true);
  t.check('كلمة المرور الأصلية غير مخزّنة', r.plaintextAbsent, true);
  t.check('اسم المستخدم معبّأ تلقائياً', r.prefilled, 'tester');

  /* ---------- 3) تسجيل الدخول ---------- */
  r = await B.evaluate(`
    const out = {};
    document.getElementById('username').value = 'tester';
    document.getElementById('password').value = 'wrong';
    await login(); out.wrong = ${status()}; out.stepAfterWrong = currentStep;
    document.getElementById('username').value = 'tester';
    document.getElementById('password').value = 'pass1234';
    await login();
    await new Promise(r => setTimeout(r, 300));
    out.step = currentStep;
    out.setupVisible = !document.getElementById('totp-setup').hidden;
    out.secret = document.getElementById('totp-secret-text').textContent;
    out.qrDrawn = document.querySelectorAll('#qrcode img, #qrcode canvas').length;
    return out;`);
  t.check('رفض كلمة مرور خاطئة', /غير صحيحة/.test(r.wrong), true);
  t.check('البقاء في خطوة الحساب بعد الفشل', r.stepAfterWrong, 'auth');
  t.check('الانتقال لخطوة TOTP', r.step, 'totp');
  t.check('ظهور شاشة تهيئة TOTP', r.setupVisible, true);
  t.check('توليد مفتاح بطول 32', r.secret.length, 32);
  t.check('رسم رمز QR', r.qrDrawn > 0, true);

  /* ---------- 4) تهيئة TOTP والتحقّق منه ---------- */
  r = await B.evaluate(`
    const out = {};
    const secret = document.getElementById('totp-secret-text').textContent;
    document.getElementById('totp-setup-code').value = '000000';
    await totp_setup_confirm();
    out.wrongCode = ${status()};
    out.notActivatedYet = !getSecurity(currentUser).totpSecret;
    document.getElementById('totp-setup-code').value = await totpCode(secret);
    await totp_setup_confirm();
    await new Promise(r => setTimeout(r, 600));
    out.activated = !!getSecurity(currentUser).totpSecret;
    out.pendingCleared = !getSecurity(currentUser).totpPending;
    out.step = currentStep;
    return out;`);
  t.check('رفض رمز تهيئة خاطئ', /غير صحيح/.test(r.wrongCode), true);
  t.check('عدم تفعيل المفتاح قبل التأكيد', r.notActivatedYet, true);
  t.check('تفعيل TOTP بعد رمز صحيح', r.activated, true);
  t.check('مسح المفتاح المؤقّت بعد التفعيل', r.pendingCleared, true);
  t.check('الانتقال لخطوة بصمة الجهاز', r.step, 'webauthn');

  /* ---------- 5) بصمة الجهاز بلا مستشعر ---------- */
  r = await B.evaluate(`
    return {
      unsupportedShown: !document.getElementById('wa-unsupported').hidden,
      registerHidden: document.getElementById('wa-register').hidden
    };`);
  t.check('رسالة عدم الدعم تظهر بلا مستشعر', r.unsupportedShown, true);
  t.check('زر التسجيل مخفي بلا مستشعر', r.registerHidden, true);

  /* ---------- 6) بصمة الجهاز مع مستشعر افتراضي ---------- */
  await B.send('WebAuthn.enable', { enableUI: false });
  await B.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true
    }
  });

  r = await B.evaluate(`
    await startWebauthn();
    await new Promise(r => setTimeout(r, 300));
    const out = { registerShown: !document.getElementById('wa-register').hidden };
    await webauthn_register();
    out.factor = factorResults.webauthn || null;
    await new Promise(r => setTimeout(r, 600));
    const sec = getSecurity(currentUser);
    out.storedId = sec.webauthnId || null;
    out.noPrivateKeyStored = JSON.stringify(sec).indexOf('privateKey') === -1;
    out.step = currentStep;
    return out;`);
  t.check('ظهور زر التسجيل مع وجود مستشعر', r.registerShown, true);
  t.check('نجاح تسجيل بصمة الجهاز', r.factor, 'تم تسجيل بصمة هذا الجهاز');
  t.check('حفظ معرّف المفتاح فقط', typeof r.storedId === 'string' && r.storedId.length > 10, true);
  t.check('لا يُحفظ أي مفتاح خاص', r.noPrivateKeyStored, true);
  t.check('الانتقال لشاشة الموافقة', r.step, 'consent');
  const realId = r.storedId;

  r = await B.evaluate(`
    showStep('webauthn');
    document.getElementById('wa-register').hidden = true;
    document.getElementById('wa-verify').hidden = false;
    factorResults.webauthn = null;
    await webauthn_verify();
    const factor = factorResults.webauthn;
    const log = readLog()[0] || {};
    await new Promise(r => setTimeout(r, 600));
    return { factor, log };`);
  t.check('نجاح التحقّق ببصمة مسجّلة', r.factor, 'بصمة الجهاز مطابقة');
  t.check('اجتياز فحص المفتاح والأعلام', /تطابق المفتاح \+ تحقق المستخدم/.test(r.log.msg || ''), true);

  r = await B.evaluate(`
    const fake = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    setSecurity(currentUser, { webauthnId: fake });
    showStep('webauthn');
    document.getElementById('wa-verify').hidden = false;
    factorResults.webauthn = null;
    await webauthn_verify();
    await new Promise(r => setTimeout(r, 600));
    const out = { step: currentStep, factor: factorResults.webauthn, failed: !readLog()[0].ok };
    setSecurity(currentUser, { webauthnId: ${JSON.stringify(realId)} });
    return out;`);
  t.check('رفض بصمة غير مسجّلة لهذا الحساب', r.factor, null);
  t.check('عدم تجاوز الخطوة عند الرفض', r.step, 'webauthn');
  t.check('تسجيل الرفض في السجل', r.failed, true);

  /* ---------- 7) شاشة الموافقة ---------- */
  r = await B.evaluate(`
    startConsent();
    const out = { disabledBefore: document.getElementById('consent-btn').disabled };
    document.getElementById('consent-check').checked = true; onConsentToggle();
    out.enabledAfter = !document.getElementById('consent-btn').disabled;
    refuseConsent();
    out.stepAfterRefuse = currentStep;
    out.userAfterRefuse = currentUser;
    return out;`);
  t.check('زر الموافقة معطّل قبل التأشير', r.disabledBefore, true);
  t.check('تفعيل الزر بعد التأشير', r.enabledAfter, true);
  t.check('الرفض يعيد لشاشة الدخول', r.stepAfterRefuse, 'auth');
  t.check('الرفض يمسح جلسة المستخدم', r.userAfterRefuse, '');

  r = await B.evaluate(`
    document.getElementById('username').value = 'tester';
    document.getElementById('password').value = 'pass1234';
    await login();
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('totp-code').value = await totpCode(getSecurity('tester').totpSecret);
    await totp_verify();
    await new Promise(r => setTimeout(r, 400));
    const afterTotp = currentStep;
    await webauthn_verify();
    await new Promise(r => setTimeout(r, 800));
    const afterWa = currentStep;
    document.getElementById('consent-check').checked = true; onConsentToggle();
    giveConsent();
    await new Promise(r => setTimeout(r, 500));
    return { afterTotp, afterWa, step: currentStep, consentAt: !!getSecurity('tester').consentAt };`);
  t.check('تحقّق TOTP في الدخول الثاني', r.afterTotp, 'webauthn');
  t.check('تحقّق البصمة في الدخول الثاني', r.afterWa, 'consent');
  t.check('الموافقة تنقل لبوابة الوجه', r.step, 'face');
  t.check('تسجيل وقت الموافقة', r.consentAt, true);

  /* ---------- 8) بوابة الوجه ---------- */
  r = await B.evaluate(`
    window.canvasFrom = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    };
    const t = performance.now();
    await ensureFaceApi();
    return {
      libLoaded: typeof faceapi !== 'undefined',
      backend: faceapi.tf.getBackend(),
      ms: Math.round(performance.now() - t)
    };`);
  t.check('جاهزية نموذج التعرّف على الوجه', r.libLoaded, true);
  t.note('محرّك الحساب: ' + r.backend + ' — زمن تجهيز النموذج: ' + r.ms + 'ms');

  r = await B.evaluate(`
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const x = c.getContext('2d'); x.fillStyle = '#6b4a2b'; x.fillRect(0, 0, 320, 240);
    await processFace(c);
    return { status: ${status()}, step: currentStep };`);
  t.check('رفض لقطة بلا وجه', /لم نتعرّف على وجه واضح/.test(r.status), true);
  t.check('البقاء في خطوة الوجه', r.step, 'face');

  r = await B.evaluate(`
    factorResults.face = null;
    await processFace(await canvasFrom('/amy1.png'));
    const factor = factorResults.face;
    const logMsg = (readLog()[0] || {}).msg || '';
    await new Promise(r => setTimeout(r, 600));
    const sec = getSecurity('tester');
    return {
      factor, logMsg,
      len: Array.isArray(sec.faceDescriptor) ? sec.faceDescriptor.length : 0,
      allNumbers: (sec.faceDescriptor || []).every(n => typeof n === 'number'),
      noImage: JSON.stringify(sec).indexOf('data:image') === -1,
      step: currentStep
    };`);
  t.check('تسجيل واصف الوجه', r.factor, 'تم تسجيل واصف الوجه');
  t.check('طول الواصف 128 رقماً', r.len, 128);
  t.check('الواصف أرقام فقط', r.allNumbers, true);
  t.check('لم تُحفظ أي صورة', r.noImage, true);
  t.check('الانتقال لخطوة العنصر الحي', r.step, 'scan');
  t.note('سجل التسجيل: ' + r.logMsg);

  r = await B.evaluate(`
    showStep('face');
    factorResults.face = null;
    await processFace(await canvasFrom('/amy2.png'));
    const factor = factorResults.face;
    const logMsg = (readLog()[0] || {}).msg || '';
    await new Promise(r => setTimeout(r, 600));
    return { factor, logMsg, step: currentStep };`);
  t.check('قبول نفس الشخص من صورة مختلفة', /^وجه مطابق/.test(r.factor || ''), true);
  t.check('تجاوز البوابة بعد المطابقة', r.step, 'scan');
  t.note('نتيجة المطابقة: ' + r.logMsg);

  r = await B.evaluate(`
    showStep('face');
    factorResults.face = null;
    await processFace(await canvasFrom('/howard1.png'));
    const logMsg = (readLog()[0] || {}).msg || '';
    await new Promise(r => setTimeout(r, 600));
    return { factor: factorResults.face, logMsg, step: currentStep };`);
  t.check('رفض شخص مختلف', r.factor, null);
  t.check('عدم تجاوز البوابة عند الرفض', r.step, 'face');
  t.note('نتيجة الرفض: ' + r.logMsg);

  // بعد الرفض نعيد التحقّق بنجاح حتى تكون الحالة النهائية مطابقة لما يصل إليه مستخدم حقيقي
  r = await B.evaluate(`
    showStep('face');
    factorResults.face = null;
    await processFace(await canvasFrom('/amy2.png'));
    await new Promise(r => setTimeout(r, 600));
    return { factor: factorResults.face, step: currentStep };`);
  t.check('التحقّق ينجح بعد محاولة مرفوضة', /^وجه مطابق/.test(r.factor || ''), true);
  t.check('العودة لخطوة العنصر الحي', r.step, 'scan');

  /* ---------- 9) العنصر الحي ---------- */
  r = await B.evaluate(`
    startScan();
    await new Promise(r => setTimeout(r, 1500));
    const out = {
      cameraOpened: !!videoStream,
      btnEnabled: !document.getElementById('capture-btn').disabled
    };
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const x = c.getContext('2d'); x.fillStyle = '#6b4a2b'; x.fillRect(0, 0, 320, 240);
    await verifyImage(c);
    await new Promise(r => setTimeout(r, 600));
    out.step = currentStep;
    out.cameraStopped = !videoStream;
    out.factor = factorResults.scan;
    return out;`);
  t.check('فتح الكاميرا في خطوة العنصر', r.cameraOpened, true);
  t.check('تفعيل زر الالتقاط', r.btnEnabled, true);
  t.check('اكتمال التحقّق والانتقال للنجاح', r.step, 'done');
  t.check('إيقاف الكاميرا بعد النجاح', r.cameraStopped, true);
  t.note('نتيجة العنصر الحي: ' + r.factor);

  /* ---------- 10) شاشة النجاح ---------- */
  r = await B.evaluate(`
    return {
      items: document.querySelectorAll('#factors-summary li').length,
      verified: sessionStorage.getItem('fv_verified'),
      user: sessionStorage.getItem('fv_user'),
      continueVisible: !!document.getElementById('continue-btn').offsetParent
    };`);
  t.check('ملخّص العوامل يعرض ستة عناصر', r.items, 6);
  t.check('ختم الجلسة بعد التحقّق', r.verified, '1');
  t.check('حفظ اسم المستخدم للجلسة', r.user, 'tester');
  t.check('ظهور زر المتابعة', r.continueVisible, true);

  /* ---------- 11) السجل ---------- */
  r = await B.evaluate(`
    openLog();
    const log = readLog();
    return {
      modalOpen: !document.getElementById('log-modal').hidden,
      rendered: document.querySelectorAll('#log-list .log-item').length,
      total: log.length,
      hasFailures: log.some(e => !e.ok),
      hasSuccess: log.some(e => e.ok),
      newestFirst: log.length > 1 ? log[0].t >= log[1].t : true,
      capped: log.length <= 50
    };`);
  t.check('فتح نافذة السجل', r.modalOpen, true);
  t.check('السجل يعرض محاولات', r.rendered > 0, true);
  t.check('السجل يسجّل النجاح والفشل', r.hasFailures && r.hasSuccess, true);
  t.check('الأحدث أولاً', r.newestFirst, true);
  t.check('السجل لا يتجاوز الحد', r.capped, true);
  t.note('عدد السجلات: ' + r.total);

  /* ---------- 12) حذف الواصف نهائياً ---------- */
  r = await B.evaluate(`
    closeModal('log-modal');
    openPrivacy();
    const before = !!getSecurity('tester').faceDescriptor;
    deleteDescriptor('tester');
    const sec = getSecurity('tester');
    return {
      before,
      after: !!sec.faceDescriptor,
      goneFromStorage: (localStorage.getItem('fv_security') || '').indexOf('faceDescriptor') === -1,
      othersKept: !!sec.totpSecret && !!sec.webauthnId,
      logged: readLog().some(e => e.step === 'privacy' && /حذف واصف الوجه/.test(e.msg))
    };`);
  t.check('الواصف موجود قبل الحذف', r.before, true);
  t.check('الواصف محذوف بعد الضغط', r.after, false);
  t.check('اختفاؤه من التخزين الخام', r.goneFromStorage, true);
  t.check('بقاء العوامل الأخرى سليمة', r.othersKept, true);
  t.check('تسجيل الحذف في السجل', r.logged, true);

  r = await B.evaluate(`
    closeModal('privacy-modal');
    showStep('face');
    factorResults.face = null;
    await processFace(await canvasFrom('/amy1.png'));
    await new Promise(r => setTimeout(r, 600));
    return { factor: factorResults.face, len: (getSecurity('tester').faceDescriptor || []).length };`);
  t.check('إعادة التسجيل بعد الحذف', r.factor, 'تم تسجيل واصف الوجه');
  t.check('طول الواصف الجديد 128', r.len, 128);

  /* ---------- 13) تخطّي الخطوات ---------- */
  r = await B.evaluate(`
    logout === undefined;
    stopCamera();
    doneSteps = []; skippedSteps = []; factorResults = {};
    showStep('auth');
    document.getElementById('username').value = 'tester';
    document.getElementById('password').value = 'pass1234';
    await login();
    await new Promise(r => setTimeout(r, 300));
    const out = { afterLogin: currentStep };

    skipStep('totp');
    await new Promise(r => setTimeout(r, 400));
    out.afterTotpSkip = currentStep;

    skipStep('webauthn');
    await new Promise(r => setTimeout(r, 400));
    out.afterWaSkip = currentStep;

    out.skippedSoFar = skippedSteps.slice();
    out.dotsSkipped = document.querySelectorAll('.step-dot.skipped').length;
    return out;`);
  t.check('الدخول يبدأ من خطوة TOTP', r.afterLogin, 'totp');
  t.check('تخطّي TOTP ينقل لبصمة الجهاز', r.afterTotpSkip, 'webauthn');
  t.check('تخطّي البصمة ينقل للموافقة', r.afterWaSkip, 'consent');
  t.check('تسجيل الخطوات المتخطّاة', r.skippedSoFar, ['totp', 'webauthn']);
  t.check('المؤشّر يميّز الخطوات المتخطّاة', r.dotsSkipped, 2);

  r = await B.evaluate(`
    skipStep('consent');
    await new Promise(r => setTimeout(r, 500));
    return {
      step: currentStep,
      skipped: skippedSteps.slice(),
      cameraOff: !videoStream,
      items: document.querySelectorAll('#factors-summary li').length,
      warned: /تم تخطّي/.test(document.getElementById('factors-summary').innerText),
      boxClass: document.getElementById('factors-summary').className,
      status: ${status()},
      verified: sessionStorage.getItem('fv_verified')
    };`);
  t.check('تخطّي الموافقة ينهي العملية مباشرة', r.step, 'done');
  t.check('تخطّي الموافقة يتخطّى الوجه والعنصر معاً', r.skipped.sort(), ['consent', 'face', 'scan', 'totp', 'webauthn']);
  t.check('عدم تشغيل الكاميرا بعد تخطّي الموافقة', r.cameraOff, true);
  t.check('الملخّص يعرض كل العوامل', r.items, 6);
  t.check('الملخّص يحذّر من التخطّي', r.warned, true);
  t.check('الملخّص يأخذ شكل التحذير', /warn/.test(r.boxClass), true);
  t.check('رسالة الحالة تنبّه للتخطّي', /تخطّي بعض العوامل/.test(r.status), true);

  r = await B.evaluate(`
    const log = readLog();
    return {
      skipLogged: log.filter(e => /تخطّى المستخدم|تخطٍّ تلقائي/.test(e.msg)).length,
      allMarkedFail: log.filter(e => /تخطّى المستخدم|تخطٍّ تلقائي/.test(e.msg)).every(e => e.ok === false)
    };`);
  t.check('السجل يوثّق كل تخطٍّ', r.skipLogged >= 5, true);
  t.check('التخطّي يُسجَّل كعدم اجتياز', r.allMarkedFail, true);

  /* ---------- 14) حماية الصفحة الداخلية ---------- */
  await B.goto(server.url + '/vault.html');
  r = await B.evaluate(`
    return { path: location.pathname, welcome: (document.getElementById('welcomeUser') || {}).innerText || null };`);
  t.check('الصفحة الداخلية تفتح بعد التحقّق', r.path, '/vault.html');
  t.check('عرض اسم المستخدم', r.welcome, 'مرحباً tester');

  await B.evaluate(`sessionStorage.clear(); location.replace('vault.html'); return true;`);
  await sleep(1500);
  r = await B.evaluate(`return { path: location.pathname, hasLogin: !!document.getElementById('login-form') };`);
  t.check('منع فتح الصفحة الداخلية بلا تحقّق', r.path, '/index.html');
  t.check('التحويل لصفحة الدخول', r.hasLogin, true);

} catch (err) {
  t.crash(err.message);
} finally {
  await B.close();
  await server.close();
  process.exit(t.report() ? 1 : 0);
}
