
/* ChaiCabin full build server.js
   - SQLite storage at ./data/chaicabin.sqlite
   - SSE for notifications (/events)
   - Endpoints for login, clock, admin actions, shifts, payroll, tasks, stock
   - Cron jobs for daily 11:00 and monthly payroll generation (last Sunday)
*/
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { promisify } = require('util');

const DB_FILE = path.join(__dirname, 'data', 'chaicabin.sqlite');
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

if(!fs.existsSync(DB_FILE)){
  console.log('Database not found, run: npm run reset-db');
}

// Open DB
const db = new sqlite3.Database(DB_FILE);

// promisify db methods
const dbGet = (sql, params=[])=> new Promise((res,rej)=> db.get(sql, params, (e,r)=> e?rej(e):res(r)));
const dbAll = (sql, params=[])=> new Promise((res,rej)=> db.all(sql, params, (e,r)=> e?rej(e):res(r)));
const dbRun = (sql, params=[])=> new Promise((res,rej)=> db.run(sql, params, function(err){ if(err) rej(err); else res(this); }));

// SSE clients
let clients = [];
app.get('/events', (req,res)=>{
  res.set({
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    Connection:'keep-alive'
  });
  res.flushHeaders();
  const id = Date.now()+Math.random();
  clients.push({id,res});
  req.on('close', ()=> { clients = clients.filter(c=>c.id!==id); });
});

function sendEvent(event, payload){
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(c=> c.res.write(msg));
}

// Notification abstraction (console + SSE)
function notify(userContact, message){
  console.log(`[NOTIFY] To ${userContact}: ${message}`);
  sendEvent('notify', { to: userContact, message });
}

// --- Auth (simple phone+password) ---
app.post('/api/login', async (req,res)=>{
  const { phone, password } = req.body;
  if(!phone || !password) return res.status(400).json({ error:'phone+password required' });
  try{
    const user = await dbGet('SELECT id,name,phone,role FROM users WHERE phone=? AND password=?', [phone, password]);
    if(!user) return res.status(401).json({ error:'Invalid credentials' });
    res.json({ user });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// --- Clock in/out with optional targetUserId & geolocation enforcement (Bolton) ---
function haversine(lat1,lng1,lat2,lng2){
  const toRad = x=> x*Math.PI/180;
  const R = 6371;
  const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

app.post('/api/clock', async (req,res)=>{
  const { userId, type, lat, lng, targetUserId } = req.body;
  if(!userId || !type) return res.status(400).json({ error:'userId and type required' });
  try{
    const actor = await dbGet('SELECT * FROM users WHERE id=?', [userId]);
    if(!actor) return res.status(400).json({ error:'actor not found' });
    const actualUserId = targetUserId || userId;
    const user = await dbGet('SELECT * FROM users WHERE id=?', [actualUserId]);
    if(!user) return res.status(400).json({ error:'target user not found' });
    // enforce geolocation only for non-admin acting users
    if(actor.role !== 'admin'){
      if(lat==null || lng==null) return res.status(400).json({ error:'Location required' });
      const dist = haversine(lat,lng,53.5780, -2.4299);
      if(dist > 0.2) return res.status(403).json({ error:'You must be at The ChaiCabin Bolton to clock in/out' });
    }
    const ts = new Date().toISOString();
    await dbRun('INSERT INTO clockins (user_id, shift_id, clock_in, clock_out, acted_by) VALUES (?,?,?,?,?)', [actualUserId, null, type==='in'?ts:null, type==='out'?ts:null, userId]);
    const msg = `${user.name} ${type} at ${ts}`;
    notify(process.env.MANAGER_PHONE || 'manager', msg);
    sendEvent('clock', { user: user.name, type, ts });
    res.json({ ok:true, ts });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// --- Stock request ---
app.post('/api/stock', async (req,res)=>{
  const { userId, items } = req.body;
  if(!userId || !items) return res.status(400).json({ error:'userId+items required' });
  try{
    await dbRun('INSERT INTO stock_requests (user_id, item, status) VALUES (?,?,?)', [userId, items, 'pending']);
    const u = await dbGet('SELECT name,phone FROM users WHERE id=?', [userId]);
    notify(process.env.MANAGER_PHONE || 'manager', `Stock request from ${u.name}: ${items}`);
    sendEvent('stock', { user: u.name, items });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// --- Tasks ---
app.post('/api/admin/task', async (req,res)=>{
  const { userId, title, notes } = req.body;
  try{
    await dbRun('INSERT INTO tasks (user_id, description, status) VALUES (?,?,?)', [userId, title, 'pending']);
    const u = await dbGet('SELECT name,phone FROM users WHERE id=?', [userId]);
    notify(u.phone, `New task: ${title}`);
    sendEvent('task', { user: u.name, title });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// --- Shifts management ---
app.post('/api/admin/shifts', async (req,res)=>{
  const { userId, startTs, endTs } = req.body;
  try{
    const resu = await dbRun('INSERT INTO shifts (user_id, start_ts, end_ts) VALUES (?,?,?)', [userId, startTs, endTs]);
    const shiftId = resu.lastID;
    // schedule check for 5 minutes after start
    scheduleLateCheck(shiftId, userId, new Date(startTs));
    sendEvent('shift-created', { shiftId, userId, startTs, endTs });
    res.json({ ok:true, shiftId });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/shifts', async (req,res)=>{
  const rows = await dbAll('SELECT s.*, u.name FROM shifts s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.start_ts');
  res.json({ shifts: rows });
});

app.get('/api/shifts/user/:id', async (req,res)=>{
  const id = Number(req.params.id);
  const rows = await dbAll('SELECT * FROM shifts WHERE user_id=? ORDER BY start_ts', [id]);
  res.json({ shifts: rows });
});

// Admin can edit shifts
app.post('/api/admin/shifts/:id/edit', async (req,res)=>{
  const id = Number(req.params.id);
  const { startTs, endTs, userId } = req.body;
  await dbRun('UPDATE shifts SET start_ts=?, end_ts=?, user_id=? WHERE id=?', [startTs, endTs, userId, id]);
  // reschedule late check by removing old timers (we don't track timers persisently here, but schedule ones on server boot and on change)
  scheduleLateCheck(id, userId, new Date(startTs));
  // notify employee
  const u = await dbGet('SELECT name,phone FROM users WHERE id=?', [userId]);
  notify(u.phone, `Your shift was changed to ${startTs} - ${endTs}`);
  sendEvent('shift-updated', { id, startTs, endTs, userId });
  res.json({ ok:true });
});

// --- Payroll endpoints ---
// Generate payroll for month (YYYY-MM)
async function generatePayrollForMonth(month){ // month like '2025-09'
  // for each user, compute hours from clockins paired in/out for that month
  const users = await dbAll('SELECT id,name FROM users WHERE role="staff"');
  for(const u of users){
    const rows = await dbAll('SELECT * FROM clockins WHERE user_id=? ORDER BY id', [u.id]);
    // naive pairing: match in then next out
    let totalMs = 0;
    for(let i=0;i<rows.length;i++){
      if(rows[i].clock_in){
        const out = rows.slice(i+1).find(x=>x.clock_out);
        if(out) totalMs += (new Date(out.clock_out) - new Date(rows[i].clock_in));
      }
    }
    const hours = totalMs/1000/60/60;
    const wageRow = await dbGet('SELECT wage FROM users WHERE id=?', [u.id]);
    const wage = wageRow? wageRow.wage || 0 : 0;
    const total = +(hours * wage).toFixed(2);
    // insert or update payroll_reports row
    const existing = await dbGet('SELECT id,admin_corrected FROM payroll_reports WHERE user_id=? AND month=?', [u.id, month]);
    if(existing){
      if(existing.admin_corrected === 0){
        await dbRun('UPDATE payroll_reports SET hours=?, total_pay=? WHERE id=?', [hours, total, existing.id]);
      } // else preserve
    } else {
      await dbRun('INSERT INTO payroll_reports (user_id, month, hours, total_pay, admin_corrected) VALUES (?,?,?,?,0)', [u.id, month, hours, total]);
    }
  }
}

// Admin trigger generate payroll
app.post('/api/admin/payroll/generate', async (req,res)=>{
  const { month } = req.body; // format YYYY-MM
  const m = month || new Date().toISOString().slice(0,7);
  try{
    await generatePayrollForMonth(m);
    sendEvent('payroll-generated', { month: m });
    // notify admin
    notify(process.env.MANAGER_PHONE || 'manager', `Payroll generated for ${m}`);
    res.json({ ok:true, month: m });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/payroll/:month', async (req,res)=>{
  const m = req.params.month;
  const rows = await dbAll('SELECT p.*, u.name, u.phone FROM payroll_reports p JOIN users u ON u.id=p.user_id WHERE p.month=?', [m]);
  res.json({ rows });
});

// Admin edit payroll row (preserve admin_corrected flag)
app.post('/api/admin/payroll/:id/edit', async (req,res)=>{
  const id = Number(req.params.id);
  const { hours, total_pay } = req.body;
  await dbRun('UPDATE payroll_reports SET hours=?, total_pay=?, admin_corrected=1 WHERE id=?', [hours, total_pay, id]);
  sendEvent('payroll-updated', { id });
  res.json({ ok:true });
});

// Get payroll for a user
app.get('/api/payroll/user/:id/:month', async (req,res)=>{
  const id = Number(req.params.id);
  const month = req.params.month;
  const p = await dbGet('SELECT * FROM payroll_reports WHERE user_id=? AND month=?', [id, month]);
  res.json({ payroll: p });
});

// --- Hours endpoint for staff (earned so far + expected) ---
app.get('/api/staff/earnings/:id', async (req,res)=>{
  const id = Number(req.params.id);
  // hours so far in current month
  const rows = await dbAll('SELECT * FROM clockins WHERE user_id=?', [id]);
  let totalMs = 0;
  for(let i=0;i<rows.length;i++){
    if(rows[i].clock_in){
      const out = rows.slice(i+1).find(x=>x.clock_out);
      if(out) totalMs += (new Date(out.clock_out) - new Date(rows[i].clock_in));
    }
  }
  const hours = totalMs/1000/60/60;
  const wageRow = await dbGet('SELECT wage FROM users WHERE id=?', [id]);
  const wage = wageRow? wageRow.wage || 0 : 0;
  const earned = +(hours * wage).toFixed(2);
  // expected from shifts in current month
  const month = new Date().toISOString().slice(0,7)+'%';
  const shifts = await dbAll('SELECT * FROM shifts WHERE user_id=? AND start_ts LIKE ?', [id, month]);
  let expectedMs = 0;
  for(const s of shifts){
    const start = new Date(s.start_ts), end = new Date(s.end_ts);
    expectedMs += (end - start);
  }
  const expectedHours = expectedMs/1000/60/60;
  const expectedEarn = +(expectedHours * wage).toFixed(2);
  res.json({ hours: +hours.toFixed(2), earned, expectedHours: +expectedHours.toFixed(2), expectedEarn });
});

// --- Admin users endpoints ---
app.post('/api/admin/users', async (req,res)=>{
  const { name, phone, password, wage } = req.body;
  try{
    await dbRun('INSERT INTO users (name, phone, password, role, wage) VALUES (?,?,?,?,?)', [name, phone, password, 'staff', wage||0]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/users', async (req,res)=>{
  const rows = await dbAll('SELECT id,name,phone,role,wage FROM users');
  res.json({ users: rows });
});
app.post('/api/admin/wage/:id', async (req,res)=>{
  const id = Number(req.params.id);
  const { wage } = req.body;
  await dbRun('UPDATE users SET wage=? WHERE id=?', [wage, id]);
  res.json({ ok:true });
});

// --- Timeoff requests ---
app.post('/api/timeoff', async (req,res)=>{
  const { userId, from, to, reason } = req.body;
  await dbRun('INSERT INTO timeoffs (user_id, from_dt, to_dt, reason, status) VALUES (?,?,?,?,?)', [userId, from, to, reason, 'pending']);
  const admin = await dbGet('SELECT phone FROM users WHERE role="admin" LIMIT 1');
  notify(admin?admin.phone:'manager', `Timeoff request from user ${userId}`);
  sendEvent('timeoff', { userId, from, to });
  res.json({ ok:true });
});
app.get('/api/admin/timeoffs', async (req,res)=>{
  const rows = await dbAll('SELECT t.*, u.name FROM timeoffs t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC');
  res.json({ timeoffs: rows });
});
app.post('/api/admin/timeoffs/:id/approve', async (req,res)=>{
  const id = Number(req.params.id);
  await dbRun('UPDATE timeoffs SET status="approved" WHERE id=?', [id]);
  const t = await dbGet('SELECT * FROM timeoffs WHERE id=?', [id]);
  const u = await dbGet('SELECT phone FROM users WHERE id=?', [t.user_id]);
  notify(u.phone, `Your timeoff request was approved.`);
  res.json({ ok:true });
});

// --- Clock event edits by admin ---
app.post('/api/admin/clock-events/:id/edit', async (req,res)=>{
  const id = Number(req.params.id);
  const { clock_in, clock_out } = req.body;
  await dbRun('UPDATE clockins SET clock_in=?, clock_out=? WHERE id=?', [clock_in || null, clock_out || null, id]);
  sendEvent('clock-edit', { id });
  res.json({ ok:true });
});

// --- Utility: get clock events ---
app.get('/api/admin/clock-events', async (req,res)=>{
  const rows = await dbAll('SELECT c.*, u.name FROM clockins c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC');
  res.json({ events: rows });
});

// --- Late check scheduling ---
let lateTimers = {}; // shiftId -> timeoutId

function scheduleLateCheck(shiftId, userId, startDate){
  try{
    // clear existing timer
    if(lateTimers[shiftId]) clearTimeout(lateTimers[shiftId]);
    const checkAt = new Date(startDate.getTime() + 5*60*1000);
    const delay = checkAt.getTime() - Date.now();
    if(delay <= 0) return;
    const t = setTimeout(async ()=>{
      // check if user has clocked in after startDate and before now
      const rows = await dbAll('SELECT * FROM clockins WHERE user_id=? AND clock_in IS NOT NULL AND clock_in>=?', [userId, startDate.toISOString()]);
      if(rows.length === 0){
        const u = await dbGet('SELECT name,phone FROM users WHERE id=?', [userId]);
        notify(u.phone, `You are late for your shift that started at ${startDate.toLocaleString()}`);
        // notify admin
        const admin = await dbGet('SELECT phone,name FROM users WHERE role="admin" LIMIT 1');
        notify(admin?admin.phone:'manager', `${u.name} has not clocked in for shift at ${startDate.toLocaleString()}`);
        sendEvent('late', { user: u.name, start: startDate.toISOString() });
      }
    }, delay);
    lateTimers[shiftId] = t;
  }catch(e){ console.error('schedule error', e); }
}

// On server start, schedule late checks for upcoming shifts in next 7 days
(async ()=>{
  try{
    const rows = await dbAll('SELECT * FROM shifts WHERE datetime(start_ts) >= datetime("now", "-1 day") AND datetime(start_ts) <= datetime("now", "+7 days")');
    rows.forEach(r=> scheduleLateCheck(r.id, r.user_id, new Date(r.start_ts)));
  }catch(e){ console.error(e); }
})();

// Cron: daily at 11:00 server time -> send 11am reminders for today's shifts
cron.schedule('0 11 * * *', async ()=>{
  try{
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const rows = await dbAll('SELECT s.*, u.name, u.phone FROM shifts s JOIN users u ON u.id=s.user_id WHERE datetime(s.start_ts) BETWEEN datetime("now","start of day") AND datetime("now","localtime","+1 day","-1 second")');
    // simplified query: get shifts where date is today
    const shiftsToday = await dbAll('SELECT s.*, u.name, u.phone FROM shifts s JOIN users u ON u.id=s.user_id WHERE date(s.start_ts)=date("now")');
    shiftsToday.forEach(s=>{
      notify(s.phone, `Reminder: You have a shift today at ${new Date(s.start_ts).toLocaleTimeString()}`);
      sendEvent('reminder-11am', { user: s.name, start: s.start_ts });
    });
  }catch(e){ console.error(e); }
});

// Cron: last Sunday monthly -> generate payroll for current month
cron.schedule('0 2 * * 0', async ()=>{ // runs every Sunday at 02:00, we'll check if last Sunday of month
  try{
    const now = new Date();
    const nextWeek = new Date(now.getTime()+7*24*60*60*1000);
    if(nextWeek.getMonth() !== now.getMonth()){ // today is last Sunday of month
      const month = now.toISOString().slice(0,7);
      await generatePayrollForMonth(month);
      const admin = await dbGet('SELECT phone FROM users WHERE role="admin" LIMIT 1');
      notify(admin?admin.phone:'manager', `Payroll generated for ${month}`);
      sendEvent('payroll-generated', { month });
    }
  }catch(e){ console.error(e); }
});

// --- static file serving fallback ---
app.get('/', (req,res)=>{ res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server running on port', PORT));
