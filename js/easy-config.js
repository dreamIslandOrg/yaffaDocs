/*
 * easy-config.js – הגדרות דוח איזי
 * ---------------------------------
 * כאן נמצאים כל הכללים העסקיים של דוח איזי.
 * כדי לשנות כלל (למשל להוסיף חברה פנימית או מילת מפתח) – משנים רק כאן.
 */
(function (global) {
  'use strict';

  global.EASY_CONFIG = {
    // שמות העמודות בקובץ איזי
    columns: {
      voucher:   { name: 'CouponNo' },
      package:   { name: 'CouponDesc' },
      quantity:  { name: 'כמות' },
      price:     { name: 'מחיר' },
      startDate: { name: 'ת. התחלה' },
      supplier:  { name: 'חברת שוברים', occurrence: 2 }, // העמודה השנייה בשם הזה = שם החברה
      idNumber:  { name: 'מזהה' }
    },

    // חברות פנימיות – כל השורות שלהן מוסרות ולא נספרות בשום מקום
    excludedCompanies: [
      'חמי יואב תיירות בע"מ',
      'חמי יואב תיירות קבוצות'
    ],

    // כללי סיווג – נבדקים לפי הסדר, הראשון שמתאים קובע.
    // כל כלל מכיל כמה "אפשרויות"; אפשרות מתאימה אם כל הביטויים שבה מופיעים בשם החבילה.
    // (בלי תלות באותיות גדולות/קטנות. \s* = "אפשר רווחים כאן")
    categories: [
      { name: 'דלאקס',
        options: [['deluxe'], ['דלאקס'], ['דלקס'], ['שקיעה']] },
      { name: 'קלאסיק + ערב',
        options: [['classic\\s*&\\s*dinner']] },
      { name: 'קלאסיק + צהרים',
        options: [['classic\\s*&\\s*more'], ['קלאסיק|classic', 'צהרים|צהריים|lunch']] }
    ]
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
