// עובד שירות: מאפשר התקנה כאפליקציה, פתיחה בלי רשת, והתראות ישירות מהמנוע בגוגל.
// הדף נטען קודם מהרשת (כדי לקבל תמיד את הגרסה האחרונה), ורק בלי רשת מהמטמון.
// הגופן (Rubik מ-Google Fonts) נשמר במטמון כדי שיעבוד גם בלי רשת.
// בקשות לגיטהאב ול-ntfy לא עוברות דרך המטמון.
//
// התראות: המנוע שולח הודעה מוצפנת (Web Push). הדפדפן מפענח, וכאן מציגים אותה, עם "✓ בוצע" ו"עוד שעה".
// לחיצה על כפתור כותבת ישר למאגר (פעמים.json), בלי לפתוח את האפליקציה, עם האסימון שהאפליקציה שמרה
// ב-IndexedDB. אם אין רשת, הפקודה נשמרת, והאפליקציה משלימה אותה כשהיא נפתחת.
importScripts('ליבה.js');
const מטמון = 'mesimot-v46';
const קבצים = ['./', 'index.html', 'ליבה.js', 'מאכלים.js', 'תמונות-מתכונים.js', 'fb-app.js', 'fb-auth.js', 'fb-store.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'badge-96.png'];
const גופנים = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const REPO_API = 'https://api.github.com/repos/nadavbenmenan/cv/contents/';
const PATHS = {tasks: 'משימות/משימות.json', occ: 'משימות/פעמים.json', config: 'משימות/תצורה.json'};

self.addEventListener('install', e => {
  e.waitUntil(caches.open(מטמון).then(c => c.addAll(קבצים)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== מטמון && k !== 'mesimot-img').map(k => caches.delete(k))))
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
  // תמונות של מצרכים ומתכונים: מהמטמון קודם, כדי שיופיעו גם בסופר בלי קליטה
  if(u.origin === 'https://www.themealdb.com' || u.origin === 'https://upload.wikimedia.org'){
    e.respondWith(caches.open('mesimot-img').then(c => c.match(e.request).then(ת => ת || fetch(e.request).then(ר => { c.put(e.request, ר.clone()); return ר; }))));
    return;
  }
  if(u.origin !== location.origin) return;
  if(u.pathname.endsWith('.apk')) return;   // קובץ ההתקנה: תמיד מהרשת, בלי עותק ישן במטמון
  e.respondWith(fetch(e.request).then(ת => {
    const עותק = ת.clone();
    caches.open(מטמון).then(c => c.put(e.request, עותק));
    return ת;
  }).catch(() => caches.match(e.request, {ignoreSearch: true}).then(ת => ת || caches.match('index.html'))));
});

/* ---------- זיכרון קטן (IndexedDB), משותף לאפליקציה ולעובד השירות ---------- */
function idb(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('משימות', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k){
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function kvSet(k, v){
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}

/* ---------- הצגת התראה ---------- */
const ACTIONS = [{action: 'done', title: '✓ בוצע'}, {action: 'snooze1h', title: 'עוד שעה'}];
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){ d = {t: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.t || 'משימות', {
    body: d.b || '', tag: d.tag || undefined, renotify: !!d.tag, data: d, dir: 'rtl', lang: 'he',
    icon: 'icon-192.png', badge: 'badge-96.png', actions: d.stop ? [{action: 'stop', title: '⏹ עצור'}] : d.btn ? ACTIONS : [],
    // טיימר: נשארת עד שסוגרים, ורוטטת חזק
    requireInteraction: !!d.ri, vibrate: d.vib ? [600, 300, 600, 300, 600, 300, 600] : undefined,
  }));
});

/* ---------- לחיצה ---------- */
self.addEventListener('notificationclick', e => {
  const n = e.notification, d = n.data || {};
  n.close();
  if(e.action === 'done' || e.action === 'snooze1h') e.waitUntil(doAction(e.action, d));
  else if(e.action === 'stop') e.waitUntil(stopTimer(d.stop).catch(() => {}));
  // לחיצה על התראת טיימר: פותחים את האפליקציה, והיא עוצרת את הצלצולים (#tm=)
  else e.waitUntil(openApp(d.u || './'));
});
// האפליקציה (או בדיקה) יכולה לבקש את אותה פעולה בהודעה
self.addEventListener('message', e => {
  if(e.data && e.data.type === 'action') e.waitUntil(doAction(e.data.action, e.data.data || {}).then(r => e.source && e.source.postMessage({type: 'action-done', result: r})));
});
async function openApp(url){
  const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  for(const c of all){
    if('focus' in c){ await c.focus(); if(c.navigate) await c.navigate(url).catch(() => {}); return; }
  }
  return self.clients.openWindow(url);
}

/** "בוצע" / "עוד שעה" מההתראה: שומרים, כותבים למאגר, ומודיעים לאפליקציה אם היא פתוחה. */
async function doAction(c, d){
  if(!d.o) return 'אין מופע';
  const cmd = {c, o: d.o, n: d.n || '', k: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), t: Date.now()};
  const list = (await kvGet('pending').catch(() => null)) || [];
  list.push(cmd);
  await kvSet('pending', list);
  let result;
  try{
    result = await applyToRepo(cmd);
    const left = ((await kvGet('pending')) || []).filter(x => x.k !== cmd.k);
    await kvSet('pending', left);
  }catch(err){
    result = 'נשמר במכשיר';
    // בלי רשת או בלי אסימון: האפליקציה תשלים כשתיפתח. מודיעים, כדי שלא יהיה נדמה שזה נרשם
    await self.registration.showNotification('עוד לא נרשם במאגר', {body: 'ייכנס כשתפתח את האפליקציה', tag: 'pending',
      dir: 'rtl', lang: 'he', icon: 'icon-192.png', badge: 'badge-96.png', data: {u: './'}});
  }
  for(const w of await self.clients.matchAll({type: 'window', includeUncontrolled: true})) w.postMessage({type: 'pending'});
  return result;
}

/* ---------- "⏹ עצור" בטיימר: stopped במאגר, והמנוע מפסיק לצלצל ---------- */
const TIMERS = 'משימות/טיימרים.json';
async function stopTimer(id){
  if(!id) return 'אין טיימר';
  const token = await kvGet('token');
  if(!token) throw new Error('אין אסימון במכשיר');
  for(let n = 0; n < 3; n++){
    const cur = await read(token, TIMERS);
    const t = cur && (cur.json.timers || []).find(x => x.id === id);
    if(!t || t.stopped || t.deleted) return 'כבר נעצר';
    const merged = ליבה.mergeTimersFile(cur.json, {timers: [Object.assign({}, t, {stopped: true, updatedAt: new Date().toISOString()})]});
    try{
      await gh(token, 'PUT', TIMERS, {message: 'טיימר: עצור', branch: 'main', content: to64(JSON.stringify(merged, null, 1)), sha: cur.sha});
      for(const w of await self.clients.matchAll({type: 'window', includeUncontrolled: true})) w.postMessage({type: 'pending'});
      return 'נעצר';
    }catch(err){ if(err.code !== 409 || n === 2) throw err; }
  }
}

/* ---------- גיטהאב ---------- */
const from64 = b => new TextDecoder().decode(Uint8Array.from(atob(String(b).replace(/\s/g, '')), ch => ch.charCodeAt(0)));
const to64 = s => { let x = ''; for(const ch of new TextEncoder().encode(s)) x += String.fromCharCode(ch); return btoa(x); };
async function gh(token, method, path, body){
  const url = REPO_API + path.split('/').map(encodeURIComponent).join('/') + (method === 'GET' ? `?ref=main&t=${Date.now()}` : '');
  const r = await fetch(url, {method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}});
  if(r.status === 404 && method === 'GET') return null;
  if(!r.ok) throw Object.assign(new Error('github ' + r.status), {code: r.status === 422 ? 409 : r.status});
  return r.json();
}
async function read(token, path){
  const g = await gh(token, 'GET', path);
  return g ? {json: JSON.parse(from64(g.content || '') || 'null'), sha: g.sha} : null;
}
async function applyToRepo(cmd){
  const token = await kvGet('token');
  if(!token) throw new Error('אין אסימון במכשיר');
  const [t, o, cf] = await Promise.all([read(token, PATHS.tasks), read(token, PATHS.occ), read(token, PATHS.config)]);
  if(!t) throw new Error('אין נתונים');
  let cur = o;
  const data = {tasks: t.json.tasks || [], domains: t.json.domains || [], occ: cur ? cur.json.occ || [] : [], config: ליבה.config(cf ? cf.json : {})};
  const rec = ליבה.applyCommand(data, cmd, cmd.t, null);
  if(!rec) return 'כבר מעודכן';
  for(let n = 0; n < 3; n++){
    const merged = ליבה.mergeOccFile(cur ? cur.json : null, {occ: [rec]});
    try{
      await gh(token, 'PUT', PATHS.occ, {message: cmd.c === 'done' ? 'משימות: בוצע מההתראה' : 'משימות: נדחה מההתראה', branch: 'main',
        content: to64(JSON.stringify(merged, null, 1)), sha: cur ? cur.sha : undefined});
      return cmd.c === 'done' ? 'בוצע' : 'נדחה';
    }catch(err){
      if(err.code !== 409 || n === 2) throw err;
      cur = await read(token, PATHS.occ);
    }
  }
}
