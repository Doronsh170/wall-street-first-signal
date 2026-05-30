# Wall Street First Signal MVP

MVP מהיר לזיהוי התראות ראשוניות על מניות וול סטריט, בדגש על טראמפ, מדיניות ממשל, מימון ממשלתי, מכסים, ביטחון, רחפנים, קוונטים ושבבים.

## מה יש כאן

1. דשבורד חי ב־HTML.
2. שרת Node.js עם Server-Sent Events.
3. מנוע חוקים מהיר לזיהוי:
   - טיקרים שמופיעים עם `$`
   - נרטיבים כמו drones, quantum, chips, tariffs, rare earths
   - קישור לטראמפ / ממשל
   - איכות מקור: official, tier1_media, trump_direct, trusted_x, market_chatter
4. endpoint לסימולציה.
5. endpoint להזנת ידיעה אמיתית.
6. שליחת Telegram אופציונלית.
7. חיבור אופציונלי ל־X Filtered Stream אם יש Bearer Token.

## התקנה

```bash
npm install
cp .env.example .env
npm start
```

פתח בדפדפן:

```bash
http://localhost:8787
```

## בדיקת זרימה תוך שניות

בדשבורד לחץ:

```text
הזרק ידיעה לדוגמה
```

או שלח ידיעה ידנית:

```bash
curl -X POST http://localhost:8787/api/ingest \
  -H "Content-Type: application/json" \
  -d '{"source":"Truth Social","author":"realDonaldTrump","text":"The Trump administration is preparing major support for American drone manufacturers to strengthen domestic defense supply chains."}'
```

## Telegram

ערוך `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

הפעל מחדש:

```bash
npm start
```

## X Stream

ערוך `.env`:

```bash
X_BEARER_TOKEN=your_x_bearer_token
```

חשוב: לפני שזה יעבוד, צריך להגדיר ב־X API את חוקי ה־Filtered Stream. הקובץ הזה כולל מאזין, אבל לא מנהל את חוקי הסטרים בעצמו.

## העיקרון המקצועי

המערכת מפרידה בין:

```text
FIRST_SIGNAL
```

לבין:

```text
VERIFIED_EVENT
```

בגרסה הזו יש רק FIRST_SIGNAL. השלב הבא הוא להוסיף:
1. בדיקת מחיר ומחזור בזמן אמת.
2. אימות מול Reuters / WSJ / Bloomberg / מקורות רשמיים.
3. עדכון שני אוטומטי אחרי 30-90 שניות.
4. דירוג Top Talked Stocks לפי תאוצת אזכורים.
5. מניעת טעויות בטיקרים קצרים כמו ON, NOW, CAT, AI.
