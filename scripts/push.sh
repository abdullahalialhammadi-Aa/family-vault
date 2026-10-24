#!/bin/sh
# رفع مختصر: يفحص، يلتزم، يجلب، ثم يرفع.
# الاستخدام:  sh scripts/push.sh "وصف التعديل"

set -e

MSG="$1"
if [ -z "$MSG" ]; then
  echo "الاستخدام: sh scripts/push.sh \"وصف التعديل\""
  exit 1
fi

cd "$(dirname "$0")/.."

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "لا توجد تعديلات للرفع."
  exit 0
fi

echo "1/4  تشغيل الفحوص السريعة..."
npm run --silent test

echo "2/4  إنشاء الالتزام..."
# لا نضيف كل شيء بلا تمييز: فقط تعديلات الملفات المتتبَّعة أصلاً،
# ثم المسارات المعروفة للمشروع إن وُجدت فيها ملفات جديدة.
git add -u
KNOWN_PATHS="index.html vault.html README.md package.json model.json metadata.json weights.bin .htaccess .gitignore tests scripts .githooks .github"
for p in $KNOWN_PATHS; do
  [ -e "$p" ] && git add -- "$p"
done

# أي ملف جديد خارج المسارات المعروفة لا يُرفع تلقائياً: نعرضه ونتوقف
UNKNOWN="$(git ls-files --others --exclude-standard)"
if [ -n "$UNKNOWN" ]; then
  echo ""
  echo "توجد ملفات جديدة غير مضافة (خارج المسارات المعروفة):"
  echo "$UNKNOWN" | sed 's/^/   /'
  echo "راجعها: أضف المطلوب منها يدوياً بـ git add <الملف> أو احذفه، ثم أعد التشغيل."
  git reset -q
  exit 1
fi

echo "الملفات التي ستُرفع:"
git diff --cached --name-status | sed 's/^/   /'
if git diff --cached --quiet; then
  echo "لا توجد تعديلات للرفع."
  exit 0
fi
git commit -q -m "$MSG"

echo "3/4  جلب آخر تحديثات من GitHub..."
git pull --rebase --quiet

echo "4/4  الرفع..."
git push --quiet

echo ""
echo "تم. صفحات GitHub تنشر التحديث خلال دقيقة تقريباً:"
echo "https://abdullahalialhammadi-aa.github.io/family-vault/"
