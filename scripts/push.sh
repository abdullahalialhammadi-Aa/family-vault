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
git add -A
git commit -q -m "$MSG"

echo "3/4  جلب آخر تحديثات من GitHub..."
git pull --rebase --quiet

echo "4/4  الرفع..."
git push --quiet

echo ""
echo "تم. صفحات GitHub تنشر التحديث خلال دقيقة تقريباً:"
echo "https://abdullahalialhammadi-aa.github.io/family-vault/"
