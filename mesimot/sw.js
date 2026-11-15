// עובד שירות: מאפשר התקנה כאפליקציה ופתיחה גם בלי רשת. כמו באפליקציית התרופות:
// הדף נטען קודם מהרשת (כדי לקבל תמיד את הגרסה האחרונה), ורק בלי רשת מהמטמון.
// הגופן (Rubik מ-Google Fonts) נשמר במטמון כדי שיעבוד גם בלי רשת.
// בקשות לגיטהאב ול-ntfy לא עוברות כאן בכלל.
const מטמון = 'mesimot-v1';
const קבצים = ['./', 'index.html', 'ליבה.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const גופנים = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(מטמון).then(c => c.addAll(קבצים)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== מטמון).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET') return;
  if(גופנים.includes(u.origin)){
    // גופן: קודם מהמטמון (הוא לא משתנה), ואם אין, מהרשת ושומרים
    e.respondWith(caches.match(e.request).then(ת => ת || fetch(e.request).then(ר => {
      const עותק = ר.clone(); caches.open(מטמון).then(c => c.put(e.request, עותק)); return ר;
    })));
    return;
  }
  if(u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(ת => {
    const עותק = ת.clone();
    caches.open(מטמון).then(c => c.put(e.request, עותק));
    return ת;
  }).catch(() => caches.match(e.request, {ignoreSearch: true}).then(ת => ת || caches.match('index.html'))));
});
