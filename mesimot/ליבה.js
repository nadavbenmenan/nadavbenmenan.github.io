// ליבה.js: כל החישובים של אפליקציית "משימות", בלי תלות בדפדפן.
// הדף טוען את הקובץ הזה, הבדיקות מריצות אותו ב-Node, וסקריפט פרסום המנוע מדביק אותו
// בתוך קוד המנוע (Google Apps Script). אסור לכתוב את החישובים האלה במקום אחר.
//
// מוסכמות:
//  - תאריך הוא מחרוזת 'YYYY-MM-DD' לפי השעון בישראל. שעה היא 'HH:MM'.
//  - רגע הוא מספר אלפיות שנייה (Date.now()). כל פונקציה שתלויה בזמן מקבלת now מבחוץ.
//  - היום מתחיל ב-00:00 (לא 05:00 כמו בתרופות).
//  - מופעים "וירטואליים": מחשבים אותם מהגדרת המשימה. נשמרת רשומה רק כשמשהו קורה.
(function(root, factory){
  const m = factory();
  if(typeof module === 'object' && module.exports) module.exports = m;
  else root.ליבה = m;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
'use strict';

const TZ = 'Asia/Jerusalem';
const DAY = 864e5;
const APP = 'https://nadavbenmenan.github.io/mesimot/';
const pad = n => String(n).padStart(2, '0');

/* ---------- תאריכים כמחרוזות ---------- */
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fmtD = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const addDays = (s, n) => fmtD(parseD(s) + n * DAY);
const diffDays = (a, b) => Math.round((parseD(a) - parseD(b)) / DAY);      // a פחות b
const weekday = s => new Date(parseD(s)).getUTCDay();                         // 0 = ראשון
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();       // m: 1–12
const compact = s => s.replace(/-/g, '');
const fromCompact = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const maxStr = (...a) => a.filter(Boolean).sort().pop() || null;

/* ---------- שעון ישראל ---------- */
// בעדיפות Intl עם אזור זמן. אם הסביבה לא תומכת, חישוב לפי החוק הישראלי:
// שעון קיץ מיום שישי שלפני יום ראשון האחרון של מרץ ב-02:00, עד יום ראשון האחרון של אוקטובר ב-02:00.
let fmtr = null;
try{
  fmtr = new Intl.DateTimeFormat('en-US', {timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'});
  if(fmtr.resolvedOptions().timeZone !== TZ) fmtr = null;
}catch(e){ fmtr = null; }

function lastSunday(y, m){ const last = Date.UTC(y, m, 0); return last - new Date(last).getUTCDay() * DAY; }
function offsetByRule(ms){
  const y = new Date(ms).getUTCFullYear();
  const start = lastSunday(y, 3) - 2 * DAY + 0 * 36e5;        // שישי, 02:00 מקומי = 00:00 UTC
  const end = lastSunday(y, 10) - 1 * 36e5 + 0;                 // ראשון, 02:00 קיץ = 23:00 UTC של שבת
  return (ms >= start && ms < end ? 3 : 2) * 36e5;
}
function parts(ms){
  if(fmtr){
    const o = {};
    for(const p of fmtr.formatToParts(new Date(ms))) o[p.type] = p.value;
    const h = +o.hour % 24;
    return {date: `${o.year}-${o.month}-${o.day}`, time: `${pad(h)}:${o.minute}`, h, mi: +o.minute, s: +o.second};
  }
  const d = new Date(ms + offsetByRule(ms));
  return {date: fmtD(d.getTime()), time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds()};
}
function offsetAt(ms){
  const p = parts(ms), [y, m, d] = p.date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** הרגע של תאריך ושעה מקומיים בישראל. */
function at(date, time){
  const [y, m, d] = date.split('-').map(Number), [h, mi] = (time || '00:00').split(':').map(Number);
  const g = Date.UTC(y, m - 1, d, h, mi);
  return g - offsetAt(g - offsetAt(g));
}
const localDate = ms => parts(ms).date;
const localTime = ms => parts(ms).time;
const toMs = v => v == null ? 0 : typeof v === 'number' ? v : Date.parse(v);

/* ---------- ברירות מחדל ---------- */
const DEFAULT_CONFIG = {
  v: 1, updatedAt: '',
  activeFrom: '07:00', activeTo: '21:00', summaryTime: '07:30', defaultTime: '10:00', quotaTime: '17:00',
  snoozeMorning: '08:00', accent: '#5B5BF7', theme: 'system',
  mailRules: [], calendars: [], ntfy: '', ntfyCmd: '', seedV: 1, tenant: null,
};
const PRIORITY = {high: 0, normal: 1, low: 2};
const PRIORITY_NAME = {high: 'עדיפות גבוהה', normal: 'עדיפות רגילה', low: 'עדיפות נמוכה'};

function config(c){ return Object.assign({}, DEFAULT_CONFIG, c || {}); }

/** משלים שדות חסרים במשימה, בלי לשנות את המקור. */
function normTask(t, cfg){
  cfg = config(cfg);
  const n = Object.assign({
    priority: 'normal', time: null, pre: [], soft: false, nag: {mode: 'daily'}, missPolicy: null,
    discreet: false, notifyTitle: null, doneLabel: null, subtasks: [], notes: '', links: [],
    start: null, archived: false, deleted: false,
  }, t);
  if(!n.time) n.time = n.kind === 'quota' ? cfg.quotaTime : cfg.defaultTime;
  if(!n.nag) n.nag = {mode: 'daily'};
  if(n.kind === 'schedule' && !n.missPolicy) n.missPolicy = 'accumulate';
  if(!n.start) n.start = n.updatedAt ? localDate(toMs(n.updatedAt)) : '2026-11-15';
  return n;
}
const isActiveTask = t => t && !t.deleted && !t.archived;

/* ---------- חוקי לוח ---------- */
function matchRule(rule, date){
  const [y, m, d] = date.split('-').map(Number), last = daysInMonth(y, m);
  const dayOf = day => day === 'last' ? last : Math.min(+day, last);
  switch(rule.type){
    case 'daily': return true;
    case 'weekly': return (rule.days || []).includes(weekday(date));
    case 'monthly': return d === dayOf(rule.day);
    case 'everyNMonths': {
      const [ay, am] = (rule.anchor || date).split('-').map(Number);
      const diff = (y - ay) * 12 + (m - am), n = Math.max(1, +rule.n || 1);
      return ((diff % n) + n) % n === 0 && d === dayOf(rule.day ?? +rule.anchor.slice(8, 10));
    }
    case 'yearly': return m === +rule.month && d === dayOf(rule.day);
  }
  return false;
}
/** כל המועדים של חוק בטווח [from, to], כולל. */
function ruleDates(rule, from, to){
  const out = [];
  for(let d = from; d <= to; d = addDays(d, 1)) if(matchRule(rule, d)) out.push(d);
  return out;
}

/* ---------- מופעים ---------- */
function indexOcc(occ){
  const byId = new Map(), byTask = new Map();
  for(const r of occ || []){
    if(r.deleted) continue;
    byId.set(r.id, r);
    if(!byTask.has(r.taskId)) byTask.set(r.taskId, []);
    byTask.get(r.taskId).push(r);
  }
  return {byId, byTask};
}
const LOOKBACK = 400;     // ימים אחורה שבודקים בהם תשלומים פתוחים

function periodOf(task, date){
  const p = task.quota?.period || 'week';
  if(p === 'month'){
    const [y, m] = date.split('-').map(Number);
    return {start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`};
  }
  const start = addDays(date, -weekday(date));
  return {start, end: addDays(start, 6)};
}
/** מצב מכסה ביום מסוים: כמה בוצעו בתקופה, כמה נשארו, האם מפגר. */
function quotaInfo(task, idx, date){
  const {start, end} = periodOf(task, date), count = +task.quota?.count || 1;
  const recs = (idx.byTask.get(task.id) || []).filter(r => r.status === 'done' && r.due >= start && r.due <= end);
  const done = recs.length, remaining = Math.max(0, count - done), daysLeft = diffDays(end, date) + 1;
  return {start, end, count, done, remaining, daysLeft, behind: remaining > 0 && remaining >= daysLeft,
    doneDays: recs.map(r => r.due).sort()};
}

/** מצב חלון של "ממועד הביצוע": מתי בוצע לאחרונה, מתי נפתח החלון ומתי הופך אדום. */
function afterDoneInfo(task, idx, today){
  const recs = (idx.byTask.get(task.id) || []).filter(r => /-n\d+$/.test(r.id));
  const closed = recs.filter(r => r.status === 'done' || r.status === 'skipped');
  const closedDate = r => r.doneAt ? localDate(toMs(r.doneAt)) : r.due;
  // תאריך אחרון שהוזן ביד (lastSetAt) גובר על סימונים שנעשו לפניו, כדי שאפשר יהיה לתקן אחורה
  const setAt = task.afterDone?.lastSetAt, counted = setAt ? closed.filter(r => (r.doneAt || r.updatedAt || '') > setAt) : closed;
  const baseline = maxStr(task.afterDone?.lastDone, ...counted.map(closedDate));
  const n = Math.max(0, ...closed.map(r => +r.id.match(/-n(\d+)$/)[1])) + 1;
  const base = baseline || task.start;
  const min = +task.afterDone?.minDays || 0, max = +task.afterDone?.maxDays || min;
  return {id: `${task.id}-n${n}`, n, lastDone: baseline, needsLast: !baseline, base,
    minDate: addDays(base, min), maxDate: addDays(base, max), day: diffDays(today, base), min, max};
}

function occFrom(task, id, due, idx, extra){
  const rec = idx.byId.get(id) || null;
  return Object.assign({id, taskId: task.id, kind: task.kind, due, status: rec ? rec.status : 'open', rec,
    snoozeUntil: rec?.snoozeUntil || null, subDone: rec?.subDone || [], note: rec?.note || ''}, extra || {});
}

/** כל המופעים של משימה שמועדם עד until (כולל עבר פתוח). */
function occurrencesOf(task, idx, today, until){
  switch(task.kind){
    case 'schedule': {
      const from = maxStr(task.start, addDays(today, -LOOKBACK));
      const list = ruleDates(task.schedule?.rule || {type: 'daily'}, from, until)
        .map(d => occFrom(task, `${task.id}-${compact(d)}`, d, idx));
      // dayOnly (ימי הולדת): יום שעבר ולא סומן לא נשאר "באיחור", פשוט עובר
      if(task.missPolicy === 'dayOnly')
        for(const o of list) if(o.due < today && (o.status === 'open' || o.status === 'snoozed')) o.status = 'missed';
      if(task.missPolicy === 'replace'){
        // פעם שהגיעה פעם חדשה אחריה (עד היום) ולא סומנה נחשבת "פוספסה"
        const reached = list.filter(o => o.due <= today);
        for(let i = 0; i < reached.length - 1; i++)
          if(reached[i].status === 'open' || reached[i].status === 'snoozed') reached[i].status = 'missed';
      }
      return list;
    }
    case 'once': {
      const d = task.once?.date;
      return d ? [occFrom(task, `${task.id}-${compact(d)}`, d, idx)] : [];
    }
    case 'afterDone': {
      const a = afterDoneInfo(task, idx, today);
      return [occFrom(task, a.id, a.maxDate, idx, {window: a})];
    }
    case 'quota':
      return [occFrom(task, `${task.id}-${compact(today)}`, null, idx, {quota: quotaInfo(task, idx, today)})];
    case 'inbox':
      return [occFrom(task, `${task.id}-1`, null, idx)];
    case 'email': {
      const e = task.email || {};
      const rec = e.receivedAt ? localDate(toMs(e.receivedAt)) : task.start;
      return [occFrom(task, `${task.id}-1`, addDays(rec, +e.dueDays || 0), idx)];
    }
  }
  return [];
}

/** המצב בפועל: דחייה שנגמרה היא שוב פתוחה. */
function effStatus(o, now){
  if(o.status === 'snoozed') return toMs(o.snoozeUntil) > now ? 'snoozed' : 'open';
  return o.status;
}
const isOpen = (o, now) => { const s = effStatus(o, now); return s === 'open' || s === 'snoozed'; };
/** התאריך שקובע את המקום במסך: סוף הדחייה, אם נדחה אל אחרי המועד. */
function effDate(o){
  if(!o.due) return o.snoozeUntil ? localDate(toMs(o.snoozeUntil)) : null;
  const s = o.snoozeUntil ? localDate(toMs(o.snoozeUntil)) : null;
  return s && s > o.due ? s : o.due;
}

/* ---------- מסך "היום" ---------- */
function sortItems(a, b){
  return (PRIORITY[a.task.priority] ?? 1) - (PRIORITY[b.task.priority] ?? 1)
    || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.task.time).localeCompare(String(b.task.time))
    || a.task.title.localeCompare(b.task.title, 'he');
}

/** מחלק את כל המשימות הפעילות לקבוצות של מסך "היום". */
function buildView(data, now, opts){
  opts = opts || {};
  const cfg = config(data.config), today = localDate(now), ahead = opts.upcomingDays || 14;
  const idx = indexOcc(data.occ);
  const v = {today, overdue: [], todays: [], week: [], waiting: [], upcoming: [], doneToday: 0};
  for(const raw of data.tasks || []){
    if(!isActiveTask(raw)) continue;
    const task = normTask(raw, cfg);
    for(const o of occurrencesOf(task, idx, today, addDays(today, ahead))){
      const item = {occ: o, task, date: effDate(o), status: effStatus(o, now)};
      if(task.kind === 'quota'){ v.week.push(item); continue; }
      if(!isOpen(o, now)) continue;
      if(task.kind === 'inbox'){ v.waiting.push(item); continue; }
      item.late = o.due ? Math.max(0, diffDays(today, o.due)) : 0;
      if(item.date < today) v.overdue.push(item);
      else if(item.date === today) v.todays.push(item);
      else if(task.kind === 'afterDone'){
        if(diffDays(o.window.minDate, today) <= 7) v.week.push(item);
        else if(o.window.minDate <= addDays(today, ahead)) v.upcoming.push(Object.assign(item, {date: o.window.minDate}));
      }
      else if(item.date <= addDays(today, ahead)) v.upcoming.push(item);
    }
  }
  for(const r of data.occ || [])
    if(!r.deleted && r.status === 'done' && r.doneAt && localDate(toMs(r.doneAt)) === today) v.doneToday++;
  for(const k of ['overdue', 'todays', 'week', 'waiting']) v[k].sort(sortItems);
  v.upcoming.sort((a, b) => a.date.localeCompare(b.date) || sortItems(a, b));
  v.total = v.doneToday + v.overdue.length + v.todays.length;
  return v;
}

/* ---------- שעות פעילות ודחייה ---------- */
function inActive(ms, cfg){
  const t = localTime(ms);
  return t >= cfg.activeFrom && t <= cfg.activeTo;
}
/** מזיז רגע שנופל מחוץ לשעות הפעילות לבוקר (08:00) של אותו יום או של היום שאחריו. */
function shiftToActive(ms, cfg){
  cfg = config(cfg);
  const d = localDate(ms), t = localTime(ms);
  if(t > cfg.activeTo) return at(addDays(d, 1), cfg.snoozeMorning);
  if(t < cfg.activeFrom) return at(d, cfg.snoozeMorning);
  return ms;
}
/** עד מתי לדחות: '1h' | 'tomorrow' | 'week' | {date, time}. */
function snoozeTarget(kind, now, task, cfg){
  cfg = config(cfg);
  const today = localDate(now), time = task?.time || cfg.defaultTime;
  let ms;
  if(kind === '1h') ms = now + 36e5;
  else if(kind === 'tomorrow') ms = at(addDays(today, 1), time);
  else if(kind === 'week') ms = at(addDays(today, 7), time);
  else ms = at(kind.date, kind.time || time);
  return shiftToActive(ms, cfg);
}

/* ---------- תכנון התראות ---------- */
const displayTitle = t => t.discreet ? (t.notifyTitle || 'תזכורת') : t.title;
const lateText = n => n === 1 ? 'באיחור של יום' : n === 2 ? 'באיחור של יומיים' : `באיחור של ${n} ימים`;
const inText = n => n === 1 ? 'מחר' : n === 2 ? 'בעוד יומיים' : `בעוד ${n} ימים`;

function nagDates(task, from, to){
  const nag = task.nag || {mode: 'daily'}, out = [];
  if(nag.mode === 'none') return out;
  const step = nag.mode === 'weekly' ? 7 : nag.mode === 'everyNDays' ? Math.max(1, +nag.n || 1) : 1;
  const times = nag.mode === 'times' && nag.times?.length ? [...nag.times].sort() : [task.time];
  for(let d = addDays(from, 0), i = 0; d <= to; d = addDays(d, 1), i++)
    if(i % step === 0) for(const t of times) out.push({date: d, time: t, multi: times.length > 1});
  return out;
}

/**
 * כל ההתראות שצריכות לצאת בטווח (ברירת מחדל 70 שעות: ntfy מתזמן עד 3 ימים קדימה).
 * אותו קלט מחזיר תמיד אותה רשימה, עם אותם מזהים. בלי ערכים חד-פעמיים (המנוע מוסיף אותם).
 */
function planNotifications(data, now, opts){
  opts = opts || {};
  const cfg = config(data.config), idx = indexOcc(data.occ);
  const end = now + (opts.horizonH || 70) * 36e5, today = localDate(now), endDate = localDate(end);
  const domains = new Map((data.domains || []).map(d => [d.id, d.name]));
  const out = new Map();
  const add = (n, keepTime, exact) => {
    const ms = keepTime && !exact ? shiftToActive(n.at, cfg) : n.at;
    if(ms <= now + 15e3 || ms > end) return;
    if(!keepTime && !exact && !inActive(ms, cfg)) return;   // מחוץ לשעות: לא נשלח, הסיכום מכסה. חוץ משעה שנבחרה במפורש
    out.set(n.id, Object.assign({}, n, {at: ms}));
  };
  for(const raw of data.tasks || []){
    if(!isActiveTask(raw)) continue;
    const task = normTask(raw, cfg), title = displayTitle(task), domain = domains.get(task.domain) || '';
    const base = {taskId: task.id, buttons: true};
    if(task.kind === 'quota'){
      for(let d = today; d <= endDate; d = addDays(d, 1)){
        const q = quotaInfo(task, idx, d), occId = `${task.id}-${compact(d)}`;
        const snz = idx.byId.get(occId), snzMs = snz?.status === 'snoozed' ? toMs(snz.snoozeUntil) : 0;
        if(!q.behind) continue;
        const msg = `${q.done} מתוך ${q.count}, נשארו ${q.daysLeft === 1 ? 'היום בלבד' : q.daysLeft + ' ימים'}`;
        if(snzMs > now){ add(Object.assign({}, base, {id: `${occId}-snz`, occId, at: snzMs, title, message: msg}), true); continue; }
        add(Object.assign({}, base, {id: `${task.id}-quota-${compact(d)}`, occId, at: at(d, task.time), title, message: msg}));
      }
      continue;
    }
    if(task.kind === 'inbox') continue;
    const maxPre = Math.max(0, ...task.pre.map(Number));
    for(const o of occurrencesOf(task, idx, today, addDays(endDate, maxPre))){
      if(!isOpen(o, now) || !o.due) continue;
      const one = Object.assign({}, base, {occId: o.id});
      const snzMs = effStatus(o, now) === 'snoozed' ? toMs(o.snoozeUntil) : 0;
      const cands = [];
      for(const x of task.pre.map(Number)) if(x > 0)
        cands.push({id: `${o.id}-pre${x}`, at: at(addDays(o.due, -x), task.time), title: `${inText(x)}: ${title}`, message: domain});
      cands.push({id: `${o.id}-day`, at: at(o.due, task.time), title, message: domain || 'היום', exact: !!task.exact});
      if(task.kind === 'afterDone' && task.soft)
        cands.push({id: `${o.id}-soft`, at: at(o.window.minDate, task.time), title: `אפשר לקבוע: ${title}`, message: domain});
      for(const n of nagDates(task, addDays(o.due, 1), endDate)){
        const late = diffDays(n.date, o.due);
        cands.push({id: `${o.id}-nag-${compact(n.date)}${n.multi ? '-' + n.time.replace(':', '') : ''}`,
          at: at(n.date, n.time), title: `${lateText(late)}: ${title}`, message: domain});
      }
      for(const c of cands){
        // מופע נדחה לא מקבל שום תזכורת עד סוף הדחייה, וגם לא באותו יום שבו הדחייה נגמרת
        if(snzMs && (c.at <= snzMs || localDate(c.at) === localDate(snzMs))) continue;
        const ex = c.exact; delete c.exact;
        add(Object.assign({}, one, c), false, ex);
      }
      if(snzMs) add(Object.assign({}, one, {id: `${o.id}-snz`, at: snzMs, title, message: 'תזכורת שנדחתה'}), true);
    }
  }
  return [...out.values()]
    .map(n => Object.assign(n, {click: `${APP}#o=${encodeURIComponent(n.occId)}`}))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** סיכום בוקר: נשלח מיד ברגע הריצה (מהמנוע). */
function buildSummary(data, now, calendar){
  const v = buildView(data, now), lines = [];
  for(const i of v.overdue) lines.push(`באיחור: ${displayTitle(i.task)}`);
  for(const i of v.todays) lines.push(`היום: ${displayTitle(i.task)}`);
  for(const i of v.week) if(i.occ.quota?.behind) lines.push(`${displayTitle(i.task)}: ${i.occ.quota.done} מתוך ${i.occ.quota.count}`);
  for(const e of calendar || []){
    if(!e.start || localDate(toMs(e.start)) !== v.today) continue;
    lines.push(e.allDay ? `ביומן: ${e.title}` : `ביומן ${localTime(toMs(e.start))}: ${e.title}`);
  }
  const n = lines.length;
  return {id: `sum-${compact(v.today)}`, title: n ? `בוקר טוב · ${n === 1 ? 'דבר אחד' : n + ' דברים'} להיום` : 'בוקר טוב · אין משימות להיום',
    message: lines.slice(0, 6).join('\n') + (n > 6 ? `\nועוד ${n - 6}` : ''), click: APP, count: n};
}

/* ---------- פעולות (מחזירות רשומת מופע חדשה) ---------- */
function baseRec(o, nowIso){
  const r = o.rec || {};
  return {id: o.id, taskId: o.taskId, due: o.due, status: 'open', doneAt: null, snoozeUntil: null,
    subDone: r.subDone || [], note: r.note || '', amount: r.amount ?? null, updatedAt: nowIso, deleted: false};
}
/** "בוצע". ל-quota נוצרת רשומה חדשה לכל ביצוע. when = מתי בוצע בפועל (אפשר לשנות). */
function markDone(data, o, opts){
  const nowIso = opts.nowIso, when = opts.when ?? toMs(nowIso);
  const doneAt = new Date(when).toISOString();
  if(o.kind === 'quota'){
    const d = localDate(when), prefix = `${o.taskId}-${compact(d)}-`;
    const k = opts.k ?? (Math.max(0, ...(data.occ || []).filter(r => r.id.startsWith(prefix))
      .map(r => +r.id.slice(prefix.length) || 0)) + 1);
    return {id: prefix + k, taskId: o.taskId, due: d, status: 'done', doneAt, snoozeUntil: null, subDone: [],
      note: opts.note || '', amount: null, updatedAt: nowIso, deleted: false};
  }
  return Object.assign(baseRec(o, nowIso), {status: 'done', doneAt, note: opts.note ?? (o.rec?.note || '')});
}
function snooze(o, untilMs, nowIso){
  if(o.kind === 'quota') return {id: o.id, taskId: o.taskId, due: localDate(toMs(nowIso)), status: 'snoozed',
    doneAt: null, snoozeUntil: new Date(untilMs).toISOString(), subDone: [], note: '', amount: null, updatedAt: nowIso, deleted: false};
  return Object.assign(baseRec(o, nowIso), {status: 'snoozed', snoozeUntil: new Date(untilMs).toISOString()});
}
const skip = (o, nowIso) => Object.assign(baseRec(o, nowIso), {status: 'skipped'});
function toggleSub(o, subId, nowIso){
  const r = o.rec ? Object.assign({}, o.rec, {updatedAt: nowIso}) : baseRec(o, nowIso);
  const s = new Set(r.subDone || []);
  s.has(subId) ? s.delete(subId) : s.add(subId);
  r.subDone = [...s];
  return r;
}
/** ביטול: מחזיר את הרשומה הקודמת (עם חותמת חדשה), או מצבה אם לא הייתה. */
function undo(prev, id, nowIso){
  return prev ? Object.assign({}, prev, {updatedAt: nowIso}) : {id, deleted: true, updatedAt: nowIso};
}

/** מוצא מופע לפי מזהה (למשל מהכתובת #o= או מפקודה). */
function findOcc(data, occId, now){
  const cfg = config(data.config), today = localDate(now), idx = indexOcc(data.occ);
  const tasks = (data.tasks || []).filter(t => !t.deleted && occId.startsWith(t.id + '-'))
    .sort((a, b) => b.id.length - a.id.length);
  for(const raw of tasks){
    const task = normTask(raw, cfg), rest = occId.slice(task.id.length + 1);
    if(task.kind === 'quota' && /^\d{8}$/.test(rest)){
      const d = fromCompact(rest);
      return {task, occ: occFrom(task, occId, null, idx, {quota: quotaInfo(task, idx, d)})};
    }
    if((task.kind === 'schedule' || task.kind === 'once') && /^\d{8}$/.test(rest)){
      const d = fromCompact(rest);
      if(task.kind === 'once' ? task.once?.date === d : matchRule(task.schedule.rule, d))
        return {task, occ: occFrom(task, occId, d, idx)};
    }
    const o = occurrencesOf(task, idx, today, today).find(x => x.id === occId);
    if(o) return {task, occ: o};
    const r = idx.byId.get(occId);
    if(r) return {task, occ: occFrom(task, occId, r.due, idx)};
  }
  return null;
}

/**
 * מבצע פקודה מכפתור בהתראה. cmd = {c, o, k}, cmdTime = הזמן של ההודעה ב-ntfy.
 * החותמת והזמן נגזרים מהפקודה, ולכן אם גם האפליקציה וגם המנוע מבצעים אותה, יוצאת אותה רשומה.
 * nonces: Set של ערכים חד-פעמיים מוכרים, או null כדי לא לבדוק (באפליקציה).
 */
function applyCommand(data, cmd, cmdTime, nonces){
  if(!cmd || !cmd.c || cmd.c === 'resync') return null;
  if(typeof nonces === 'string'){ if(!verifyCmd(cmd, nonces)) return null; }
  else if(nonces && !nonces.has(cmd.k)) return null;
  const f = findOcc(data, String(cmd.o || ''), cmdTime);
  if(!f) return null;
  const nowIso = new Date(cmdTime).toISOString(), {task, occ} = f;
  if(cmd.c === 'done'){
    if(occ.kind !== 'quota' && occ.status === 'done') return null;
    if(occ.kind === 'quota'){
      const id = `${task.id}-${compact(localDate(cmdTime))}-c${String(cmd.k || cmdTime).replace(/[^\w]/g, '')}`;
      if((data.occ || []).some(r => r.id === id && !r.deleted)) return null;
      return markDone(data, occ, {nowIso, k: id.split('-').pop()});
    }
    return markDone(data, occ, {nowIso});
  }
  if(occ.status === 'done') return null;
  if(cmd.c === 'snooze1h') return snooze(occ, snoozeTarget('1h', cmdTime, task, data.config), nowIso);
  if(cmd.c === 'tomorrow') return snooze(occ, snoozeTarget('tomorrow', cmdTime, task, data.config), nowIso);
  return null;
}

/* ---------- חתימה על פקודות ---------- */
// במקום רשימה של ערכים חד־פעמיים: k = גיבוב של (מפתח סודי | מזהה ההתראה | מופע). המפתח (cmd_key) נמצא רק
// ב־הגדרות.json במאגר הפרטי. כך גם המנוע וגם האפליקציה יכולים לבדוק פקודה, בלי לשמור רשימה.
function sha256(str){
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes = [];
  for(const ch of unescape(encodeURIComponent(String(str)))) bytes.push(ch.charCodeAt(0));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while(bytes.length % 64 !== 56) bytes.push(0);
  for(let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const W = new Array(64), rot = (x, n) => (x >>> n) | (x << (32 - n));
  for(let o = 0; o < bytes.length; o += 64){
    for(let i = 0; i < 16; i++) W[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
    for(let i = 16; i < 64; i++){
      const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for(let i = 0; i < 64; i++){
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
const cmdKey = (secret, n, o) => sha256(`${secret}|${n}|${o}`).slice(0, 16);
function verifyCmd(cmd, secret){
  return !!(secret && cmd && cmd.k && cmd.n && cmd.o) && cmd.k === cmdKey(secret, cmd.n, cmd.o);
}
/** שלושת הכפתורים בהתראה: פקודה לערוץ הפקודות, חתומה. */
function buttonsFor(n, cmdTopic, secret){
  const body = c => JSON.stringify({c, o: n.occId, n: n.id, k: cmdKey(secret, n.id, n.occId)});
  const b = (label, c) => ({action: 'http', label, url: `https://ntfy.sh/${cmdTopic}`, method: 'POST', body: body(c), clear: true});
  return [b('✓ בוצע', 'done'), b('עוד שעה', 'snooze1h'), b('מחר', 'tomorrow')];
}

/* ---------- מה לקבוע ומה למחוק ב-ntfy ---------- */
// state: {<מזהה>: {at, sig, occId}}. אותו חישוב במנוע ובאפליקציה.
// ntfy לא מחליף הודעה מתוזמנת עם אותו מזהה, ולכן כל "קביעה" היא מחיקה ואז פרסום.
const notifSig = n => sha256(`${n.at}|${n.title}|${n.message}|${n.occId}|${n.buttons ? 1 : 0}`).slice(0, 10);
function diffSchedule(state, plan, data, now){
  state = state || {};
  const want = new Map(plan.map(n => [n.id, n])), del = [], drop = [], pub = [];
  for(const [id, s] of Object.entries(state)){
    if(want.has(id)) continue;
    // עתידית שלא רצויה עוד: מוחקים. שכבר יצאה: מוחקים רק אם המופע נסגר (כך היא נעלמת מהנייד)
    let gone = s.at > now;
    if(!gone && s.occId){ const f = findOcc(data, s.occId, now); gone = !f || (f.occ.kind !== 'quota' && !isOpen(f.occ, now)); }
    if(gone && s.at > now - 3 * DAY) del.push(id);
    else if(gone || s.at < now - 3 * DAY) drop.push(id);
  }
  for(const n of plan) if(state[n.id]?.sig !== notifSig(n)) pub.push(n);
  return {del, drop, pub};
}
/** המנוע חי אם רץ תזמון מלא ב-7 השעות האחרונות (הוא רץ לפחות כל 6 שעות). */
const engineAlive = (inbox, now) => !!(inbox && inbox.engine && inbox.engine.lastFull && now - toMs(inbox.engine.lastFull) < 7 * 36e5);

/* ---------- משימה קבועה מההוספה המהירה ---------- */
const REPEATS = [['', 'לא חוזר'], ['daily', 'כל יום'], ['weekly', 'כל שבוע'], ['monthly', 'כל חודש'], ['m2', 'כל חודשיים'], ['yearly', 'כל שנה']];
const repeatText = r => (REPEATS.find(x => x[0] === r) || [, /^m\d+$/.test(r || '') ? `כל ${r.slice(1)} חודשים` : ''])[1];
/** חוק לוח לפי הבחירה, מעוגן בתאריך הראשון (אותו יום בשבוע / בחודש / בשנה). */
function ruleFor(repeat, date){
  const day = +date.slice(8, 10);
  if(repeat === 'daily') return {type: 'daily'};
  if(repeat === 'weekly') return {type: 'weekly', days: [weekday(date)]};
  if(repeat === 'monthly') return {type: 'monthly', day};
  if(repeat === 'yearly') return {type: 'yearly', month: +date.slice(5, 7), day};
  const n = /^m(\d+)$/.exec(repeat || '');
  return n ? {type: 'everyNMonths', n: +n[1], anchor: date, day} : null;
}
/** הכיוון ההפוך, ליומן: חוק לוח → RRULE. null אם אין התאמה פשוטה. */
function rruleOf(rule){
  if(!rule) return null;
  return {daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY',
    everyNMonths: `FREQ=MONTHLY;INTERVAL=${Math.max(1, +rule.n || 1)}`}[rule.type] || null;
}

/* ---------- יומן גוגל ---------- */
// קישור שפותח ביומן גוגל אירוע חדש, ממולא מראש. המשתמש לוחץ "שמירה" ביומן. בלי הרשאות ובלי גישה לחשבון.
// עם שעה (משימה שנקבעה לה שעה במפורש): אירוע של חצי שעה. בלי שעה: אירוע של יום שלם.
const calStamp = ms => localDate(ms).replace(/-/g, '') + 'T' + localTime(ms).replace(':', '') + '00';
function calendarUrl(ev){
  const q = ['action=TEMPLATE', 'text=' + encodeURIComponent(ev.title || '')];
  if(ev.time){
    const start = at(ev.date, ev.time);
    q.push('dates=' + calStamp(start) + '/' + calStamp(start + (ev.minutes || 30) * 6e4), 'ctz=Asia%2FJerusalem');
  }else q.push('dates=' + compact(ev.date) + '/' + compact(addDays(ev.date, 1)));
  if(ev.details) q.push('details=' + encodeURIComponent(ev.details));
  if(ev.rrule) q.push('recur=' + encodeURIComponent('RRULE:' + ev.rrule));   // אירוע חוזר
  return 'https://calendar.google.com/calendar/render?' + q.join('&');
}
/** אירוע ביומן למופע של משימה. משימה דיסקרטית: בשם שמופיע בהתראות, לא בשם האמיתי. */
function calendarFor(task, occ){
  if(!occ || !occ.due) return null;
  return calendarUrl({title: displayTitle(task), date: occ.due, time: task.exact ? task.time : null,
    // משימה קבועה: אירוע חוזר ביומן (חוץ מ"יום אחרון בחודש", שאין לו ניסוח פשוט)
    rrule: task.kind === 'schedule' && task.schedule?.rule?.day !== 'last' ? rruleOf(task.schedule?.rule) : null,
    details: 'ממשימות: ' + APP + '#o=' + encodeURIComponent(occ.id)});
}

/* ---------- מתכונים ---------- */
// משימות/מתכונים.json: {v, recipes: [{id, title, desc, image, cat, ingredients: [טקסט], steps: [טקסט], notes,
//   prep, total, level, updatedAt, deleted}]}. מיזוג לפי id, כמו כל השאר.
// הקטגוריות לפי אתרי מתכונים (17.11.2026): לפי סוג הארוחה או המנה, ובמנה עיקרית לפי החלבון
const RECIPE_CATS = ['ארוחת בוקר', 'עוף', 'בשר', 'דגים', 'פסטה', 'תוספות', 'סלטים', 'ממרחים ורטבים', 'מרקים', 'מאפים ולחמים', 'עוגות ועוגיות', 'קינוחים', 'אחר'];
// קטגוריות מהגרסה הקודמת: אם אין ניחוש טוב יותר
const OLD_CATS = {'מנה עיקרית': 'אחר', 'בשר ועוף': 'בשר', 'סלטים וממרחים': 'סלטים', 'מאפים ובצקים': 'מאפים ולחמים', 'קינוחים ועוגות': 'קינוחים'};
function mergeRecipesFile(a, b, now){ return {v: 1, recipes: mergeById(a?.recipes, b?.recipes, now)}; }
const UNITS = 'כוסות|כוס|כפות|כף|כפיות|כפית|גרם|גר׳|ג׳|ג|קילוגרם|קילו|ק״ג|קג|ליטר|ליטרים|מ״ל|מל|יחידות|יחידה|חבילות|חבילה|' +
  'שקיות|שקית|פחיות|פחית|קופסאות|קופסה|קופסת|צנצנת|קורט|מעט|חופן|ענפים|ענף|ענפי|צרור|צרורות|שיני|שן|פרוסות|פרוסה|' +
  'מקלות|מקל|עלים|עלי|בקבוק|רבע|חצי|שליש|קצת|לפי הטעם|כמה|זוג|גביע|גביעים|מכסה|מכסות|כפיה|טיפות|טיפה|ראש|ראשי|אשכול|' +
  'נתח|נתחים|פילה|פילות|קוביות|קובייה|יח׳|יח';
const UNIT_RE = new RegExp(`^(?:(?:${UNITS})(?=\\s|$)\\s*(?:של\\s+)?)+`);
/** מצרך במתכון → שם המוצר לקניות. "2 3/4 כוסות מים קרים (650 מ"ל)" → "מים"; "3 שיני שום כתושות" → "שום". */
function ingredientProduct(line){
  if(/[:：]\s*$/.test(String(line || ''))) return null;   // כותרת משנה ("לבצק:")
  let s = shopNorm(String(line || '').replace(/\([^)]*\)/g, ' ').replace(/[*•▪·]/g, ' '));
  // "ל-24 שעות: 1/2 כפית שמרים" / "לבצק: 2 כוסות קמח": מה שאחרי הנקודתיים הוא המצרך
  const colon = /^([^:：]{1,25})[:：]\s*(.+)$/.exec(s);
  if(colon && (/^[לב]-?\s?[\d]|\d/.test(colon[1]) || /^ל[א-ת]/.test(colon[1]))) s = colon[2];
  s = s.split(/[,;:]| או | \/ /)[0];
  // כמויות בהתחלה: מספרים, שברים, טווחים, ואחריהם יחידות
  for(let i = 0; i < 4; i++){
    s = s.replace(/^[\d\s.,/\-–½¼¾⅛⅓⅔+]+/, '').trim();
    s = s.replace(UNIT_RE, '').trim();
  }
  s = s.replace(/^(?:של|את)\s+/, '').replace(/\s+(?:\d.*)$/, '').trim();
  if(!s) return null;
  const m = shopMatch(s);
  // מוצר מהרשימה: השם שלו ("קמח 00 לפיצה" → "קמח"). אחרת: עד 3 המילים הראשונות
  if(m && !m.word) return m.entry.name;
  return s.split(' ').slice(0, 3).join(' ');
}
/** משכים בשלב: "8-12 דקות", "כחצי דקה", "כשעה", "72 שעות" → [{label, minutes}] (בטווח: המספר הקטן). */
const WORD_DUR = {'שעה וחצי': 90, 'שעתיים': 120, 'חצי שעה': 30, 'רבע שעה': 15, 'חצי דקה': 1, 'שעה': 60, 'דקה': 1, 'יומיים': 2880};
const DUR_RE = /(?:(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+))?\s*|(חצי|רבע)\s+)(דקות|דקה|דק׳|שעות|שעה|ימים|יום)(?=[\s.,;)\-–]|$)|(שעה וחצי|שעתיים|חצי שעה|רבע שעה|חצי דקה|יומיים|שעה|דקה)(?=[\s.,;)\-–]|$)/g;
function durationsIn(text){
  const out = [], seen = new Set();
  // "כ-5 דקות", "כשעה", "לחצי שעה": בלי האות שלפני
  let t = ' ' + String(text || '').replace(/(^|[\s(])[כלב]-?(?=\d|חצי|רבע|שעה|שעתיים|דקה|יומיים)/g, '$1') + ' ';
  // "24/48/72 שעות" → "24 שעות 48 שעות 72 שעות"
  t = t.replace(/(\d+(?:\s*\/\s*\d+)+)\s*(דקות|שעות|ימים)/g, (m, nums, u) => nums.split('/').map(n => n.trim() + ' ' + u).join(' , '));
  let m;
  DUR_RE.lastIndex = 0;
  while((m = DUR_RE.exec(t))){
    if(/[א-ת]/.test(t[m.index - 1] || '')) continue;   // חלק ממילה אחרת
    let minutes, label;
    if(m[5]){ label = m[5]; minutes = WORD_DUR[m[5]]; }
    else{
      const unit = /דק/.test(m[4]) ? 1 : /שע/.test(m[4]) ? 60 : 1440;
      const n = m[3] ? (m[3] === 'חצי' ? 0.5 : 0.25) : +m[1].replace(',', '.');
      minutes = Math.max(1, Math.round(n * unit)); label = m[0].trim();
    }
    if(minutes > 0 && !seen.has(minutes)){ seen.add(minutes); out.push({label, minutes}); }
  }
  return out;
}
const isDurationOnly = l => { const d = durationsIn(l); return d.length > 0 && l.replace(DUR_RE, '').replace(/[\s\-–,.:]/g, '') === ''; };
/*
 * פירוק מתכון מודבק: הכללים (כל אחד נבדק בבדיקות/מתכונים/, על מתכונים אמיתיים מכמה מקורות).
 *  1. ניקוי: סימוני עיצוב (** __ #), אמוג'י, תבליטים (• - * ▪ ✓ ☐), מספור (1. 1) (1) "שלב 1:"), רווחים כפולים, שורות כפולות.
 *  2. כותרות חלקים, גם עם נקודתיים, אמוג'י, "ל-4 מנות" או באנגלית: מצרכים / אופן ההכנה / הערות.
 *  3. כותרת עם תוכן באותה שורה ("מצרכים: קמח, מים, מלח"): התוכן נכנס לחלק.
 *  4. פרטים, בשורה אחת ("זמן הכנה: 15 דקות") או בשתיים (כותרת ואז ערך): זמן הכנה, זמן בישול/אפייה, זמן כולל, רמת קושי,
 *     מנות, קישור למקור. "מאת", "צילום", "כשרות" וכדומה: מדלגים.
 *  5. כותרות משנה בתוך חלק ("לבצק:", "הכנת הרוטב:"): נשמרות כשורה שנגמרת בנקודתיים, ולא נכנסות לקניות.
 *  6. שלבים ממוספרים: שורה בלי מספר היא המשך של השלב הקודם. מספר לבד בשורה ("1.") מתחבר לשורה שאחריו.
 *  7. שורה שהיא רק משך ("5 דקות", כפתור טיימר שהועתק) לא נהיית שלב. הזמן מזוהה מתוך השלב עצמו.
 *  8. שורות של אתרים ואפליקציות: דירוג (★), "הדפסה", "שתפו", "מצב בישול", "בתיאבון": מדלגים. "תגובות", "מתכונים נוספים": עוצרים.
 *  9. אחרי הפרטים שבסוף (זמנים, קושי, קישור): שורות לא מוכרות (שם הכותב וכו') לא נכנסות.
 * 10. קישור (http) בכל מקום: קישור למקור, ולא טקסט.
 * 11. שם: השורה הראשונה. אם היא תיאור ארוך: השם נגזר מתחילתו ("סלט מטבוחה של עגבניות..." → "סלט מטבוחה").
 * 12. מצרכים בשורה אחת מופרדים בפסיקים ("כפית פפריקה, כפית כמון, מלח"): כל אחד בנפרד.
 * 13. בלי כותרות בכלל: שורה קצרה או שמתחילה בכמות = מצרך; שורה ארוכה = שלב.
 * 14. פתיח של צ'אט ("הנה מתכון...", "בשמחה!", שורה שנגמרת בנקודתיים לפני הכותרות): לא נכנס.
 * 15. שם עם מקף ("פיצה Ooni – מתכון לבצק נפוליטני"): השם לפני המקף, והשאר תיאור. "מתכון ל..." בתחילת השם יורד.
 * 16. כותרת חלק מוכרת עם טקסט אחריה ("הכנה לפני חלוקה: ...") היא שלב, לא כותרת. כותרת עם תוכן רק במילה המדויקת.
 */
const LEVELS = {'קל': 'קל', 'קלה': 'קל', 'פשוט': 'קל', 'פשוטה': 'קל', 'easy': 'קל', 'בינוני': 'בינוני', 'בינונית': 'בינוני', 'medium': 'בינוני',
  'מאתגר': 'מאתגר', 'מאתגרת': 'מאתגר', 'קשה': 'מאתגר', 'מורכב': 'מאתגר', 'מורכבת': 'מאתגר', 'hard': 'מאתגר'};
const RX = {
  junkMark: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️​-‏‪-‮*_#~`>|]/gu,
  // מספור "1." ולא מספר עשרוני "1.5"
  bullet: /^(?:[-–—•●▪▫◦·✓✔☐☑□■◆○*+]|\d{1,2}\s*[.)](?![\d/])|\(\d{1,2}\)|[א-י]\s*[.)](?=\s)|שלב\s*\d+\s*[:.)-]?)\s*/,
  numbered: /^(?:\d{1,2}\s*[.)](?![\d/])|\(\d{1,2}\)|שלב\s*\d+)/,
  numOnly: /^(?:\d{1,2}\s*[.)]?|שלב\s*\d+\s*[:.]?)$/,
  ing: /^(?:רשימת\s+)?ה?(מצרכים|מרכיבים|רכיבים|חומרים|מה צריך|ingredients)(?:\s.{0,25})?$/i,
  steps: /^(?:אופן\s+ה?הכנה|הוראות(?:\s+ה?הכנה)?|ה?הכנה|שלבי\s+ה?הכנה|דרך\s+ה?הכנה|כך\s+מכינים|איך\s+מכינים|instructions|directions|method|preparation)(?:\s.{0,20})?$/i,
  notes: /^(?:הערות|הערה|טיפים|טיפ|טיפים והערות|הערות וטיפים|notes?|tips?)$/i,
  junk: /^(?:הדפסה|הדפס|שתפו|שתף|שיתוף|שמור|שמרו|שמירה|לייק|אהבתי|מצב בישול|הוספה לרשימה|הוספה לקניות|דירוג|פרסומת|בתיאבון.*|לחצו כאן.*|קראו עוד.*|print|share|save|jump to recipe)$/i,
  rating: /[★☆⭐]|^\d(?:\.\d)?\s*\(\d+\s*(?:דירוגים|ratings?)\)/,
  stop: /^(?:תגובות|מתכונים נוספים|מתכונים דומים|עוד מתכונים|אולי יעניין|הירשמו|comments|related)/i,
  intro: /^(?:הנה|להלן|בשמחה|כמובן|בטח|אשמח|הכנתי|זה ה?מתכון|קיבלת|מצרף|מצורף|here is|here's|sure)\b|שצירפת|ששלחת|מהתמונות|מהתמונה/i,
  secExact: /^(?:ה?מצרכים|ה?מרכיבים|רכיבים|חומרים|ingredients|אופן\s+ה?הכנה|הוראות(?:\s+ה?הכנה)?|שלבי\s+ה?הכנה|instructions|directions|method|ה?הכנה|הערות|טיפים|notes?|tips?)$/i,
};
const META = [[/^(?:זמן\s+ה?הכנה|זמן\s+עבודה|prep\s*time)$/i, 'prep'], [/^(?:זמן\s+ה?(?:אפייה|בישול)|cook\s*time|bake\s*time)$/i, 'cook'],
  [/^(?:זמן\s+כולל(?:\s+להכנה)?|סה["״]?כ\s+זמן|total\s*time)$/i, 'total'], [/^(?:רמת\s+ה?קושי|דרגת\s+קושי|קושי|difficulty)$/i, 'level'],
  [/^(?:מספר\s+מנות|מנות|כמות|תפוקה|סועדים|servings|yield)$/i, 'servings'], [/^(?:קישור\s+למקור|מקור|לינק|קישור|source)$/i, 'source'],
  [/^(?:מאת|כותב|צילום|סגנון|כשרות|מטבח|קטגוריה|תגיות|author)$/i, 'skip']];
const QTY_START = new RegExp(`^(?:[\\d½¼¾⅛⅓⅔]|(?:${UNITS})(?=\\s))`);
function parseRecipeText(text){
  const r = {title: '', desc: '', ingredients: [], steps: [], notes: '', prep: '', cook: '', total: '', level: '', servings: '', source: ''};
  const notes = [], before = [], seen = new Set();
  let part = null, field = null, numbered = false, joinNext = false;
  const key = l => l.replace(RX.junkMark, '').replace(/[:：\-–—.]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const setMeta = (f, v) => {
    v = v.trim();
    if(!v || f === 'skip') return;
    if(f === 'level') r.level = LEVELS[key(v).toLowerCase()] || r.level;
    else if(f === 'source'){ const u = /https?:\/\/\S+/.exec(v); if(u) r.source = u[0]; }
    else r[f] = key(v).slice(0, 30);
  };
  const isSub = l => /[:：]$/.test(l) && key(l).length <= 25 && !/\d/.test(l);
  for(let raw of String(text || '').split(/\r?\n/)){
    raw = raw.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
    if(!raw) continue;
    // 10. קישור
    const url = /https?:\/\/\S+/.exec(raw);
    if(url){ if(!r.source) r.source = url[0]; raw = raw.replace(url[0], '').trim(); if(!key(raw)) continue; }
    const k = key(raw);
    if(!k) continue;
    // 8. אתרים ואפליקציות
    if(RX.stop.test(k)) break;
    if(RX.junk.test(k) || RX.rating.test(raw)) continue;
    // 4. פרטים (שורה אחת או שתיים)
    const mm = /^([^:：]{2,24})[:：]\s*(.*)$/.exec(raw);
    const head = key(mm ? mm[1] : raw), rest = mm ? key(mm[2]) ? mm[2].trim() : '' : '';   // "*הכנה:*": הכוכבית אחרי הנקודתיים היא לא תוכן
    const meta = META.find(([re]) => re.test(head));
    if(meta && (mm || raw.length < 30)){
      if(rest) setMeta(meta[1], rest); else field = meta[1];
      if(r.steps.length || r.ingredients.length) part = 'tail';   // 9. פרטים בסוף: מה שאחריהם לא נכנס
      continue;
    }
    if(field){ const f = field; field = null; if(raw.length <= 40){ setMeta(f, raw); continue; } }
    // 2-3. כותרות חלקים
    let sec = RX.ing.test(head) ? 'ing' : RX.steps.test(head) ? 'steps' : RX.notes.test(head) ? 'notes' : null;
    if(sec && rest && !RX.secExact.test(head)) sec = null;   // 16. "הכנה לפני חלוקה: ..." הוא שלב
    if(sec && head.length <= 35){
      part = sec; numbered = false; joinNext = false;
      if(rest) raw = rest; else continue;
    }else if(part === 'tail') continue;
    if(seen.has(raw)) continue;   // 1. שורה כפולה
    seen.add(raw);
    if(part === 'ing'){
      if(isSub(raw)){ r.ingredients.push(key(raw) + ':'); continue; }
      const c = raw.replace(RX.bullet, '').replace(RX.junkMark, '').trim();
      if(!c) continue;
      const pieces = c.split(/\s*,\s*/);
      // 12. כמה מצרכים בשורה אחת
      if(pieces.length >= 3 && pieces.every(x => x && x.length <= 25)) r.ingredients.push(...pieces);
      else r.ingredients.push(c);
    }else if(part === 'steps'){
      if(RX.numOnly.test(key(raw)) || RX.numOnly.test(raw)){ joinNext = true; numbered = true; continue; }   // 6. "1." לבד
      if(isSub(raw)){ r.steps.push(key(raw) + ':'); continue; }
      const isNum = RX.numbered.test(raw);
      const c = raw.replace(RX.bullet, '').replace(RX.junkMark, '').trim();
      if(!c || isDurationOnly(c)) continue;   // 7.
      if(isNum) numbered = true;
      const prev = r.steps[r.steps.length - 1];
      if(!joinNext && !isNum && numbered && prev && !/:$/.test(prev)) r.steps[r.steps.length - 1] = prev + ' ' + c;   // 6. המשך
      else r.steps.push(c);
      joinNext = false;
    }else if(part === 'notes'){
      const c = raw.replace(RX.bullet, '').replace(RX.junkMark, '').trim();
      if(c) notes.push(c);
    }else{
      const c = raw.replace(RX.junkMark, '').replace(/\s+/g, ' ').trim();
      // 14. פתיח של צ'אט לפני הכותרות
      if(c && !(RX.intro.test(c) || (/[:：]$/.test(c) && c.length > 30 && !r.ingredients.length && !r.steps.length))) before.push(c);
    }
  }
  r.notes = notes.join('\n');
  // 13. בלי כותרות בכלל
  if(!r.ingredients.length && !r.steps.length && before.length > 1){
    const [first, ...others] = before;
    before.length = 0; before.push(first);
    for(const l of others){
      const c = l.replace(RX.bullet, '').trim();
      (QTY_START.test(c) || (c.length <= 30 && !/[.!]$/.test(c)) ? r.ingredients : r.steps).push(c);
    }
  }
  // 15. שם עם מקף: לפני המקף שם, אחריו תיאור
  if(before.length){
    const dash = before[0].split(/\s[–—-]\s/);
    if(dash.length > 1 && dash[0].length <= 40){ before[0] = dash[0].trim(); before.splice(1, 0, dash.slice(1).join(' – ').trim()); }
    before[0] = before[0].replace(/^מתכון\s+(?:ל|של\s+)?(?=[א-ת])/, '').trim();
  }
  // 11. שם ותיאור
  if(before.length && before[0].length <= 45 && !/[.!]$/.test(before[0])){ r.title = before.shift(); r.desc = before.join(' '); }
  else if(before.length){
    r.desc = before.join(' ');
    r.title = before[0].split(/ של | עם | ש(?=[א-ת]+ )|,|\.| - | – /)[0].split(' ').slice(0, 4).join(' ').trim();
  }
  return r;
}
/* ---------- סיווג ותמונות למתכונים ---------- */
// קטגוריה לפי מילים בשם (ואם אין, במצרכים). הסדר חשוב: ספציפי קודם ("מרק עוף" = מרק, "סלט טונה" = סלט, "עוגת גבינה" = קינוח).
const PROTEIN_RULES = [
  ['דגים', ['דג', 'דגים', 'סלמון', 'טונה', 'אמנון', 'לברק', 'דניס', 'שרימפס', 'בקלה', 'מושט', 'פילה דג', 'סושי', 'פירות ים', 'קלמרי', 'מוסר', 'פורל', 'הרינג']],
  ['עוף', ['עוף', 'עופות', 'שניצל', 'שניצלים', 'פרגיות', 'פרגית', 'חזה', 'כנפיים', 'כנפי', 'הודו', 'שוקיים', 'כרעיים', 'נאגטס', 'שווארמה']],
  ['בשר', ['בשר', 'בקר', 'סטייק', 'אנטריקוט', 'צלי', 'גולש', 'פסטרמה', 'אסאדו', 'כבש', 'טלה', 'המבורגר', 'קבב', 'כבד', 'נקניק', 'נקניקיות', 'צ׳ולנט', 'חמין', 'סינטה', 'צלעות', 'קופתה', 'בולונז']],
];
// סוג המנה. המילה הראשונה בשם שמתאימה קובעת ("מרק עוף" = מרק, "סלט טונה" = סלט, "עוגת גבינה" = עוגה).
// "*" = מנה בלי סוג ברור (קציצות, תבשיל): החלבון קובע ("קציצות דגים" = דגים)
const CAT_RULES = [
  ['ארוחת בוקר', ['שקשוקה', 'חביתה', 'חביתות', 'פנקייק', 'פנקייקים', 'בלינצ׳ס', 'קרפ', 'קרפים', 'טוסט', 'גרנולה', 'דייסה', 'ביצים', 'ביצה', 'שייק', 'וופל', 'וופלים', 'פריטטה', 'יוגורט', 'סמוטי']],
  ['מרקים', ['מרק', 'מרקים']],
  ['ממרחים ורטבים', ['סלט מטבוחה', 'סלט חצילים', 'מטבוחה', 'חומוס', 'ממרח', 'טחינה', 'באבא', 'מטבל', 'סלסה', 'צזיקי', 'גוואקמולי', 'פסטו', 'מיונז', 'רוטב', 'איולי', 'ריבה', 'סחוג', 'עמבה']],
  ['סלטים', ['סלט', 'סלטים', 'קולסלאו', 'טאבולה', 'פטוש']],
  ['עוגות ועוגיות', ['עוגה', 'עוגת', 'עוגות', 'עוגיות', 'עוגייה', 'עוגיית', 'מאפינס', 'בראוניז', 'רוגלך', 'קאפקייקס', 'טארט', 'שטרודל']],
  ['קינוחים', ['קינוח', 'קינוחים', 'מוס', 'פודינג', 'גלידה', 'טירמיסו', 'קרם', 'פנקוטה', 'מלבי', 'סורבה', 'כדורי שוקולד', 'שוקולד', 'טראפלס', 'חטיף', 'חטיפי']],
  ['מאפים ולחמים', ['לחם', 'חלה', 'חלות', 'פיצה', 'בצק', 'מאפה', 'מאפים', 'בורקס', 'פוקאצ׳ה', 'פוקצ׳ה', 'לחמניות', 'פיתות', 'פיתה', 'פשטידה', 'קיש', 'פאי', 'מלוואח', 'ג׳חנון', 'באגט', 'כעכים', 'בייגל', 'טורטיה', 'לאפה', 'סמבוסק']],
  ['פסטה', ['פסטה', 'ספגטי', 'לזניה', 'ניוקי', 'פטוצ׳יני', 'מקרוני', 'פנה', 'רביולי', 'נודלס', 'פפרדלה', 'טורטליני']],
  ['תוספות', ['אורז', 'תפוחי אדמה', 'תפו״א', 'צ׳יפס', 'פירה', 'פתיתים', 'קוסקוס', 'מג׳דרה', 'בורגול', 'קינואה', 'ירקות', 'ריזוטו', 'פולנטה', 'חצילים', 'קישואים', 'כרובית', 'ברוקולי', 'שעועית', 'עדשים', 'לביבות', 'בטטה', 'אטריות']],
  ...PROTEIN_RULES,
  ['*', ['קציצות', 'קציצה', 'כדורי', 'כדורים', 'שיפודים', 'ממולאים', 'ממולא', 'תבשיל', 'קדרה', 'מוקפץ', 'קארי', 'צלוי', 'בתנור']],
];
/** קטגוריה לפי המצרכים, כשהשם לא מספיק: החלבון העיקרי, ואם אין, אפייה מתוקה או בצק שמרים. */
function catFromIngredients(r){
  const ing = (r.ingredients || []).filter(x => !/[:：]\s*$/.test(x)).map(x => ' ' + shopNorm(String(x)) + ' ');
  if(!ing.length) return '';
  const has = w => ing.some(l => l.includes(' ' + w));
  const score = PROTEIN_RULES.map(([k, l]) => [k, ing.filter(x => l.some(w => x.includes(' ' + w + ' ') || x.includes(' ' + w))).length]).sort((a, b) => b[1] - a[1]);
  if(score[0][1]) return score[0][0];
  if(has('קמח') && has('סוכר') && (has('אבקת אפייה') || has('ביצ') || has('חמאה') || has('שוקולד'))) return 'עוגות ועוגיות';
  if(has('קמח') && has('שמרים')) return 'מאפים ולחמים';
  if(['פסטה', 'ספגטי', 'פנה', 'לזניה'].some(has)) return 'פסטה';
  return '';
}
const hasWord = (text, w) => { const t = ' ' + shopNorm(text).replace(/[^\u0590-\u05FFa-z0-9׳ ]/g, ' ') + ' ';
  return w.includes(' ') ? t.includes(' ' + w + ' ') || t.includes(' ' + w) : t.split(' ').some(x => x === w || (x.length > 2 && sameWord(x, w)) || x.replace(/^[והבלמש]/, '') === w); };
/** קטגוריה משוערת למתכון לפי השם, או '' אם לא ברור. */
/** המילה הראשונה בשם שמתאימה לכלל: "כדורי בשר ברוטב עגבניות" = כדורי בשר (לפני "רוטב"). "מתכון ל" בהתחלה לא נספר. */
function firstMatch(title, rules){
  const words = shopNorm(title).replace(/^מתכון\s+(?:ל|של\s+)?/, '').replace(/[^\u0590-\u05FFa-z0-9׳ ]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w.length > 3 && /^[והבלמש]/.test(w) ? [w, w.slice(1)] : [w]);
  let best = null;
  rules.forEach(([key, list], ri) => {
    for(const w of list){
      const parts = w.split(' ');
      for(let i = 0; i + parts.length <= words.length; i++){
        if(parts.every((p, j) => words[i + j].some(x => x === p || (x.length > 2 && sameWord(x, p))))){
          if(!best || i < best.i || (i === best.i && ri < best.ri)) best = {key, i, ri};
          break;
        }
      }
    }
  });
  return best ? best.key : '';
}
/** קטגוריה משוערת: סוג המנה מהשם, אחר כך החלבון (בשם או במצרכים). '' = לא ברור. */
function guessRecipeCat(r){
  const t = firstMatch(r.title || '', CAT_RULES);
  if(t && t !== '*') return t;
  return firstMatch(r.title || '', PROTEIN_RULES) || catFromIngredients(r) || '';
}
const recipeCat = r => (RECIPE_CATS.includes(r.cat) && r.cat !== 'אחר' ? r.cat : '') || guessRecipeCat(r) || OLD_CATS[r.cat] || 'אחר';

/* ---------- יציאה מהבית: מה לקחת, לפי מה שיש היום ---------- */
const LEAVE_RULES = [
  [['אימון', 'אימונים', 'חדר כושר', 'כושר', 'ספינינג', 'פילאטיס', 'יוגה', 'ריצה', 'קרוספיט', 'כדורגל', 'כדורסל', 'טניס', 'פדל', 'סטודיו', 'gym'], ['🎽 בגדי אימון', '👟 נעלי ספורט', '🧴 מגבת', '💧 בקבוק מים', '🎧 אוזניות']],
  [['בריכה', 'שחייה', 'חוף', 'לים', 'בים', 'חוף הים'], ['🩱 בגד ים', '🧴 מגבת', '🕶️ משקפי שמש', '☀️ קרם הגנה']],
  [['רופא', 'רופאה', 'תור', 'מרפאה', 'קופת חולים', 'בית חולים', 'בדיקת דם', 'בדיקה', 'שיניים'], ['🪪 תעודת זהות', '📄 הפניות ומסמכים']],
  [['טיסה', 'נתב״ג', 'נתב"ג', 'שדה תעופה', 'נמל תעופה', 'חו״ל'], ['🛂 דרכון', '🔌 מטען', '🎧 אוזניות']],
  [['ראיון', 'ראיון עבודה'], ['📄 קורות חיים', '🪪 תעודת זהות']],
  [['יום הולדת', 'חתונה', 'בר מצווה', 'בת מצווה', 'ברית', 'מסיבה'], ['🎁 מתנה']],
  [['טסט', 'רישוי', 'מוסך'], ['🚗 רישיון רכב ורישיון נהיגה']],
  [['סופר', 'קניות', 'שוק'], ['🛍️ שקיות']],
  [['בנק', 'דואר', 'משרד הפנים'], ['🪪 תעודת זהות']],
];
/** מה לקחת: מהמילים בשמות של מה שיש היום (משימות, אירועים), בלי כפילויות. */
function leaveItems(titles){
  const out = [];
  for(const t of titles || []) for(const [words, items] of LEAVE_RULES) if(firstMatch(String(t), [['x', words]])) for(const i of items) if(!out.includes(i)) out.push(i);
  return out;
}

/* ---------- כמויות: פי 2, חצי ---------- */
const FRAC = {'½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125};
/** כמות יפה: 1.5 → "1½", 0.25 → "¼", 125 → "125". */
function fmtQty(x){
  if(!(x > 0)) return '0';
  if(x >= 20) return String(Math.round(x));
  const w = Math.floor(x + 1e-9), f = x - w;
  const opts = [[0, ''], [.25, '¼'], [1 / 3, '⅓'], [.5, '½'], [2 / 3, '⅔'], [.75, '¾'], [1, '']];
  let best = opts[0]; for(const o of opts) if(Math.abs(f - o[0]) < Math.abs(f - best[0])) best = o;
  if(Math.abs(f - best[0]) > .07) return String(+x.toFixed(1));
  const ww = w + (best[0] === 1 ? 1 : 0);
  return ww ? ww + best[1] : best[1];
}
const QN = '(?:\\d+(?:[.,]\\d+)?(?:\\s+\\d+\\/\\d+)?|\\d+\\/\\d+|\\d*[½¼¾⅓⅔⅛])';
const Q_RE = new RegExp(`(${QN})(\\s*[-–]\\s*(${QN}))?`, 'g');
const qVal = s => { s = s.replace(',', '.'); let m;
  if((m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s))) return +m[1] + m[2] / m[3];
  if((m = /^(\d+)\/(\d+)$/.exec(s))) return m[1] / m[2];
  if((m = /^(\d*)([½¼¾⅓⅔⅛])$/.exec(s))) return (+m[1] || 0) + FRAC[m[2]];
  return +s; };
const SCALE_UNIT = /^\s*(?:כוסות|כוס|כפות|כף|כפיות|כפית|גרם|גר׳|ג׳|ג|קילוגרם|קילו|ק״ג|קג|ליטר|ליטרים|מ״ל|מ"ל|מל|ק"ג|יחידות|יחידה|חבילות|חבילה|שקיות|שקית|פחיות|פחית|קופסאות|קופסה|קופסת|שיני|שן|פרוסות|פרוסה|ביצים|ביצה|g|ml|kg)(?![א-ת])/;
/** מצרך בכמות אחרת: "2 כוסות קמח" ×½ → "1 כוסות קמח"; "חצי כוס" ×2 → "1 כוס"; "(650 מ״ל)" גם. */
function scaleLine(line, f){
  const s = String(line ?? '');
  if(!f || f === 1 || /[:：]\s*$/.test(s)) return s;
  const lead = /^(\s*)(חצי|רבע|שליש)(?=\s)/.exec(s);
  if(lead) return lead[1] + fmtQty({'חצי': .5, 'רבע': .25, 'שליש': 1 / 3}[lead[2]] * f) + s.slice(lead[0].length);
  // "קילו קמח", "כוס סוכר" (בלי מספר) = 1
  const unitOnly = /^(\s*)(?=(?:קילו|ק״ג|ק"ג|כוס|כף|כפית|ליטר|חבילה|שקית|פחית|קופסה|קופסת|צנצנת|גביע|פרוסה|יחידה)(?![א-ת]))/.exec(s);
  if(unitOnly && !/^\s*\d/.test(s)) return unitOnly[1] + fmtQty(f) + ' ' + s.slice(unitOnly[0].length);
  const start = s.search(/\S/);
  return s.replace(Q_RE, (m, a, rng, b, off) => {
    if(off !== start && !SCALE_UNIT.test(s.slice(off + m.length))) return m;
    if(/[א-תa-z0-9]/i.test(s[off - 1] || '')) return m;
    return fmtQty(qVal(a) * f) + (rng ? '-' + fmtQty(qVal(b) * f) : '');
  });
}
/** "4 מנות" ×2 → "8 מנות". */
const scaleServings = (v, f) => f === 1 || !v ? v : String(v).replace(/\d+(?:[.,]\d+)?/g, n => fmtQty(+n.replace(',', '.') * f));
/** מצב בישול: לכל שלב, המצרכים שמוזכרים בו, עם הכמות. "להוסיף את הסוכר" → "1 כוס סוכר". */
function stepIngredients(step, ingredients, f){
  const text = ' ' + shopNorm(String(step || '')).replace(/[^\u0590-\u05FFa-z0-9׳ ]/g, ' ') + ' ';
  // "והביצים" → ביצים: עד שתי אותיות בהתחלה (ו, ה, ב, ל, מ, ש)
  const words = text.split(/\s+/).filter(Boolean).map(w => { const v = [w]; let x = w;
    for(let i = 0; i < 2 && x.length > 3 && /^[והבלמש]/.test(x); i++){ x = x.slice(1); v.push(x); } return v; });
  const out = [];
  for(const line of ingredients || []){
    if(/[:：]\s*$/.test(line)) continue;
    const prod = ingredientProduct(line); if(!prod) continue;
    const key = shopNorm(prod).split(' ')[0];
    if(key.length < 2) continue;
    if(words.some(ws => ws.some(w => w === key || (w.length > 2 && sameWord(w, key)) || (key.length > 3 && w.startsWith(key))))) out.push(scaleLine(line, f || 1));
  }
  return out;
}

/* ---------- שעות שינה (מהטלפון: מתי המסך כבה ומתי נפתח) ---------- */
/**
 * events: [{t, k: 'on' | 'off' | 'unlock'}] מהטלפון. שימוש = מפתיחת הטלפון (או הדלקת מסך, אם אין נעילה) ועד שהמסך כבה.
 * שינה = ההפסקה הארוכה ביותר בכל לילה (מתחילה בין 19:00 ל-6:00, לפחות 3 שעות). הצצה קצרה באמצע הלילה (עד 5 דקות,
 * עם שעה לפחות לפני ואחרי) לא קוטעת את השינה ונספרת כהתעוררות. מחזיר [{date, sleep, wake, mins, wakeups}], החדש קודם.
 */
function sleepNights(events, nowMs){
  const ev = (events || []).filter(e => e && +e.t).slice().sort((a, b) => a.t - b.t);
  const startK = ev.some(e => e.k === 'unlock') ? 'unlock' : 'on';
  let S = [], cur = null;
  for(const e of ev){
    if(e.k === startK){ if(!cur) cur = {a: e.t}; }
    else if(e.k === 'off' && cur){ cur.b = Math.max(e.t, cur.a); S.push(cur); cur = null; }
  }
  if(cur) S.push({a: cur.a, b: nowMs || cur.a});
  const brief = new Set();
  for(let i = 1; i < S.length - 1; i++)
    if(S[i].b - S[i].a <= 5 * 6e4 && S[i].a - S[i - 1].b >= 36e5 && S[i + 1].a - S[i].b >= 36e5) brief.add(i);
  const keep = S.filter((x, i) => !brief.has(i)), nights = {};
  for(let i = 0; i + 1 < keep.length; i++){
    const from = keep[i].b, to = keep[i + 1].a, h = +localTime(from).slice(0, 2);
    if(to - from < 3 * 36e5 || !(h >= 19 || h < 6)) continue;
    const date = localDate(from - 12 * 36e5), wakeups = S.filter((x, j) => brief.has(j) && x.a > from && x.b < to).length;
    if(!nights[date] || to - from > nights[date].wake - nights[date].sleep) nights[date] = {date, sleep: from, wake: to, mins: Math.round((to - from) / 6e4), wakeups};
  }
  return Object.values(nights).sort((a, b) => b.date.localeCompare(a.date));
}
// תמונות (TheMealDB: 141 שנבחרו ביד, ועוד כ-580 לפי סוג המנה). קבוצה לפי מילה בשם; בתוך קבוצה: כל מתכון מקבל תמונה אחרת.
const IMG_BASE = 'https://www.themealdb.com/images/media/meals/';
// נבחרו ביד לפי מה שבתמונה (16.11.2026): בכל קבוצה הראשונות הן המתאימות ביותר
const RECIPE_IMAGES = {
  fish: ["4o4wh11761848573.jpg", "1520084413.jpg", "tqd7s21763780609.jpg", "yx8j1i1763484612.jpg", "p02vq41763754350.jpg", "uwxusv1487344500.jpg", "9q1ci41779735714.jpg"],
  salmon: ["1548772327.jpg", "xxyupu1468262513.jpg", "1549542994.jpg"],
  chicken: ["nlxald1764112200.jpg", "ro8mzj1763800655.jpg", "4hzyvq1763792564.jpg", "qptpvt1487339892.jpg", "hcg6l91763596970.jpg", "qpxvuq1511798906.jpg", "tytyxu1515363282.jpg", "feh9k21784665694.jpg", "kvbotn1581012881.jpg"],
  beef: ["kgfh3q1763075438.jpg", "pkopc31683207947.jpg", "vtqxtu1511784197.jpg", "ursuup1487348423.jpg", "vvpprx1487325699.jpg", "vussxq1511882648.jpg", "n1hcou1628770088.jpg", "sxxpst1468569714.jpg", "lmwaf61783805434.jpg"],
  salad: ["bqx8mc1782684286.jpg", "6awyvm1782685205.jpg", "93iok31766436070.jpg", "7whfgi1782678933.jpg", "ei21r61764365935.jpg", "k29viq1585565980.jpg", "tbj1bs1764118062.jpg", "dbazbg1763779999.jpg", "fqpqml1764359125.jpg", "wvqpwt1468339226.jpg"],
  dip: ["hkz4k71782590338.jpg", "gpon5u1763801180.jpg", "dlmh401760524897.jpg", "8c8m4q1763791156.jpg", "flrajf1762341295.jpg"],
  bread: ["fm01ky1764366365.jpg", "lmc6r51764365554.jpg", "hem6gk1784664868.jpg", "54xzk31760524666.jpg", "8825lo1763815264.jpg", "5u37fy1764116774.jpg", "xceagx1784662211.jpg", "l6hj9a1784668199.jpg", "lz9rw91779733434.jpg"],
  dessert: ["uttuxy1511382180.jpg", "v5jrnn1764362830.jpg", "gkcdpl1764441325.jpg", "swttys1511385853.jpg", "uuxwvq1483907861.jpg", "vmz7gl1614350221.jpg", "9kmyly1784660555.jpg", "ryspuw1511786688.jpg", "xqqqtu1511637379.jpg", "ytme8t1764111401.jpg"],
  veg: ["wrpwuu1511786491.jpg", "u5e9qq1763795441.jpg", "oga0ax1780089591.jpg", "w0rsga1782683912.jpg", "yoj48r1763817100.jpg", "b66myb1683207208.jpg", "vpxyqt1511464175.jpg", "iydbwy1763816111.jpg"],
  pasta: ["sutysw1468247559.jpg", "0jv5gx1661040802.jpg", "wtsvxx1511296896.jpg", "llcbn01574260722.jpg", "ustsqw1468250014.jpg", "rvxxuy1468312893.jpg", "wxswxy1511452625.jpg", "usywpp1511189717.jpg"],
  side: ["qywups1511796761.jpg", "j223gc1784579841.jpg", "xw1ruy1763786501.jpg", "kw92t41604181871.jpg", "2ncui81784396094.jpg"],
  pizza: ["wf49qs1763075222.jpg", "x0lk931587671540.jpg"],
  shrimp: ["dxs5t71782678369.jpg", "e2kcut1782591669.jpg", "4xcfai1763765676.jpg"],
  meatball: ["72fgzj1764109947.jpg", "8rfd4q1764112993.jpg", "lhqev81565090111.jpg", "gjjlzc1782496055.jpg", "lgmnff1763789847.jpg", "04axct1763793018.jpg"],
  burger: ["44bzep1761848278.jpg", "k420tj1585565244.jpg", "vdwloy1713225718.jpg"],
  lamb: ["8xuvhj1763794991.jpg", "p9tebp1764118792.jpg", "ttfxxn1762773067.jpg", "jyylmo1763790808.jpg"],
  rice: ["5r5rvx1763287943.jpg", "j8c1d51782772399.jpg", "wuyd2h1765655837.jpg", "c6ghxm1763335584.jpg", "zg2b9l1760524940.jpg"],
  soup: ["x2fw9e1560460636.jpg", "sqpqtp1515365614.jpg", "xxtsvx1511814083.jpg", "x0mreq1784577446.jpg", "7n8su21699013057.jpg", "xvrrux1511783685.jpg", "1brbso1763585098.jpg", "stpuws1511191310.jpg"],
  eggs: ["g373701551450225.jpg", "eo0yfb1763600916.jpg", "wpkfin1763597958.jpg", "30s7vf1763741844.jpg", "47y6ii1765658818.jpg"],
  cake: ["tqrrsq1511723764.jpg", "c0gmo31766594751.jpg", "vrspxv1511722107.jpg", "wxyvqq1511723401.jpg", "qxuqtt1511724269.jpg", "wtqrqw1511639627.jpg", "urtqut1511723591.jpg"],
  cookies: ["yleo1y1784839077.jpg", "sktequ1764447186.jpg", "1544384070.jpg", "txce0y1782494894.jpg", "qidask1779650423.jpg", "y75q5j1782685779.jpg"],
  pie: ["ysxwuq1487323065.jpg", "yrstur1511816601.jpg", "stnxzp1784835840.jpg", "ruwpww1511817242.jpg", "qe8pf51576795532.jpg", "usuqtp1511385394.jpg"],
  potato: ["1550441882.jpg", "z458v91763817681.jpg", "sxrpws1511555907.jpg"],
  breakfast: ["jvjnoh1780086318.jpg", "hqaejl1695738653.jpg"]
};
// עוד תמונות (17.11.2026): כל המנות ב-TheMealDB (בלי חזיר), לפי סוג המנה. נכנסות אחרי אלה שנבחרו ביד, כך שהמתאימות נשארות ראשונות
const RECIPE_IMAGES_MORE = {"shrimp":["dxs5t71782678369.jpg","e2kcut1782591669.jpg","4xcfai1763765676.jpg","jg4r991779916649.jpg","usywpp1511189717.jpg","u2lhqb1763331899.jpg","n7h5zs1765318909.jpg","bx07m71764792853.jpg","1525873040.jpg","rvypwy1503069308.jpg","9nh4dl1766435484.jpg","rtwwvv1511799504.jpg","0iryz91763778419.jpg","96lt871763480970.jpg","u03xhi1763308917.jpg","1529445434.jpg","fpl3mv1766433431.jpg","f3cxnc1765656994.jpg","sl6vqv1763335988.jpg","568t931763584227.jpg","1c5oso1614347493.jpg","hblwvg1763478203.jpg","qqlwv91763501559.jpg","9c5nlx1763424766.jpg","l50vz41763422681.jpg","9r2xrg1763771238.jpg"],"side":["iuws3q1783801530.jpg","jyvy8u1783800448.jpg","5jdtie1763289302.jpg","o2cd4r1764113576.jpg","ejht7k1780092390.jpg","dlmh401760524897.jpg","fg7d641784666908.jpg","skzd0x1780091674.jpg","tkxquw1628771028.jpg","16zbeu1763789342.jpg","ussyxw1515364536.jpg","gpz67p1560458984.jpg","fm01ky1764366365.jpg","7i6csk1780094394.jpg","p6hgrj1782851874.jpg","45noa31782850540.jpg","bza0g51782856541.jpg","58oia61564916529.jpg","brhaoj1780086661.jpg","lyr07q1782505714.jpg","lqshrh1779648160.jpg","cbfy1c1784672521.jpg","wvpvsu1511786158.jpg","849jd81763075251.jpg","ytttsv1511798734.jpg","9f4z6v1598734293.jpg","vwwspt1487394060.jpg","qcprt21782497529.jpg","io2u3z1779551885.jpg","gpon5u1763801180.jpg","8x0vgs1780090328.jpg","tsdbcq1764795636.jpg","g6xb8m1764875029.jpg","dd7t4d1764877271.jpg","paejva1765321314.jpg","8wynv41782686271.jpg","xajyjk1780091885.jpg","mlchx21564916997.jpg","44pjrn1779814409.jpg","5sgsob1763196284.jpg","bjeq6g1782505296.jpg","8hx4fi1780087744.jpg","ukeksq1784395551.jpg","oemdp11779556068.jpg","xd9aj21740432378.jpg","ug6bwk1779556566.jpg","o7p9581608589317.jpg","i5o2b61763739053.jpg","wwuqvt1487345467.jpg","vgsipt1779917593.jpg","45xxr21593348847.jpg","vvn5f71764360273.jpg","uuyrrx1487327597.jpg","h5qmn31763304965.jpg","urq5w21777540535.jpg","crd1jz1763592990.jpg","8c8m4q1763791156.jpg","hkz4k71782590338.jpg","oga0ax1780089591.jpg","s5d8ha1784666032.jpg","sxwquu1511793428.jpg","1wj8w31763781990.jpg","ypuxtw1511297463.jpg","3hcy191764376285.jpg","x5qz5k1761595900.jpg","0umm891763364625.jpg"],"meatball":["04axct1763793018.jpg","8rfd4q1764112993.jpg","gjjlzc1782496055.jpg","lhqev81565090111.jpg","72fgzj1764109947.jpg","prjve31763486864.jpg"],"eggs":["grhn401765687086.jpg","hqaejl1695738653.jpg","rwvw8q1765660071.jpg","vayi021784668764.jpg","c7lzrl1683208757.jpg","47y6ii1765658818.jpg","y7h0lq1683208991.jpg","yvpuuy1511797244.jpg","bopa2i1683209167.jpg","qwtrtp1511799242.jpg","ysqrus1487425681.jpg","g373701551450225.jpg","wpkfin1763597958.jpg","1oz4nb1765687990.jpg","yqwtvu1487426027.jpg","2dsltq1560461468.jpg","eo0yfb1763600916.jpg","4uje7l1763762276.jpg","30s7vf1763741844.jpg"],"veg":["3m8yae1763257951.jpg","zub3s91764110535.jpg","urtpqw1487341253.jpg","ra2k8a1764365055.jpg","qwicc91764368097.jpg","81ahfr1784394567.jpg","z267f71764364072.jpg","xjii2g1784836867.jpg","tvtxpq1511464705.jpg","w0rsga1782683912.jpg","81j8iu1782590903.jpg","wuxrtu1483564410.jpg","9tllzd1782853513.jpg","pb6mj11763788331.jpg","u5e9qq1763795441.jpg","21yc5s1760524759.jpg","wssvvs1511785879.jpg","lvn2d51598732465.jpg","ytogg31784397116.jpg","b79r6f1585566277.jpg","yoj48r1763817100.jpg","ctw3ba1763788978.jpg","k1if4d1782589892.jpg","xihv0c1764447887.jpg","walmi81779552709.jpg","1bsv1q1560459826.jpg","x26z3y1780155760.jpg","sywrsu1511463066.jpg","4er7mj1598733193.jpg","xxpqsy1511452222.jpg","9tddhg1764443699.jpg","ssyqwr1511451678.jpg","8a8fu01762772651.jpg","0ljvc51763248075.jpg","bvg8sn1763298713.jpg","0nswfe1763279040.jpg","wrpwuu1511786491.jpg","ppodrp1762325183.jpg","xrrwpx1487347049.jpg","ckbx1h1764123606.jpg","gqlxgc1764368767.jpg","i0610h1765659464.jpg","j9nray1765657692.jpg","uwxqwy1483389553.jpg","quuxsx1511476154.jpg","7b862e1763194846.jpg","wspuvp1511303478.jpg","b66myb1683207208.jpg","60o82j1762341177.jpg","rqtxvr1511792990.jpg","vpxyqt1511464175.jpg","n3xxd91598732796.jpg","e2g2r21764367568.jpg","p5m3w21779644533.jpg","minfsc1763766806.jpg","va668f1683209318.jpg","sonirb1763782831.jpg","vptwyt1511450962.jpg","wqurxy1511453156.jpg","f698g91763768731.jpg","wrustq1511475474.jpg"],"dessert":["a4kgf21763075288.jpg","adxcbq1619787919.jpg","xvsurr1511719182.jpg","p277uc1764109195.jpg","y4t9zg1777628842.jpg","dokbyt1779645030.jpg","jp09191782856005.jpg","5pmn0g1779813285.jpg","yk78uc1763075719.jpg","bjtjyl1779552068.jpg","ytme8t1764111401.jpg","6v583k1780093743.jpg","ryppsv1511815505.jpg","gl92ih1789802951.jpg","rpvptu1511641092.jpg","e756bf1761848342.jpg","dg7tad1782588053.jpg","1549542877.jpg","9kecho1784575366.jpg","h7zrys1779736460.jpg","z1hz7z1765316430.jpg","k9o0xr1764373018.jpg","uttuxy1511382180.jpg","1550442508.jpg","erzs951763296201.jpg","8oupz51761848432.jpg","u9ezi21764375474.jpg","twspvx1511784937.jpg","f9u0lk1784397769.jpg","vvusxs1483907034.jpg","r33cud1576791081.jpg","nxnny61763250596.jpg","1d85821576790598.jpg","gp1sj51783799928.jpg","46uazv1782588877.jpg","0h1b7m1764120235.jpg","pjbaq11784731571.jpg","x73ll91763247842.jpg","u4scbo1764446514.jpg","jyjlhj1763075323.jpg","cz1d6v1777627421.jpg","8cvkcz1766596315.jpg","1ugsho1763248007.jpg","uuxwvq1483907861.jpg","kzi6p51764787198.jpg","dm8kee1779553541.jpg","0s80wo1764374393.jpg","u6wbby1784832845.jpg","rw64di1766595573.jpg","1xscby1764790242.jpg","xrysxr1483568462.jpg","ysqupp1511640538.jpg","ul2uy31764794321.jpg","76nffj1763593933.jpg","4i5cnx1587672171.jpg","j2n7vg1761848636.jpg","u1gisz1784732667.jpg","fnh40v1782853788.jpg","4ae5tp1782506270.jpg","tmc6ai1782851531.jpg","qe8pf51576795532.jpg","vwuprt1511813703.jpg","s9qyzd1764790772.jpg","z9g8011763075640.jpg","6aj3wy1784661564.jpg","sumomx1784395153.jpg","gkcdpl1764441325.jpg","ssxvup1511387476.jpg","x6jqog1764359857.jpg","wii0591764375062.jpg","yqqqwu1511816912.jpg","v5jrnn1764362830.jpg","vtxyxv1483567157.jpg","6ut2og1619790195.jpg","wxfmk41777628643.jpg","si2rty1763282314.jpg","xqvyqr1511638875.jpg","xqqqtu1511637379.jpg","xrptpq1483909204.jpg","oe8rg51699014028.jpg","d6o4nu1763362422.jpg","rsqwus1511640214.jpg","xihiu41762773169.jpg","mjgl9z1784393681.jpg","txsupu1511815755.jpg","3wnyvh1764373818.jpg","uryqru1511798039.jpg","qawvoy1777627952.jpg"],"bread":["se5vhk1764114880.jpg","ymk7gt1783803106.jpg","sr7chd1780264758.jpg","5vhbzt1782239221.jpg","sl7cr91782588539.jpg","xqwwpy1483908697.jpg","lmwaf61783805434.jpg","6utn1w1782237402.jpg","z672jx1780263633.jpg","dk70uv1784670127.jpg","fnfnhi1784671116.jpg","vqpwrv1511723001.jpg","as88dq1762772486.jpg","hem6gk1784664868.jpg","u1996p1784670686.jpg","ae6clc1760524712.jpg","0wmns51784837949.jpg","q8sp3j1593349686.jpg","8825lo1763815264.jpg","xceagx1784662211.jpg","08c5f41764791918.jpg","5u37fy1764116774.jpg","9aia021779646058.jpg","l6hj9a1784668199.jpg","lz9rw91779733434.jpg","um1phx1782504510.jpg","kwmdk41764120884.jpg","6ebldy1784672108.jpg","iydbwy1763816111.jpg","lmc6r51764365554.jpg","i8l2fu1763742525.jpg","54xzk31760524666.jpg","5mfmh01780158856.jpg","u9l7k81628771647.jpg"],"salad":["tbj1bs1764118062.jpg","02s6gc1763799560.jpg","6awyvm1782685205.jpg","q21suk1782772956.jpg","k29viq1585565980.jpg","5q88l31784664151.jpg","ei21r61764365935.jpg","ji3mho1782499823.jpg","wvqpwt1468339226.jpg","zry07j1763779321.jpg","7ytdtz1784833420.jpg","fqpqml1764359125.jpg","ebvuir1699013665.jpg","2i0plx1784837241.jpg","93iok31766436070.jpg","bqx8mc1782684286.jpg","7whfgi1782678933.jpg","urtwux1486983078.jpg","st9shl1763755808.jpg","z458v91763817681.jpg","dbazbg1763779999.jpg","6g3rso1763486069.jpg","pk8wtn1763758591.jpg"],"fish":["diuub11782687570.jpg","jvjnoh1780086318.jpg","jc6oub1763196663.jpg","qqwhw51780093126.jpg","r7mcjm1780261264.jpg","4o4wh11761848573.jpg","uvuyxu1503067369.jpg","73o3vq1765317873.jpg","wkhwqr1782774765.jpg","nmtq3n1782772031.jpg","9q1ci41779735714.jpg","1520084413.jpg","a15wsa1614349126.jpg","nv5lf31628771380.jpg","yhi46r1763330279.jpg","rprcc51782774240.jpg","ze8uwg1763196123.jpg","wuvryu1468232995.jpg","lpd4wy1614347943.jpg","5rk8vc1779740302.jpg","xquakq1619787532.jpg","wai9bw1619788844.jpg","rg9ze01763479093.jpg","cp74zo1762341241.jpg","uwxusv1487344500.jpg","yxiilf1763759428.jpg","njj1681763297231.jpg","vytypy1511883765.jpg","tqd7s21763780609.jpg","wqqvyq1511179730.jpg","7ttta31593350374.jpg","g046bb1663960946.jpg","yx8j1i1763484612.jpg","yypwwq1511304979.jpg","p02vq41763754350.jpg"],"cookies":["q47rkb1762324620.jpg","y75q5j1782685779.jpg","t3r3ka1560461972.jpg","yypvst1511386427.jpg","txce0y1782494894.jpg","f9qog11784574376.jpg","yleo1y1784839077.jpg","sktequ1764447186.jpg","qidask1779650423.jpg","35kejr1763599712.jpg","1544384070.jpg","7mxnzz1593350801.jpg"],"cake":["c0gmo31766594751.jpg","sywswr1511383814.jpg","ywwrsp1511720277.jpg","xlqqhw1764369924.jpg","0206h11699013358.jpg","tkwxmv1777540463.jpg","h68o161782679437.jpg","vrspxv1511722107.jpg","2mrghf1782773422.jpg","tqtywx1468317395.jpg","ldnrm91576791881.jpg","sgqy9d1784832045.jpg","wxyvqq1511723401.jpg","oaqz9f1766593912.jpg","uwq8001777540502.jpg","wtqrqw1511639627.jpg","eqnf3p1779649407.jpg","9zqrod1763075574.jpg","vfybi01780261706.jpg","y2irzl1585563479.jpg","gdn1ot1763075684.jpg","x7cbsp1779811798.jpg","urtqut1511723591.jpg","tzt3it1764363293.jpg","swttys1511385853.jpg","fycrai1782690897.jpg","c400ok1764439058.jpg","rwuyqx1511383174.jpg","qxuqtt1511724269.jpg","qtuuys1511387068.jpg","xvgpng1764121726.jpg","yh3sg71763741307.jpg","e8ihjp1764123021.jpg","58bkyo1593350017.jpg","tqrrsq1511723764.jpg","xqrwyr1511133646.jpg","fx0exq1779646651.jpg","de83k51763075604.jpg","6s3i3p1763488540.jpg","y4jpgq1560459207.jpg","qxutws1486978099.jpg","towo9c1763814590.jpg"],"pie":["wxywrq1468235067.jpg","stnxzp1784835840.jpg","ax643t1784731109.jpg","wyrqqq1468233628.jpg","sytuqu1511553755.jpg","wrssvt1511556563.jpg","wpputp1511812960.jpg","oal8x31764119345.jpg","qtqwwu1511792650.jpg","rqvwxt1511384809.jpg","wurrux1468416624.jpg","pvfkz61761595976.jpg","zy4fs51777540384.jpg","ne5wzp1764115568.jpg","ysxwuq1487323065.jpg","6ht8141764786479.jpg","qpqtuu1511386216.jpg","ae4rwb1779645576.jpg","sxrpws1511555907.jpg","kpiu4t1782242131.jpg","uh1n5u1763075545.jpg","vssrtx1511557680.jpg","xwutvy1511555540.jpg","h031jy1782853081.jpg","rxvxrr1511797671.jpg","vmz7gl1614350221.jpg","usuqtp1511385394.jpg","s5o6521784834958.jpg","ruwpww1511817242.jpg","5xdrkw1764444472.jpg","8ovxf41763253962.jpg","qysyss1511558054.jpg","178z5o1585514569.jpg","9kmyly1784660555.jpg","yrstur1511816601.jpg","ryspuw1511786688.jpg","spswqs1511558697.jpg","x8opo81777582259.jpg","wprvrw1511641295.jpg","w8umt11583268117.jpg","zjtfp31764440795.jpg"],"potato":["pa03n41777540582.jpg","flrajf1762341295.jpg","j223gc1784579841.jpg","9ya6o71780262651.jpg","de0sns1779555283.jpg","qywups1511796761.jpg","1550441882.jpg","mp9z0i1782238092.jpg","zdyurx1783801146.jpg","vz94r81760534692.jpg","b5ft861583188991.jpg","kvbotn1581012881.jpg","xj9sa81764788866.jpg","hxcuj01762772827.jpg","v1n3cj1783805938.jpg","qwrtut1468418027.jpg","08ez421782683409.jpg","o2wb6p1581005243.jpg","d8bfyg1764117503.jpg","7xte3u1763757761.jpg"],"beef":["13fg4j1764441982.jpg","jgl9qq1764437635.jpg","kgfh3q1763075438.jpg","5tf8j11782236249.jpg","m0p0j81765568742.jpg","pkopc31683207947.jpg","z0ageb1583189517.jpg","vtqxtu1511784197.jpg","ursuup1487348423.jpg","41cxjh1683207682.jpg","dxpc7j1764370714.jpg","1529444830.jpg","t2b8bn1779737789.jpg","1nalo51765188375.jpg","cgl60b1683206581.jpg","bc8v651619789840.jpg","svprys1511176755.jpg","ssrrrs1503664277.jpg","vvpprx1487325699.jpg","urzj1d1587670726.jpg","4pqimk1683207418.jpg","804v1j1764367088.jpg","uuqvwu1504629254.jpg","brmxra1782681940.jpg","8b2msz1763074897.jpg","j80gmw1764372176.jpg","n7qnkb1630444129.jpg","0sd7ac1764787957.jpg","xb97a81583266727.jpg","kdz63q1764793442.jpg","pn59o51628769837.jpg","rlwcc51598734603.jpg","q99te31763075494.jpg","wsqqsw1515364068.jpg","z1tfnw1764443171.jpg","0bpjb11763075817.jpg","lqampv1762325397.jpg","1525874812.jpg","tvttqv1504640475.jpg","wdfa171763065079.jpg","6sarfo1762340107.jpg","uttupv1511815050.jpg","ctg8jd1585563097.jpg","x372ug1598733932.jpg","1520083578.jpg","c9a3l31593261890.jpg","yyrrxr1511816289.jpg","2ncui81784396094.jpg","ewcikl1614348364.jpg","thvft91784576451.jpg","hx335q1619789561.jpg","dnd87q1782775269.jpg","dqxtlh1780153831.jpg","p7eid81782503889.jpg","swo87v1763595282.jpg","vussxq1511882648.jpg","1529443236.jpg","svf3d01780298321.jpg","kyuxew1763479470.jpg","n1hcou1628770088.jpg","tqd3ac1763786065.jpg","8859m71764377470.jpg","mq27gf1764436795.jpg"],"burger":["44bzep1761848278.jpg","lgmnff1763789847.jpg","k420tj1585565244.jpg"],"chicken":["020z181619788503.jpg","nmxec11782498644.jpg","sbx7n71587673021.jpg","uuuspp1511297945.jpg","syqypv1486981727.jpg","wruvqv1511880994.jpg","1529446352.jpg","qxytrx1511304021.jpg","qtuwxu1468233098.jpg","qrqywr1503066605.jpg","wyxwsp1486979827.jpg","uuns781783804024.jpg","tyywsw1505930373.jpg","hob03q1780264260.jpg","nz0lg71784671684.jpg","er4d081765186828.jpg","qpxvuq1511798906.jpg","uwvxpv1511557015.jpg","hcg6l91763596970.jpg","4hzyvq1763792564.jpg","4mhr3u1763481087.jpg","s73ytv1765567838.jpg","qstyvs1505931190.jpg","4htbtm1783803558.jpg","ypxvwv1505333929.jpg","kzxflc1763194887.jpg","feh9k21784665694.jpg","1529444113.jpg","o5fuq51764789643.jpg","utqnjv1763598650.jpg","vwrpps1503068729.jpg","40r49m1763197022.jpg","1525872624.jpg","o93jur1782769321.jpg","yxsurp1511304301.jpg","uuuspp1468263334.jpg","0dhtwr1763371444.jpg","47abic1782854326.jpg","hglsbl1614346998.jpg","li30ck1763281992.jpg","4o13oe1784396585.jpg","nlxald1764112200.jpg","ro8mzj1763800655.jpg","k5qzdl1782689660.jpg","kcv6hj1598733479.jpg","3um6il1763794322.jpg","pqulvm1763282839.jpg","a08uqk1761848682.jpg","cj56fs1762340001.jpg","el64dy1763483009.jpg","arzs741766434335.jpg","qptpvt1487339892.jpg","wvpsxx1468256321.jpg","ittake1763586925.jpg","sstssx1487349585.jpg","ol2xxt1763582263.jpg","z2sw3o1764378271.jpg"],"salmon":["1548772327.jpg","xxyupu1468262513.jpg","1549542994.jpg","1550440197.jpg","ikizdm1763760862.jpg","prrirc1763781360.jpg","xxrxux1503070723.jpg"],"soup":["uyqrrv1511553350.jpg","pbzcrx1763765096.jpg","k07k271782502861.jpg","zadvgb1699012544.jpg","fl4brj1764361323.jpg","xrxz7h1782592711.jpg","x0mreq1784577446.jpg","tvvxpv1511191952.jpg","sypxpx1515365095.jpg","6vi2cv1763075785.jpg","60oc3k1699009846.jpg","p9tebp1764118792.jpg","q8pu1k1764114334.jpg","rvtvuw1511190488.jpg","qserum1780156275.jpg","mlkjeu1782775816.jpg","yf5eyw1783804464.jpg","stpuws1511191310.jpg","tnwy8m1628770384.jpg","p5nzbk1782680889.jpg","1529446137.jpg","7n8su21699013057.jpg","vptqpw1511798500.jpg","raqjbj1762773035.jpg","xvrrux1511783685.jpg","sxxpst1468569714.jpg","mobh1l1779648766.jpg","x2fw9e1560460636.jpg","ntafxw1763586291.jpg","jcr46d1614763831.jpg","1ngcbf1628770793.jpg","6g9gif1782688663.jpg","0r7y5n1782681336.jpg","nimml81782855200.jpg","do7zps1614349775.jpg","ip5xtp1769779958.jpg","sqpqtp1515365614.jpg","lx1kkj1593349302.jpg","bmbvjk1782770310.jpg","9ptx0a1565090843.jpg","xxtsvx1511814083.jpg","4k8nzy1763583384.jpg","118oj61763423896.jpg","7kb44y1763589084.jpg","1brbso1763585098.jpg","a2ec961763587756.jpg","t8mn9g1560460231.jpg"],"rice":["wuyd2h1765655837.jpg","11bvtm1764795135.jpg","pkyvrn1764878267.jpg","kw92t41604181871.jpg","tytyxu1515363282.jpg","utxqpt1511639216.jpg","xrttsx1487339558.jpg","kos9av1699014767.jpg","4kzx4d1779554755.jpg","5572yt1779739329.jpg","9bl20p1763248192.jpg","sjfgbc1779647169.jpg","j8c1d51782772399.jpg","1520081754.jpg","5r5rvx1763287943.jpg","1550441275.jpg","c6ghxm1763335584.jpg","zg2b9l1760524940.jpg","cr2kyr1763793839.jpg","xw1ruy1763786501.jpg"],"lamb":["8xuvhj1763794991.jpg","ttfxxn1762773067.jpg","jyylmo1763790808.jpg","ampz9v1763787134.jpg","uc9qp11764796575.jpg","sxysrt1468240488.jpg","7vdtqi1780160088.jpg","8x09hy1560460923.jpg","rjhf741585564676.jpg","vvstvq1487342592.jpg","yuwtuu1511295751.jpg","qtwtss1468572261.jpg","uttrxw1511637813.jpg","vy6k391780090969.jpg","cuio7s1555492979.jpg","gr4lo51763791826.jpg","9kwatm1763327074.jpg","u55lbp1585564013.jpg","a1mi7t1779643816.jpg","0p7l6b1763813981.jpg"],"pasta":["2wx8cm1763373419.jpg","0jv5gx1661040802.jpg","uquqtu1511178042.jpg","xutquv1505330523.jpg","xr0n4r1576788363.jpg","wtsvxx1511296896.jpg","hbte551782770868.jpg","vvtvtr1511180578.jpg","llcbn01574260722.jpg","sutysw1468247559.jpg","ustsqw1468250014.jpg","wxswxy1511452625.jpg","5fu4ew1760524857.jpg","rvxxuy1468312893.jpg","qvrwpt1511181864.jpg"],"breakfast":["utxryw1511721587.jpg","1543774956.jpg","sqrtwu1511721265.jpg","bfok4w1780242078.jpg","thazgm1555350962.jpg","sng9bm1765320170.jpg","hyk47c1762772689.jpg","927vvp1779732018.jpg","f3ee3y1763309332.jpg","smoa3h1762341142.jpg"],"pizza":["wf49qs1763075222.jpg","x0lk931587671540.jpg"]};
for(const [g, list] of Object.entries(RECIPE_IMAGES_MORE)){
  const cur = RECIPE_IMAGES[g] || (RECIPE_IMAGES[g] = []), have = new Set(Object.values(RECIPE_IMAGES).flat());
  for(const f of list) if(!have.has(f)) cur.push(f);
}

// סוג המנה (מרק, סלט, ממרח) לפני המרכיב: "סלט טונה" = סלט, "מרק עוף" = מרק
const IMG_RULES = [['soup', ['מרק']], ['dip', ['סלט מטבוחה', 'סלט חצילים', 'מטבוחה', 'חומוס', 'באבא', 'ממרח', 'מטבל', 'טחינה', 'צזיקי', 'גוואקמולי', 'סלסה']], ['salad', ['סלט']],
  ['pizza', ['פיצה']], ['salmon', ['סלמון']], ['shrimp', ['שרימפס']], ['fish', ['דג', 'דגים', 'אמנון', 'טונה', 'לברק', 'דניס', 'בקלה', 'מושט']],
  ['meatball', ['קציצות', 'כדורי בשר', 'כדורי', 'קבב', 'קופתה']], ['burger', ['המבורגר']], ['eggs', ['שקשוקה', 'חביתה', 'ביצים', 'פריטטה']],
  ['cookies', ['עוגיות', 'עוגייה', 'בראוניז']], ['cake', ['עוגה', 'עוגת', 'עוגות', 'מאפינס']], ['dessert', ['קינוח', 'מוס', 'פודינג', 'גלידה', 'טירמיסו', 'שוקולד']],
  ['pie', ['פשטידה', 'קיש', 'פאי', 'טארט', 'בורקס', 'מאפה']], ['bread', ['לחם', 'חלה', 'לחמניות', 'פיתות', 'פיתה', 'פוקאצ׳ה', 'בצק', 'באגט', 'מלוואח']],
  ['pasta', ['פסטה', 'ספגטי', 'לזניה', 'ניוקי', 'פטוצ׳יני', 'מקרוני']], ['rice', ['אורז', 'ריזוטו', 'מג׳דרה', 'פאייה']], ['lamb', ['כבש', 'טלה']],
  ['chicken', ['עוף', 'שניצל', 'פרגיות', 'חזה', 'כנפיים', 'הודו']], ['beef', ['בשר', 'סטייק', 'אנטריקוט', 'צלי', 'גולש', 'פסטרמה', 'אסאדו']],
  ['potato', ['תפוחי אדמה', 'צ׳יפס', 'פירה']], ['breakfast', ['פנקייק', 'בלינצ׳ס', 'קרפ']], ['veg', ['ירקות', 'חצילים', 'קישואים', 'כרובית', 'ברוקולי']]];
const CAT_IMG = {'ארוחת בוקר': 'eggs', 'עוף': 'chicken', 'בשר': 'beef', 'דגים': 'fish', 'פסטה': 'pasta', 'תוספות': 'side', 'סלטים': 'salad',
  'ממרחים ורטבים': 'dip', 'מרקים': 'soup', 'מאפים ולחמים': 'bread', 'עוגות ועוגיות': 'cake', 'קינוחים': 'dessert', 'אחר': 'side'};
// כשמחפשים עוד תמונות: קבוצות קרובות קודם (לעוף: קציצות, אורז, בשר), ורק אחר כך כל השאר
const IMG_NEAR = {chicken: ['meatball', 'rice', 'potato', 'beef', 'lamb'], beef: ['meatball', 'burger', 'lamb', 'chicken'], meatball: ['beef', 'lamb', 'burger', 'chicken'],
  burger: ['beef', 'meatball'], lamb: ['beef', 'meatball'], fish: ['salmon', 'shrimp'], salmon: ['fish', 'shrimp'], shrimp: ['fish', 'salmon', 'pasta'],
  pasta: ['rice', 'pizza'], rice: ['side', 'veg', 'chicken'], soup: ['veg'], salad: ['veg', 'dip'], dip: ['salad', 'veg'], eggs: ['breakfast', 'veg'],
  breakfast: ['eggs', 'cake', 'dessert'], cake: ['dessert', 'cookies', 'pie'], cookies: ['cake', 'dessert'], dessert: ['cake', 'cookies'], bread: ['pie', 'pizza'],
  pie: ['bread', 'cake'], pizza: ['bread', 'pie'], potato: ['side', 'veg'], veg: ['salad', 'side', 'soup'], side: ['rice', 'potato', 'veg']};
const ING_IMG = [['salmon', ['סלמון']], ['shrimp', ['שרימפס']], ['fish', ['דג', 'דגים', 'אמנון', 'טונה', 'לברק', 'דניס']], ['chicken', ['עוף', 'חזה', 'פרגיות', 'כנפיים', 'הודו']],
  ['beef', ['בשר', 'בקר', 'אנטריקוט', 'סטייק']], ['lamb', ['כבש', 'טלה']]];
function recipeImageGroup(r){ return firstMatch(r.title || '', IMG_RULES) || CAT_IMG[recipeCat(r)] || 'side'; }
const imgUrl = f => IMG_BASE + f + '/medium';
const imgFile = u => { const m = /\/meals\/([^/]+?)(?:\/(?:medium|small|preview|large))?$/.exec(u || ''); return m ? m[1] : null; };
/** הקבוצה של תמונה (לפי הקובץ), או null לתמונה מבחוץ. */
const imageGroupOf = u => { const f = imgFile(u); if(!f) return null; for(const [g, l] of Object.entries(RECIPE_IMAGES)) if(l.includes(f)) return g; return null; };
/** תמונות לבחירה: הנוכחית קודם, אחריה שאר הקבוצה (קודם אלה שלא בשימוש), ואז מקבוצות קרובות. */
function imageOptions(r, recipes, current){
  const g = imageGroupOf(current) || recipeImageGroup(r);
  const used = new Set(Object.entries(recipeImages(recipes || [])).filter(([id]) => id !== r.id).map(([, u]) => imgFile(u)));
  // לפי הסיכוי: הקבוצה של המנה, אחר כך החלבון מהמצרכים, קבוצות קרובות, ובסוף כל השאר
  const fromIng = [...new Set((r.ingredients || []).map(x => firstMatch(String(x), ING_IMG)).filter(Boolean))];
  const groups = [...new Set([g, ...fromIng, ...(IMG_NEAR[g] || []), ...Object.keys(RECIPE_IMAGES)])];
  const cur = imgFile(current), seen = new Set([cur]), order = [];
  for(const k of groups){
    const l = RECIPE_IMAGES[k] || [];
    for(const f of [...l.filter(f => !used.has(f)), ...l.filter(f => used.has(f))]) if(!seen.has(f)){ seen.add(f); order.push(f); }
  }
  return [current, ...order.map(imgUrl)].filter(Boolean);
}
const GROUP_EMOJI = {pizza: '🍕', salmon: '🍣', fish: '🐟', shrimp: '🦐', chicken: '🍗', meatball: '🧆', beef: '🥩', burger: '🍔', lamb: '🍖',
  pasta: '🍝', rice: '🍚', soup: '🍲', salad: '🥗', dip: '🥣', eggs: '🍳', cake: '🍰', cookies: '🍪', dessert: '🍮', bread: '🍞', pie: '🥧',
  potato: '🥔', veg: '🥕', breakfast: '🥞', side: '🍽️'};
/** האמוג'י של המתכון: לפי התמונה שנבחרה, ואם אין, לפי שם המנה. */
const recipeEmojiOf = (r, img) => GROUP_EMOJI[imageGroupOf(img) || recipeImageGroup(r)] || '🍽️';
/** {id: קישור לתמונה} לכל המתכונים: תמונה שהוזנה, ואם אין, אחת מהקבוצה המתאימה. שני מתכונים באותה קבוצה: תמונות שונות. */
function recipeImages(recipes){
  const out = {}, byGroup = {}, taken = new Set((recipes || []).map(r => imgFile(r.image)).filter(Boolean));
  for(const r of recipes || []){
    if(r.image){ out[r.id] = r.image; continue; }
    const g = recipeImageGroup(r);
    (byGroup[g] = byGroup[g] || []).push(r);
  }
  for(const [g, list] of Object.entries(byGroup)){
    const pics = (RECIPE_IMAGES[g] || RECIPE_IMAGES.side).filter(f => !taken.has(f));
    const all = RECIPE_IMAGES[g] || RECIPE_IMAGES.side;
    // הראשונה בקבוצה היא המתאימה ביותר; כל מתכון נוסף באותה קבוצה מקבל את הבאה (ולא תמונה שנבחרה ביד למתכון אחר)
    list.sort((a, b) => a.id.localeCompare(b.id)).forEach((r, i) => { out[r.id] = imgUrl((pics.length ? pics : all)[i % (pics.length || all.length)]); });
  }
  return out;
}

/* ---------- טיימרים (התראה מהמנוע כשהזמן עובר) ---------- */
// משימות/טיימרים.json: {v, timers: [{id, at, title, body, updatedAt, deleted}]}. האפליקציה כותבת, המנוע שולח בזמן.
function mergeTimersFile(a, b, now){ return {v: 1, timers: mergeById(a?.timers, b?.timers, now)}; }
const liveTimers = (file, now) => (file?.timers || []).filter(t => !t.deleted && !t.stopped && t.kind !== 'med' && t.at > now - 36e5).sort((a, b) => a.at - b.at);
/* טיימר של מתכון "מצלצל" עד שעוצרים: Web Push לא יכול להשמיע צליל מתמשך, ולכן ההתראה חוזרת כל דקה, עד 5 פעמים,
   עם צליל ורטט בכל פעם (אותו tag, renotify), עד ש"⏹ עצור" (stopped: true). תזכורת תרופה (kind: 'med'): פעם אחת. */
const TIMER_RINGS = 5, TIMER_RING_GAP = 60e3;
/** טיימרים שהגיע זמנם (עד 20 דקות אחורה) ועוד לא נשלחו, ומתי הבא. צלצול חוזר: מזהה <id>~<n>, והאחרון שהגיע בלבד. */
function timersDue(file, now, sent){
  const due = [], later = [];
  for(const t of (file?.timers || [])){
    if(t.deleted || t.stopped) continue;
    const rings = t.kind === 'med' ? 1 : TIMER_RINGS, vid = n => n ? `${t.id}~${n}` : t.id;
    let pick = null;
    for(let n = 0; n < rings; n++){
      const at = t.at + n * TIMER_RING_GAP;
      if(at > now + PUSH_LEAD){ later.push(at); break; }
      if(at > now - PUSH_BACK) pick = n;
    }
    if(pick == null) continue;
    let done = false;
    for(let n = pick; n < rings; n++) if(sent['timer@' + vid(n)]) done = true;   // כבר צלצל (או צלצול מאוחר יותר)
    if(!done) due.push(Object.assign({}, t, {id: vid(pick), base: t.id, ring: pick + 1, rings}));
  }
  return {due, next: later.length ? Math.min(...later) : null};
}
// תזכורות תרופות (kind: 'med') יושבות באותו קובץ: התראה רגילה, שפותחת את מסך התרופות
const timerPayload = t => t.kind === 'med' ? JSON.stringify({t: t.title, b: t.body || '', u: APP + '#meds', tag: 'med-' + t.id})
  : t.base ? JSON.stringify({t: '⏱ ' + (t.title || 'הטיימר הסתיים'), b: (t.body ? `עבר ${t.body}` : 'הזמן עבר') + (t.ring > 1 ? ` · צלצול ${t.ring} מתוך ${t.rings}` : ''),
      u: APP + '#tm=' + encodeURIComponent(t.base), tag: 'timer-' + t.base, ri: true, vib: true, stop: t.base})
  : JSON.stringify({t: '⏱ ' + (t.title || 'הטיימר הסתיים'), b: t.body ? `עבר ${t.body}` : 'הזמן עבר', u: APP, tag: 'timer-' + t.id, ri: true, vib: true});

/** ערך ריק בפועל: "", "—", "-", "אין", "לא צוין"... */
const blank = v => !String(v ?? '').replace(/[\s\-–—_.:*]/g, '') || /^(אין|לא צוין|לא ידוע|ללא|n\/?a|none)$/i.test(String(v).trim());
/** כותרות משנה שאין אחריהן כלום יורדות. */
const dropEmptySubs = list => (list || []).map(x => String(x).trim()).filter(x => !blank(x))
  .filter((x, i, a) => !/[:：]\s*$/.test(x) || (a[i + 1] !== undefined && !/[:：]\s*$/.test(a[i + 1])));
/** המתכון בלי חלקים ריקים: מה שריק לא מוצג, לא באפליקציה ולא בשיתוף. */
function cleanRecipe(r){
  const out = Object.assign({}, r);
  for(const k of ['desc', 'notes', 'prep', 'cook', 'total', 'level', 'servings', 'source']) out[k] = blank(r[k]) ? '' : String(r[k]).trim();
  out.ingredients = dropEmptySubs(r.ingredients); out.steps = dropEmptySubs(r.steps);
  return out;
}
/** המתכון כהודעה (וואטסאפ): אמוג'י לפי התמונה שנבחרה, וליד כל מצרך האמוג'י שלו מרשימת הסופר. */
function recipeText(rc, img){
  rc = cleanRecipe(rc);
  const e = recipeEmojiOf(rc, img), L = [`${e} *${rc.title}* ${e}`];
  if(rc.desc) L.push(rc.desc);
  const meta = [rc.prep && `⏱ הכנה: ${rc.prep}`, rc.cook && `🔥 בישול/אפייה: ${rc.cook}`, rc.total && `⌛ סה״כ: ${rc.total}`, rc.servings && `👥 מנות: ${rc.servings}`, rc.level && `📊 ${rc.level}`].filter(Boolean);
  if(meta.length) L.push(meta.join(' · '));
  const ing = rc.ingredients || [];
  if(ing.length) L.push('', '🛒 *מצרכים:*', ...ing.map(x => /[:：]\s*$/.test(x) ? `*${x}*` : `${(ingredientProduct(x) && shopInfo(ingredientProduct(x)).textEmoji) || '▫️'} ${x}`));
  if((rc.steps || []).length){ let n = 0; L.push('', '👩‍🍳 *אופן ההכנה:*', ...rc.steps.map(x => /[:：]\s*$/.test(x) ? `*${x}*` : `${++n}. ${x}`)); }
  if(rc.notes) L.push('', '💡 *הערות:*', rc.notes);
  if(rc.source) L.push('', '🔗 ' + rc.source);
  return L.join('\n');
}

/* ---------- ימי הולדת ומסמכים ---------- */
// שניהם משימות רגילות (כך שההתראות, לוח השנה וההיסטוריה עובדים בלי שינוי), עם special לזיהוי.
// יום הולדת: כל שנה באותו יום, תזכורת שבוע ויום לפני. מסמך: חד-פעמית בתאריך פקיעת התוקף, תזכורת מראש, ונודניק שבועי אם פג.
const DOC_TYPES = ['דרכון', 'תעודת זהות', 'רישיון נהיגה', 'טסט לרכב', 'ביטוח רכב', 'ביטוח דירה', 'ביטוח בריאות', 'כרטיס אשראי', 'ויזה', 'מנוי', 'אחריות למוצר'];
// ימים מיוחדים: יום הולדת, יום נישואין, אזכרה, או שם חופשי ("יום השנה לדירה")
const OCCASIONS = {birthday: {emoji: '🎂', name: 'יום הולדת'}, anniversary: {emoji: '💍', name: 'יום נישואין'},
  memorial: {emoji: '🕯️', name: 'אזכרה'}, custom: {emoji: '✨', name: 'אחר'}};
function occasionTitle(o){
  const k = o.occasion || 'birthday', who = (o.name || '').trim(), lbl = (o.label || '').trim();
  if(k === 'birthday') return `יום הולדת ל${who}`;
  if(k === 'anniversary') return who ? `יום נישואין: ${who}` : 'יום נישואין';
  if(k === 'memorial') return `אזכרה: ${who}`;
  return lbl && who ? `${lbl}: ${who}` : lbl || who || 'יום מיוחד';
}
function birthdayTask(o, nowIso){
  const [y, m, d] = o.date.split('-').map(Number), k = OCCASIONS[o.occasion] ? o.occasion : 'birthday';
  return {id: o.id || 'bd' + sha256((o.name || '') + o.date + nowIso).slice(0, 10), title: occasionTitle(o), special: 'birthday', occasion: k,
    occasionLabel: k === 'custom' ? (o.label || '').trim() : '', person: (o.name || '').trim(),
    birthYear: o.knowYear === false ? null : y, domain: 'personal', priority: 'normal', kind: 'schedule',
    schedule: {rule: {type: 'yearly', month: m, day: d}}, start: `2000-${pad(m)}-${pad(d)}`, missPolicy: 'dayOnly', time: o.time || '09:00',
    pre: [7, 1], nag: {mode: 'none'}, doneLabel: k === 'birthday' ? 'בירכתי' : 'סמן כבוצע', subtasks: [], notes: o.notes || '', links: [], archived: false, deleted: false, updatedAt: nowIso};
}
function docTask(o, nowIso){
  const before = +o.remindDays || 30;
  return {id: o.id || 'doc' + sha256(o.name + o.expiry + nowIso).slice(0, 10), title: `חידוש ${o.name}`, special: 'doc', docName: o.name,
    domain: 'personal', priority: 'high', kind: 'once', once: {date: o.expiry}, time: '10:00', remindDays: before,
    pre: [...new Set([before, 7].filter(x => x <= before))].sort((a, b) => b - a), nag: {mode: 'weekly'}, doneLabel: 'חידשתי',
    subtasks: [], notes: o.notes || '', links: [], start: localDate(Date.parse(nowIso)), archived: false, deleted: false, updatedAt: nowIso};
}
/* ---------- תחזוקה שוטפת ---------- */
// דברים שמחליפים או עושים כל פרק זמן (מברשת שיניים, מסנן מים, סכין גילוח, תספורת). אלה משימות "ממועד הביצוע" (afterDone)
// עם upkeep: true, כך שההתראות, "החלפתי" וההיסטוריה עובדים כמו בכל משימה. min/max בימים: טווח (תספורת 21-30) או מדויק.
const UPKEEP_EVERY = [[7, 7, 'שבוע'], [14, 14, 'שבועיים'], [21, 30, '3-4 שבועות'], [30, 30, 'חודש'], [60, 60, 'חודשיים'],
  [90, 90, '3 חודשים'], [180, 180, 'חצי שנה'], [365, 365, 'שנה']];
function everyText(min, max){
  const f = UPKEEP_EVERY.find(([a, b]) => a === +min && b === +max);
  return f ? f[2] : +min === +max ? `${min} ימים` : `${min}-${max} ימים`;
}
function upkeepTask(o, nowIso){
  const min = Math.max(1, +o.min || 30), max = Math.max(min, +o.max || min);
  return {id: o.id || 'up' + sha256((o.name || '') + nowIso).slice(0, 10), title: (o.name || '').trim(), upkeep: true, emoji: o.emoji || '🔧',
    domain: o.domain || 'home', priority: 'normal', kind: 'afterDone', afterDone: {minDays: min, maxDays: max, lastDone: o.lastDone || null},
    soft: min !== max, time: o.time || '10:00', pre: [], nag: {mode: 'daily', from: 'max'}, doneLabel: o.doneLabel || 'החלפתי',
    subtasks: [], notes: o.notes || '', links: [], start: o.lastDone || localDate(Date.parse(nowIso)), archived: false, deleted: false, updatedAt: nowIso};
}
/** מצב כל פריט: {task, last, sinceDays, minDate, maxDate, left (ימים עד המועד), state: late/due/soon/ok/unknown, pct, every}. הדחוף קודם. */
function upkeepView(tasks, occ, today){
  const idx = indexOcc(occ), order = {late: 0, due: 1, soon: 2, unknown: 3, ok: 4};
  return (tasks || []).filter(t => t.upkeep && !t.deleted && !t.archived && t.kind === 'afterDone').map(t => {
    const a = afterDoneInfo(t, idx, today), left = diffDays(a.maxDate, today), toMin = diffDays(a.minDate, today);
    const state = a.needsLast ? 'unknown' : left < 0 ? 'late' : toMin <= 0 && a.min !== a.max ? 'due' : left <= 3 ? 'soon' : 'ok';
    return {task: t, last: a.lastDone, sinceDays: a.lastDone ? diffDays(today, a.lastDone) : null, minDate: a.minDate, maxDate: a.maxDate,
      left, toMin, state, pct: a.needsLast ? 0 : Math.max(0, Math.min(100, Math.round(a.day / (a.max || 1) * 100))), every: everyText(a.min, a.max)};
  }).sort((x, y) => order[x.state] - order[y.state] || x.left - y.left);
}
/** ימי הולדת לפי הקרוב: {task, next, inDays, age (בן כמה יהיה, אם השנה ידועה)} */
function birthdaysView(tasks, today){
  return (tasks || []).filter(t => t.special === 'birthday' && !t.deleted).map(t => {
    const r = t.schedule.rule, y = +today.slice(0, 4);
    let next = `${y}-${pad(r.month)}-${pad(Math.min(r.day, daysInMonth(y, r.month)))}`;
    if(next < today) next = `${y + 1}-${pad(r.month)}-${pad(Math.min(r.day, daysInMonth(y + 1, r.month)))}`;
    const k = t.occasion || 'birthday';
    return {task: t, next, inDays: diffDays(next, today), age: t.birthYear ? +next.slice(0, 4) - t.birthYear : null,
      occasion: k, emoji: OCCASIONS[k].emoji, label: k === 'custom' ? (t.occasionLabel || 'יום מיוחד') : OCCASIONS[k].name};
  }).sort((a, b) => a.inDays - b.inDays || (a.task.person || '').localeCompare(b.task.person || '', 'he'));
}
/** מסמכים לפי פקיעת התוקף: {task, expiry, inDays, state: 'ok' | 'soon' | 'expired' | 'renewed'} */
function docsView(tasks, occ, today){
  const idx = indexOcc(occ);
  return (tasks || []).filter(t => t.special === 'doc' && !t.deleted).map(t => {
    const expiry = t.once.date, rec = idx.byId.get(`${t.id}-${compact(expiry)}`), inDays = diffDays(expiry, today);
    const state = rec && rec.status === 'done' ? 'renewed' : inDays < 0 ? 'expired' : inDays <= (t.remindDays || 30) ? 'soon' : 'ok';
    return {task: t, expiry, inDays, state};
  }).sort((a, b) => ({expired: 0, soon: 1, ok: 2, renewed: 3}[a.state] - {expired: 0, soon: 1, ok: 2, renewed: 3}[b.state]) || a.inDays - b.inDays);
}

/* ---------- חישוב קלוריות ---------- */
// משימות/קלוריות.json: {v, foods, entries, acts, recipes, meals, weights, settings}. כל רשימה ממוזגת לפי id (מאוחר מנצח).
// foods: מאכלים אישיים, וגם תיקון של מאכל מהמאגר (אותו id). entries: מה נאכל {date, meal, foodId, name, qty, unit, grams, kcal, manual}.
// acts: פעילות {date, type, km, level, minutes, kcal, manual}. meals: ארוחות קבועות {name, items}. weights: {date, kg}.
// הקלוריות נשמרות ברשומה ברגע ההוספה, כך שתיקון מאוחר של מאכל לא משנה היסטוריה.
// מאגר: קלוריות ל-100 גרם (מבושל כשרלוונטי), לפי טבלאות תזונה מקובלות (USDA ומשרד הבריאות). יחידות: "שם:גרמים", הראשונה ברירת מחדל.
const FOOD_DB = `לחם לבן|265|פרוסה:30
לחם מלא|247|פרוסה:35
פיתה|275|יחידה:90,חצי:45
לחמניה|280|יחידה:70
חלה|290|פרוסה:40
לאפה|280|יחידה:120
טוסט גבינה|280|יחידה:150
אורז לבן מבושל|130|כוס:160,כף:15,מנה:200
אורז מלא מבושל|112|כוס:195,מנה:200
פסטה מבושלת|158|כוס:140,מנה:200
קוסקוס מבושל|112|כוס:157,מנה:200
פתיתים מבושלים|160|כוס:150,מנה:200
בורגול מבושל|83|כוס:182,מנה:200
קינואה מבושלת|120|כוס:185,מנה:200
נודלס מבושלים|138|מנה:200,כוס:160
מג׳דרה|150|מנה:250,כוס:200
תפוח אדמה מבושל|87|יחידה:150
פירה|106|כוס:210,כף:30
צ׳יפס|312|מנה:120
בטטה אפויה|90|יחידה:150
שיבולת שועל|389|כף:8,כוס:80
קורנפלקס|357|כוס:30
גרנולה|470|כף:12,כוס:100
ביצה|143|יחידה:55
ביצה קשה|155|יחידה:50
חביתה|196|חביתה 3 ביצים:195,ביצה אחת:65
שקשוקה|110|מנה:300
חלב 3%|60|כוס:240,כף:15
חלב 1%|42|כוס:240,כף:15
יוגורט 3%|61|גביע:200
יוגורט יווני|97|גביע:150,כף:20
קוטג׳ 5%|95|כף:30,גביע:250
גבינה לבנה 5%|98|כף:30,גביע:250
גבינה צהובה|350|פרוסה:20
גבינה בולגרית|260|קובייה:30
גבינת שמנת|250|כף:20
שמנת חמוצה|162|כף:15
חמאה|717|כפית:5,כף:14
מעדן חלב|120|גביע:125
חזה עוף צלוי|165|מנה:150
שניצל עוף|260|יחידה:120
שוק עוף צלוי|190|יחידה:100
פרגית צלויה|180|יחידה:100
עוף בתנור|200|מנה:200
בשר טחון מבושל|250|מנה:150
קציצות בשר|230|יחידה:50
סטייק|270|מנה:200
המבורגר|250|קציצה:150
נקניקייה|290|יחידה:50
שווארמה|230|מנה:200
קבב|260|יחידה:60
פסטרמה|150|פרוסה:15
חזה הודו פרוס|105|פרוסה:15
טונה במים|116|קופסה:120
טונה בשמן|200|קופסה:120
סלמון אפוי|206|מנה:150
דג לבן אפוי|128|מנה:150
סושי|150|יחידה:25
חומוס|177|כף:30,מנה:150
טחינה מוכנה|250|כף:20
טחינה גולמית|595|כף:15
פלאפל|333|כדור:17
סביח|200|מנה:350
סלט ירקות|25|מנה:150
סלט ירקות עם שמן|70|מנה:150
עגבנייה|18|יחידה:120
מלפפון|15|יחידה:100
גזר|41|יחידה:70
פלפל|31|יחידה:150
חסה|15|כוס:50
אבוקדו|160|יחידה:150,כף:15
ירקות מבושלים|50|מנה:150
עדשים מבושלות|116|כוס:200
חומוס גרגרים מבושלים|164|כוס:164
מרק עוף|35|קערה:350
מרק עדשים|80|קערה:350
מרק ירקות|40|קערה:350
תפוח|52|יחידה:180
בננה|89|יחידה:120
תפוז|47|יחידה:150
קלמנטינה|53|יחידה:75
אגס|57|יחידה:170
ענבים|69|כוס:150
אבטיח|30|פלח:300
מלון|34|פלח:200
תות|32|חופן:80,כוס:150
מנגו|60|חופן:80,יחידה:300
תמר מג׳הול|277|יחידה:24
שקדים|579|חופן:30
אגוזי מלך|654|חופן:30
בוטנים|567|חופן:30
גרעינים|584|חופן:25
במבה|534|שקית:80,שקית קטנה:25
ביסלי|490|שקית:70
שוקולד חלב|535|קובייה:5,חפיסה:100
עוגיות|480|יחידה:10
עוגה|400|פרוסה:70
גלידה|207|כדור:65
פופקורן|387|כוס:8
חטיף אנרגיה|400|יחידה:40
פיצה|266|משולש:110
בורקס|380|יחידה:90
מלאווח|320|יחידה:125
קפה שחור|2|כוס:240
קפה הפוך|50|כוס:240
תה|1|כוס:240
סוכר|387|כפית:5
דבש|304|כפית:7,כף:21
ריבה|250|כפית:7,כף:20
שמן זית|884|כפית:5,כף:13
מיונז|680|כף:14
קטשופ|112|כף:17
מיץ תפוזים|45|כוס:240
קולה|42|פחית:330,כוס:240
בירה|43|בקבוק:330
יין|85|כוס:150
שניצל עוף אפוי (שפריץ שמן)|218|מנה 220 גרם לפני בישול:220
שניצל עוף מטוגן|282|מנה 220 גרם לפני בישול:220
חזה עוף (משקל לפני בישול)|125|מנה 220 גרם לפני בישול:220
צ׳יפס בסיר אוויר (שפריץ שמן)|160|מנה:150
יוגורט חלבון בטעמים|72|גביע:200
טונה סטארקיסט בשמן|192|קופסה:120
לחם פשוט מלא דק|240|פרוסה דקה:22
רוטב בולונז ביתי (בשר טחון)|165|מנה:150,כף:20
כדורי בשר ברוטב אדום|150|מנה:300,כדור עם רוטב:75
רוטב עגבניות לפיצה|45|מנה:80,כף:15`;
// ערכים לפי משקל לפני בישול (שניצל, חזה): חזה עוף נא כ-120 ל-100 גרם, ציפוי (ביצה ופירורי לחם) כ-175 למנה,
// שפריץ שמן כ-40, טיגון סופג כ-20 גרם שמן (180). צ'יפס בסיר אוויר: תפוח אדמה שאיבד מים, ושפריץ שמן.
// חלבון ל-100 גרם (גרמים), לפי מאגר התזונה הלאומי וטבלאות USDA (17.11.2026)
const PROT_BUILTIN = {"לחם לבן": 9, "לחם מלא": 10, "פיתה": 9, "לחמניה": 9, "חלה": 9, "לאפה": 8.5, "טוסט גבינה": 12, "אורז לבן מבושל": 2.7, "אורז מלא מבושל": 2.6, "פסטה מבושלת": 5.8, "קוסקוס מבושל": 3.8, "פתיתים מבושלים": 5, "בורגול מבושל": 3.1, "קינואה מבושלת": 4.4, "נודלס מבושלים": 4.5, "מג׳דרה": 6, "תפוח אדמה מבושל": 1.9, "פירה": 2, "צ׳יפס": 3.4, "בטטה אפויה": 2, "שיבולת שועל": 13, "קורנפלקס": 7.5, "גרנולה": 10, "ביצה": 12.6, "ביצה קשה": 12.6, "חביתה": 13, "שקשוקה": 6, "חלב 3%": 3.3, "חלב 1%": 3.4, "יוגורט 3%": 3.5, "יוגורט יווני": 9, "קוטג׳ 5%": 11, "גבינה לבנה 5%": 9, "גבינה צהובה": 25, "גבינה בולגרית": 17, "גבינת שמנת": 6, "שמנת חמוצה": 2.4, "חמאה": 0.9, "מעדן חלב": 3, "חזה עוף צלוי": 31, "שניצל עוף": 18, "שוק עוף צלוי": 26, "פרגית צלויה": 25, "עוף בתנור": 25, "בשר טחון מבושל": 25, "קציצות בשר": 17, "סטייק": 26, "המבורגר": 17, "נקניקייה": 12, "שווארמה": 20, "קבב": 17, "פסטרמה": 20, "חזה הודו פרוס": 18, "טונה במים": 26, "טונה בשמן": 27, "סלמון אפוי": 22, "דג לבן אפוי": 23, "סושי": 6, "חומוס": 8, "טחינה מוכנה": 8, "טחינה גולמית": 17, "פלאפל": 13, "סביח": 7, "סלט ירקות": 1, "סלט ירקות עם שמן": 1, "עגבנייה": 0.9, "מלפפון": 0.7, "גזר": 0.9, "פלפל": 1, "חסה": 1.4, "אבוקדו": 2, "ירקות מבושלים": 2, "עדשים מבושלות": 9, "חומוס גרגרים מבושלים": 8.9, "מרק עוף": 3, "מרק עדשים": 5, "מרק ירקות": 1.5, "תפוח": 0.3, "בננה": 1.1, "תפוז": 0.9, "קלמנטינה": 0.8, "אגס": 0.4, "ענבים": 0.7, "אבטיח": 0.6, "מלון": 0.8, "תות": 0.7, "מנגו": 0.8, "תמר מג׳הול": 1.8, "שקדים": 21, "אגוזי מלך": 15, "בוטנים": 26, "גרעינים": 21, "במבה": 16, "ביסלי": 9, "שוקולד חלב": 7.6, "עוגיות": 6, "עוגה": 5, "גלידה": 3.5, "פופקורן": 13, "חטיף אנרגיה": 8, "פיצה": 11, "בורקס": 7, "מלאווח": 6, "קפה שחור": 0.1, "קפה הפוך": 3, "תה": 0, "סוכר": 0, "דבש": 0.3, "ריבה": 0.4, "שמן זית": 0, "מיונז": 1, "קטשופ": 1.2, "מיץ תפוזים": 0.7, "קולה": 0, "בירה": 0.5, "יין": 0.1, "שניצל עוף אפוי (שפריץ שמן)": 22, "שניצל עוף מטוגן": 19, "חזה עוף (משקל לפני בישול)": 23, "צ׳יפס בסיר אוויר (שפריץ שמן)": 3, "יוגורט חלבון בטעמים": 10, "טונה סטארקיסט בשמן": 26, "לחם פשוט מלא דק": 11, "רוטב בולונז ביתי (בשר טחון)": 12, "כדורי בשר ברוטב אדום": 11, "רוטב עגבניות לפיצה": 1.5};
// המאכלים האישיים של המשתמש (נכנסו לפני שהיה חלבון)
const PROT_PERSONAL = {'my-pancake': 9, 'my-pizza': 8};
const FOODS = FOOD_DB.split('\n').map((l, i) => {
  const [name, k, units] = l.split('|');
  return {id: 'f-' + sha256(name).slice(0, 8), name, kcal100: +k, prot100: PROT_BUILTIN[name] ?? null, units: units.split(',').map(u => { const [n, g] = u.split(':'); return {name: n, g: +g}; }), rank: i, builtin: true};
});
// מאגר מורחב: מאגר התזונה הלאומי (כ-4,400 מאכלים), נטען באפליקציה מ-מאכלים.js. מאכל מהמאגר המובנה עם אותו שם קודם.
// דירוג: המובנים (הנפוצים, בשמות קצרים) קודם, ואחריהם המורחב, שם קצר קודם.
let FOODS_EXTRA = [];
function addFoodDb(text){
  const names = new Set(FOODS.map(f => shopNorm(f.name)));
  FOODS_EXTRA = String(text || '').split('\n').filter(Boolean).map(l => {
    const [name, k, units, pr] = l.split('|'), n = shopNorm(name);
    if(!name || names.has(n)) return null;
    names.add(n);
    return {id: 'z-' + sha256(name).slice(0, 8), name, kcal100: +k || 0, prot100: pr !== undefined && pr !== '' ? +pr : null, rank: 2000 + name.length, builtin: true, db: true, _n: n,
      units: units ? units.split(',').map(u => { const [un, g] = u.split(':'); return {name: un, g: +g}; }).filter(u => u.g > 0) : []};
  }).filter(Boolean);
  return FOODS_EXTRA.length;
}
const allBuiltin = () => FOODS_EXTRA.length ? FOODS.concat(FOODS_EXTRA) : FOODS;
const MEALS = [['breakfast', 'בוקר', '🍳'], ['lunch', 'צהריים', '🍲'], ['dinner', 'ערב', '🥗'], ['snack', 'נשנושים', '🍎']];
// פעילות: MET (פעילות/מנוחה), לפי ה-Compendium of Physical Activities. קלוריות = MET × משקל × שעות.
const ACTIVITIES = {
  bike: {name: 'רכיבה על אופניים', emoji: '🚴', by: 'km', levels: [['נינוח (כ-14 קמ״ש)', 14, 4.0], ['בינוני (כ-18 קמ״ש)', 18, 6.8], ['מהיר (כ-21 קמ״ש)', 21, 8.0], ['מאוד מהיר (25+ קמ״ש)', 25, 10.0]]},
  walk: {name: 'הליכה', emoji: '🚶', by: 'km', levels: [['איטית (3 קמ״ש)', 3.2, 2.8], ['רגילה (5 קמ״ש)', 4.8, 3.5], ['מהירה (5.5 קמ״ש)', 5.6, 4.3], ['מאוד מהירה (6.5 קמ״ש)', 6.4, 5.0]]},
  run: {name: 'ריצה', emoji: '🏃', by: 'km', levels: [['קלה (8 קמ״ש)', 8, 8.3], ['בינונית (10 קמ״ש)', 10, 9.8], ['מהירה (12 קמ״ש)', 12, 11.5]]},
  strength: {name: 'אימון כוח', emoji: '🏋️', by: 'min', quick: [20, 40, 60], levels: [['קל', 0, 3.5], ['בינוני', 0, 5.0], ['מאומץ', 0, 6.0]]},
  swim: {name: 'שחייה', emoji: '🏊', by: 'min', quick: [20, 30, 45], levels: [['נינוחה', 0, 5.8], ['בינונית', 0, 8.3], ['מאומצת', 0, 9.8]]},
  other: {name: 'פעילות אחרת', emoji: '⚡', by: 'min', quick: [20, 30, 60], levels: [['קלה', 0, 3.0], ['בינונית', 0, 5.0], ['מאומצת', 0, 7.5]]},
};
const CAL_DEFAULTS = {height: 168, weight: 87, goal: 2000};
function mergeCaloriesFile(a, b, now){
  const out = {v: 1};
  for(const k of ['foods', 'entries', 'acts', 'recipes', 'meals', 'weights', 'settings', 'favs', 'sleep']) out[k] = mergeById(a?.[k], b?.[k], now);
  return out;
}
const live = l => (l || []).filter(x => !x.deleted);
/** כל המאכלים: המאגר + אישיים. מאכל אישי עם id של מאכל מהמאגר = תיקון שלו. */
function calFoods(file){
  const mine = new Map(live(file?.foods).map(f => [f.id, f])), base = allBuiltin();
  const out = mine.size ? base.map(f => mine.has(f.id) ? Object.assign({}, f, mine.get(f.id), {builtin: true, corrected: true, _n: null}) : f) : base.slice();
  const ids = mine.size ? new Set(base.map(f => f.id)) : null;
  for(const f of mine.values()) if(!ids.has(f.id)) out.push(Object.assign({rank: 1000}, f));
  for(const r of live(file?.recipes)) out.push(Object.assign({rank: 900}, recipeFood(r)));   // מתכונים אישיים = מאכלים
  return out;
}
const KCAL_SEED = {foods: [], meals: []};   // הארוחות הקבועות האישיות נשמרות בנתונים של המשתמש, לא בקוד
/** מה להוסיף לקובץ הקלוריות בפעם הראשונה, או null. */
function kcalSeed(file, nowIso){
  if(live(file?.settings).some(x => x.id === 'seedK' && x.v >= 1)) return null;
  nowIso = '2026-11-16T00:00:00.000Z';   // חותמת ישנה וקבועה: כל עריכה או מחיקה גוברת, ושום מכשיר לא "מחזיר" מה שנמחק
  const foods = KCAL_SEED.foods.map(f => Object.assign({}, f, {updatedAt: nowIso, deleted: false}));
  const all = calFoods({foods});
  const meals = KCAL_SEED.meals.map(([id, name, meal, items]) => ({id, name, meal, updatedAt: nowIso, deleted: false,
    items: items.map(([key, qty, unit]) => { const f = all.find(x => x.id === key || x.name === key);
      return {foodId: f.id, name: f.name, qty, unit, grams: foodGrams(f, qty, unit), kcal: foodKcal(f, qty, unit), manual: false}; })}));
  return {foods, meals, settings: [{id: 'seedK', v: 1, updatedAt: nowIso, deleted: false}]};
}
/** גרמים לכמות ויחידה. "גרם" תמיד אפשרי. */
function foodGrams(food, qty, unit){
  if(!unit || unit === 'גרם') return +qty || 0;
  const u = (food.units || []).find(x => x.name === unit);
  return (+qty || 0) * (u ? u.g : 100);
}
const foodKcal = (food, qty, unit) => Math.round(foodGrams(food, qty, unit) * (+food.kcal100 || 0) / 100);
const prot100Of = f => f ? (f.prot100 ?? PROT_PERSONAL[f.id] ?? null) : null;
/** חלבון בגרמים (ספרה אחת אחרי הנקודה), או null כשלא ידוע. */
const foodProt = (food, qty, unit) => { const p = prot100Of(food); return p == null ? null : Math.round(foodGrams(food, qty, unit) * p / 10) / 10; };
/** החלבון ברשומת אכילה: מה שנשמר, ואם אין (רשומה ישנה), לפי המאכל והמשקל. */
function entryProt(e, foods){
  if(e.prot != null) return +e.prot;
  const f = foods && foods.get(e.foodId), p = prot100Of(f) ?? PROT_PERSONAL[e.foodId];
  return p == null ? 0 : Math.round((+e.grams || 0) * p / 10) / 10;
}
// מפת המאכלים (כולל מתכונים אישיים) לחישוב חלבון ברשומות ישנות. נבנית מחדש רק כשהקובץ או המאגר משתנים
const foodMapCache = new WeakMap();
function foodMap(file){
  if(!file) return new Map();
  const c = foodMapCache.get(file);
  if(c && c.n === FOODS_EXTRA.length) return c.m;
  const m = new Map(calFoods(file).map(f => [f.id, f]));
  foodMapCache.set(file, {n: FOODS_EXTRA.length, m});
  return m;
}
/** הצעות: מה שנאכל הכי הרבה קודם, ואז המאגר. עם טקסט: רק מה שמתאים (גם יחיד/רבים). */
function foodSuggest(file, query, limit){
  const q = shopNorm(query), count = {};
  for(const e of live(file?.entries)) if(e.foodId) count[e.foodId] = (count[e.foodId] || 0) + 1;
  const fits = f => { if(!q) return true; const n = f._n || shopNorm(f.name); return n.startsWith(q) || n.includes(' ' + q) || q.split(' ').every(a => n.split(' ').some(b => sameWord(a, b) || b.startsWith(a))); };
  return calFoods(file).filter(fits)
    .sort((a, b) => (count[b.id] || 0) - (count[a.id] || 0) || (q ? +!(a._n || shopNorm(a.name)).startsWith(q) - +!(b._n || shopNorm(b.name)).startsWith(q) : 0) || a.rank - b.rank)
    .slice(0, limit || 12).map(f => Object.assign({}, f, {uses: count[f.id] || 0}));
}
function calSettings(file){
  const s = live(file?.settings).find(x => x.id === 'settings') || {};
  return Object.assign({}, CAL_DEFAULTS, s);
}
/** המשקל בתאריך: העדכון האחרון עד אותו יום (ואם אין, משקל ההתחלה). */
function weightOn(file, date){
  const w = live(file?.weights).filter(x => x.date <= date).sort((a, b) => b.date.localeCompare(a.date) || (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
  return w ? +w.kg : calSettings(file).weight;
}
/** קלוריות משוערות לפעילות. km: לפי מרחק ומהירות; min: לפי דקות. */
function activityKcal(a, weight){
  const def = ACTIVITIES[a.type] || ACTIVITIES.other, lv = def.levels[Math.min(def.levels.length - 1, Math.max(0, +a.level || 0))];
  const hours = def.by === 'km' ? (+a.km || 0) / lv[1] : (+a.minutes || 0) / 60;
  return Math.round(lv[2] * weight * hours);
}
const activityMinutes = a => { const def = ACTIVITIES[a.type] || ACTIVITIES.other; return def.by === 'km' ? Math.round((+a.km || 0) / def.levels[+a.level || 0][1] * 60) : +a.minutes || 0; };
/** סיכום יום: נאכל, נשרף, יעד, נותר (יעד פחות נאכל: הפעילות לא מתווספת ליעד), ולפי ארוחות. */
function calDay(file, date){
  const st = calSettings(file), entries = live(file?.entries).filter(e => e.date === date), acts = live(file?.acts).filter(a => a.date === date);
  const meals = MEALS.map(([id, name, emoji]) => { const items = entries.filter(e => e.meal === id).sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
    return {id, name, emoji, items, kcal: items.reduce((s, e) => s + (+e.kcal || 0), 0)}; });
  const eaten = meals.reduce((s, m) => s + m.kcal, 0), burned = acts.reduce((s, a) => s + (+a.kcal || 0), 0);
  // חלבון: לכל רשומה, והיעד (1.6 גרם לק״ג, אם לא נקבע אחר)
  const fm = foodMap(file), weight = weightOn(file, date);
  for(const m of meals){ m.items = m.items.map(e => Object.assign({}, e, {protein: entryProt(e, fm)})); m.protein = Math.round(m.items.reduce((x, e) => x + e.protein, 0)); }
  const protein = Math.round(meals.reduce((x, m) => x + m.items.reduce((y, e) => y + e.protein, 0), 0)), protGoal = Math.round(+st.protGoal || 1.6 * weight);
  return {date, goal: +st.goal, eaten, burned, remaining: +st.goal - eaten, pct: st.goal ? Math.min(100, Math.round(eaten / st.goal * 100)) : 0,
    over: eaten > st.goal, meals, acts, weight, protein, protGoal, protPct: protGoal ? Math.min(100, Math.round(protein / protGoal * 100)) : 0};
}
/** היסטוריה: ימים שיש בהם משהו, מהחדש לישן. */
function calHistory(file, limit){
  const days = new Set([...live(file?.entries).map(e => e.date), ...live(file?.acts).map(a => a.date)]);
  return [...days].sort().reverse().slice(0, limit || 60).map(d => { const x = calDay(file, d); return {date: d, eaten: x.eaten, burned: x.burned, goal: x.goal, protein: x.protein, protGoal: x.protGoal}; });
}
/** רשומת אכילה ממאכל. */
function calEntry(food, o, nowIso){
  const grams = foodGrams(food, o.qty, o.unit), kcal = o.kcal != null && o.kcal !== '' ? Math.round(+o.kcal) : foodKcal(food, o.qty, o.unit);
  return {id: o.id || 'e' + sha256(food.id + nowIso + Math.random()).slice(0, 10), date: o.date, meal: o.meal, foodId: food.id, name: food.name,
    qty: +o.qty, unit: o.unit, grams, kcal, prot: foodProt(food, o.qty, o.unit), manual: o.kcal != null && o.kcal !== '' && Math.round(+o.kcal) !== foodKcal(food, o.qty, o.unit),
    addedAt: o.addedAt || nowIso, updatedAt: nowIso, deleted: false};
}
/** מתכון אישי → מאכל: סך הקלוריות של המרכיבים, מחולק למנות. */
function recipeFood(r){
  const total = (r.items || []).reduce((s, i) => s + (+i.kcal || 0), 0), grams = (r.items || []).reduce((s, i) => s + (+i.grams || 0), 0), n = Math.max(1, +r.servings || 1);
  const base = new Map(allBuiltin().map(f => [f.id, f])), pr = (r.items || []).reduce((s, i) => { const f = base.get(i.foodId); const p = i.prot ?? (prot100Of(f) == null ? 0 : (+i.grams || 0) * prot100Of(f) / 100); return s + p; }, 0);
  return {id: r.id, name: r.name, kcal100: grams ? Math.round(total / grams * 100) : 0, prot100: grams ? Math.round(pr / grams * 1000) / 10 : null, units: [{name: 'מנה', g: grams ? Math.round(grams / n) : 100}],
    total, perServing: Math.round(total / n), recipe: true, updatedAt: r.updatedAt, deleted: r.deleted};
}

/* ---------- יומן גוגל דרך המנוע ---------- */
// משימה עם calendar: true נכנסת ליומן גוגל של המשתמש. המנוע (שרץ בחשבון שלו) יוצר את האירוע, ושומר ב-משימות/יומן.json
// מה נוצר: {v, events: [{id: מזהה המשימה, eventId, series, sig, updatedAt, deleted}]}. שינוי במשימה = האירוע הישן נמחק וחדש נוצר.
/** מה צריך להיות ביומן למשימה, או null. date: התאריך הראשון; time: רק אם נבחרה שעה; rule: למשימה קבועה (אירוע חוזר). */
function calendarSpec(raw, data, now){
  if(!raw || raw.deleted || raw.archived || !raw.calendar) return null;
  const cfg = config(data.config), task = normTask(raw, cfg), today = localDate(now), idx = indexOcc(data.occ);
  let date = null, rule = null;
  if(task.kind === 'once') date = task.once?.date;
  else if(task.kind === 'schedule'){
    rule = task.schedule?.rule || {type: 'daily'};
    date = ruleDates(rule, maxStr(task.start, today), addDays(today, 800))[0] || null;
  }else if(task.kind === 'afterDone'){
    const o = occurrencesOf(task, idx, today, addDays(today, 800)).find(x => x.due && isOpen(x, now));
    date = o ? o.due : null;
  }
  if(!date) return null;
  const time = task.exact ? task.time : null, title = displayTitle(task);
  const occId = task.kind === 'afterDone' ? null : `${task.id}-${compact(date)}`;
  const spec = {title, date, time, rule, link: APP + (occId ? '#o=' + encodeURIComponent(occId) : '')};
  spec.sig = sha256(JSON.stringify([title, task.kind === 'schedule' ? task.start : date, time, rule])).slice(0, 12);
  return spec;
}
/** מה המנוע צריך לעשות: create = [{task, spec, old}], remove = [רשומות לאירועים שכבר לא רצויים]. */
function calendarDiff(data, calFile, now){
  const have = new Map((calFile?.events || []).filter(e => !e.deleted).map(e => [e.id, e])), create = [], remove = [];
  for(const t of data.tasks || []){
    const spec = calendarSpec(t, data, now), old = have.get(t.id);
    if(spec && (!old || old.sig !== spec.sig)) create.push({task: t, spec, old: old || null});
    else if(!spec && old) remove.push(old);
    have.delete(t.id);
  }
  for(const e of have.values()) remove.push(e);   // משימה שנמחקה לגמרי
  return {create, remove};
}
function mergeCalFile(a, b, now){ return {v: 1, events: mergeById(a?.events, b?.events, now)}; }

/* ---------- התראות ישירות לאפליקציה (Web Push, מהמנוע) ---------- */
// אין תזמון מראש: המנוע רץ כל דקה, ושולח רק מה שהגיע זמנו. לכן "בוצע" עוצר מיד את כל התזכורות הבאות.
const PUSH_BACK = 20 * 60e3, PUSH_LEAD = 30e3;
const pushKey = n => `${n.id}@${n.at}`;
/**
 * מה לשלוח עכשיו: התראות שזמנן הגיע (עד 20 דקות אחורה, למקרה שריצה התעכבה) ועוד לא נשלחו.
 * next = מתי ההתראה הבאה (בדקות הקרובות), כדי שהמנוע יידע לרוץ אז. sent = {pushKey: זמן שליחה}.
 */
function pushDue(data, now, sent){
  sent = sent || {};
  const plan = planNotifications(data, now - PUSH_BACK, {horizonH: (PUSH_BACK + 15 * 60e3) / 36e5});
  const due = [], later = [];
  for(const n of plan){
    if(n.at > now + PUSH_LEAD){ later.push(n.at); continue; }
    if(sent[pushKey(n)]) continue;
    const f = n.occId && findOcc(data, n.occId, now);
    if(!f || (f.occ.kind !== 'quota' && !isOpen(f.occ, now))) continue;
    due.push(n);
  }
  return {due, next: later.length ? Math.min(...later) : null};
}
/** תוכן ההתראה (מוצפן בדרך). btn = להציג כפתורים. */
const pushPayload = n => JSON.stringify({t: n.title, b: n.message || '', u: n.click || APP, tag: n.occId || n.id,
  o: n.occId || null, n: n.id, btn: !!(n.buttons && n.occId)});
/** מנקה מהזיכרון התראות שנשלחו לפני יותר מיומיים. */
function pruneSent(sent, now){
  const out = {};
  for(const [k, t] of Object.entries(sent || {})) if(now - t < 2 * DAY) out[k] = t;
  return out;
}
/** מכשירים שנרשמו להתראות: {v, subs: [{id, endpoint, p256dh, auth, updatedAt, deleted}]}. */
function mergeSubsFile(a, b, now){ return {v: 1, subs: mergeById(a?.subs, b?.subs, now)}; }
const liveSubs = file => (file?.subs || []).filter(s => !s.deleted && s.endpoint && s.p256dh && s.auth);

/* ---------- מיזוג ---------- */
/** לפי id: ה-updatedAt המאוחר מנצח. מחיקה (deleted) נשמרת 30 יום ואז נעלמת. */
function mergeById(a, b, now){
  const m = new Map();
  for(const r of [...(a || []), ...(b || [])]){
    if(!r || !r.id) continue;
    const c = m.get(r.id);
    if(!c || (r.updatedAt || '') > (c.updatedAt || '')
       || ((r.updatedAt || '') === (c.updatedAt || '') && JSON.stringify(r) > JSON.stringify(c))) m.set(r.id, r);
  }
  const limit = new Date((now ?? Date.now()) - 30 * DAY).toISOString();
  return [...m.values()].filter(r => !(r.deleted && (r.updatedAt || '') < limit));
}
function mergeConfig(a, b){
  const list = [a, b].filter(Boolean);
  const w = list.reduce((x, y) => (y.updatedAt || '') > (x.updatedAt || '') ? y : x, list[0] || {});
  return config(w);
}
function mergeTasksFile(a, b, now){
  return {v: 1, tasks: mergeById(a?.tasks, b?.tasks, now), domains: mergeById(a?.domains, b?.domains, now)};
}
function mergeOccFile(a, b, now){ return {v: 1, occ: mergeById(a?.occ, b?.occ, now)}; }

/* ---------- מייל ---------- */
/** מחלץ סכום ליד "לתשלום" או "סה"כ" עם ₪ או ש"ח. null אם אין. */
function extractAmount(text){
  const s = String(text || '');
  const num = '(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  const cur = '(?:₪|ש"ח|ש״ח|שח)';
  const res = [
    new RegExp(`(?:לתשלום|סה"כ|סה״כ|סך הכל)[^\\d₪]{0,25}${cur}?\\s*${num}\\s*${cur}?`),
  ];
  for(const re of res){
    const m = s.match(re);
    if(m){
      const around = s.slice(Math.max(0, m.index), m.index + m[0].length + 6);
      if(/₪|ש"ח|ש״ח|שח/.test(around)) return +m[1].replace(/,/g, '');
    }
  }
  return null;
}
/** משימה ממייל לפי כלל. המזהה נגזר ממזהה ההודעה, ולכן אותו מייל לא יוצר שתי משימות. */
function taskFromMail(rule, mail, nowIso){
  return {
    id: `mail-${mail.messageId}`, title: rule.title, domain: rule.domain, priority: rule.priority || 'normal',
    kind: 'email', email: {ruleId: rule.id, messageId: mail.messageId, threadUrl: mail.threadUrl || '',
      receivedAt: mail.receivedAt, amount: mail.amount ?? null, dueDays: +rule.dueDays || 0},
    time: rule.time || null, pre: [], nag: rule.nag || {mode: 'daily'}, discreet: !!rule.discreet,
    notifyTitle: rule.notifyTitle || null, calc: rule.calc || null, subtasks: (rule.subtasks || []).map(x => Object.assign({}, x)),
    notes: '', links: [], start: localDate(toMs(mail.receivedAt)), archived: false, updatedAt: nowIso, deleted: false,
  };
}
/** מחזיר רק משימות חדשות ממיילים שעוד לא נראו (גם לא משימה שנמחקה). */
function newMailTasks(tasks, rules, mails, nowIso){
  const seen = new Set((tasks || []).map(t => t.id)), out = [];
  for(const m of mails || []){
    const rule = (rules || []).find(r => r.id === m.ruleId);
    const id = `mail-${m.messageId}`;
    if(!rule || seen.has(id)) continue;
    seen.add(id);
    out.push(taskFromMail(rule, m, nowIso));
  }
  return out;
}

/* ---------- טקסטים ---------- */
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const shortDate = d => { const [y, m, dd] = d.split('-'); return `${+dd}.${+m}`; };
const longDate = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ב${MONTH_NAMES[m - 1]}`; };
function listHe(a){ return a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' ו' + a[a.length - 1]; }
const monthsHe = n => n === 1 ? 'כל חודש' : n === 2 ? 'כל חודשיים' : `כל ${n} חודשים`;
const timesHe = n => n === 1 ? 'פעם אחת' : n === 2 ? 'פעמיים' : `${n} פעמים`;

/** משפט בעברית פשוטה שמסביר את החוק של המשימה. */
function describeRule(task){
  switch(task.kind){
    case 'schedule': {
      const r = task.schedule?.rule || {};
      const dayTxt = r.day === 'last' ? 'ביום האחרון בחודש' : `ב־${r.day} לחודש`;
      if(r.type === 'daily') return 'כל יום';
      if(r.type === 'weekly') return (r.days || []).length === 7 ? 'כל יום'
        : `כל שבוע, ביום ${listHe((r.days || []).slice().sort().map(d => DAY_NAMES[d]))}`;
      if(r.type === 'monthly') return r.day === 'last' ? 'בסוף כל חודש' : `כל חודש, ב־${r.day} לחודש`;
      if(r.type === 'everyNMonths') return `${monthsHe(+r.n)}, ${dayTxt}`;
      if(r.type === 'yearly') return `כל שנה, ב־${r.day} ב${MONTH_NAMES[r.month - 1]}`;
      return '';
    }
    case 'afterDone': {
      const {minDays: a, maxDays: b} = task.afterDone || {};
      const span = a >= 14 && Math.round(a / 7) !== Math.round(b / 7)
        ? `כל ${Math.round(a / 7)} עד ${Math.round(b / 7)} שבועות` : `כל ${a} עד ${b} ימים`;
      return `${span}. נספר מהפעם האחרונה שבוצעה, לא מתאריך קבוע`;
    }
    case 'quota': return `${timesHe(+task.quota?.count || 1)} ${task.quota?.period === 'month' ? 'בחודש' : 'בשבוע'}`;
    case 'once': return task.once?.date ? `פעם אחת, ב־${shortDate(task.once.date)}.${task.once.date.slice(0, 4)}` : 'פעם אחת';
    case 'inbox': return 'בלי תאריך. נשארת ברשימה עד שמסמנים אותה';
    case 'email': return `נוצרה ממייל. יעד: ${task.email?.dueDays || 0} ימים מהגעתו`;
  }
  return '';
}

/* ---------- הוספה מהירה: "לקחת משקפיים מחר ב-7" ---------- */
/** מחלץ תאריך ושעה מהטקסט. מחזיר {title, date, time} (date/time = null כשלא נאמר). */
function parseQuick(text, now){
  let s = ' ' + String(text || '').replace(/\s+/g, ' ').trim() + ' ';
  const today = localDate(now);
  let date = null, time = null, part = null, m;
  const cut = re => { const x = s.match(re); if(x) s = s.replace(x[0], ' '); return x; };
  // "כל חודש", "כל חודשיים", "כל 3 חודשים", "כל יום", "כל שבוע", "כל שנה": משימה קבועה
  let repeat = null;
  if((m = cut(/ (?:כל|פעם ב)\s?(יום|שבוע|חודש|חודשיים|שנה|(\d+) חודשים)(?= )/)))
    repeat = m[2] ? (+m[2] === 1 ? 'monthly' : 'm' + m[2]) : {'יום': 'daily', 'שבוע': 'weekly', 'חודש': 'monthly', 'חודשיים': 'm2', 'שנה': 'yearly'}[m[1]];
  const done = o => repeat ? Object.assign(o, {repeat}) : o;
  if((m = cut(/ (?:בעוד|עוד) (חצי שעה|רבע שעה|שעה|שעתיים|(\d+) (שעות|דקות|דק'))(?= )/))){
    const min = m[2] ? +m[2] * (m[3] === 'שעות' ? 60 : 1) : {'חצי שעה': 30, 'רבע שעה': 15, 'שעה': 60, 'שעתיים': 120}[m[1]];
    const ms = Math.ceil((now + min * 6e4) / 6e4) * 6e4;
    return done({title: s.trim(), date: localDate(ms), time: localTime(ms)});
  }
  // תאריך "3.4" או "3/4" (יום.חודש): השנה, ואם עבר, בשנה הבאה. "10.30" הוא שעה (אין חודש 30)
  if((m = cut(/ (?:ב[-־]?\s?)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?= )/)) && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31){
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +today.slice(0, 4);
    date = `${y}-${pad(+m[2])}-${pad(Math.min(+m[1], daysInMonth(y, +m[2])))}`;
    if(!m[3] && date < today) date = `${y + 1}-${date.slice(5)}`;
  }else if(m) s = s.replace(' ', ' ' + m[0].trim() + ' ');   // לא תאריך: מחזירים, כדי שייקרא כשעה
  // "כל חודש ב-10": היום ה-10 בחודש, לא שעה (בלי "בשעה" ובלי נקודתיים)
  if(!date && repeat && (repeat === 'monthly' || /^m\d+$/.test(repeat)) && !/ (בבוקר|בצהריים|בצהרים|אחה"צ|בערב|בלילה|בשעה)(?= )/.test(s) && (m = cut(/ ב[-־]?\s?(\d{1,2})(?= )/)) && +m[1] >= 1 && +m[1] <= 31){
    const [y, mo] = today.split('-').map(Number), d = Math.min(+m[1], daysInMonth(y, mo));
    date = `${y}-${pad(mo)}-${pad(d)}`;
    if(date < today){ const ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1; date = `${ny}-${pad(nm)}-${pad(Math.min(+m[1], daysInMonth(ny, nm)))}`; }
  }
  if(date){}
  else if(cut(/ מחרתיים(?= )/)) date = addDays(today, 2);
  else if(cut(/ מחר(?= )/)) date = addDays(today, 1);
  else if(cut(/ היום(?= )/)) date = today;
  else if((m = cut(/ (?:ב?יום |ב)(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?= )/))){
    let d = addDays(today, 1);
    while(weekday(d) !== DAY_NAMES.indexOf(m[1])) d = addDays(d, 1);
    date = d;
  }
  if((m = cut(/ (בבוקר|בצהריים|בצהרים|אחה"צ|אחר הצהריים|בערב|בלילה)(?= )/))) part = m[1];
  if((m = cut(/ (?:בשעה |ב[-־]?\s?)(\d{1,2})(?:[:.](\d{2}))?(?= )/)) || (m = cut(/ (\d{1,2}):(\d{2})(?= )/))){
    let h = +m[1]; const mm = +(m[2] || 0);
    if(h <= 23 && mm <= 59){
      if(part && h < 12 && /ערב|לילה|צהר|אחה/.test(part) && !(/צהר/.test(part) && h >= 11)) h += 12;
      time = `${pad(h)}:${pad(mm)}`;
      if(!date){
        date = today;
        if(at(today, time) <= now){
          // "ב-7" בשלוש אחר הצהריים = 19:00 היום. אחרת: מחר
          if(!part && h < 12 && at(today, `${pad(h + 12)}:${pad(mm)}`) > now) time = `${pad(h + 12)}:${pad(mm)}`;
          else date = addDays(today, 1);
        }
      }
    }
  }
  if(!time && part) time = {'בבוקר': '08:00', 'בצהריים': '12:00', 'בצהרים': '12:00', 'אחה"צ': '16:00', 'אחר הצהריים': '16:00', 'בערב': '19:00', 'בלילה': '21:00'}[part];
  if(time && !date) date = at(today, time) > now ? today : addDays(today, 1);
  return done({title: s.trim(), date, time});
}

/* ---------- קניות ---------- */
// מחלקות לפי סדר ההליכה בסופר: מהכניסה (ירקות) ועד הקירור והקפואים בסוף, כדי שהקר יהיה בעגלה הכי פחות זמן.
const SHOP_CATS = [
  ['veg', '🥬', 'פירות וירקות'], ['bread', '🍞', 'לחם ומאפים'], ['dry', '🫘', 'קטניות, אורז ופסטה'],
  ['cans', '🥫', 'שימורים ורטבים'], ['bake', '🧂', 'שמן, תבלינים ואפייה'], ['morning', '☕', 'קפה, תה ודגני בוקר'],
  ['snack', '🍫', 'חטיפים ומתוקים'], ['drink', '🥤', 'משקאות'], ['dairy', '🥛', 'חלב, גבינות וביצים'],
  ['deli', '🥙', 'מעדנייה וסלטים'], ['meat', '🍗', 'בשר, עוף ודגים'], ['frozen', '🧊', 'קפואים'],
  ['clean', '🧽', 'ניקיון ובית'], ['care', '🧴', 'טיפוח והיגיינה'], ['other', '🛒', 'שונות'],
].map(([id, emoji, name], i) => ({id, emoji, name, order: i}));
const SHOP_CAT = Object.fromEntries(SHOP_CATS.map(c => [c.id, c]));
// המוצרים הנפוצים בסופר בישראל, בכל מחלקה מהנפוץ לפחות נפוץ. "שם|אמוג'י". שם בלי אמוג'י מקבל את של המחלקה.
const SHOP_POPULAR = {
  veg: 'עגבניות|🍅 מלפפונים|🥒 בצל|🧅 תפוחי אדמה|🥔 גזר|🥕 לימון|🍋 בננות|🍌 תפוחים|🍎 פלפל אדום|🫑 אבוקדו|🥑 שום|🧄 חסה|🥬 ' +
       'בטטה|🍠 עגבניות שרי|🍅 פטרוזיליה|🌿 כוסברה|🌿 שמיר|🌿 נענע|🌿 קישואים|🥒 חצילים|🍆 כרוב|🥬 ברוקולי|🥦 כרובית|🥦 תפוזים|🍊 ' +
       'קלמנטינות|🍊 אגסים|🍐 ענבים|🍇 אבטיח|🍉 מלון|🍈 תותים|🍓 פטריות|🍄 בצל ירוק|🧅 תירס|🌽 ג׳ינג׳ר|🫚 פלפל חריף|🌶️ סלק| אפרסקים|🍑 מנגו|🥭 קיווי|🥝 אננס|🍍 רימונים|🍎 שזיפים|🍑 דובדבנים|🍒 קוקוס|🥥 ארטישוק| פומלה|🍊 אפרסמון|🍊 תרד|🥬 ארוגולה|🥬 סלרי|🥬',
  bread: 'לחם|🍞 פיתות|🫓 לחמניות|🥖 חלה|🍞 באגט|🥖 טורטיות|🫓 לחם מלא|🍞 קרואסון|🥐 עוגה|🍰 לחמניות המבורגר|🍔 פירורי לחם|🍞',
  dry: 'אורז|🍚 פסטה|🍝 ספגטי|🍝 עדשים|🫘 חומוס יבש|🫘 שעועית|🫘 קוסקוס|🍚 בורגול|🌾 קינואה|🌾 פתיתים|🍚 שיבולת שועל|🌾 אטריות|🍜 נודלס|🍜',
  cans: 'רסק עגבניות|🥫 טונה|🐟 תירס בקופסה|🌽 חומוס בקופסה|🥫 זיתים|🫒 מלפפונים חמוצים|🥒 רוטב עגבניות|🥫 קטשופ|🍅 מיונז|🥫 חרדל|🥫 ' +
        'טחינה|🥫 רוטב סויה|🥫 שעועית בקופסה|🥫 אפונה וגזר|🥫 שימורי פטריות|🍄 ריבה|🍓 דבש|🍯 ממרח שוקולד|🍫 חמאת בוטנים|🥜',
  bake: 'שמן|🫒 שמן זית|🫒 מלח|🧂 סוכר|🧂 קמח|🌾 פלפל שחור|🧂 פפריקה|🌶️ כורכום|🧂 כמון|🧂 אבקת אפייה|🧂 סודה לשתייה|🧂 שמרים|🧂 ' +
        'וניל|🧂 קקאו|🍫 שוקולד מריר|🍫 אבקת מרק|🍲 חומץ|🧂 תבלין|🧂 אגוזים|🌰 שקדים|🌰 צימוקים|🍇 תמרים|🌴',
  morning: 'קפה|☕ קפה נמס|☕ קפה טורקי|☕ קפסולות|☕ תה|🍵 דגני בוקר|🥣 קורנפלקס|🥣 גרנולה|🥣 סילאן|🍯',
  snack: 'ביסלי|🍿 במבה|🥜 צ׳יפס|🥔 בייגלה|🥨 שוקולד|🍫 עוגיות|🍪 וופלים|🧇 קרקרים|🍘 פריכיות|🍘 גרעינים|🌻 פופקורן|🍿 ' +
         'חטיף אנרגיה|🍫 מסטיק|🍬 סוכריות|🍬 גלידה|🍦',
  drink: 'מים|💧 סודה|💧 קולה|🥤 מיץ תפוזים|🧃 מיץ|🧃 תרכיז|🧃 בירה|🍺 יין|🍷 שוקו|🥛 משקה סויה|🥛 משקה שקדים|🥛 מים מינרליים|💧',
  dairy: 'חלב|🥛 ביצים|🥚 קוטג׳|🧀 גבינה לבנה|🧀 גבינה צהובה|🧀 יוגורט|🥛 שמנת מתוקה|🥛 שמנת חמוצה|🥛 חמאה|🧈 לבנה|🥛 ' +
         'גבינה בולגרית|🧀 מוצרלה|🧀 פרמזן|🧀 גבינת שמנת|🧀 מעדן|🍮 פודינג|🍮 מילקי|🍮 אשל|🥛 גיל|🥛 ריקוטה|🧀 חלב שקדים|🥛 מרגרינה|🧈',
  deli: 'חומוס|🥙 טחינה מוכנה|🥙 סלט חצילים|🍆 מטבוחה|🍅 נקניק|🥓 פסטרמה|🥓 נקניקיות|🌭 טופו|🧈 שניצל תירס|🌽',
  meat: 'חזה עוף|🍗 שניצל|🍗 עוף שלם|🍗 כרעיים|🍗 פרגיות|🍗 שוקיים|🍗 בשר טחון|🥩 סטייק|🥩 צלי|🥩 המבורגר|🍔 ' +
        'כבד|🥩 הודו|🍗 סלמון|🐟 אמנון|🐟 דג|🐟 קבב|🥩',
  frozen: 'ירקות קפואים|🧊 אפונה קפואה|🫛 שעועית קפואה|🫘 צ׳יפס קפוא|🍟 בורקס|🥐 פיצה קפואה|🍕 שניצל קפוא|🍗 בצק עלים|🥐 ' +
          'פירות קפואים|🍓 קרח|🧊 מלאווח|🫓 ג׳חנון|🫓',
  clean: 'נייר טואלט|🧻 מגבות נייר|🧻 סבון כלים|🧽 טבליות למדיח|🧽 ספוגים|🧽 אבקת כביסה|🧺 ג׳ל כביסה|🧺 מרכך כביסה|🧺 ' +
         'אקונומיקה|🧴 מנקה רצפות|🧴 שקיות אשפה|🗑️ נייר אפייה|📜 נייר כסף|📜 ניילון נצמד|📜 מטליות|🧽 מגבונים|🧻 ' +
         'כוסות חד פעמיות|🥤 צלחות חד פעמיות|🍽️ סוללות|🔋 נורה|💡 שקיות סנדוויץ׳|🛍️ מצתים|🔥',
  care: 'משחת שיניים|🪥 מברשת שיניים|🪥 שמפו|🧴 מרכך|🧴 סבון|🧼 סבון ידיים|🧼 ג׳ל רחצה|🧴 דאודורנט|🧴 סכיני גילוח|🪒 ' +
        'קצף גילוח|🪒 קרם הגנה|🧴 קרם לחות|🧴 מקלוני אוזניים|🦻 חוט דנטלי|🦷 ממחטות|🤧 טמפונים|🩸 תחבושות|🩸 פלסטרים|🩹 אקמול|💊 ויטמינים|💊',
};
// שאר המוצרים בסופר (כ-700), אחרי הנפוצים. מוצעים כשמקלידים, ולא ברשימת ההצעות הראשונה.
const SHOP_MORE = {
 "veg": "לפת| דלעת|🎃 דלורית|🎃 צנון| צנונית| קולורבי| שומר| כרישה| אספרגוס| נבטים|🌱 נבטי חמנייה|🌱 עלי בייבי|🥬 חסה אייסברג|🥬 חסה רומית|🥬 כרוב סגול|🥬 כרוב ניצנים|🥬 פלפל צהוב|🫑 פלפל ירוק|🫑 פלפל כתום|🫑 צ׳ילי|🌶️ תפוחי אדמה אדומים|🥔 בצל סגול|🧅 בצל לבן|🧅 שאלוט|🧅 שום טרי|🧄 כורכום טרי| בזיליקום|🌿 רוזמרין|🌿 טימין|🌿 מרווה|🌿 אורגנו טרי|🌿 עירית|🌿 מנגולד|🥬 ענבים ירוקים|🍇 ענבים אדומים|🍇 תפוח ירוק|🍏 תפוחי פינק ליידי|🍎 תפוחי גרני סמית|🍏 נקטרינות|🍑 משמש|🍑 שסק| תאנים| ליצ׳י| פסיפלורה| גויאבה| פפאיה| אוכמניות|🫐 פטל| ליים|🍋 אשכולית|🍊 פומלית|🍊 מנדרינות|🍊 פטריות שמפיניון|🍄 פטריות פורטובלו|🍄 פטריות שיטאקי|🍄 פטריות יער|🍄 עגבניות תמר|🍅 שעועית ירוקה|🫛 אפונה טרייה|🫛 לוביה| במיה| ארוגולה|🥬 כוסברה טרייה|🌿 נענע טרייה|🌿 קייל|🥬 סלרי ענפים|🥬 פלפל חריף ירוק|🌶️ בטטה לבנה|🍠 תפוחי אדמה לאפייה|🥔 מלפפון בייבי|🥒 עגבניות לבישול|🍅 חציל בלאדי|🍆 אבוקדו האס|🥑 קלמנטינות אור|🍊 פרי הדר|🍊 תות שדה|🍓 מלון כתום|🍈 אבטיח ללא גרעינים|🍉 תפוח עץ|🍎 בננות מיובשות|🍌 שום קלוף|🧄 בצל קלוף|🧅 ירקות חתוכים|🥗 סלט ירקות ארוז|🥗",
 "bread": "לחם אחיד|🍞 לחם שיפון|🍞 לחם כוסמין|🍞 לחם דגנים|🍞 לחם לבן|🍞 לחם פרוס|🍞 לחם ללא גלוטן|🍞 לחם מחמצת|🍞 לחמניות מתוקות|🥖 לחמניות נקניקיה|🌭 פיתות מלאות|🫓 לאפה|🫓 חלה מתוקה|🍞 בייגל|🥯 בייגלה ירושלמי|🥯 מצות|🫓 בורקס גבינה|🥐 בורקס תפוחי אדמה|🥐 רוגלך|🥐 מאפינס|🧁 עוגת שמרים|🍰 עוגת שוקולד|🍰 עוגת גבינה|🍰 עוגת דבש|🍰 עוגת תפוזים|🍰 קרואסון שוקולד|🥐 קרואסון שקדים|🥐 דונאטס|🍩 סופגניות|🍩 פוקאצ׳ה|🍞 ג׳בטה|🥖 פרנה|🫓 קרוטונים|🍞 לחם קלוי|🍞 פיתה ללא גלוטן|🫓 עוגיות מאפייה|🍪 שטרודל|🥐 קרמבו|🍫",
 "dry": "אורז בסמטי|🍚 אורז יסמין|🍚 אורז פרסי|🍚 אורז מלא|🍚 אורז לסושי|🍙 אורז עגול|🍚 פסטה פנה|🍝 פסטה פוזילי|🍝 לזניה|🍝 פטוצ׳יני|🍝 טורטליני|🍝 ניוקי|🍝 פסטה מלאה|🍝 פסטה ללא גלוטן|🍝 קוסקוס מלא|🍚 עדשים כתומות|🫘 עדשים ירוקות|🫘 עדשים שחורות|🫘 שעועית לבנה|🫘 שעועית אדומה|🫘 שעועית שחורה|🫘 אפונה יבשה|🫘 פול|🫘 גריסי פנינה|🌾 כוסמת|🌾 דוחן|🌾 סולת|🌾 אטריות אורז|🍜 אטריות ביצים|🍜 ראמן|🍜 פתיתים אפויים|🍚 פירה מוכן|🥔 פסטה קונכיות|🍝 ספגטי מלא|🍝 אורז פרא|🍚 פריקה|🌾 בורגול דק|🌾 בורגול גס|🌾 קמח חומוס|🌾",
 "cans": "חלב מרוכז| אפונה בקופסה|🥫 ארטישוק בקופסה|🥫 לבבות דקל|🥫 עגבניות מרוסקות|🥫 עגבניות קלופות|🥫 פסטו|🌿 רוטב פסטה|🥫 רוטב צ׳ילי מתוק|🌶️ רוטב ברביקיו|🥫 סחוג|🌶️ הריסה|🌶️ עמבה|🥭 רוטב טריאקי|🥫 רוטב אלף האיים|🥫 רוטב לסלט|🥫 זיתים ירוקים|🫒 זיתים שחורים|🫒 זיתי קלמטה|🫒 כרוב כבוש|🥫 לימון כבוש|🍋 פלפלים קלויים|🫑 חלפיניו|🌶️ צלפים|🥫 טונה בשמן|🐟 טונה במים|🐟 סרדינים|🐟 אנשובי|🐟 ריבת תות|🍓 ריבת משמש|🍑 ריבת חלב|🥛 חלב קוקוס|🥥 קרם קוקוס|🥥 אננס בקופסה|🍍 אפרסקים בקופסה|🍑 תירס גמדי|🌽 שעועית אפויה|🥫 ממרח זיתים|🫒 חרדל דיז׳ון|🥫 מיונז לייט|🥫 טחינה גולמית|🥫 מרק בקופסה|🥫 גרגרי חומוס בקופסה|🥫 שעועית לבנה ברוטב|🥫 קטשופ חריף|🍅 רוטב שום|🧄 רוטב חמוץ מתוק|🥫 רוטב צ׳ילי|🌶️ ממרח לוטוס|🍪 ממרח פיסטוק|🥜 חמאת שקדים|🥜 דבש טבעי|🍯 סירופ מייפל|🍁 סירופ תמרים|🌴",
 "bake": "פלפל לבן| ראס אל חנות| קוביות מרק| כמון טחון| שמן קנולה|🫒 שמן חמניות|🌻 שמן קוקוס|🥥 שמן סויה|🫒 תרסיס שמן|🫒 חומץ בלסמי|🧂 חומץ תפוחים|🍎 מיץ לימון|🍋 מלח גס|🧂 מלח לימון|🧂 מלח ים|🧂 סוכר חום|🧂 אבקת סוכר|🧂 סוכר וניל|🧂 סטיביה|🧂 סוכרזית|🧂 קמח לבן|🌾 קמח מלא|🌾 קמח תופח|🌾 קמח כוסמין|🌾 קמח תירס|🌽 קורנפלור|🌾 שמרים יבשים|🧂 ג׳לטין|🧂 שוקולד צ׳יפס|🍫 סוכריות לקישוט|🍬 תמצית וניל|🧂 פפריקה מתוקה|🌶️ פפריקה חריפה|🌶️ פלפל אנגלי|🧂 קינמון|🧂 הל|🧂 ציפורן|🧂 זעתר|🌿 סומק|🧂 בהרט|🧂 חוואיג׳|🧂 ג׳ינג׳ר טחון|🧂 אגוז מוסקט|🧂 אורגנו|🌿 בזיליקום יבש|🌿 פטרוזיליה יבשה|🌿 עלי דפנה|🌿 צ׳ילי גרוס|🌶️ שום גבישי|🧄 בצל מטוגן|🧅 אבקת שום|🧄 אבקת בצל|🧅 תבלין לעוף|🧂 אבקת מרק עוף|🍲 אבקת מרק בצל|🍲 שומשום|🌰 אגוזי מלך|🌰 אגוזי לוז|🌰 קשיו|🥜 פקאן|🌰 פיסטוקים|🥜 בוטנים|🥜 צנוברים|🌰 שקדים טחונים|🌰 קוקוס טחון|🥥 חמוציות| משמש מיובש|🍑 שזיפים מיובשים|🍑 תאנים מיובשות| זרעי צ׳יה|🌱 זרעי פשתן|🌱 גרעיני דלעת|🎃 פרג|🌰 שמן שומשום|🫒 מלח עם יוד|🧂 תערובת לעוגה|🍰 פודינג אינסטנט|🍮 קצפת אבקה|🧂 שוקולד לבן לבישול|🍫 אבקת קקאו|🍫 פירורי פנקו|🍞 קמח שקדים|🌰 סוכר קנים|🧂 דבש תמרים|🌴",
 "morning": "קפה טחון|☕ פולי קפה|☕ קפה פילטר|☕ קפה נטול קפאין|☕ תה ירוק|🍵 תה צמחים|🍵 תה נענע|🍵 תה קמומיל|🍵 תה ארל גריי|🍵 תה שחור|🍵 אבקת שוקו|🍫 כריות|🥣 מוזלי|🥣 ממרח תמרים|🌴 קפסולות נספרסו|☕ מחליב לקפה|🥛 קפה בוץ|☕ קפה הל|☕ דגני בוקר מלאים|🥣 פצפוצי אורז|🥣 פתיתי תירס|🥣 תה לימונית|🍵 תה פירות|🍵 קפה קלוי|☕",
 "snack": "אפרופו|🌽 דוריטוס|🌽 תפוצ׳יפס|🥔 צ׳יטוס|🧀 קליק|🍫 פסק זמן|🍫 טעמי|🍫 כיף כף|🍫 קינדר|🍫 מקופלת|🍫 שוקולד חלב|🍫 שוקולד לבן|🍫 עוגיות שוקולד צ׳יפס|🍪 אוראו|🍪 חטיף חלבון|🍫 חטיף דגנים|🍫 חטיף פירות|🍓 גרעינים לבנים|🌻 גרעינים שחורים|🌻 פיצוחים|🥜 בוטנים אמריקאים|🥜 סוכריות גומי|🍬 מרשמלו|🍬 חלבה|🍬 טופי|🍬 סוכריה על מקל|🍭 במבה נוגט|🥜 חטיף אורז|🍘 כעכים|🥨 פרינגלס|🥔 ביסקוויטים|🍪 פתי בר|🍪 עוגיות גבינה|🍪 בייגלה מלוח|🥨 צ׳יפס בטטה|🍠 שוקולד מריר 70|🍫 פסק זמן לבן|🍫 מנטוס|🍬 שוקולד עם אגוזים|🍫 עוגיות חמאה|🍪 גלידה בגביע|🍦",
 "drink": "שישיית מים|💧 מים בטעמים|💧 קולה זירו|🥤 ספרייט|🥤 פאנטה|🥤 שוופס|🥤 פריגת|🧃 ספרינג|🧃 תפוזינה|🧃 מיץ תפוחים|🧃 מיץ ענבים|🧃 מיץ אשכוליות|🧃 לימונדה|🍋 תה קר|🧋 משקה אנרגיה|🥤 רד בול|🥤 בירה ללא אלכוהול|🍺 יין אדום|🍷 יין לבן|🍷 יין רוזה|🍷 יין קידוש|🍷 וודקה|🍸 ערק|🥃 וויסקי|🥃 ליקר|🍸 סיידר|🍎 שוקו בשקית|🥛 קפה קר|☕ משקה שיבולת שועל|🥛 מי קוקוס|🥥 טוניק|🥤 מיץ גזר|🥕 מיץ רימונים|🧃 מיץ מנגו|🧃 נביעות|💧 מים מוגזים|💧 קוקה קולה|🥤 פפסי|🥤 ספרייט זירו|🥤 ג׳ין|🍸 רום|🥃 שמפניה|🍾 בירה שחורה|🍺",
 "dairy": "חלב 3%|🥛 חלב 1%|🥛 חלב דל לקטוז|🥛 ביצים חופש|🥚 ביצים גדולות|🥚 גבינה צפתית|🧀 גבינת פטה|🧀 גבינת עזים|🧀 גבינה צהובה פרוסה|🧀 עמק|🧀 גאודה|🧀 אדם|🧀 צ׳דר|🧀 חלומי|🧀 ברי|🧀 קממבר|🧀 גבינה כחולה|🧀 מסקרפונה|🧀 גבינה מגורדת|🧀 יוגורט יווני|🥛 יוגורט פירות|🥛 יוגורט חלבון|🥛 יוגורט שתייה|🥛 אקטיביה|🥛 דנונה|🥛 יופלה|🥛 מעדן חלבון|🍮 דני|🍮 לבן|🥛 קפיר|🥛 שמנת לבישול|🥛 שמנת להקצפה|🥛 קצפת|🥛 חמאה מלוחה|🧈 גבינה לבנה 5%|🧀 קוטג׳ 5%|🧀 גבינת ריקוטה|🧀 גבינה מלוחה|🧀 גבינת שמנת לייט|🧀 מוצרלה טרייה|🧀 חלב עמיד|🥛 חלב בשקית|🥛 פודינג חלב|🍮 מעדן שוקולד|🍮 טופו משי|🧈 יוגורט טבעי|🥛 שמנת חמוצה 15%|🥛",
 "deli": "סלט טורקי|🥗 סלט כרוב|🥗 סלט ביצים|🥚 סלט טונה|🐟 באבא גנוש|🍆 גוואקמולי|🥑 צזיקי|🥒 סלמי|🥓 פסטרמה הודו|🥓 קבנוס|🌭 קובה|🥟 ממולאים|🫑 מרק מוכן|🍲 כבד קצוץ|🥩 הרינג|🐟 סלמון מעושן|🐟 זיתים מתובלים|🫒 סייטן|🥩 חומוס מסבחה|🥙 פלאפל|🧆 שניצל מוכן|🍗 עוף צלוי|🍗 אורז מוכן|🍚 סלט קינואה|🥗 סלט חסה|🥗 חזה הודו פרוס|🥓 נקניק סלמי|🥓 פסטרמה בקר|🥓 ממרח חצילים|🍆 סלט גזר|🥕",
 "meat": "כנפיים|🍗 ירכיים|🍗 כבד עוף|🍗 לבבות עוף|🍗 קורקבנים|🍗 טחון עוף|🍗 טחון הודו|🍗 אנטריקוט|🥩 סינטה|🥩 פילה בקר|🥩 צלעות|🥩 אסאדו|🥩 אונטריב|🥩 צלי כתף|🥩 שפונדרה|🥩 בשר לגולאש|🥩 כבש|🐑 טלה|🐑 צלעות טלה|🐑 דניס|🐟 לברק|🐟 מוסר ים|🐟 בורי|🐟 טונה טרייה|🐟 פילה בקלה|🐟 קרפיון|🐟 שרימפס|🦐 פילה דג|🐟 נסיכת הנילוס|🐟 שניצל עוף|🍗 חזה עוף פרוס|🍗 כרעיים עוף|🍗 פרגית שלמה|🍗 בשר בקר|🥩 בשר טחון בקר|🥩 המבורגר טרי|🍔 קבב עוף|🍗 נקניקיות עוף|🌭 שוק טלה|🐑 פילה סלמון|🐟 טחון דגים|🐟 מרגז|🌭",
 "frozen": "ברוקולי קפוא|🥦 כרובית קפואה|🥦 תירס קפוא|🌽 ירקות מוקפצים|🥡 תרד קפוא|🥬 במיה קפואה| תותים קפואים|🍓 מנגו קפוא|🥭 פירות יער קפואים|🫐 בצק פילו|🥐 בצק שמרים|🥐 קובה קפואה|🥟 נאגטס|🍗 פלאפל קפוא|🧆 המבורגר קפוא|🍔 קבב קפוא|🥩 דגים קפואים|🐟 אצבעות דגים|🐟 ארטיק|🍦 קרטיב|🍧 יוגורט קפוא|🍦 אדממה|🫛 טבעות בצל|🧅 סיגרים|🥐 לביבות קפואות|🥔 פיצה משפחתית|🍕 בורקס פיצה|🥐 ירקות לשניצל|🥦 פטריות קפואות|🍄 אפונה וגזר קפואים|🫛 שעועית ירוקה קפואה|🫛 גלידה וניל|🍦 גלידה שוקולד|🍦 עוף קפוא|🍗 פילה אמנון קפוא|🐟 פירה קפוא|🥔 כופתאות גיוזה|🥟 מוקפץ קפוא|🥡",
 "clean": "מפיות|🧻 מבריק למדיח|🧽 מלח למדיח|🧂 ג׳ל למדיח|🧽 סקוץ׳|🧽 קפסולות כביסה|🧺 מסיר כתמים|🧺 מלבין|🧺 מנקה חלונות|🪟 מנקה אמבטיה|🛁 מסיר אבנית|🧴 תרסיס חיטוי|🧴 ג׳ל אסלה|🚽 מבשם אוויר|🌸 מבשם לאסלה|🚽 שקיות הקפאה|🛍️ שקיות זיפלוק|🛍️ תבניות אלומיניום|🍽️ סכו״ם חד פעמי|🍴 קשים|🥤 קשיות|🥤 גפרורים|🔥 נרות|🕯️ נרות שבת|🕯️ מטאטא|🧹 יעה|🧹 מגב|🧹 דלי|🪣 סמרטוט רצפה|🧽 כפפות ניקוי|🧤 כפפות חד פעמיות|🧤 אטבי כביסה|🧺 נייר טואלט לח|🧻 דוחה יתושים|🦟 תרסיס נגד חרקים|🦟 מנקה כללי|🧴 מנקה מטבח|🧴 מסיר שומנים|🧴 מנקה תנורים|🧴 פותח סתימות|🧴 שקיות אשפה גדולות|🗑️ מפות חד פעמיות|🍽️ קערות חד פעמיות|🥣 סוללות AA|🔋 סוללות AAA|🔋 מטליות מיקרופייבר|🧽 נייר סופג|🧻 שקיות קניות|🛍️ מרכך כביסה מרוכז|🧺 אבקה למדיח|🧽 נוזל כביסה|🧺 אקונומיקה ג׳ל|🧴 מנקה רצפות בניחוח|🧴",
 "care": "מי פה|🦷 מסכה לשיער|🧴 ג׳ל לשיער|🧴 ספריי לשיער|🧴 צבע לשיער|🎨 ספוג רחצה|🧽 בושם|🌸 אפטרשייב|🧴 קרם ידיים|🧴 קרם גוף|🧴 קרם פנים|🧴 שפתון לחות|💄 מסיר איפור|🧴 פדים|⚪ צמר גפן|⚪ מגבונים לחים|🧻 חיתולים|🍼 מגבונים לתינוק|🍼 תחליף חלב|🍼 קרם החתלה|🍼 שמפו לתינוק|🍼 נורופן|💊 אדוויל|💊 אופטלגין|💊 טיפות עיניים|💧 תרסיס לאף|💊 סירופ לשיעול|💊 ויטמין D|💊 ויטמין C|💊 אומגה 3|💊 מגנזיום|💊 ברזל|💊 קונדומים| מדחום|🌡️ אלכוהול לחיטוי|🧴 ג׳ל אלכוהול|🧴 לק|💅 מסיר לק|💅 גומיות לשיער|🎀 מסרק|🪮 מברשת שיער|🪮 תחבושות לילה|🩸 פדים יומיים|🩸 סבון פנים|🧼 קרם לחות לפנים|🧴 דאודורנט ספריי|🧴 דאודורנט רול|🧴 משחת שיניים לבנה|🪥 מברשות שיניים חשמליות|🪥 קיסמים|🦷 חוט דנטלי מקלות|🦷 שמפו נגד קשקשים|🧴 קרם הגנה לילדים|🧴 אפטר סאן|🧴 גזה|🩹 תחבושת אלסטית|🩹 משחה לפצעים|🩹 כדורים לכאב גרון|💊 אנטיהיסטמין|💊",
 "other": "אוכל לכלב|🐕 אוכל לחתול|🐈 חול לחתול|🐈 חטיפים לכלב|🐕 שקיות לקקי|🐕 פרחים|💐 מתנה|🎁 כרטיס ברכה|💌 עיתון|📰 בלונים|🎈"
};

const SHOP_CATALOG = [];
// מוצרים שהאמוג'י של המחלקה באמת מראה אותם (שאר מוצרים בלי אמוג'י משלהם לא יקבלו את של המחלקה)
const EMOJI_OK = new Set(['חסה', 'כרוב', 'עלי בייבי', 'כרוב סגול', 'מנגולד', 'תרד', 'קייל', 'לחם', 'חלה', 'לחם מלא', 'לחם שיפון', 'לחם כוסמין', 'לחם דגנים',
  'לחם לבן', 'לחם פרוס', 'לחם מחמצת', 'לחם ללא גלוטן', 'לחם קלוי', 'שעועית', 'עדשים', 'עדשים כתומות', 'עדשים ירוקות', 'עדשים שחורות', 'שעועית לבנה', 'שעועית אדומה',
  'שעועית שחורה', 'אפונה יבשה', 'פול', 'רסק עגבניות', 'מלח', 'סוכר', 'קפה', 'חלב', 'קרח', 'שוקולד', 'משקה סויה', 'שימורי פטריות']);
for(const [list, base] of [[SHOP_POPULAR, 0], [SHOP_MORE, 1000]])
  for(const [cat, s] of Object.entries(list))
    [...s.matchAll(/\s*([^|]+?)\|(\S*)/g)].forEach(([, name, emoji], i) => {
      name = name.trim();
      if(!SHOP_CATALOG.some(x => x.name === name)) SHOP_CATALOG.push({name, cat, emoji: emoji || SHOP_CAT[cat].emoji, rank: base + i});
    });
// שמות נרדפים: מוצר אחד בכמה שמות. החיפוש מוצא אותו בכל אחד מהם, אבל ברשימה הוא מופיע פעם אחת, בשם הראשון.
const SHOP_ALIASES = `קשים=קשיות; סודה=מים מוגזים; משקה שקדים=חלב שקדים; משקה סויה=חלב סויה; קולה=קוקה קולה;
  צ׳יפס=תפוצ׳יפס; פלפל חריף=צ׳ילי; תפוחים=תפוח עץ,תפוחי עץ; קורנפלקס=פתיתי תירס; קקאו=אבקת קקאו;
  מגבות נייר=נייר סופג,נייר מגבת; סבון כלים=נוזל כלים; ג׳ל כביסה=נוזל כביסה; ריקוטה=גבינת ריקוטה; שניצל=שניצל עוף;
  כרעיים=כרעיים עוף; בשר טחון=בשר טחון בקר,טחון בקר; סלמון=פילה סלמון; המבורגר=המבורגר טרי; סלמי=נקניק סלמי;
  פסטרמה=פסטרמה בקר; טחינה=טחינה גולמית; מים=מים מינרליים,נביעות,מים בבקבוק; שמנת חמוצה=שמנת חמוצה 15%;
  גבינה לבנה=גבינה לבנה 5%; יוגורט=יוגורט טבעי; ביצים=ביצים גדולות; שמנת מתוקה=שמנת להקצפה;
  דבש=דבש טבעי; מנקה רצפות=מנקה רצפות בניחוח; תה=תה שחור; שעועית קפואה=שעועית ירוקה קפואה;
  ממחטות=טישו; פלפל אדום=גמבה; כוסברה=כוסבר; נייר טואלט=נייר טואלט רגיל;
  מצתים=מצית; גפרורים=גפרור; נורה=נורות; קיסמים=קיסם;
  עגבניות=עגבניות לבישול; עגבניות שרי=עגבניות תמר; בצל=בצל לבן,בצל קלוף; לחם=לחם לבן,לחם פרוס,לחם אחיד;
  חסה=חסה אייסברג,חסה רומית; תפוחי אדמה=תפוחי אדמה אדומים,תפוחי אדמה לאפייה; שום=שום טרי,שום קלוף;
  ענבים=ענבים ירוקים,ענבים אדומים; פטריות=פטריות שמפיניון; כוסברה=כוסברה טרייה; נענע=נענע טרייה; סלרי=סלרי ענפים;
  פלפל חריף=פלפל חריף ירוק; בטטה=בטטה לבנה; אבוקדו=אבוקדו האס; קלמנטינות=קלמנטינות אור; מלון=מלון כתום;
  אבטיח=אבטיח ללא גרעינים; חלה=חלה מתוקה; עוגיות=עוגיות מאפייה; אורז=אורז עגול;
  פסטה=פסטה פנה,פסטה פוזילי,פסטה קונכיות; פתיתים=פתיתים אפויים; בורגול=בורגול דק,בורגול גס; קמח=קמח לבן;
  טונה=טונה בשמן,טונה במים; חלב=חלב 3%,חלב 1%,חלב עמיד,חלב בשקית,חלב בקרטון; מיונז=מיונז לייט; קטשופ=קטשופ חריף;
  שעועית אפויה=שעועית לבנה ברוטב; מלח=מלח ים,מלח עם יוד; סוכר חום=סוכר קנים; שמרים=שמרים יבשים;
  שוקולד מריר=שוקולד מריר 70; שוקולד לבן=שוקולד לבן לבישול; פסק זמן=פסק זמן לבן; ספרייט=ספרייט זירו; שוקו=שוקו בשקית;
  ביצים=ביצים חופש; גבינה צהובה=גבינה צהובה פרוסה; גבינת שמנת=גבינת שמנת לייט; מוצרלה=מוצרלה טרייה; טופו=טופו משי;
  חמאה=חמאה מלוחה; מעדן=מעדן שוקולד; חזה עוף=חזה עוף פרוס; שקיות אשפה=שקיות אשפה גדולות;
  סוללות=בטריות,סוללות AA,סוללות AAA; מטליות=מטליות מיקרופייבר; מרכך כביסה=מרכך כביסה מרוכז; אקונומיקה=כלור,אקונומיקה ג׳ל;
  תחבושות=תחבושות לילה; קרם פנים=קרם לחות לפנים; דאודורנט=דאודורנט ספריי,דאודורנט רול; משחת שיניים=משחת שיניים לבנה;
  חוט דנטלי=חוט דנטלי מקלות; קרם הגנה=קרם הגנה לילדים; גלידה=גלידה וניל,גלידה שוקולד,גלידה בגביע;
  פולי קפה=קפה קלוי; גרעינים=גרעינים לבנים,גרעינים שחורים; בוטנים=בוטנים אמריקאים; דגני בוקר=דגני בוקר מלאים;
  בייגלה=בייגלה מלוח; מגבונים=מגבונים לחים; קוטג׳=קוטג׳ 5%`;
const ALIAS_OF = {};
for(const part of SHOP_ALIASES.split(';')){
  const [canon, rest] = part.split('=').map(x => x.trim());
  for(const al of rest.split(',').map(x => x.trim())) ALIAS_OF[al] = canon;
}
// שם נרדף שהופיע ברשימה כמוצר נפרד יוצא ממנה, ועובר לשמות של המוצר הראשי
for(let i = SHOP_CATALOG.length - 1; i >= 0; i--) if(ALIAS_OF[SHOP_CATALOG[i].name]) SHOP_CATALOG.splice(i, 1);
for(const x of SHOP_CATALOG) x.aliases = Object.keys(ALIAS_OF).filter(al => ALIAS_OF[al] === x.name);
// תמונות אמיתיות של מצרכים (TheMealDB, נבחרו ונבדקו אחת-אחת: רק תמונה שמראה את המוצר עצמו)
const SHOP_PHOTOS = {"שמרים": "Instant Yeast", "ריבת חלב": "Dulce de leche", "סילאן": "Maple Syrup", "לבנה": "Cream Cheese", "שמרים יבשים": "Instant Yeast", "לפת": "Turnips", "עגבניות": "Tomatoes", "מלפפונים": "Cucumber", "בצל": "Onions", "תפוחי אדמה": "Potatoes", "גזר": "Carrots", "לימון": "Lemon", "בננות": "Banana", "תפוחים": "Apples", "פלפל אדום": "Red Pepper", "אבוקדו": "Avocado", "שום": "Garlic", "חסה": "Lettuce", "עגבניות שרי": "Cherry Tomatoes", "פטרוזיליה": "Parsley", "כוסברה": "Cilantro", "שמיר": "Dill", "נענע": "Mint", "קישואים": "Zucchini", "חצילים": "Aubergine", "כרוב": "Cabbage", "ברוקולי": "Broccoli", "תפוזים": "Orange", "אגסים": "Pears", "תותים": "Strawberries", "פטריות": "Mushrooms", "בצל ירוק": "Spring Onions", "ג׳ינג׳ר": "Ginger", "פלפל חריף": "Green Chilli", "סלק": "Beetroot", "אפרסקים": "Peaches", "מנגו": "Mango", "דלעת": "Pumpkin", "דלורית": "Butternut Squash", "כרישה": "Leek", "שומר": "Fennel Bulb", "אספרגוס": "Asparagus", "נבטים": "Bean Sprouts", "פלפל צהוב": "Yellow Pepper", "פלפל ירוק": "Green Pepper", "בצל סגול": "Red Onions", "שאלוט": "Shallots", "בזיליקום": "Basil", "רוזמרין": "Rosemary", "טימין": "Thyme", "מרווה": "Sage", "עירית": "Chives", "תאנים": "Figs", "אוכמניות": "Blueberries", "פטל": "Raspberries", "ליים": "Lime", "קייל": "Kale", "ארוגולה": "Rocket", "תרד": "Spinach", "סלרי": "Celery", "שעועית ירוקה": "Green Beans", "משמש": "Apricot", "דובדבנים": "Cherry", "כרוב ניצנים": "Brussels Sprouts", "צ׳ילי": "Red Chilli", "פטריות שיטאקי": "Shiitake Mushrooms", "פטריות יער": "Wild Mushrooms", "חלפיניו": "Jalapeno", "לפת": "Turnips", "רימונים": "Pomegranate", "לחם": "Bread", "פיתות": "Pita Bread", "באגט": "Baguette", "טורטיות": "Tortillas", "לחמניות המבורגר": "Buns", "לחמניות": "Bread Rolls", "פירורי לחם": "Breadcrumbs", "לחם שיפון": "Rye Bread", "לחם מלא": "Wholegrain Bread", "צ׳בטה": "Ciabatta", "ג׳בטה": "Ciabatta", "אורז": "Rice", "פסטה": "Penne Rigate", "ספגטי": "Spaghetti", "עדשים": "Lentils", "חומוס יבש": "Chickpeas", "קוסקוס": "Couscous", "בורגול": "Bulgur Wheat", "קינואה": "Quinoa", "שיבולת שועל": "Rolled Oats", "אטריות": "Noodles", "נודלס": "Noodles", "אורז בסמטי": "Basmati Rice", "אורז יסמין": "Jasmine Rice", "אורז מלא": "Brown Rice", "אורז לסושי": "Sushi Rice", "לזניה": "Lasagne Sheets", "פטוצ׳יני": "Fettuccine", "שעועית לבנה": "Butter Beans", "שעועית אדומה": "Kidney Beans", "שעועית שחורה": "Black Beans", "עדשים ירוקות": "French Lentils", "אטריות אורז": "Rice Noodles", "כוסמת": "Buckwheat", "פול": "Broad Beans", "קמח חומוס": "Chickpea Flour", "רסק עגבניות": "Tomato Puree", "זיתים": "Black Olives", "זיתים ירוקים": "Green Olives", "זיתים שחורים": "Pitted Black Olives", "מלפפונים חמוצים": "Dill Pickles", "רוטב עגבניות": "Tomato Sauce", "קטשופ": "Tomato Ketchup", "מיונז": "Mayonnaise", "חרדל": "Mustard", "חרדל דיז׳ון": "Dijon Mustard", "טחינה": "Tahini", "רוטב סויה": "Soy Sauce", "ריבה": "Jam", "דבש": "Honey", "ממרח שוקולד": "Nutella", "חמאת בוטנים": "Peanut Butter", "עגבניות מרוסקות": "Chopped Tomatoes", "חלב קוקוס": "Coconut Milk", "שעועית אפויה": "Baked Beans", "צלפים": "Capers", "סרדינים": "Sardines", "כרוב כבוש": "Sauerkraut", "רוטב ברביקיו": "Barbeque Sauce", "סירופ מייפל": "Maple Syrup", "רוטב צ׳ילי מתוק": "sweet chilli sauce", "פסטו": "Basil Leaves", "סחוג": "Green Salsa", "רוטב צ׳ילי": "Hotsauce", "שמן": "Vegetable Oil", "שמן זית": "Olive Oil", "מלח": "Salt", "סוכר": "Sugar", "קמח": "Flour", "פלפל שחור": "Black Pepper", "פפריקה": "Paprika", "כורכום": "Turmeric", "כמון": "Cumin", "אבקת אפייה": "Baking Powder", "סודה לשתייה": "Bicarbonate Of Soda", "וניל": "Vanilla Extract", "תמצית וניל": "Vanilla Extract", "קקאו": "Cocoa", "שוקולד מריר": "Dark Chocolate", "חומץ": "White Vinegar", "אגוזים": "Walnuts", "אגוזי מלך": "Walnuts", "שקדים": "Almonds", "צימוקים": "Raisins", "תמרים": "Medjool Dates", "שמן קנולה": "Canola Oil", "שמן חמניות": "Sunflower Oil", "חומץ בלסמי": "Balsamic Vinegar", "חומץ תפוחים": "Apple Cider Vinegar", "מיץ לימון": "Lemon Juice", "מלח גס": "Sea Salt", "סוכר חום": "Brown Sugar", "אבקת סוכר": "Icing Sugar", "קורנפלור": "Cornstarch", "קמח תירס": "Corn Flour", "קמח שקדים": "Almond Flour", "ג׳לטין": "Gelatine Leafs", "שוקולד צ׳יפס": "Chocolate Chips", "פפריקה מתוקה": "sweet smoked paprika", "פפריקה חריפה": "Chilli Powder", "קינמון": "Cinnamon", "הל": "Cardamom", "ציפורן": "Cloves", "ג׳ינג׳ר טחון": "Ground Ginger", "אגוז מוסקט": "Nutmeg", "אורגנו": "Oregano", "עלי דפנה": "Bay Leaves", "צ׳ילי גרוס": "Red Chilli Flakes", "אבקת שום": "Garlic Powder", "שומשום": "Sesame Seed", "אגוזי לוז": "Hazlenuts", "קשיו": "Cashews", "פקאן": "Pecan Nuts", "בוטנים": "Peanuts", "צנוברים": "Pine Nuts", "קוקוס טחון": "Desiccated Coconut", "משמש מיובש": "Dried Apricots", "שזיפים מיובשים": "Prunes", "שקדים טחונים": "Ground Almonds", "פלפל אנגלי": "Allspice", "סוכר וניל": "vanilla sugar", "שמן שומשום": "Sesame Seed Oil", "בהרט": "Mixed Spice", "ראס אל חנות": "Ras el hanout", "כמון טחון": "Ground Cumin", "אבקת מרק עוף": "Chicken Stock Cube", "קוביות מרק": "Bouillon Cubes", "שוקולד": "Milk Chocolate", "בייגלה": "Pretzels", "מרשמלו": "Miniature Marshmallows", "שוקולד חלב": "Milk Chocolate", "גלידה": "Ice Cream", "מים": "Water", "בירה": "Stout", "יין": "Red Wine", "יין אדום": "Red Wine", "יין לבן": "White Wine", "סיידר": "Cider", "רום": "Rum", "משקה שקדים": "Almond Milk", "משקה סויה": "Soya Milk", "חלב": "Milk", "ביצים": "Eggs", "גבינה צהובה": "Cheddar Cheese", "יוגורט": "Yogurt", "שמנת מתוקה": "Heavy Cream", "שמנת חמוצה": "Sour Cream", "חמאה": "Butter", "גבינה בולגרית": "Feta", "מוצרלה": "Mozzarella", "פרמזן": "Parmesan", "גבינת שמנת": "Cream Cheese", "ריקוטה": "Ricotta", "מרגרינה": "Vegan Butter", "יוגורט יווני": "Greek Yogurt", "גבינת פטה": "Feta", "גאודה": "Gouda Cheese", "ברי": "Brie", "גבינת עזים": "Goats Cheese", "מסקרפונה": "Mascarpone", "שמנת לבישול": "Single Cream", "קצפת": "Whipping Cream", "חלב מרוכז": "Condensed Milk", "צ׳דר": "Mature Cheddar", "גבינה מגורדת": "Shredded Mexican Cheese", "גבינה צהובה פרוסה": "Cheese Slices", "טופו": "Tofu", "פלאפל": "Falafel", "סלמון מעושן": "Smoked Salmon", "הרינג": "Herring", "חזה עוף": "Chicken Breast", "עוף שלם": "Chicken", "כרעיים": "Chicken Legs", "שוקיים": "Chicken drumsticks", "פרגיות": "Chicken Thighs", "בשר טחון": "Minced Beef", "סטייק": "Beef", "סלמון": "Salmon", "דג": "White Fish", "הודו": "Turkey Mince", "כבש": "Lamb", "טלה": "Lamb", "צלעות טלה": "Lamb Loin Chops", "שוק טלה": "Lamb Leg", "טחון עוף": "Turkey Mince", "טחון הודו": "Turkey Mince", "פילה בקר": "Beef Fillet", "אנטריקוט": "Beef", "שפונדרה": "Beef Brisket", "בשר בקר": "Beef", "בורי": "White Fish", "פילה בקלה": "Cod", "בקלה": "Cod", "שרימפס": "Prawns", "מושט": "White Fish Fillets", "לברק": "White Fish", "דניס": "Red Snapper", "טונה טרייה": "Tuna", "פילה דג": "Fish fillet", "אמנון": "White Fish Fillets", "אפונה קפואה": "Frozen Peas", "צ׳יפס קפוא": "Fries", "בצק עלים": "Puff Pastry", "בצק פילו": "Filo Pastry", "ירקות קפואים": "Stir-fry Vegetables", "שעועית קפואה": "Green Beans", "פירות יער קפואים": "Blackberries", "תותים קפואים": "Strawberries", "מנגו קפוא": "Mango", "תירס בקופסה": "Sweetcorn"};
const photoUrl = name => name ? 'https://www.themealdb.com/images/ingredients/' + encodeURIComponent(name) + '-small.png' : '';
// אמוג'י שלא באמת מראה את המוצר (🍿 לביסלי, 🥓 לנקניק, 🦻 למקלונים): בלי. במקומו האות הראשונה בצבע המחלקה
const NO_EMOJI = new Set(["ארטישוק", "צנון", "צנונית", "קולורבי", "כורכום טרי", "שסק", "ליצ׳י", "פסיפלורה", "גויאבה", "פפאיה", "במיה", "אפרסמון", "קרמבו", "ריבת חלב", "שמרים", "חמוציות", "תאנים מיובשות", "סטיביה", "סוכרזית", "קצפת אבקה", "פרג", "זרעי צ׳יה", "זרעי פשתן", "ביסלי", "חלבה", "לבנה", "נקניק", "פסטרמה", "סלמי", "פסטרמה הודו", "חזה הודו פרוס", "כבד קצוץ", "סייטן", "כבד", "לבבות עוף", "קורקבנים", "במיה קפואה", "נייר אפייה", "נייר כסף", "ניילון נצמד", "מקלוני אוזניים", "קונדומים", "פדים", "צמר גפן", "טמפונים", "תחבושות", "תחבושות לילה", "פדים יומיים", "שמן סויה", "תרסיס שמן", "כבד עוף"]);
for(const x of SHOP_CATALOG){
  x.photo = SHOP_PHOTOS[x.name] || '';
  if(NO_EMOJI.has(x.name) || x.emoji === SHOP_CAT[x.cat].emoji && !EMOJI_OK.has(x.name)) x.emoji = '';
}
// "תחומי על": מוצר בלי תמונה ובלי אמוג'י משלו מקבל תמונה של הסוג שלו (פלפל לבן = תבלין, ביסלי = חטיף). הראשון שמתאים קובע.
// כלל בלי words הוא ברירת המחדל של המחלקה. כך לשום מוצר אין "בלי תמונה".
const GENERIC = [
  {cat: 'bake', words: ['סטיביה', 'סוכרזית', 'ממתיק', 'סוכר'], photo: 'Sugar'},
  {cat: 'bake', words: ['זרעי', 'גרעיני', 'פרג', 'צ׳יה', 'פשתן', 'שומשום'], photo: 'Sesame Seed'},
  {cat: 'bake', words: ['מיובש', 'מיובשות', 'מיובשים', 'חמוציות', 'צימוקים'], photo: 'Dried Fruit'},
  {cat: 'bake', words: ['שמן', 'תרסיס'], photo: 'Vegetable Oil'},
  {cat: 'bake', words: ['שמרים'], photo: 'Instant Yeast'},
  {cat: 'bake', words: ['קמח', 'סולת'], photo: 'Flour'},
  {cat: 'bake', words: ['אגוזי', 'אגוזים', 'שקדים', 'פיסטוקים', 'בוטנים'], photo: 'Pine Nuts'},
  {cat: 'bake', photo: 'Cumin'},                                   // תבלין
  {cat: 'snack', words: ['שוקולד', 'קליק', 'טעמי', 'כיף', 'קינדר', 'מקופלת', 'פסק', 'קרמבו', 'חטיף', 'וופלים', 'ופלים'], photo: 'Milk Chocolate'},
  {cat: 'snack', words: ['סוכריות', 'סוכריה', 'מסטיק', 'מנטוס', 'טופי', 'גומי', 'מרשמלו'], emoji: '🍬'},
  {cat: 'snack', words: ['חלבה'], photo: 'Peanut Brittle'},
  {cat: 'snack', words: ['עוגיות', 'ביסקוויטים', 'פתי'], emoji: '🍪'},
  {cat: 'snack', photo: 'Pretzels'},                               // חטיף מלוח
  {cat: 'veg', words: ['שסק', 'משמש'], photo: 'Apricot'},
  {cat: 'veg', words: ['ליצ׳י', 'פסיפלורה', 'גויאבה', 'פפאיה', 'פרי', 'פירות'], photo: 'Mango'},
  {cat: 'veg', words: ['אפרסמון'], photo: 'Peaches'},
  {cat: 'veg', words: ['צנון', 'צנונית', 'קולורבי', 'לפת'], photo: 'Turnips'},
  {cat: 'veg', words: ['כורכום'], photo: 'Ginger'},
  {cat: 'veg', words: ['במיה', 'לוביה', 'ארטישוק'], photo: 'Green Beans'},
  {cat: 'veg', words: ['עלי', 'עשבי', 'נבטי'], photo: 'Coriander Leaves'},
  {cat: 'veg', emoji: '🥬'},
  {cat: 'cans', words: ['ריבה', 'ריבת'], photo: 'Jam'},
  {cat: 'cans', words: ['ממרח'], emoji: '🥫'},
  {cat: 'cans', emoji: '🥫'},
  {cat: 'dairy', words: ['גבינה', 'גבינת'], photo: 'Cheese'},
  {cat: 'dairy', words: ['לבנה'], photo: 'Cream Cheese'},
  {cat: 'dairy', emoji: '🥛'},
  {cat: 'deli', words: ['נקניק', 'נקניקיות', 'פסטרמה', 'סלמי', 'קבנוס', 'פרוס', 'כבד'], photo: 'Doner Meat'},
  {cat: 'deli', words: ['סייטן', 'טופו'], photo: 'Tofu'},
  {cat: 'deli', emoji: '🥙'},
  {cat: 'meat', words: ['דג', 'דגים', 'קרפיון', 'מוסר', 'נסיכת', 'פילה'], photo: 'White Fish'},
  {cat: 'meat', words: ['עוף', 'הודו', 'פרגית', 'כנפיים', 'ירכיים'], photo: 'Chicken Thighs'},
  {cat: 'meat', photo: 'Mixed Beef Cuts'},                         // בשר (כולל כבד, לבבות, קורקבנים)
  {cat: 'frozen', words: ['במיה'], photo: 'Green Beans'},
  {cat: 'frozen', emoji: '🧊'},
  {cat: 'bread', emoji: '🍞'}, {cat: 'dry', emoji: '🫘'}, {cat: 'morning', emoji: '☕'}, {cat: 'drink', emoji: '🥤'},
  {cat: 'clean', words: ['נייר', 'מגבות', 'מפיות', 'ניילון'], emoji: '🧻'}, {cat: 'clean', emoji: '🧽'},
  {cat: 'care', words: ['תרופה', 'כדורים', 'סירופ', 'ויטמין', 'טיפות'], emoji: '💊'}, {cat: 'care', emoji: '🧴'},
  {cat: 'other', emoji: '🛒'},
];
function genericFor(name, cat){
  const words = shopNorm(name).split(' ');
  const g = GENERIC.find(r => r.cat === cat && (!r.words || r.words.some(w => words.some(x => x === w || sameWord(x, w)))));
  return g ? {photo: g.photo ? photoUrl(g.photo) : '', emoji: g.emoji || ''} : {photo: '', emoji: (SHOP_CAT[cat] || SHOP_CAT.other).emoji};
}
// מילים שמזהות מחלקה גם כשהמוצר לא ברשימה (למשל "גבינת עזים" = חלב). לא מוצעות בהצעות.
const SHOP_WORDS = {
  veg: 'ירק פרי תפוח עגבני מלפפון פלפל בצל חסה נקטרינה שזיף דובדבן פטריה צנון קולורבי דלעת לוביה במיה שמיר עלי ' +
       'נבטים פירות ירקות שעועית_ירוקה אפרסק משמש תאנה אוכמניות פסיפלורה ליים אשכולית בזיליקום רוזמרין טימין מרווה ' +
       'כרישה שומר חזרת צנונית ליצ׳י פפאיה גויאבה',
  bread: 'לחם לחמניה פיתה מאפה בייגל עוגה עוגות בורקס_טרי רוגלך מאפין קרואסונים לאפה פוקאצ׳ה בריוש',
  dry: 'אורז בסמטי פסטה עדשים גריסים פתיתים אטריות קוסקוס פנה פוזילי לזניה פירה_מוכן גרגירי',
  cans: 'שימורים קופסה רוטב ממרח ריבה חמוצים פסטו שימורי חלפיניו צלפים קטשופ',
  bake: 'תבלין תבלינים אבקת שמן תמצית קמח אגוזי פקאן קשיו בוטנים שומשום פרג קינמון אורגנו פטרוזיליה_יבשה ' +
        'ג׳לטין סוכרזית ממתיק סילאן סירופ קוקוס_טחון פירורים',
  morning: 'קפה תה דגני נס אספרסו קפסולה',
  snack: 'חטיף ממתק ממתקים שוקולד עוגיה עוגיות וופל ופלים מסטיק סוכריה מרשמלו חלבה דובונים בייגלה פרינגלס דוריטוס ' +
         'אפרופו תפוצ׳יפס קליק כיף_כף',
  drink: 'מיץ משקה בקבוק יין בירה וודקה ערק ויסקי סודה מים שתיה שתייה קולה ספרייט פאנטה פריגת ספרינג תפוזינה ' +
         'אנרגיה לימונדה סיידר נביעות',
  dairy: 'חלב גבינה יוגורט שמנת מעדן ביצה ביצים קצפת בולגרית פטה צפתית עמק תנובה טרה יופלה דנונה קוטג׳ גאודה ' +
         'חלומי ברי קממבר חמאה לבן אקטיביה',
  deli: 'סלט נקניק פסטרמה סלמי שווארמה_מוכנה ממרחים פלאפל קובה',
  meat: 'עוף בשר דג פילה שניצל קציצה כנפיים לבבות אנטריקוט פרגית אסאדו אונטריב צלעות כבש טלה סינטה ' +
        'נתחי שוק טחון בקר הודו פילה_דג לברק דניס מוסר טונה_טרייה קרפיון שרימפס',
  frozen: 'קפוא קפואה קפואים גלידה ארטיק פיצה בצק מלוואח ג׳חנון כופתאות פלמני',
  clean: 'ניקוי ניקיון מנקה כביסה כלים אשפה זבל ספוג מטלית סמרטוט מגב מטאטא אקונומיקה מסיר שקית שקיות ' +
         'נייר מפית מפיות כוס_חד חד_פעמי סוללה נורה גפרורים נרות מרכך_כביסה פרסיל סנו כלור מבריק אלומיניום תבנית',
  care: 'שמפו סבון קרם תרופה ויטמין טיפות גילוח דאודורנט בושם תחבושת טמפון פלסטר מגבונים_לחים ' +
        'משחה קונדישנר ג׳ל לק אקמול נורופן אדוויל מסכה תחליב צמר_גפן קיסם',
};
const shopNorm = s => String(s || '').trim().replace(/\s+/g, ' ').replace(/['"`׳״]/g, '׳').toLowerCase();
// השוואת מילים בעברית: יחיד ורבים, ה/ת בסוף ואותיות סופיות נחשבים אותה מילה.
// בננה = בננות, עגבניה = עגבניות, ביצה = ביצים, פיתה = פיתות, גבינה = גבינת, שקית = שקיות, לימון = לימונים.
const FINALS = {'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ'};
// סיומות (אחרי המרת אותיות סופיות: ם→מ). בכוונה בלי "יות", "יה" ו"ית": הן מחברות מילים שונות
// (עוגה/עוגיות, סוכר/סוכריות, כרוב/כרובית). "עגבניה/עגבניות" מתחברות דרך "ה" ו"ות" (עגבני).
const SUFFIXES = ['ימ', 'ות', 'ה', 'ת', 'י'];
// מילים שנראות כמו צורה של מילה אחרת אבל הן מוצר אחר (חלבה ≠ חלב, לבנה ≠ לבן, פירה ≠ פירות)
const NO_STEM = new Set(['חלבה', 'לבנה', 'לבנ', 'פירה', 'ביגלה', 'ביגל']);
function wordStems(w){
  w = w.replace(/[ךםןףץ]/g, c => FINALS[c]).replace(/יי/g, 'י');   // עוגייה = עוגיה
  const out = new Set([w]);
  if(NO_STEM.has(w)) return out;
  for(const suf of SUFFIXES){
    if(!w.endsWith(suf) || w.length - suf.length < 2) continue;
    if(suf === 'ת' && w.endsWith('ות')) continue;                 // "קשיות" לא נהיה "קשיו"
    out.add(w.slice(0, -suf.length));
  }
  return out;
}
const sameWord = (a, b) => { if(a === b) return true; const sa = wordStems(a); for(const x of wordStems(b)) if(sa.has(x)) return true; return false; };
// מילה עם ו/ה בהתחלה ("והבננות") נבדקת גם בלעדיהן
const wordForms = w => w.startsWith('וה') && w.length > 4 ? [w, w.slice(1), w.slice(2)] : w.length > 3 && /^[וה]/.test(w) ? [w, w.slice(1)] : [w];
/** כמה טוב שם הרשימה (מילים) מתאים לשם שהוקלד. 0 = לא מתאים. כל מילה ברשימה חייבת להופיע בשם. */
function phraseScore(inWords, words){
  let score = 0;
  for(let i = 0; i < words.length; i++){
    let best = 0;
    for(let j = 0; j < inWords.length; j++) for(const f of wordForms(inWords[j])){
      const v = f === words[i] ? 3 : sameWord(f, words[i]) ? 2 : 0;
      best = Math.max(best, v ? v * Math.min(f.length, words[i].length) + (j === i ? 1 : 0) : 0);
    }
    if(!best) return 0;
    score += best;
  }
  return score;
}
const SHOP_MATCH = SHOP_CATALOG.flatMap(x => [x.name, ...x.aliases].map(n => ({words: shopNorm(n).split(' '), cat: x.cat, get emoji(){ return x.emoji; }, entry: x})))
  .concat(Object.entries(SHOP_WORDS).flatMap(([cat, ws]) => ws.split(/\s+/).map(w => ({words: w.split('_'), cat, emoji: null, word: true}))));
/** ההתאמה הטובה ביותר ברשימה: צירוף ארוך ומדויק קודם ("שמנת" = שמנת ולא שמן; "בצל ירוק" לפני "בצל"). */
function shopMatch(name){
  const inWords = shopNorm(name).split(' ').filter(Boolean);
  let best = null, bestScore = 0;
  for(const m of SHOP_MATCH){
    const sc = phraseScore(inWords, m.words) - (m.word ? 0.5 : 0);   // שוויון: מוצר מהרשימה לפני מילת מפתח
    if(sc > bestScore){ best = m; bestScore = sc; }
  }
  return best;
}
/** מפתח השוואה: אותו מוצר בכתיב אחר (בננה / בננות) מקבל אותו מפתח */
const shopStemKey = name => shopNorm(name).split(' ').map(w => [...wordStems(w)].sort((a, b) => a.length - b.length)[0]).join(' ');
const sameProduct = (a, b) => {
  const x = shopNorm(a).split(' '), y = shopNorm(b).split(' ');
  return x.length === y.length && x.every((w, i) => sameWord(w, y[i]));
};
/** השם הראשי של מוצר ("קשיות" → "קשים"). מוצר שאין לו שם נרדף נשאר כמו שהוא. */
function canonName(name){
  for(const al in ALIAS_OF) if(sameProduct(name, al)) return ALIAS_OF[al];
  return String(name || '').trim().replace(/\s+/g, ' ');
}
const aliasesOf = name => { const c = canonName(name); return [c, ...Object.keys(ALIAS_OF).filter(al => ALIAS_OF[al] === c)]; };

/** מחלקה ואמוג'י למוצר: בחירה ידנית קודם, אחר כך הרשימה הנפוצה, אחר כך לפי מילה בשם. */
function shopInfo(nameOrItem){
  const item = typeof nameOrItem === 'object' ? nameOrItem : null;
  const catOf = id => SHOP_CAT[id] || SHOP_CAT.other;
  const name = item ? item.name : nameOrItem, m = shopMatch(name);
  let cat = m ? m.cat : 'other';
  if(item && item.cat && SHOP_CAT[item.cat]) cat = item.cat;
  // תמונה ואמוג'י: מהמוצר שהתאים. מילת מפתח ("ביצה"): מהמוצר מהרשימה שהכי מתאים לה באותה מחלקה ("ביצים")
  let entry = m && !m.word && m.cat === cat ? m.entry : null;
  if(!entry){
    const inWords = shopNorm(name).split(' ').filter(Boolean);
    let bs = 0;
    for(const x of SHOP_MATCH) if(!x.word && x.cat === cat){ const sc = phraseScore(inWords, x.words); if(sc > bs){ bs = sc; entry = x.entry; } }
  }
  let emoji = entry ? entry.emoji : '', photo = entry ? photoUrl(entry.photo) : '';
  if(!emoji && !photo) ({emoji, photo} = genericFor(name, cat));   // תחום על: תמונה של הסוג
  // לטקסט (וואטסאפ, מצרכי מתכון) תמיד יש אמוג'י: של המוצר, של הסוג (פלפל לבן = תבלין), או של המחלקה
  const textEmoji = emoji || genericFor(name, cat).emoji || catOf(cat).emoji;
  return {cat, emoji, photo, textEmoji, catName: catOf(cat).name, catEmoji: catOf(cat).emoji, order: catOf(cat).order};
}

// כל מוצר הוא רשומה אחת לתמיד: active = ברשימה עכשיו. count = כמה פעמים הוסף (לסדר ההצעות).
const shopKey = name => shopNorm(name);
const shopId = name => 'p-' + sha256(shopKey(name)).slice(0, 10);
function shopAdd(items, name, nowIso){
  if(!String(name || '').trim()) return null;
  const clean = canonName(name);   // שם נרדף ("קשיות") נשמר בשם הראשי ("קשים")
  const live = (items || []).filter(x => !x.deleted);
  // אותו מוצר בכתיב אחר ("בננות" כשיש "בננה") או בשם נרדף: אותה רשומה, כדי שלא יהיו כפילויות וההיסטוריה תישמר
  const cur = live.find(x => x.id === shopId(clean)) || live.find(x => sameProduct(canonName(x.name), clean));
  if(cur && cur.active) return null;
  const r = {id: cur ? cur.id : shopId(clean), name: cur ? cur.name : clean, active: true, count: (cur ? +cur.count || 0 : 0) + 1, addedAt: nowIso,
    boughtAt: cur ? cur.boughtAt || null : null, updatedAt: nowIso, deleted: false};
  if(cur && cur.cat) r.cat = cur.cat;
  return r;
}
function shopBuy(item, nowIso){ return Object.assign({}, item, {active: false, boughtAt: nowIso, updatedAt: nowIso}); }
function shopSetCat(item, cat, nowIso){ return Object.assign({}, item, {cat: SHOP_CAT[cat] ? cat : 'other', updatedAt: nowIso}); }
/** הצעות: קודם מוצרים מהעבר (הפופולריים קודם), ואחריהם מוצרים נפוצים מהרשימה המובנית. עם טקסט: רק מה שמכיל אותו. */
function shopSuggest(items, query, limit){
  const q = shopKey(query), mine = (items || []).filter(x => !x.deleted);
  const known = new Set(mine.map(x => shopStemKey(canonName(x.name))));
  const qWords = q.split(' ').filter(Boolean);
  // מתאים להקלדה: מכיל את הטקסט, או אותן מילים בכתיב אחר ("בננה" מוצא "בננות")
  const fits = name => { const n = shopKey(name), w = n.split(' ');
    return n.includes(q) || qWords.every(a => w.some(b => sameWord(a, b))); };
  const past = mine.filter(x => !x.active && (!q || aliasesOf(x.name).some(fits)))
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.addedAt || '').localeCompare(a.addedAt || '') || a.name.localeCompare(b.name));
  // מהרשימה המובנית: לסירוגין בין המחלקות, כדי שבהתחלה יופיע מגוון ולא רק ירקות
  // ברשימה המובנית: רק מילה שמתחילה במה שהוקלד ("גב" = גבינה, לא עגבניות)
  const hit = n => { n = shopNorm(n); return n.startsWith(q) || n.includes(' ' + q) || qWords.every(a => n.split(' ').some(b => sameWord(a, b))); };
  const cat = SHOP_CATALOG.filter(x => !known.has(shopStemKey(x.name)) && (!q || [x.name, ...x.aliases].some(hit)))
    .sort((a, b) => (q ? +!a.name.startsWith(q) - +!b.name.startsWith(q) : 0) || a.rank - b.rank || SHOP_CAT[a.cat].order - SHOP_CAT[b.cat].order)
    .map(x => ({name: x.name, catalog: true}));
  return past.concat(cat).slice(0, limit || 12).map(x => { const i = shopInfo(x); return Object.assign({}, x, {emoji: i.emoji, photo: i.photo, cat: i.cat}); });
}
const shopList = items => (items || []).filter(x => x.active && !x.deleted).sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
/** הרשימה מחולקת למחלקות, לפי סדר ההליכה בסופר. */
function shopGroups(items){
  const g = {};
  for(const x of shopList(items)){
    const i = shopInfo(x);
    (g[i.cat] = g[i.cat] || {cat: i.cat, name: i.catName, emoji: SHOP_CAT[i.cat].emoji, order: i.order, items: []})
      .items.push(Object.assign({}, x, {emoji: i.emoji, textEmoji: i.textEmoji, photo: i.photo, catId: i.cat}));
  }
  return Object.values(g).sort((a, b) => a.order - b.order);
}
/** הרשימה כהודעת וואטסאפ: אותה חלוקה למחלקות ובאותו סדר. *כוכביות* = מודגש בוואטסאפ. */
function shopText(items){
  const groups = shopGroups(items), n = groups.reduce((s, g) => s + g.items.length, 0);
  if(!n) return '';
  return `🛒 *רשימת קניות* (${n})\n\n` +
    groups.map(g => `${g.emoji} *${g.name}*\n` + g.items.map(x => `${x.textEmoji || '▫️'} ${x.name}`).join('\n')).join('\n\n');
}
function mergeShopFile(a, b, now){ return {v: 1, items: mergeById(a?.items, b?.items, now)}; }

/* ---------- חשבונות הדייר ---------- */
// חשמל: חלק יחסי לפי מונה המשנה, מתוך הסכום הכולל של החשבון (כולל מע"מ, תשלום קבוע והספק).
// ארנונה: סכום קבוע לתקופה של חודשיים (אפשר יחסי לימים). מים: חצי מהסכום.
const TENANT_DEFAULT = {arnona: null, waterShare: 0.5, lastSub: null, lastSubDate: null, bills: []};
function tenantCfg(cfg){ return Object.assign({}, TENANT_DEFAULT, config(cfg).tenant || {}); }
const num = x => x === '' || x == null ? NaN : +String(x).replace(/[,\s₪]/g, '');
const agorot = x => Math.round(x * 100) / 100;
function calcElec(i){
  const prev = num(i.subPrev), cur = num(i.subCur), house = num(i.houseKwh), total = num(i.total);
  if([prev, cur, house, total].some(x => !isFinite(x))) return {ok: false, err: 'חסר מספר'};
  const kwh = agorot(cur - prev);
  if(kwh < 0) return {ok: false, err: 'הקריאה הנוכחית קטנה מהקודמת'};
  if(house <= 0) return {ok: false, err: 'צריכת הבית חייבת להיות גדולה מאפס'};
  if(kwh > house) return {ok: false, err: 'הדייר לא יכול לצרוך יותר מכל הבית'};
  const ratio = kwh / house;
  return {ok: true, kwh, ratio, pct: Math.round(ratio * 1000) / 10, amount: agorot(ratio * total)};
}
function calcWater(total, share){
  const t = num(total);
  if(!isFinite(t) || t < 0) return {ok: false, err: 'חסר סכום'};
  return {ok: true, amount: agorot(t * (share ?? 0.5))};
}
function calcArnona(fixed, days, periodDays){
  const f = num(fixed); if(!isFinite(f)) return {ok: false, err: 'חסר סכום'};
  const d = num(days), p = num(periodDays);
  if(isFinite(d) && isFinite(p) && p > 0 && d < p) return {ok: true, amount: agorot(f * Math.max(0, d) / p), partial: true};
  return {ok: true, amount: agorot(f), partial: false};
}
/** חיוב אחד בכל חשבון חשמל: החשמל, ועוד ארנונה ומים אם מולאו. */
function calcCharge(i){
  const e = calcElec(i);
  if(!e.ok) return e;
  const blank = x => x === '' || x == null;
  const a = blank(i.arnona) ? {ok: true, amount: 0} : calcArnona(i.arnona);
  const w = blank(i.waterTotal) ? {ok: true, amount: 0} : calcWater(i.waterTotal, i.waterShare);
  if(!a.ok) return {ok: false, err: 'סכום הארנונה לא תקין'};
  if(!w.ok) return {ok: false, err: 'סכום המים לא תקין'};
  return Object.assign({}, e, {elecAmount: e.amount, arnonaAmount: a.amount, waterAmount: w.amount,
    amount: agorot(e.amount + a.amount + w.amount)});
}
const money = x => (Math.round(x * 100) % 100 ? x.toFixed(2) : String(Math.round(x))) + ' ₪';
/** הודעה לדייר. */
function tenantText(b){
  if(b.kind === 'elec'){
    const el = b.elecAmount ?? b.amount, lines = [`חשבונות, ${b.period || 'החשבון האחרון'}:`,
      `חשמל: המונה שלך מ־${b.subPrev} עד ${b.subCur}, כלומר ${b.kwh} קוט"ש. כל הבית ${b.houseKwh} קוט"ש, אז החלק שלך ${b.pct}% מתוך ${money(num(b.total))}: ${money(el)}.`];
    if(b.arnonaAmount) lines.push(`ארנונה (קבוע לחודשיים): ${money(b.arnonaAmount)}.`);
    if(b.waterAmount) lines.push(`מים, חצי מ־${money(num(b.waterTotal))}: ${money(b.waterAmount)}.`);
    lines.push(`סך הכול לתשלום: ${money(b.amount)}.`);
    return lines.join('\n');
  }
  if(b.kind === 'water') return `מים, ${b.period || 'החשבון האחרון'}:\nהחשבון כולו ${money(num(b.total))}, חצי לכל אחד.\nלתשלום: ${money(b.amount)}.`;
  if(b.kind === 'arnona') return `ארנונה, ${b.period || 'התקופה האחרונה'}:\n${b.partial ? `${b.days} ימים מתוך ${b.periodDays}, מתוך ${money(num(b.fixed))}` : 'הסכום הקבוע שסיכמנו'}.\nלתשלום: ${money(b.amount)}.`;
  return '';
}

/* ---------- לשונית "חשבונות": חיוב משולב לדייר, בפורמט של המשתמש ---------- */
// tenant.charges: [{id, date, elec: {from, to, prev, cur, house, total}, arnona: {period, amount}, water: {period, total, share},
//   offsets: [מזהי חובות שקוזזו], total, paid, paidAt}]. tenant.ledger: חובות פתוחים [{id, date, text, amount, dir: 'me' (אני חייב לו) | 'him', settled}].
const fmtN = (x, d) => (+x).toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});
const shek = x => Math.abs(x - Math.round(x)) < 1e-9 ? fmtN(Math.round(x), 0) : fmtN(x, 2);
const ddmm = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '';
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const spaced = p => String(p || '').replace(/\s*[-–]\s*/g, ' - ');
/** החשבון: סכומים, וסה"כ מעוגל למטה לשקל שלם (כמו שהמשתמש שולח). קיזוז: חוב שלי לדייר יורד מהסכום. */
function tenantCharge(i, ledger){
  const r = {ok: true, parts: []};
  if(i.elec){
    const e = calcElec({subPrev: i.elec.prev, subCur: i.elec.cur, houseKwh: i.elec.house, total: i.elec.total});
    if(!e.ok) return e;
    r.elec = e; r.parts.push(e.amount);
  }
  if(i.arnona){ const a = num(i.arnona.amount); if(!isFinite(a)) return {ok: false, err: 'סכום הארנונה לא תקין'}; r.arnona = a; r.parts.push(a); }
  if(i.water){ const w = calcWater(i.water.total, i.water.share ?? 0.5); if(!w.ok) return {ok: false, err: 'סכום המים לא תקין'}; r.water = w.amount; r.parts.push(w.amount); }
  if(!r.parts.length) return {ok: false, err: 'אין מה לחשב'};
  r.sum = agorot(r.parts.reduce((x, y) => x + y, 0));
  r.offsets = (i.offsets || []).map(id => (ledger || []).find(l => l.id === id)).filter(Boolean);
  r.offset = r.offsets.reduce((x, l) => x + (l.dir === 'me' ? -num(l.amount) : num(l.amount)), 0);
  r.total = Math.floor(r.sum + r.offset + 1e-9);
  return r;
}
/** ההודעה לדייר, בדיוק בפורמט של ההודעה שהמשתמש שלח בנובמבר 2026 (בדיקות/הודעת-חשבונות-לדוגמה.txt). */
function tenantMsg(i, ledger){
  const r = tenantCharge(i, ledger);
  if(!r.ok) return '';
  const head = [], L = [];
  if(i.elec) head.push(`חשמל עד ${HE_MONTHS[+i.elec.to.slice(5, 7) - 1]}`);
  if(i.water) head.push(`מים ${i.water.period}`);
  if(i.arnona) head.push(`ארנונה ${i.arnona.period}`);
  const joined = head.length > 1 ? head.slice(0, -1).join(', ') + ' ו' + head[head.length - 1] : head[0];
  L.push(`היי, מצרף חישוב מסודר של החשבונות לתקופה החדשה (${joined}):`);
  if(i.elec){
    const e = i.elec, k = r.elec.kwh;
    L.push('', `⚡ חשמל (${ddmm(e.from)} עד ${ddmm(e.to)})`, `• קריאה קודמת: ${fmtN(num(e.prev), 2)}`, `• קריאה נוכחית: ${fmtN(num(e.cur), 2)}`,
      `• צריכה בפועל שלך: ${fmtN(k, 2)} קוט"ש`,
      `• חישוב: צריכת הבית בחשבון היא ${shek(num(e.house))} קוט"ש בעלות כוללת של ${fmtN(num(e.total), 2)} ש"ח:`,
      `(${fmtN(k, 2)} קוט"ש שלך ÷ ${shek(num(e.house))} קוט"ש כללי) × ${fmtN(num(e.total), 2)} ש"ח`,
      `• סך הכל חשמל: *${fmtN(r.elec.amount, 2)}* ש"ח`);
  }
  if(i.arnona) L.push('', `🏛️ ארנונה (${spaced(i.arnona.period)})`, `• תשלום דו-חודשי קבוע: *${shek(r.arnona)}* ש"ח`);
  if(i.water){
    const half = Math.abs((i.water.share ?? 0.5) - 0.5) < 1e-9;
    L.push('', `💧 מים (${spaced(i.water.period)}${half ? ' - חצי חצי' : ''})`, `• סך הכל חשבון: ${fmtN(num(i.water.total), 2)} ש"ח`,
      `• החלק שלך${half ? ' (חצי)' : ''}: *${fmtN(r.water, 2)}* ש"ח`);
  }
  for(const l of r.offsets) L.push('', `${l.dir === 'me' ? '➖ קיזוז' : '➕ תוספת'}: ${l.text}: ${shek(num(l.amount))} ש"ח`);
  L.push('', `💰 סה"כ לתשלום לתקופה זו: *${shek(r.total)}* ש"ח`, '', 'מצורפים החשבונות המעודכנים');
  return L.join('\n');
}
/** יתרה: חיובים שלא שולמו, וחובות פתוחים לכל כיוון. */
function tenantBalance(tc){
  const ch = (tc.charges || []).filter(c => !c.deleted), led = (tc.ledger || []).filter(l => !l.deleted && !l.settled);
  return {unpaid: ch.filter(c => !c.paid).reduce((x, c) => x + c.total, 0),
    iOwe: led.filter(l => l.dir === 'me').reduce((x, l) => x + num(l.amount), 0),
    heOwes: led.filter(l => l.dir === 'him').reduce((x, l) => x + num(l.amount), 0)};
}
/** הודעה שכבר נשלחה לדייר (מוואטסאפ) → חשבון. כך החשבונות הקודמים נכנסים לאפליקציה בלי להיות בקוד הציבורי.
 *  השנה לא כתובה בהודעה: לפי התאריך של היום (חודש מאוחר מהיום = שנה שעברה). */
function parseTenantMsg(text, today){
  const t = String(text || ''), n = x => x == null ? NaN : +String(x).replace(/,/g, ''), g = re => (t.match(re) || [])[1];
  const norm = p => String(p || '').replace(/\s*[-–]\s*/g, '-').trim();
  const out = {};
  const el = t.match(/חשמל\s*\((\d{1,2})\/(\d{1,2})\s*עד\s*(\d{1,2})\/(\d{1,2})\)/);
  if(el){
    const [y0, m0] = (today || '2026-01-01').split('-').map(Number), tm = +el[4], ty = tm > m0 ? y0 - 1 : y0, fm = +el[2], fy = fm > tm ? ty - 1 : ty;
    const d = (y, m, dd) => `${y}-${pad(m)}-${pad(+dd)}`;
    out.elec = {from: d(fy, fm, el[1]), to: d(ty, tm, el[3]), prev: n(g(/קריאה קודמת:\s*([\d,.]+)/)), cur: n(g(/קריאה נוכחית:\s*([\d,.]+)/)),
      house: n(g(/צריכת הבית[^\d]*([\d,.]+)/)), total: n(g(/בעלות כוללת של\s*([\d,.]+)/))};
    if(Object.values(out.elec).some(x => typeof x === 'number' && !isFinite(x))) return {ok: false, err: 'לא הצלחתי לקרוא את פרטי החשמל'};
  }
  const ar = t.match(/ארנונה\s*\(([^)]+)\)[\s\S]*?\*([\d,.]+)\*/);
  if(ar) out.arnona = {period: norm(ar[1]), amount: n(ar[2])};
  const wa = t.match(/מים\s*\(([^)]+?)(?:\s*-\s*חצי חצי)?\)[\s\S]*?סך הכל חשבון:\s*([\d,.]+)/);
  if(wa) out.water = {period: norm(wa[1]), total: n(wa[2]), share: 0.5};
  if(!out.elec && !out.arnona && !out.water) return {ok: false, err: 'זו לא נראית כמו הודעת חשבונות'};
  const total = n(g(/סה"כ לתשלום[^*]*\*([\d,.]+)\*/));
  const r = tenantCharge(Object.assign({offsets: []}, out), []);
  return Object.assign({ok: true, offsets: [], total: isFinite(total) ? total : r.total}, out);
}

/* ---------- עדכוני נתונים (למי שכבר התקין) ---------- */
/** מחזיר משימות לעדכן ותצורה חדשה, או null כשאין מה לעשות. */
function migrate(data, today, nowIso){
  const cfg = config(data.config), tasks = data.tasks || [], v = +cfg.seedV || 1;
  if(v >= 5) return null;
  const seed = initialData(today), byId = id => tasks.find(t => t.id === id), out = [];
  // לשונית תחזוקה: מברשת, מסנן ותספורת עוברים אליה (בלי לאבד את מה שכבר סומן), ונוסף סכין גילוח
  for(const [id, extra] of Object.entries(UPKEEP_MARKS)){
    const cur = byId(id);
    if(!cur || cur.deleted || cur.upkeep) continue;
    out.push(Object.assign({}, cur, extra, {title: cur.title === 'החלפת מסננת' ? 'החלפת מסנן מים' : cur.title, updatedAt: nowIso}));
  }
  if(!byId('razor')) out.push(Object.assign({}, seed.tasks.find(t => t.id === 'razor'), {updatedAt: nowIso}));
  return {tasks: out, config: Object.assign({}, cfg, {seedV: 5, updatedAt: nowIso})};
}

/** תזכורות החלפה (16.11.2026): חודש מההחלפה האחרונה, חודשיים למסננת. "החלפתי" מתחיל את הספירה מחדש. */
const REPLACE_TASKS = today => [
  {id: 'toothbrush', title: 'החלפת מברשת שיניים', domain: 'health', kind: 'afterDone', upkeep: true, emoji: '🪥',
   afterDone: {minDays: 30, maxDays: 30, lastDone: today}, nag: {mode: 'daily', from: 'max'}, doneLabel: 'החלפתי'},
  {id: 'filter', title: 'החלפת מסנן מים', domain: 'home', kind: 'afterDone', upkeep: true, emoji: '💧',
   afterDone: {minDays: 60, maxDays: 60, lastDone: today}, nag: {mode: 'daily', from: 'max'}, doneLabel: 'החלפתי'},
  {id: 'razor', title: 'החלפת סכין גילוח', domain: 'personal', kind: 'afterDone', upkeep: true, emoji: '🪒',
   afterDone: {minDays: 60, maxDays: 60, lastDone: today}, nag: {mode: 'daily', from: 'max'}, doneLabel: 'החלפתי'},
];
const UPKEEP_MARKS = {toothbrush: {upkeep: true, emoji: '🪥'}, filter: {upkeep: true, emoji: '💧'}, haircut: {upkeep: true, emoji: '💇'}};

/* ---------- נתונים התחלתיים (סעיף 5 באפיון) ---------- */
const DOMAINS = [
  {id: 'money', name: 'כספים', color: '#0E9F8E'},
  {id: 'home', name: 'בית', color: '#C2410C'},
  {id: 'health', name: 'בריאות', color: '#2F7BEF'},
  {id: 'personal', name: 'אישי', color: '#8B5CF6'},
  {id: 'work', name: 'עבודה', color: '#64748B'},
];
/** נתונים התחלתיים לכל משתמש: רק תזכורות תחזוקה כלליות. חותמת ריקה: כל עריכה גוברת. */
function initialData(today){
  const T = (o) => Object.assign({priority: 'normal', time: '10:00', pre: [], soft: false, nag: {mode: 'daily'},
    missPolicy: null, discreet: false, notifyTitle: null, doneLabel: null, subtasks: [], notes: '', links: [],
    start: today, archived: false, updatedAt: '', deleted: false}, o);
  return {
    tasks: [
      T({id: 'haircut', title: 'תספורת', domain: 'personal', kind: 'afterDone',
        afterDone: {minDays: 21, maxDays: 30, lastDone: null}, soft: true, nag: {mode: 'daily', from: 'max'},
        doneLabel: 'הסתפרתי', subtasks: [{id: 's1', text: 'לקבוע תור'}], upkeep: true, emoji: '💇'}),
      ...REPLACE_TASKS(today).map(T),
    ],
    domains: DOMAINS.map(d => Object.assign({hidden: false, updatedAt: ''}, d)),
    config: Object.assign({}, DEFAULT_CONFIG, {seedV: 5}),
  };
}

return {
  TZ, APP, DAY, DEFAULT_CONFIG, PRIORITY, PRIORITY_NAME, DAY_NAMES, MONTH_NAMES, DOMAINS,
  pad, parseD, fmtD, addDays, diffDays, weekday, daysInMonth, compact, fromCompact,
  parts, at, localDate, localTime, toMs, offsetByRule, usesIntl: !!fmtr,
  config, normTask, isActiveTask, matchRule, ruleDates, indexOcc, periodOf, quotaInfo, afterDoneInfo,
  occurrencesOf, effStatus, isOpen, effDate, buildView, inActive, shiftToActive, snoozeTarget,
  displayTitle, lateText, inText, planNotifications, buildSummary,
  markDone, snooze, skip, toggleSub, undo, findOcc, applyCommand,
  sha256, cmdKey, verifyCmd, buttonsFor, notifSig, diffSchedule, engineAlive,
  mergeById, mergeConfig, mergeTasksFile, mergeOccFile,
  extractAmount, taskFromMail, newMailTasks,
  shortDate, longDate, describeRule, initialData,
  parseQuick, shopKey, shopId, shopAdd, shopBuy, shopSetCat, shopSuggest, shopList, shopGroups, shopText, shopInfo, shopMatch, sameWord, canonName, mergeShopFile,
  SHOP_CATS, SHOP_CATALOG, calendarUrl, calendarFor, FOODS, MEALS, addFoodDb, ACTIVITIES, CAL_DEFAULTS, mergeCaloriesFile, calFoods, foodGrams, foodKcal, foodSuggest, calSettings, weightOn, activityKcal, activityMinutes, calDay, calHistory, calEntry, recipeFood, kcalSeed, tenantCharge, tenantMsg, tenantBalance, parseTenantMsg, DOC_TYPES, OCCASIONS, occasionTitle, birthdayTask, docTask, birthdaysView, docsView, upkeepTask, upkeepView, everyText, UPKEEP_EVERY, RECIPE_CATS, mergeRecipesFile, guessRecipeCat, recipeCat, recipeImages, recipeImageGroup, imageOptions, fmtQty, scaleLine, scaleServings, stepIngredients, sleepNights, imageGroupOf, recipeEmojiOf, RECIPE_IMAGES, mergeTimersFile, liveTimers, timersDue, timerPayload, ingredientProduct, durationsIn, parseRecipeText, recipeText, cleanRecipe, calendarSpec, calendarDiff, mergeCalFile, REPEATS, repeatText, ruleFor, rruleOf, pushDue, pushKey, pushPayload, pruneSent, mergeSubsFile, liveSubs,
  foodProt, entryProt, prot100Of, LEAVE_RULES, leaveItems,
  TENANT_DEFAULT, tenantCfg, calcElec, calcWater, calcArnona, calcCharge, tenantText, money, migrate,
};
});
