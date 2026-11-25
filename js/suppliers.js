/*
 * הגדרות ספקים. ספק חדש = אובייקט חדש ברשימה, בלי לשנות קוד אחר.
 *
 * name            – שם הספק כפי שיוצג בדוח
 * easySuppliers   – ביטויים בשם "חברת שוברים" באיזי. משמש רק כדי לשבץ בגיליון של הספק
 *                   שורות איזי שלא נמצאו (ההצלבה עצמה – לפי מספר שובר בלבד).
 * detect          – עמודות שחייבות להופיע בשורת הכותרות; כך מזהים שהקובץ/הטבלה של הספק הזה.
 *                   שם עמודה מתאים גם אם הכותרת מתחילה בו (למשל "קוד עסקה (שובר)").
 * columns         – מיפוי עמודות הספק לשדות שלנו.
 * hasPrice        – האם יש בדוח סכומים להשוואה.
 * easyKey         – "coupon" = מספר השובר באיזי כמו שהוא;
 *                   "coupon_drop_first_digit" = מספר השובר באיזי בלי הספרה הראשונה.
 * idFallback      – אם אין התאמה לפי מספר שובר – לנסות לפי ת"ז.
 * aggregateByKey  – הספק מדווח שורה לכל אדם: מאחדים שורות לפי מפתח וסוכמים כמויות.
 * zipPassword     – הקובץ יורד בזיפ מוגן סיסמה (הסיסמה מוזנת בהגדרות בדף, לא כאן).
 */
var SUPPLIERS = [
  {
    name: "תמורה – הסתדרות המורים",
    easySuppliers: ["הסתדרות המורים"],
    detect: ["מס' הזמנה", 'ת"ז', "כמות מימושים", "עלות"],
    columns: {
      voucher_id: "מס' הזמנה",
      id_number: 'ת"ז',
      package_name: "תאור ווריאנט",
      quantity: "כמות מימושים",
      final_price: "עלות",
      date: "תאריך מימוש",
      customer: "שם",
    },
    hasPrice: true,
    easyKey: "coupon",
    idFallback: true,
  },
  {
    name: "מולטי פס – דולצ'ה ויטה",
    easySuppliers: ["דולצ'ה ויטה"],
    detect: ["מספר כרטיס", "שם קופון הטבה", "שווי הטבות"],
    columns: {
      voucher_id: "מספר כרטיס",
      package_name: "שם קופון הטבה",
      quantity: "כמות קופונים שמומשו",
      final_price: "שווי הטבות",
      customer: "שם",
      date_parts: { year: "שנה", month: "חודש", day: "יום" },
    },
    hasPrice: true,
    easyKey: "coupon",
    idFallback: false,
  },
  {
    // center.icmega.co.il – הזמנות -> דוחות -> דו"ח הזמנות
    name: "icmega – חבר / שוטרים / מגה",
    easySuppliers: ["חבר משרתי הקבע", "קרנות השוטרים", "אי.סי. מגה"],
    detect: ["קוד עסקה", "מחיר לבודד"],
    columns: {
      voucher_id: "קוד עסקה",
      quantity: "כמות",
      final_price: 'סה"כ',
      unit_price: "מחיר לבודד",
      date: "תאריך מימוש",
      customer: "מספר שורה",
      // אין בדוח הזה שם חבילה – נבדקים רק כמות ומחיר
    },
    hasPrice: true,
    easyKey: "coupon_drop_first_digit",
    idFallback: false,
    zipPassword: true,
  },
  {
    // dtsreports.dts.co.il – דוח שוברי הטבות -> פרטי הזמנות של היום
    name: "נופשונית – Swish",
    easySuppliers: ["נופשונית"],
    detect: ["מזהה לקוח", "כמות שמומשה", "וריאנט", "אסמכתא"],
    columns: {
      voucher_id: "מזהה לקוח", // ת"ז הלקוח = מספר השובר באיזי
      package_name: "וריאנט",
      quantity: "כמות שמומשה",
      reference: "אסמכתא",
    },
    hasPrice: false,
    easyKey: "coupon",
    aggregateByKey: true,
    idFallback: true,
  },
];

if (typeof module !== "undefined") module.exports = SUPPLIERS;
