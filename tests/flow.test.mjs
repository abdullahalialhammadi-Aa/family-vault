// اختبار شامل لبوابة التحقّق الثلاثية داخل متصفّح Chrome حقيقي.
// يغطّي: الحساب، رمز TOTP، بصمة الجهاز، الموافقة، بوابة الوجه، العنصر الحي،
// السجل، حذف الواصف، وحماية الصفحة الداخلية.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, createChecker, sleep } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', '.fixtures');

/* ---------- صور اختبار تُنزَّل عند التشغيل ولا تُحفظ في المستودع ---------- */
const FIXTURE_BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/examples/images/';
const FIXTURES = { 'amy1.png': 'amy/amy1.png', 'amy2.png': 'amy/amy2.png', 'howard1.png': 'howard/howard1.png' };

async function ensureFixtures() {
  fs.mkdirSync(fixtures, { recursive: true });
  for (const [local, remote] of Object.entries(FIXTURES)) {
    const dest = path.join(fixtures, local);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(FIXTURE_BASE + remote);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        ok = fs.statSync(dest).size > 1000;
      } catch (e) {
        await sleep(1500);
      }
    }
    if (!ok) throw new Error('تعذّر تنزيل صورة الاختبار ' + local);
  }
}

await ensureFixtures();

const server = await startServer([root, fixtures]);
// مهلة واسعة: تحميل نموذج الوجه على معالج خادم التكامل المستمر أبطأ بكثير من الجهاز المحلي
const B = await launch(server.url + '/index.html', { fakeCamera: true, timeout: 600000 });
const t = createChecker();
const status = () => 'document.getElementById("status-msg").innerText';

try {
  /* ---------- 1) تحميل الصفحة ---------- */
  let r = await B.evaluate(`
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
  await B.evaluate(`
    window.canvasFrom = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    };
    await ensureFaceApi();
    return true;`);

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

  /* ---------- 13) حماية الصفحة الداخلية ---------- */
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
