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
  mailRules: [], calendars: [], ntfy: '', ntfyCmd: '',
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
  const add = (n, keepTime) => {
    const ms = keepTime ? shiftToActive(n.at, cfg) : n.at;
    if(ms <= now + 15e3 || ms > end) return;
    if(!keepTime && !inActive(ms, cfg)) return;          // מחוץ לשעות: לא נשלח, הסיכום מכסה
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
      cands.push({id: `${o.id}-day`, at: at(o.due, task.time), title, message: domain || 'היום'});
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
        add(Object.assign({}, one, c));
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
  if(nonces && !nonces.has(cmd.k)) return null;
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
    notifyTitle: rule.notifyTitle || null, subtasks: (rule.subtasks || []).map(x => Object.assign({}, x)),
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
      T({id: 'arnona', title: 'תשלום ארנונה', domain: 'money', priority: 'high', kind: 'schedule',
        schedule: {rule: {type: 'everyNMonths', n: 2, day: 14, anchor: '2026-01-14'}}, missPolicy: 'accumulate', pre: [3],
        notes: 'לאמת את היום בחודש מול השובר. ההנחה: 14 בחודשים האי־זוגיים, לפי תאריך היעד 14.1.2026. באתר העירייה כתוב רק שהתשלומים דו־חודשיים.'}),
      T({id: 'gym', title: 'פעילות גופנית', domain: 'health', kind: 'quota', quota: {count: 3, period: 'week'},
        time: '17:00', nag: {mode: 'none'}}),
      T({id: 'haircut', title: 'תספורת', domain: 'personal', kind: 'afterDone',
        afterDone: {minDays: 21, maxDays: 30, lastDone: null}, soft: true, nag: {mode: 'daily', from: 'max'},
        doneLabel: 'הסתפרתי', subtasks: [{id: 's1', text: 'לקבוע תור'}]}),
      T({id: 'rent', title: 'חידוש שכר דירה', domain: 'home', priority: 'high', kind: 'once',
        once: {date: '2026-11-30'}, pre: [14, 7, 3, 1], notes: 'החוזה שלי כשוכר.'}),
    ],
    domains: DOMAINS.map(d => Object.assign({hidden: false, updatedAt: ''}, d)),
    config: Object.assign({}, DEFAULT_CONFIG, {
      mailRules: [{id: 'elec', enabled: false, from: '', subject: '', title: 'חישוב חשמל עם הדייר', domain: 'rental',
        priority: 'high', dueDays: 3, time: '10:00', extractAmount: true, nag: {mode: 'daily'},
        subtasks: [{id: 's1', text: 'לחשב חלוקה'}, {id: 's2', text: 'לשלוח לדייר'}, {id: 's3', text: 'לקבל תשלום'}]}],
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
  mergeById, mergeConfig, mergeTasksFile, mergeOccFile,
  extractAmount, taskFromMail, newMailTasks,
  shortDate, longDate, describeRule, initialData,
};
});
