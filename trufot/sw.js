// עובד שירות: מאפשר התקנה כאפליקציה ופתיחה גם בלי רשת.
// הדף נטען קודם מהרשת (כדי לקבל תמיד את הגרסה האחרונה), ורק בלי רשת מהמטמון.
// בקשות לגיטהאב ול-ntfy לא עוברות כאן בכלל.
const מטמון = 'trufot-v1';
const קבצים = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(מטמון).then(c => c.addAll(קבצים)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== מטמון).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if(e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(ת => {
    const עותק = ת.clone();
    caches.open(מטמון).then(c => c.put(e.request, עותק));
    return ת;
  }).catch(() => caches.match(e.request).then(ת => ת || caches.match('index.html'))));
});
