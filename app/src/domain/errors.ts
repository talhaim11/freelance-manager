/** Hebrew explanations for error codes raised by the database functions and the demo repository. */
export const ERROR_MESSAGES: Record<string, string> = {
  NOT_ALLOWED: 'החשבון הזה אינו מורשה לגשת לנתונים.',
  NOT_FOUND: 'המסמך לא נמצא.',
  VAT_STATUS_UNKNOWN: 'לא הוגדר סטטוס מע"מ לתאריך המסמך. הגדירו אותו בהגדרות.',
  EXEMPT_CANNOT_ISSUE_TAX_INVOICE: 'עוסק פטור אינו רשאי להפיק חשבונית מס.',
  NOT_SUPPORTED_YET: 'סוג המסמך הזה עדיין לא נתמך בגרסה זו.',
  USE_CANCEL_DOCUMENT: 'מסמך ביטול נוצר רק מתוך פעולת "ביטול" על מסמך קיים.',
  PROFILE_INCOMPLETE: 'חסרים פרטי העסק (שם, מספר זהות/עוסק וכתובת). השלימו בהגדרות.',
  CUSTOMER_REQUIRED: 'יש לבחור לקוח.',
  CUSTOMER_ADDRESS_REQUIRED: 'בחשבונית חובה להציג את כתובת הלקוח. עדכנו את כרטיס הלקוח.',
  PAYMENT_METHOD_REQUIRED: 'בקבלה חובה לציין את אמצעי התשלום.',
  INVALID_LINES: 'יש לתקן את שורות המסמך (תיאור, כמות חיובית, מחיר תקין).',
  INVALID_TOTAL: 'סכום המסמך חייב להיות חיובי.',
  SERIES_MISMATCH: 'סדרת המספור אינה מתאימה לסוג המסמך.',
  LEGACY_SERIES: 'לא ניתן להפיק מסמכים חדשים בסדרה היסטורית.',
  FINALIZED_DOCUMENT: 'מסמך שהופק אינו ניתן לעריכה או מחיקה. אפשר לבטל אותו במסמך ביטול.',
  REASON_REQUIRED: 'יש לציין סיבת ביטול.',
  NOT_ISSUED: 'רק מסמך שהופק ניתן לביטול. טיוטה אפשר פשוט למחוק.',
  CANNOT_CANCEL_CANCELLATION: 'לא ניתן לבטל מסמך ביטול.',
  IDEMPOTENCY_KEY_REUSED: 'בקשה כפולה לא תקינה. רעננו את הדף ונסו שוב.',
  SERIES_NUMBER_LOCKED: 'מספור סדרה מתקדם רק בהפקת מסמך.',
  SESSION_EXPIRED: 'החיבור לחשבון פג. התחברו מחדש — הפעולה לא בוצעה.',
  DUPLICATE: 'רשומה כזו כבר קיימת (למשל סדרה באותו שם).',
  ALLOCATION_INVALID: 'שיוך התשלום לא תקין: אפשר לשייך רק לחשבונית עסקה שהופקה, לא בוטלה ושייכת לאותו לקוח.',
  ALLOCATION_EXCEEDS_BALANCE: 'הסכום המשויך גדול מהיתרה הפתוחה של החשבונית (ייתכן ששולמה בינתיים ממכשיר אחר). רעננו ובדקו.',
  ALLOCATION_EXCEEDS_RECEIPT: 'סך השיוכים לחשבוניות גדול מסכום הקבלה.',
  ALLOCATION_IMMUTABLE: 'שיוך של קבלה שהופקה אינו ניתן לשינוי. אפשר לבטל את הקבלה.',
  INVOICE_HAS_PAYMENTS: 'לחשבונית יש תשלומים רשומים. יש לבטל קודם את הקבלות ששויכו אליה.',
  FILE_TOO_LARGE: 'הקובץ גדול מדי (עד 10MB).',
  FILE_TYPE_NOT_ALLOWED: 'סוג הקובץ אינו נתמך. אפשר תמונה או PDF.',
  ATTACHMENT_IMMUTABLE: 'קובץ מקור שצורף אינו ניתן לשינוי או למחיקה.',
  IMPORT_INVALID: 'הקובץ אינו גיבוי תקין של האפליקציה, או שהוא פגום. לא נשמר דבר.',
  IMPORT_TARGET_NOT_EMPTY: 'שחזור אפשרי רק לחשבון ריק (בלי לקוחות, מסמכים או הוצאות). לא נשמר דבר.',
  IMPORT_ALREADY_DONE: 'הנתונים מהאפליקציה הקודמת כבר יובאו לחשבון הזה. לא נשמר דבר.',
  BACKUP_FILE_MISMATCH: 'קובץ בתוך הגיבוי חסר או שונה מהמקור (טביעת SHA-256 לא תואמת). לא נשמר דבר.',
  REFERENCE_REQUIRED: 'יש להזין מספר אסמכתה (מהאתר הרשמי) לפני סימון כהוגש/שולם.',
  OUTPUT_IMMUTABLE: 'היסטוריית ההדפסות אינה ניתנת לשינוי.',
  NETWORK: 'אין תקשורת עם השרת. הפעולה לא בוצעה או שתוצאתה לא ידועה — בדקו ונסו שוב.',
};

export class AppError extends Error {
  constructor(public code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Extracts a known error code from an error or database message. */
export function errorCode(e: unknown): string {
  if (e instanceof AppError) return e.code;
  const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  const m = /\b([A-Z][A-Z_]{3,})\b/.exec(msg);
  if (m && ERROR_MESSAGES[m[1]]) return m[1];
  if (/fetch|network|Failed to fetch/i.test(msg)) return 'NETWORK';
  return 'UNKNOWN';
}

export function errorMessage(e: unknown): string {
  const code = errorCode(e);
  return ERROR_MESSAGES[code] ?? 'אירעה שגיאה לא צפויה. הפעולה לא הושלמה.';
}

/** Maps Supabase Auth errors to Hebrew without revealing whether an account exists. */
export function authErrorMessage(e: { message?: string; status?: number; name?: string } | null): string {
  if (!e) return '';
  const m = e.message ?? '';
  if (e.name === 'AuthRetryableFetchError' || /fetch|network|load failed/i.test(m) || e.status === 0) {
    return 'אין תקשורת עם השרת. בדקו את החיבור לאינטרנט ונסו שוב.';
  }
  if (e.status === 429 || /rate limit|too many/i.test(m)) return 'יותר מדי ניסיונות. המתינו כמה דקות ונסו שוב.';
  if (/invalid login credentials|invalid_credentials/i.test(m) || e.status === 400) return 'הדוא״ל או הסיסמה שגויים.';
  return 'הכניסה נכשלה. נסו שוב.';
}
