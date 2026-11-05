# ניהול עסק עצמאי (Freelance Manager)

אפליקציה בעברית לניהול עסק של יחיד — כרגע שכיר + עוסק פטור.

| תיקייה | מה יש בה |
|---|---|
| `legacy/` | האפליקציה הקיימת (קובץ יחיד), עם תיקוני אמינות ואבטחה של M1, וכלי גיבוי `backup.html`. זה מה שנפרס היום. |
| `app/` | הבסיס לאפליקציה החדשה (Vite + React + TypeScript, RTL, נגישה, מחשב ונייד). |
| `app/src/domain/` | לוגיקה טהורה: כסף באגורות, כללי מסמכים, היסטוריית סטטוס מע"מ, כללי מס מגורסים עם מקורות, מנוע הערכה. |
| `supabase/migrations/` | סכמה, הרשאות (RLS + רשימת מורשים), מספור טרנזקציוני, הגנה על מסמכים שהופקו, ביטול עקיב. |
| `tests/` | יחידה, בסיס נתונים (Postgres משובץ), דפדפן (Playwright), ו-`tests/live/` מול Supabase אמיתי. |

מסמכים: [UPGRADE_SPEC.md](UPGRADE_SPEC.md) · [GOVERNMENT_INTEGRATIONS.md](GOVERNMENT_INTEGRATIONS.md) · [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) · [docs/SETUP.md](docs/SETUP.md)

```
npm install
npm run dev          # האפליקציה החדשה: http://localhost:5173 (מצב דמו בלי Supabase)
npx vitest run       # יחידה + בסיס נתונים
npx playwright test  # דפדפן (מצב דמו + האפליקציה הקיימת)
npm run test:live:local   # מול Supabase מקומי (Docker) — Auth, RLS, מחשב↔טלפון
npm run test:live:dev     # מול פרויקט הפיתוח בענן
```

המערכת אינה ייעוץ מס ואינה מחליפה רו"ח. הערכות מס מסומנות כהערכה, עם מקורות ותאריך אימות.
