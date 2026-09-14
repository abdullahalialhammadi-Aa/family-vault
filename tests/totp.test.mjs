// اختبار خوارزميات Base32 و TOTP المستخرجة من index.html نفسه،
// مقابل المتجهات المرجعية في المعيارين RFC 4648 و RFC 6238.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// نستخرج الكود المشحون فعلياً بدل إعادة كتابته، حتى يختبر ما يستخدمه المستخدم
const start = html.indexOf('const B32_ALPHABET');
const end = html.indexOf('أدوات Base64URL');
if (start < 0 || end < 0) {
  console.error('FAIL  تعذّر العثور على كتلة التشفير في index.html');
  process.exit(1);
}
let block = html.slice(start, end);
block = block.slice(0, block.lastIndexOf('/*'));

const prelude = 'const TOTP_PERIOD = 30, TOTP_DIGITS = 6, TOTP_WINDOW = 1;\n';
const exports = '\nexport { base32Encode, base32Decode, hotp, totpCode, totpCheck, randomBase32Secret };';
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(prelude + block + exports).toString('base64')
);

const { base32Encode, base32Decode, totpCode, totpCheck, randomBase32Secret } = mod;
const t = createChecker();
const enc = new TextEncoder();

/* ---------- Base32 مقابل RFC 4648 ---------- */
t.check('base32 لسلسلة المعيار', base32Encode(enc.encode('12345678901234567890')),
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
t.check('base32 "f"', base32Encode(enc.encode('f')), 'MY');
t.check('base32 "fo"', base32Encode(enc.encode('fo')), 'MZXQ');
t.check('base32 "foo"', base32Encode(enc.encode('foo')), 'MZXW6');
t.check('base32 "foobar"', base32Encode(enc.encode('foobar')), 'MZXW6YTBOI');
t.check('فك ثم ترميز يعيد الأصل',
  new TextDecoder().decode(base32Decode(base32Encode(enc.encode('Family Vault 123')))),
  'Family Vault 123');

let threw = false;
try { base32Decode('INVALID!!'); } catch (e) { threw = true; }
t.check('رفض مفتاح base32 غير صالح', threw, true);

/* ---------- TOTP مقابل RFC 6238 ---------- */
// المفتاح ASCII "12345678901234567890" بست خانات (آخر ستة أرقام من متجهات المعيار)
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const vectors = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130']
];
for (const [seconds, expected] of vectors) {
  t.check('TOTP عند الثانية ' + seconds, await totpCode(SECRET, seconds), expected);
}

/* ---------- سلوك التحقق ---------- */
const now = await totpCode(SECRET);
t.check('قبول الرمز الحالي', await totpCheck(SECRET, now), true);
t.check('قبول الرمز مع مسافات', await totpCheck(SECRET, ' ' + now + ' '), true);
t.check('رفض رمز خاطئ', await totpCheck(SECRET, '000001'), false);
t.check('رفض طول غير صحيح', await totpCheck(SECRET, '1234'), false);
t.check('رفض نص غير رقمي', await totpCheck(SECRET, 'abcdef'), false);

const nowSec = Date.now() / 1000;
t.check('قبول رمز الفترة السابقة', await totpCheck(SECRET, await totpCode(SECRET, nowSec - 30)), true);
t.check('رفض رمز عمره خمس دقائق', await totpCheck(SECRET, await totpCode(SECRET, nowSec - 300)), false);

/* ---------- المفتاح المولّد ---------- */
const generated = randomBase32Secret(20);
t.check('طول المفتاح المولّد', generated.length, 32);
t.check('المفتاح المولّد يستخدم أبجدية base32 فقط', /^[A-Z2-7]+$/.test(generated), true);
t.check('المفتاح المولّد يولّد رموزاً صالحة', await totpCheck(generated, await totpCode(generated)), true);
t.check('مفتاحان مولّدان مختلفان', randomBase32Secret(20) !== randomBase32Secret(20), true);

process.exit(t.report() ? 1 : 0);
