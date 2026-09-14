// فحوص ثابتة سريعة على ملفّي الصفحة، بلا متصفّح ولا شبكة.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const index = read('index.html');
const vault = read('vault.html');
const t = createChecker();

/* ---------- الملفات التي يعتمد عليها الموقع موجودة ---------- */
for (const f of ['index.html', 'vault.html', 'model.json', 'metadata.json', 'weights.bin']) {
  t.check('الملف موجود: ' + f, fs.existsSync(path.join(root, f)), true);
}

const meta = JSON.parse(read('metadata.json'));
t.check('فئات النموذج هي MOUSE و COFFEE', meta.labels.slice().sort(), ['COFFEE', 'MOUSE']);

/* ---------- عوامل التحقّق الثلاثة موجودة في الكود ---------- */
const required = {
  'دالة تهيئة TOTP': 'function totp_setup()',
  'دالة تأكيد تهيئة TOTP': 'function totp_setup_confirm()',
  'دالة التحقّق من TOTP': 'async function totp_verify()',
  'تسجيل بصمة الجهاز': 'async function webauthn_register()',
  'التحقّق من بصمة الجهاز': 'async function webauthn_verify()',
  'استخراج واصف الوجه': 'async function faceDescriptorOf(',
  'حذف الواصف نهائياً': 'function deleteDescriptor(',
  'سجل المحاولات': 'function addLog(',
  'شاشة الموافقة': 'function giveConsent()',
  'رفض الموافقة': 'function refuseConsent()',
  'تخطّي الخطوات': 'function skipStep(',
  'إعداد تفعيل التخطّي': 'const ALLOW_SKIP'
};

/* ---------- زر تخطٍّ لكل خطوة ---------- */
const skipTargets = ['totp', 'webauthn', 'consent', 'face', 'scan'];
for (const key of skipTargets) {
  t.check('زر تخطّي لخطوة ' + key, index.includes("skipStep('" + key + "')"), true);
}
t.check('عدد أزرار التخطّي', (index.match(/class="btn-skip skip-control"/g) || []).length, 5);
for (const [name, needle] of Object.entries(required)) {
  t.check(name, index.includes(needle), true);
}

/* ---------- المكتبات الخارجية مثبّتة الإصدار ---------- */
const pinned = index.match(/https:\/\/cdn\.jsdelivr\.net\/[^"']+|https:\/\/cdnjs\.cloudflare\.com\/[^"']+/g) || [];
t.check('توجد مكتبات خارجية', pinned.length > 0, true);
const unpinned = pinned.filter(u => !/@\d+\.\d+\.\d+|\/\d+\.\d+\.\d+\//.test(u));
t.check('كل المكتبات مثبّتة على إصدار محدّد', unpinned, []);

/* ---------- ضوابط الأمان والخصوصية ---------- */
t.check('التحقّق من سياق آمن قبل البصمة', index.includes('window.isSecureContext'), true);
t.check('فحص علم تحقّق المستخدم في WebAuthn', index.includes('0x04'), true);
t.check('فحص تطابق نطاق الموقع', index.includes('rpIdHash') || index.includes('expectedHash'), true);
t.check('طلب تحقّق المستخدم إلزامياً', index.includes('userVerification: "required"'), true);
t.check('لا تُحفظ صورة الوجه', !/faceImage|facePhoto|toDataURL\(\)\s*\)?\s*;?\s*setSecurity/.test(index), true);
t.check('الواصف يُحفظ كأرقام فقط', index.includes('faceDescriptor'), true);

/* ---------- الصفحة الداخلية محميّة ---------- */
t.check('الصفحة الداخلية تفحص ختم الجلسة', vault.includes("sessionStorage.getItem('fv_verified')"), true);
t.check('الصفحة الداخلية تحوّل عند غياب التحقّق', vault.includes("location.replace('index.html')"), true);

/* ---------- نظافة الكود ---------- */
t.check('لا يوجد debugger متروك', !/\bdebugger\b/.test(index + vault), true);
t.check('لا يوجد alert متروك', !/\balert\(/.test(index + vault), true);
t.check('لا توجد روابط http غير آمنة', !/["']http:\/\/(?!localhost|127\.)/.test(index + vault), true);

/* ---------- سلامة أساسية للبنية ---------- */
for (const [name, src] of [['index.html', index], ['vault.html', vault]]) {
  t.check(name + ': وسم html مفتوح ومغلق', /<html[\s>]/.test(src) && src.includes('</html>'), true);
  t.check(name + ': ترميز UTF-8 معلن', src.includes('charset="UTF-8"') || src.includes('charset=UTF-8'), true);
  t.check(name + ': اتجاه من اليمين لليسار', src.includes('dir="rtl"'), true);
  t.check(name + ': وسم viewport للهاتف', src.includes('name="viewport"'), true);
  const open = (src.match(/<script[\s>]/g) || []).length;
  const close = (src.match(/<\/script>/g) || []).length;
  t.check(name + ': وسوم script متوازنة', open === close, true);
}

process.exit(t.report() ? 1 : 0);
