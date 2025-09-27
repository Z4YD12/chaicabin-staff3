
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbDir = path.join(__dirname, '..', 'data');
if(!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
const dbPath = path.join(dbDir, 'chaicabin.sqlite');
if(fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new sqlite3.Database(dbPath);

db.serialize(()=>{
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT UNIQUE,
    password TEXT,
    role TEXT,
    wage REAL DEFAULT 10.0
  )`);

  db.run(`CREATE TABLE shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    start_ts TEXT,
    end_ts TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE clockins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    shift_id INTEGER,
    clock_in TEXT,
    clock_out TEXT,
    acted_by INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE payroll_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    month TEXT,
    hours REAL,
    total_pay REAL,
    admin_corrected INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    description TEXT,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE stock_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    item TEXT,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE timeoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    from_dt TEXT,
    to_dt TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending'
  )`);

  // seed users
  db.run(`INSERT INTO users (name, phone, password, role, wage) VALUES (?,?,?,?,?)`, ['Manager','07100000010','pass','admin',0]);
  db.run(`INSERT INTO users (name, phone, password, role, wage) VALUES (?,?,?,?,?)`, ['Alice','07100000001','pass','staff',9.5]);
  db.run(`INSERT INTO users (name, phone, password, role, wage) VALUES (?,?,?,?,?)`, ['Bob','07100000002','pass','staff',10]);

  // sample shifts - create upcoming shifts
  const now = new Date();
  const pad = (n)=> n<10? '0'+n : ''+n;
  function iso(dt){
    return dt.toISOString();
  }
  const d1 = new Date(); d1.setDate(d1.getDate()+1); d1.setHours(9,0,0,0);
  const d1e = new Date(d1); d1e.setHours(17,0,0,0);
  const d2 = new Date(); d2.setDate(d2.getDate()+2); d2.setHours(10,0,0,0);
  const d2e = new Date(d2); d2e.setHours(16,0,0,0);

  db.run(`INSERT INTO shifts (user_id, start_ts, end_ts) VALUES (?,?,?)`, [2, iso(d1), iso(d1e)]);
  db.run(`INSERT INTO shifts (user_id, start_ts, end_ts) VALUES (?,?,?)`, [3, iso(d2), iso(d2e)]);

});

db.close();
console.log('Database created and seeded at ./data/chaicabin.sqlite');
