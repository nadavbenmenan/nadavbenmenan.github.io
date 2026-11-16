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
  const baseline = maxStr(task.afterDone?.lastDone, ...closed.map(closedDate));
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
// קישור שפותח ביומן גוגל אירוע חדש, ממולא מראש. נדב לוחץ "שמירה" ביומן. בלי הרשאות ובלי גישה לחשבון.
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
const RECIPE_CATS = ['מנה עיקרית', 'דגים', 'בשר ועוף', 'תוספות', 'סלטים וממרחים', 'מרקים', 'מאפים ובצקים', 'קינוחים ועוגות', 'אחר'];
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
  const t = ' ' + String(text || '').replace(/(^|[\s(])[כלב]-?(?=\d|חצי|רבע|שעה|שעתיים|דקה|יומיים)/g, '$1') + ' ';
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
    const head = key(mm ? mm[1] : raw), rest = mm ? mm[2].trim() : '';
    const meta = META.find(([re]) => re.test(head));
    if(meta && (mm || raw.length < 30)){
      if(rest) setMeta(meta[1], rest); else field = meta[1];
      if(r.steps.length || r.ingredients.length) part = 'tail';   // 9. פרטים בסוף: מה שאחריהם לא נכנס
      continue;
    }
    if(field){ const f = field; field = null; if(raw.length <= 40){ setMeta(f, raw); continue; } }
    // 2-3. כותרות חלקים
    const sec = RX.ing.test(head) ? 'ing' : RX.steps.test(head) ? 'steps' : RX.notes.test(head) ? 'notes' : null;
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
      if(c) before.push(c);
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
const CAT_RULES = [
  ['מרקים', ['מרק']],
  ['סלטים וממרחים', ['סלט', 'מטבוחה', 'חומוס', 'ממרח', 'טחינה', 'באבא', 'מטבל', 'סלסה', 'צזיקי', 'גוואקמולי', 'פסטו', 'מיונז', 'רוטב']],
  ['קינוחים ועוגות', ['עוגה', 'עוגת', 'עוגות', 'עוגיות', 'עוגייה', 'קינוח', 'מוס', 'פודינג', 'גלידה', 'בראוניז', 'מאפינס', 'קרם', 'טירמיסו', 'שוקולד', 'חטיף', 'כדורי שוקולד', 'רוגלך']],
  ['מאפים ובצקים', ['לחם', 'חלה', 'חלות', 'פיצה', 'בצק', 'מאפה', 'מאפים', 'בורקס', 'פוקאצ׳ה', 'לחמניות', 'פיתות', 'פיתה', 'פשטידה', 'קיש', 'פאי', 'מלוואח', 'ג׳חנון', 'באגט', 'פוקצ׳ה', 'כעכים', 'בייגל']],
  ['דגים', ['דג', 'דגים', 'סלמון', 'טונה', 'אמנון', 'לברק', 'דניס', 'שרימפס', 'בקלה', 'מושט', 'פילה דג', 'סושי']],
  ['בשר ועוף', ['עוף', 'בשר', 'שניצל', 'קציצות', 'כדורי בשר', 'קבב', 'המבורגר', 'פרגיות', 'חזה', 'כבש', 'טלה', 'אנטריקוט', 'סטייק', 'צלי', 'גולש', 'פסטרמה', 'כנפיים', 'שווארמה', 'הודו', 'כבד', 'נקניק']],
  ['תוספות', ['אורז', 'תפוחי אדמה', 'צ׳יפס', 'פירה', 'פתיתים', 'קוסקוס', 'מג׳דרה', 'בורגול', 'קינואה', 'ירקות צלויים', 'ירקות מוקפצים', 'אטריות']],
  ['מנה עיקרית', ['שקשוקה', 'פסטה', 'ספגטי', 'לזניה', 'ניוקי', 'ריזוטו', 'פטוצ׳יני', 'תבשיל', 'חביתה', 'פריטטה', 'מוסקה', 'ממולאים', 'קארי']],
];
const hasWord = (text, w) => { const t = ' ' + shopNorm(text).replace(/[^\u0590-\u05FFa-z0-9׳ ]/g, ' ') + ' ';
  return w.includes(' ') ? t.includes(' ' + w + ' ') || t.includes(' ' + w) : t.split(' ').some(x => x === w || (x.length > 2 && sameWord(x, w)) || x.replace(/^[והבלמש]/, '') === w); };
/** קטגוריה משוערת למתכון לפי השם, או '' אם לא ברור. */
function guessRecipeCat(r){
  for(const [cat, words] of CAT_RULES) if(words.some(w => hasWord(r.title || '', w))) return cat;
  return '';
}
const recipeCat = r => r.cat || guessRecipeCat(r) || 'אחר';
// תמונות (TheMealDB, 141 תמונות, נבדק שכולן נטענות). קבוצה לפי מילה בשם; בתוך קבוצה: כל מתכון מקבל תמונה אחרת.
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
// סוג המנה (מרק, סלט, ממרח) לפני המרכיב: "סלט טונה" = סלט, "מרק עוף" = מרק
const IMG_RULES = [['soup', ['מרק']], ['dip', ['מטבוחה', 'חומוס', 'באבא', 'ממרח', 'מטבל', 'טחינה', 'צזיקי', 'גוואקמולי', 'סלסה']], ['salad', ['סלט']],
  ['pizza', ['פיצה']], ['salmon', ['סלמון']], ['shrimp', ['שרימפס']], ['fish', ['דג', 'דגים', 'אמנון', 'טונה', 'לברק', 'דניס', 'בקלה', 'מושט']],
  ['meatball', ['קציצות', 'כדורי בשר', 'כדורי', 'קבב', 'קופתה']], ['burger', ['המבורגר']], ['eggs', ['שקשוקה', 'חביתה', 'ביצים', 'פריטטה']],
  ['cookies', ['עוגיות', 'עוגייה', 'בראוניז']], ['cake', ['עוגה', 'עוגת', 'עוגות', 'מאפינס']], ['dessert', ['קינוח', 'מוס', 'פודינג', 'גלידה', 'טירמיסו', 'שוקולד']],
  ['pie', ['פשטידה', 'קיש', 'פאי', 'טארט', 'בורקס', 'מאפה']], ['bread', ['לחם', 'חלה', 'לחמניות', 'פיתות', 'פיתה', 'פוקאצ׳ה', 'בצק', 'באגט', 'מלוואח']],
  ['pasta', ['פסטה', 'ספגטי', 'לזניה', 'ניוקי', 'פטוצ׳יני', 'מקרוני']], ['rice', ['אורז', 'ריזוטו', 'מג׳דרה', 'פאייה']], ['lamb', ['כבש', 'טלה']],
  ['chicken', ['עוף', 'שניצל', 'פרגיות', 'חזה', 'כנפיים', 'הודו']], ['beef', ['בשר', 'סטייק', 'אנטריקוט', 'צלי', 'גולש', 'פסטרמה', 'אסאדו']],
  ['potato', ['תפוחי אדמה', 'צ׳יפס', 'פירה']], ['breakfast', ['פנקייק', 'בלינצ׳ס', 'קרפ']], ['veg', ['ירקות', 'חצילים', 'קישואים', 'כרובית', 'ברוקולי']]];
const CAT_IMG = {'מנה עיקרית': 'chicken', 'דגים': 'fish', 'בשר ועוף': 'beef', 'תוספות': 'side', 'סלטים וממרחים': 'salad', 'מרקים': 'soup',
  'מאפים ובצקים': 'bread', 'קינוחים ועוגות': 'dessert', 'אחר': 'side'};
function recipeImageGroup(r){
  for(const [g, words] of IMG_RULES) if(words.some(w => hasWord(r.title || '', w))) return g;
  return CAT_IMG[recipeCat(r)] || 'side';
}
const imgUrl = f => IMG_BASE + f + '/medium';
const imgFile = u => { const m = /\/meals\/([^/]+?)(?:\/(?:medium|small|preview|large))?$/.exec(u || ''); return m ? m[1] : null; };
/** הקבוצה של תמונה (לפי הקובץ), או null לתמונה מבחוץ. */
const imageGroupOf = u => { const f = imgFile(u); if(!f) return null; for(const [g, l] of Object.entries(RECIPE_IMAGES)) if(l.includes(f)) return g; return null; };
/** תמונות לבחירה: הנוכחית קודם, אחריה שאר הקבוצה (קודם אלה שלא בשימוש), ואז מקבוצות קרובות. */
function imageOptions(r, recipes, current){
  const g = imageGroupOf(current) || recipeImageGroup(r);
  const used = new Set(Object.entries(recipeImages(recipes || [])).filter(([id]) => id !== r.id).map(([, u]) => imgFile(u)));
  const mine = RECIPE_IMAGES[g] || [], near = Object.entries(RECIPE_IMAGES).filter(([k]) => k !== g).flatMap(([, l]) => l);
  const cur = imgFile(current);
  const order = [...mine.filter(f => f !== cur && !used.has(f)), ...mine.filter(f => f !== cur && used.has(f)), ...near.filter(f => f !== cur)];
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
const liveTimers = (file, now) => (file?.timers || []).filter(t => !t.deleted && t.at > now - 36e5).sort((a, b) => a.at - b.at);
/** טיימרים שהגיע זמנם (עד 20 דקות אחורה) ועוד לא נשלחו, ומתי הבא. */
function timersDue(file, now, sent){
  const due = [], later = [];
  for(const t of (file?.timers || [])){
    if(t.deleted || sent['timer@' + t.id]) continue;
    if(t.at > now + PUSH_LEAD) later.push(t.at);
    else if(t.at > now - PUSH_BACK) due.push(t);
  }
  return {due, next: later.length ? Math.min(...later) : null};
}
const timerPayload = t => JSON.stringify({t: '⏱ ' + (t.title || 'הטיימר הסתיים'), b: t.body ? `עבר ${t.body}` : 'הזמן עבר', u: APP, tag: 'timer-' + t.id, ri: true, vib: true});

/** המתכון כהודעה (וואטסאפ): אמוג'י לפי התמונה שנבחרה, וליד כל מצרך האמוג'י שלו מרשימת הסופר. */
function recipeText(rc, img){
  const e = recipeEmojiOf(rc, img), L = [`${e} *${rc.title}* ${e}`];
  if(rc.desc) L.push(rc.desc);
  const meta = [rc.prep && `⏱ הכנה: ${rc.prep}`, rc.cook && `🔥 בישול/אפייה: ${rc.cook}`, rc.total && `⌛ סה״כ: ${rc.total}`, rc.servings && `👥 מנות: ${rc.servings}`, rc.level && `📊 ${rc.level}`].filter(Boolean);
  if(meta.length) L.push(meta.join(' · '));
  const ing = rc.ingredients || [];
  if(ing.length) L.push('', '🛒 *מצרכים:*', ...ing.map(x => /[:：]\s*$/.test(x) ? `*${x}*` : `${(ingredientProduct(x) && shopInfo(ingredientProduct(x)).cat !== 'other') ? shopInfo(ingredientProduct(x)).emoji : '▫️'} ${x}`));
  if((rc.steps || []).length){ let n = 0; L.push('', '👩‍🍳 *אופן ההכנה:*', ...rc.steps.map(x => /[:：]\s*$/.test(x) ? `*${x}*` : `${++n}. ${x}`)); }
  if(rc.notes) L.push('', '💡 *הערות:*', rc.notes);
  if(rc.source) L.push('', '🔗 ' + rc.source);
  return L.join('\n');
}

/* ---------- ימי הולדת ומסמכים ---------- */
// שניהם משימות רגילות (כך שההתראות, לוח השנה וההיסטוריה עובדים בלי שינוי), עם special לזיהוי.
// יום הולדת: כל שנה באותו יום, תזכורת שבוע ויום לפני. מסמך: חד-פעמית בתאריך פקיעת התוקף, תזכורת מראש, ונודניק שבועי אם פג.
const DOC_TYPES = ['דרכון', 'תעודת זהות', 'רישיון נהיגה', 'טסט לרכב', 'ביטוח רכב', 'ביטוח דירה', 'ביטוח בריאות', 'כרטיס אשראי', 'ויזה', 'מנוי', 'אחריות למוצר'];
function birthdayTask(o, nowIso){
  const [y, m, d] = o.date.split('-').map(Number);
  return {id: o.id || 'bd' + sha256(o.name + o.date + nowIso).slice(0, 10), title: `יום הולדת ל${o.name}`, special: 'birthday', person: o.name,
    birthYear: o.knowYear === false ? null : y, domain: 'personal', priority: 'normal', kind: 'schedule',
    schedule: {rule: {type: 'yearly', month: m, day: d}}, start: `2000-${pad(m)}-${pad(d)}`, missPolicy: 'dayOnly', time: o.time || '09:00',
    pre: [7, 1], nag: {mode: 'none'}, doneLabel: 'בירכתי', subtasks: [], notes: o.notes || '', links: [], archived: false, deleted: false, updatedAt: nowIso};
}
function docTask(o, nowIso){
  const before = +o.remindDays || 30;
  return {id: o.id || 'doc' + sha256(o.name + o.expiry + nowIso).slice(0, 10), title: `חידוש ${o.name}`, special: 'doc', docName: o.name,
    domain: 'personal', priority: 'high', kind: 'once', once: {date: o.expiry}, time: '10:00', remindDays: before,
    pre: [...new Set([before, 7].filter(x => x <= before))].sort((a, b) => b - a), nag: {mode: 'weekly'}, doneLabel: 'חידשתי',
    subtasks: [], notes: o.notes || '', links: [], start: localDate(Date.parse(nowIso)), archived: false, deleted: false, updatedAt: nowIso};
}
/** ימי הולדת לפי הקרוב: {task, next, inDays, age (בן כמה יהיה, אם השנה ידועה)} */
function birthdaysView(tasks, today){
  return (tasks || []).filter(t => t.special === 'birthday' && !t.deleted).map(t => {
    const r = t.schedule.rule, y = +today.slice(0, 4);
    let next = `${y}-${pad(r.month)}-${pad(Math.min(r.day, daysInMonth(y, r.month)))}`;
    if(next < today) next = `${y + 1}-${pad(r.month)}-${pad(Math.min(r.day, daysInMonth(y + 1, r.month)))}`;
    return {task: t, next, inDays: diffDays(next, today), age: t.birthYear ? +next.slice(0, 4) - t.birthYear : null};
  }).sort((a, b) => a.inDays - b.inDays || a.task.person.localeCompare(b.task.person, 'he'));
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

/* ---------- יומן גוגל דרך המנוע ---------- */
// משימה עם calendar: true נכנסת ליומן גוגל של נדב. המנוע (שרץ בחשבון שלו) יוצר את האירוע, ושומר ב-משימות/יומן.json
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
 "veg": "דלעת|🎃 דלורית|🎃 צנון| צנונית| קולורבי| שומר| כרישה| אספרגוס| נבטים|🌱 נבטי חמנייה|🌱 עלי בייבי|🥬 חסה אייסברג|🥬 חסה רומית|🥬 כרוב סגול|🥬 כרוב ניצנים|🥬 פלפל צהוב|🫑 פלפל ירוק|🫑 פלפל כתום|🫑 צ׳ילי|🌶️ תפוחי אדמה אדומים|🥔 בצל סגול|🧅 בצל לבן|🧅 שאלוט|🧅 שום טרי|🧄 כורכום טרי| בזיליקום|🌿 רוזמרין|🌿 טימין|🌿 מרווה|🌿 אורגנו טרי|🌿 עירית|🌿 מנגולד|🥬 ענבים ירוקים|🍇 ענבים אדומים|🍇 תפוח ירוק|🍏 תפוחי פינק ליידי|🍎 תפוחי גרני סמית|🍏 נקטרינות|🍑 משמש|🍑 שסק| תאנים| ליצ׳י| פסיפלורה| גויאבה| פפאיה| אוכמניות|🫐 פטל| ליים|🍋 אשכולית|🍊 פומלית|🍊 מנדרינות|🍊 פטריות שמפיניון|🍄 פטריות פורטובלו|🍄 פטריות שיטאקי|🍄 פטריות יער|🍄 עגבניות תמר|🍅 שעועית ירוקה|🫛 אפונה טרייה|🫛 לוביה| במיה| ארוגולה|🥬 כוסברה טרייה|🌿 נענע טרייה|🌿 קייל|🥬 סלרי ענפים|🥬 פלפל חריף ירוק|🌶️ בטטה לבנה|🍠 תפוחי אדמה לאפייה|🥔 מלפפון בייבי|🥒 עגבניות לבישול|🍅 חציל בלאדי|🍆 אבוקדו האס|🥑 קלמנטינות אור|🍊 פרי הדר|🍊 תות שדה|🍓 מלון כתום|🍈 אבטיח ללא גרעינים|🍉 תפוח עץ|🍎 בננות מיובשות|🍌 שום קלוף|🧄 בצל קלוף|🧅 ירקות חתוכים|🥗 סלט ירקות ארוז|🥗",
 "bread": "לחם אחיד|🍞 לחם שיפון|🍞 לחם כוסמין|🍞 לחם דגנים|🍞 לחם לבן|🍞 לחם פרוס|🍞 לחם ללא גלוטן|🍞 לחם מחמצת|🍞 לחמניות מתוקות|🥖 לחמניות נקניקיה|🌭 פיתות מלאות|🫓 לאפה|🫓 חלה מתוקה|🍞 בייגל|🥯 בייגלה ירושלמי|🥯 מצות|🫓 בורקס גבינה|🥐 בורקס תפוחי אדמה|🥐 רוגלך|🥐 מאפינס|🧁 עוגת שמרים|🍰 עוגת שוקולד|🍰 עוגת גבינה|🍰 עוגת דבש|🍰 עוגת תפוזים|🍰 קרואסון שוקולד|🥐 קרואסון שקדים|🥐 דונאטס|🍩 סופגניות|🍩 פוקאצ׳ה|🍞 ג׳בטה|🥖 פרנה|🫓 קרוטונים|🍞 לחם קלוי|🍞 פיתה ללא גלוטן|🫓 עוגיות מאפייה|🍪 שטרודל|🥐 קרמבו|🍫",
 "dry": "אורז בסמטי|🍚 אורז יסמין|🍚 אורז פרסי|🍚 אורז מלא|🍚 אורז לסושי|🍙 אורז עגול|🍚 פסטה פנה|🍝 פסטה פוזילי|🍝 לזניה|🍝 פטוצ׳יני|🍝 טורטליני|🍝 ניוקי|🍝 פסטה מלאה|🍝 פסטה ללא גלוטן|🍝 קוסקוס מלא|🍚 עדשים כתומות|🫘 עדשים ירוקות|🫘 עדשים שחורות|🫘 שעועית לבנה|🫘 שעועית אדומה|🫘 שעועית שחורה|🫘 אפונה יבשה|🫘 פול|🫘 גריסי פנינה|🌾 כוסמת|🌾 דוחן|🌾 סולת|🌾 אטריות אורז|🍜 אטריות ביצים|🍜 ראמן|🍜 פתיתים אפויים|🍚 פירה מוכן|🥔 פסטה קונכיות|🍝 ספגטי מלא|🍝 אורז פרא|🍚 פריקה|🌾 בורגול דק|🌾 בורגול גס|🌾 קמח חומוס|🌾",
 "cans": "אפונה בקופסה|🥫 ארטישוק בקופסה|🥫 לבבות דקל|🥫 עגבניות מרוסקות|🥫 עגבניות קלופות|🥫 פסטו|🌿 רוטב פסטה|🥫 רוטב צ׳ילי מתוק|🌶️ רוטב ברביקיו|🥫 סחוג|🌶️ הריסה|🌶️ עמבה|🥭 רוטב טריאקי|🥫 רוטב אלף האיים|🥫 רוטב לסלט|🥫 זיתים ירוקים|🫒 זיתים שחורים|🫒 זיתי קלמטה|🫒 כרוב כבוש|🥫 לימון כבוש|🍋 פלפלים קלויים|🫑 חלפיניו|🌶️ צלפים|🥫 טונה בשמן|🐟 טונה במים|🐟 סרדינים|🐟 אנשובי|🐟 ריבת תות|🍓 ריבת משמש|🍑 ריבת חלב|🥛 חלב קוקוס|🥥 קרם קוקוס|🥥 אננס בקופסה|🍍 אפרסקים בקופסה|🍑 תירס גמדי|🌽 שעועית אפויה|🥫 ממרח זיתים|🫒 חרדל דיז׳ון|🥫 מיונז לייט|🥫 טחינה גולמית|🥫 מרק בקופסה|🥫 גרגרי חומוס בקופסה|🥫 שעועית לבנה ברוטב|🥫 קטשופ חריף|🍅 רוטב שום|🧄 רוטב חמוץ מתוק|🥫 רוטב צ׳ילי|🌶️ ממרח לוטוס|🍪 ממרח פיסטוק|🥜 חמאת שקדים|🥜 דבש טבעי|🍯 סירופ מייפל|🍁 סירופ תמרים|🌴",
 "bake": "שמן קנולה|🫒 שמן חמניות|🌻 שמן קוקוס|🥥 שמן סויה|🫒 תרסיס שמן|🫒 חומץ בלסמי|🧂 חומץ תפוחים|🍎 מיץ לימון|🍋 מלח גס|🧂 מלח לימון|🧂 מלח ים|🧂 סוכר חום|🧂 אבקת סוכר|🧂 סוכר וניל|🧂 סטיביה|🧂 סוכרזית|🧂 קמח לבן|🌾 קמח מלא|🌾 קמח תופח|🌾 קמח כוסמין|🌾 קמח תירס|🌽 קורנפלור|🌾 שמרים יבשים|🧂 ג׳לטין|🧂 שוקולד צ׳יפס|🍫 סוכריות לקישוט|🍬 תמצית וניל|🧂 פפריקה מתוקה|🌶️ פפריקה חריפה|🌶️ פלפל אנגלי|🧂 קינמון|🧂 הל|🧂 ציפורן|🧂 זעתר|🌿 סומק|🧂 בהרט|🧂 חוואיג׳|🧂 ג׳ינג׳ר טחון|🧂 אגוז מוסקט|🧂 אורגנו|🌿 בזיליקום יבש|🌿 פטרוזיליה יבשה|🌿 עלי דפנה|🌿 צ׳ילי גרוס|🌶️ שום גבישי|🧄 בצל מטוגן|🧅 אבקת שום|🧄 אבקת בצל|🧅 תבלין לעוף|🧂 אבקת מרק עוף|🍲 אבקת מרק בצל|🍲 שומשום|🌰 אגוזי מלך|🌰 אגוזי לוז|🌰 קשיו|🥜 פקאן|🌰 פיסטוקים|🥜 בוטנים|🥜 צנוברים|🌰 שקדים טחונים|🌰 קוקוס טחון|🥥 חמוציות| משמש מיובש|🍑 שזיפים מיובשים|🍑 תאנים מיובשות| זרעי צ׳יה|🌱 זרעי פשתן|🌱 גרעיני דלעת|🎃 פרג|🌰 שמן שומשום|🫒 מלח עם יוד|🧂 תערובת לעוגה|🍰 פודינג אינסטנט|🍮 קצפת אבקה|🧂 שוקולד לבן לבישול|🍫 אבקת קקאו|🍫 פירורי פנקו|🍞 קמח שקדים|🌰 סוכר קנים|🧂 דבש תמרים|🌴",
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
const SHOP_MATCH = SHOP_CATALOG.flatMap(x => [x.name, ...x.aliases].map(n => ({words: shopNorm(n).split(' '), cat: x.cat, emoji: x.emoji, entry: x})))
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
  // תמונה: מהמוצר שהתאים. אם התאימה מילת מפתח ("ביצה"), מחפשים מוצר מהרשימה באותה מחלקה ("ביצים" 🥚)
  let emoji = m && m.emoji && m.cat === cat ? m.emoji : null;
  if(!emoji){
    const inWords = shopNorm(name).split(' ').filter(Boolean);
    let bs = 0;
    for(const x of SHOP_MATCH) if(!x.word && x.cat === cat){ const sc = phraseScore(inWords, x.words); if(sc > bs){ bs = sc; emoji = x.emoji; } }
  }
  emoji = emoji || catOf(cat).emoji;
  return {cat, emoji, catName: catOf(cat).name, order: catOf(cat).order};
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
  return past.concat(cat).slice(0, limit || 12).map(x => Object.assign({}, x, {emoji: shopInfo(x).emoji}));
}
const shopList = items => (items || []).filter(x => x.active && !x.deleted).sort((a, b) => (a.addedAt || '').localeCompare(b.addedAt || ''));
/** הרשימה מחולקת למחלקות, לפי סדר ההליכה בסופר. */
function shopGroups(items){
  const g = {};
  for(const x of shopList(items)){
    const i = shopInfo(x);
    (g[i.cat] = g[i.cat] || {cat: i.cat, name: i.catName, emoji: SHOP_CAT[i.cat].emoji, order: i.order, items: []})
      .items.push(Object.assign({}, x, {emoji: i.emoji}));
  }
  return Object.values(g).sort((a, b) => a.order - b.order);
}
/** הרשימה כהודעת וואטסאפ: אותה חלוקה למחלקות ובאותו סדר. *כוכביות* = מודגש בוואטסאפ. */
function shopText(items){
  const groups = shopGroups(items), n = groups.reduce((s, g) => s + g.items.length, 0);
  if(!n) return '';
  return `🛒 *רשימת קניות* (${n})\n\n` +
    groups.map(g => `${g.emoji} *${g.name}*\n` + g.items.map(x => `▫️ ${x.emoji} ${x.name}`).join('\n')).join('\n\n');
}
function mergeShopFile(a, b, now){ return {v: 1, items: mergeById(a?.items, b?.items, now)}; }

/* ---------- חשבונות הדייר ---------- */
// חשמל: חלק יחסי לפי מונה המשנה, מתוך הסכום הכולל של החשבון (כולל מע"מ, תשלום קבוע והספק).
// ארנונה: סכום קבוע לתקופה של חודשיים (אפשר יחסי לימים). מים: חצי מהסכום.
const TENANT_DEFAULT = {arnona: 285, waterShare: 0.5, lastSub: null, lastSubDate: null, bills: []};
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

/* ---------- עדכוני נתונים (למי שכבר התקין) ---------- */
/** מחזיר משימות לעדכן ותצורה חדשה, או null כשאין מה לעשות. */
function migrate(data, today, nowIso){
  const cfg = config(data.config), tasks = data.tasks || [], v = +cfg.seedV || 1;
  if(v >= 4) return null;
  const seed = initialData(today), byId = id => tasks.find(t => t.id === id), seedRule = id => seed.config.mailRules.find(r => r.id === id);
  const out = [];
  let rules = (cfg.mailRules || []).slice();
  if(v < 2){
    const old = byId('arnona');
    if(old && !old.deleted) out.push(Object.assign({}, old, {deleted: true, updatedAt: nowIso}));
    for(const id of ['arnona-hk', 'token'])
      if(!byId(id)) out.push(Object.assign({}, seed.tasks.find(t => t.id === id), {updatedAt: nowIso}));
    rules = rules.map(r => r.id === 'elec' ? Object.assign({}, seedRule('elec'), {from: r.from || seedRule('elec').from}) : r);
  }
  // גרסה 3: כתובת השולח של המים, והוראות החידוש של האסימון (גם במנוע)
  if(!rules.some(r => r.id === 'water')) rules.push(seedRule('water'));
  rules = rules.map(r => r.id === 'water' ? Object.assign({}, r, {enabled: true, from: r.from || seedRule('water').from}) : r);
  const tk = byId('token') || out.find(t => t.id === 'token');
  if(tk && !tk.deleted && tk.notes !== TOKEN_NOTES){
    const i = out.indexOf(tk), nt = Object.assign({}, tk, {notes: TOKEN_NOTES, updatedAt: nowIso});
    if(i >= 0) out[i] = nt; else out.push(nt);
  }
  // גרסה 4: מברשת שיניים ומסננת
  for(const t of seed.tasks.filter(x => x.id === 'toothbrush' || x.id === 'filter'))
    if(!byId(t.id)) out.push(Object.assign({}, t, {updatedAt: nowIso}));
  return {tasks: out, config: Object.assign({}, cfg, {seedV: 4, mailRules: rules, updatedAt: nowIso})};
}

/** תזכורות החלפה (16.11.2026): חודש מההחלפה האחרונה, חודשיים למסננת. "החלפתי" מתחיל את הספירה מחדש. */
const REPLACE_TASKS = today => [
  {id: 'toothbrush', title: 'החלפת מברשת שיניים', domain: 'health', kind: 'afterDone',
   afterDone: {minDays: 30, maxDays: 30, lastDone: today}, nag: {mode: 'daily', from: 'max'}, doneLabel: 'החלפתי'},
  {id: 'filter', title: 'החלפת מסננת', domain: 'home', kind: 'afterDone',
   afterDone: {minDays: 60, maxDays: 60, lastDone: today}, nag: {mode: 'daily', from: 'max'}, doneLabel: 'החלפתי'},
];
const TOKEN_NOTES = 'האסימון תקף 90 יום. ליצור חדש באותה דרך: רק המאגר cv, הרשאת Contents לקריאה וכתיבה, 90 יום. להדביק בשני מקומות: 1) באפליקציה: ⋮ ← גיטהאב וסנכרון ← החלפת אסימון (זה גם מסמן את המשימה כבוצעה). 2) במנוע: script.google.com ← הפרויקט ← הגדרות הפרויקט ← Script properties ← GH_TOKEN.';

/* ---------- נתונים התחלתיים (סעיף 5 באפיון) ---------- */
const DOMAINS = [
  {id: 'money', name: 'כספים', color: '#0E9F8E'},
  {id: 'rental', name: 'דירה מושכרת', color: '#E07A1F'},
  {id: 'home', name: 'בית', color: '#C2410C'},
  {id: 'health', name: 'בריאות', color: '#2F7BEF'},
  {id: 'personal', name: 'אישי', color: '#8B5CF6'},
  {id: 'work', name: 'עבודה', color: '#64748B'},
];
/** חותמת ריקה: כל עריכה, בכל מכשיר, גוברת על ברירת המחדל. */
function initialData(today){
  const T = (o) => Object.assign({priority: 'normal', time: '10:00', pre: [], soft: false, nag: {mode: 'daily'},
    missPolicy: null, discreet: false, notifyTitle: null, doneLabel: null, subtasks: [], notes: '', links: [],
    start: today, archived: false, updatedAt: '', deleted: false}, o);
  return {
    tasks: [
      T({id: 'psych', title: 'תשלום לפסיכולוג', domain: 'money', priority: 'high', kind: 'schedule',
        schedule: {rule: {type: 'monthly', day: 'last'}}, missPolicy: 'accumulate', pre: [1],
        discreet: true, notifyTitle: 'תשלום חודשי'}),
      T({id: 'arnona-hk', title: 'הוראת קבע לארנונה', domain: 'money', priority: 'high', kind: 'once',
        once: {date: addDays(today, 14)}, pre: [3, 1], doneLabel: 'נקבעה',
        subtasks: [{id: 's1', text: 'למלא בקשה להוראת קבע בעיריית גבעתיים'}, {id: 's2', text: 'לוודא שהחיוב הראשון ירד'}],
        notes: 'במקום לזכור לשלם כל חודשיים. עד שהוראת הקבע פעילה, לשלם את השובר כרגיל.'}),
      T({id: 'gym', title: 'פעילות גופנית', domain: 'health', kind: 'quota', quota: {count: 3, period: 'week'},
        time: '17:00', nag: {mode: 'none'}}),
      T({id: 'haircut', title: 'תספורת', domain: 'personal', kind: 'afterDone',
        afterDone: {minDays: 21, maxDays: 30, lastDone: null}, soft: true, nag: {mode: 'daily', from: 'max'},
        doneLabel: 'הסתפרתי', subtasks: [{id: 's1', text: 'לקבוע תור'}]}),
      T({id: 'rent', title: 'חידוש שכר דירה', domain: 'home', priority: 'high', kind: 'once',
        once: {date: '2026-11-30'}, pre: [14, 7, 3, 1], notes: 'החוזה שלי כשוכר.'}),
      T({id: 'token', title: 'חידוש אסימון גיטהאב', domain: 'personal', priority: 'high', kind: 'afterDone',
        afterDone: {minDays: 82, maxDays: 89, lastDone: today}, soft: true, nag: {mode: 'daily', from: 'max'},
        doneLabel: 'חידשתי', notes: TOKEN_NOTES}),
      ...REPLACE_TASKS(today).map(T),
    ],
    domains: DOMAINS.map(d => Object.assign({hidden: false, updatedAt: ''}, d)),
    config: Object.assign({}, DEFAULT_CONFIG, {
      seedV: 4,
      mailRules: [
        {id: 'elec', enabled: true, from: 'noreplys@iec.co.il', subject: '', title: 'חישוב חשמל עם הדייר', domain: 'rental',
          priority: 'high', dueDays: 3, time: '10:00', extractAmount: true, nag: {mode: 'daily'}, calc: 'elec',
          subtasks: [{id: 's1', text: 'לקרוא את מונה המשנה של הדייר'}, {id: 's2', text: 'לחשב במחשבון'}, {id: 's3', text: 'לשלוח לדייר'}, {id: 's4', text: 'לקבל תשלום'}]},
        {id: 'water', enabled: true, from: 'mast@outbox.co.il', subject: '', title: 'חלוקת מים עם הדייר', domain: 'rental',
          priority: 'normal', dueDays: 3, time: '10:00', extractAmount: true, nag: {mode: 'daily'}, calc: 'water',
          subtasks: [{id: 's1', text: 'לחשב במחשבון'}, {id: 's2', text: 'לשלוח לדייר'}, {id: 's3', text: 'לקבל תשלום'}]},
      ],
    }),
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
  SHOP_CATS, SHOP_CATALOG, calendarUrl, calendarFor, DOC_TYPES, birthdayTask, docTask, birthdaysView, docsView, RECIPE_CATS, mergeRecipesFile, guessRecipeCat, recipeCat, recipeImages, recipeImageGroup, imageOptions, imageGroupOf, recipeEmojiOf, RECIPE_IMAGES, mergeTimersFile, liveTimers, timersDue, timerPayload, ingredientProduct, durationsIn, parseRecipeText, recipeText, calendarSpec, calendarDiff, mergeCalFile, REPEATS, repeatText, ruleFor, rruleOf, pushDue, pushKey, pushPayload, pruneSent, mergeSubsFile, liveSubs,
  TENANT_DEFAULT, tenantCfg, calcElec, calcWater, calcArnona, calcCharge, tenantText, money, migrate,
};
});
