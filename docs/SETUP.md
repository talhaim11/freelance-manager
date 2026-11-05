# הגדרה, הרצה ובדיקה — Milestone M1

> שום דבר כאן לא פורס לייצור. הפריסה הקיימת (Netlify) לא משתנה עד שתמזג את הענף.

## 0. מה צריך במחשב
- Node.js 20 ומעלה (נבדק עם Node 24).
- בתיקיית הפרויקט: `npm install`

## 1. בדיקה מיידית — בלי שום חשבון חיצוני

### 1.1 האפליקציה החדשה במצב דמו
```
npm run dev
```
- במחשב: http://localhost:5173 → "פתיחה במצב דמו".
- **בטלפון** (באותה רשת Wi-Fi): בטרמינל יופיע `Network: http://192.168.x.x:5173` — פתחו את הכתובת הזו בטלפון.
  אם Windows שואל על חומת אש עבור Node.js — אשרו לרשת פרטית בלבד.
- במצב דמו הנתונים סינתטיים, נשמרים רק בדפדפן הנוכחי, ומסומנים בבאנר קבוע. הם לא מגיעים לשום שרת.

### 1.2 האפליקציה הקיימת (המתוקנת)
```
node scripts/static-server.mjs legacy 4173
```
- http://localhost:4173 — ו-`/backup.html` לכלי הגיבוי.
- שימו לב: כתובת מקומית היא "מקור" אחר מהאתר החי, לכן **הנתונים האמיתיים שלכם לא יופיעו כאן** (זה מכוון). לבדיקה עם Drive אמיתי צריך להוסיף את `http://localhost:4173` ל-Authorized JavaScript origins של ה-Client ID — לא חובה.

### 1.3 כל הבדיקות האוטומטיות
```
npm run typecheck
npx vitest run            # יחידה + בסיס נתונים (Postgres 17 משובץ, רץ מקומית)
npx playwright test       # דפדפן: אפליקציה קיימת + חדשה, מחשב + נייד
npm run build && npm run check:secrets
```

## 2. לפני כל דבר אחר: גיבוי הנתונים האמיתיים
הנתונים האמיתיים נמצאים בדפדפן שבו עבדתם ו/או ב-Google Drive (appDataFolder) — לא במאגר.
1. **לפני** מיזוג הענף, באתר החי הנוכחי — אין בו כלי גיבוי, לכן:
   - בכל דפדפן שבו השתמשתם: פתחו את האתר, F12 → Console, והריצו:
     `copy(localStorage.getItem('freelance_local'))` — ואז הדביקו לקובץ טקסט ושמרו.
     (בטלפון אין Console — הגיבוי ייעשה דרך `backup.html` אחרי המיזוג.)
2. **אחרי** מיזוג ופריסה: פתחו `https://<האתר>/backup.html` בכל דפדפן/מכשיר, הורידו את העותק המקורי, את דוח הביקורת, ואת קובץ ה-Drive (כפתור "התחבר וקרא מ-Drive").
3. הגרסה המתוקנת גם שומרת אוטומטית עותק "pre-upgrade" ב-IndexedDB בפעם הראשונה שהיא נפתחת, ועותקים לפני כל מיזוג.

## 3. הגדרת Supabase (נדרש לרשומות אמיתיות ולסנכרון מחשב ↔ טלפון)

### 3.1 החלטה על תוכנית (עלות)
| | Free | Pro |
|---|---|---|
| מחיר | 0 | ‎$25 לחודש (כולל ‎$10 קרדיט מחשוב) |
| גיבוי אוטומטי | **אין** | יומי, נשמר 7 ימים |
| השהיה | הפרויקט מושהה אחרי שבוע ללא פעילות | לא מושהה |
| אחסון | ‏500MB DB, ‏1GB קבצים | ‏8GB DB, ‏100GB קבצים |

(מקור: supabase.com/pricing, נבדק 5.11.2026.) לרשומות עסקיות אמיתיות מומלץ Pro, או Free + גיבוי ידני קבוע (ייצוא אוטומטי יתווסף בשלב 2).

### 3.2 יצירת הפרויקט
1. https://supabase.com/dashboard → New project. אזור: **Central EU (Frankfurt)**. סיסמת DB חזקה — שמרו במנהל סיסמאות.
2. **SQL Editor** → New query → הדביקו את כל התוכן של
   `supabase/migrations/20261105000000_m1_foundation.sql` → Run.
   (חלופה: Supabase CLI — `npx supabase link --project-ref <ref>` ואז `npx supabase db push`.)
3. רשימת המורשים — ב-SQL Editor:
   ```sql
   insert into app.allowed_users(email) values (lower('<הדוא"ל שלך>'));
   ```

### 3.3 הזדהות — חשבון אחד בלבד
1. **Authentication → Sign In / Providers**: כבו **Allow new users to sign up**. השאירו את Email פעיל.
2. **Authentication → Users → Add user → Create new user**: הדוא"ל שלך (אותו דוא"ל מרשימת המורשים). סמנו Auto Confirm.
3. **Authentication → URL Configuration**:
   - Site URL: `http://localhost:5173` (בשלב הבדיקות).
   - Redirect URLs: `http://localhost:5173`, וגם `http://<IP-של-המחשב>:5173` לבדיקה מהטלפון.
4. הכניסה באפליקציה היא בקישור חד-פעמי לדוא"ל (אין סיסמה, אין הרשמה). גם אם מישהו אחר יצליח ליצור חשבון — בלי רשימת המורשים הוא לא יראה ולא יכתוב דבר (נבדק בבדיקות).

### 3.4 חיבור האפליקציה
1. **Project Settings → API Keys**: העתיקו את ה-Project URL ואת המפתח **הציבורי** (anon / publishable).
2. בתיקיית הפרויקט צרו `.env.local`:
   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<המפתח הציבורי>
   ```
   **לעולם** אל תשימו את ה-service_role / secret key בקובץ הזה או בכל משתנה `VITE_`.
   `.env.local` לא נכנס ל-Git.
3. `npm run dev` → כניסה עם הדוא"ל → הגדרות: פרטי עסק, סטטוס מע"מ (עוסק פטור + תאריך), סדרות מספור.
   - אם הפקת בעבר מסמכים באפליקציה הקודמת — **התחילו את הסדרה החדשה ממספר שלא יתנגש** (למשל המספר הבא אחרי האחרון שהופק). המיגרציה (שלב 2) תשמור את המסמכים הישנים בסדרה היסטורית נפרדת.

## 4. מה עדיין לא נעשה בכוונה
- **אין פריסה.** כשתרצה: Netlify → Deploy Preview לענף (לא production), עם משתני הסביבה של 3.4 ב-Netlify UI.
- **ה-netlify.toml בענף** מגדיר `publish = "legacy"`. זה דורס את הגדרות ה-UI. לפני מיזוג: ודאו ב-Netlify (Site configuration → Build & deploy) שאין build command או תיקיית publish אחרת שאתם צריכים.
- **רוטציית ה-OAuth client secret** — לא בוצעה. הצעדים ב-`UPGRADE_SPEC.md` §9.3. האפליקציה לא משתמשת ב-secret כלל.
- **מיגרציית נתונים** מהאפליקציה הקודמת — שלב 2.
