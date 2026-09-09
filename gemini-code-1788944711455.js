const metadata = {
  "tfjsVersion": "1.7.4",
  "tmVersion": "2.4.16",
  "packageVersion": "0.8.4-alpha2",
  "packageName": "@teachablemachine/image",
  "timeStamp": "2026-09-09T06:05:39.376Z",
  "userMetadata": {},
  "modelName": "tm-my-image-model",
  "labels": ["MOUSE", "COFFEE"],
  "imageSize": 224
};

// تحميل النموذج مع البيانات الوصفية المدمجة
const model = await tmImage.load('./model_2.json', metadata);