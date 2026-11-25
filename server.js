'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const BASE_URL = `${(process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '')}/`;
const STATE_ID = 'main';
const MAX_BODY_BYTES = 1024 * 1024;
const SUPABASE_URL = process.env.SUPABASE_URL?.trim() || '';
const SUPABASE_PUBLISHABLE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
const SUPABASE_ORIGIN = (() => {
  try { return new URL(SUPABASE_URL).origin; } catch { return ''; }
})();
const BUSINESS_CATEGORIES = Object.freeze({
  income: ['Sales', 'Services', 'Other income'],
  expense: ['Stock', 'Transport', 'Utilities', 'Marketing', 'Equipment', 'Other expense'],
});

fs.mkdirSync(DATA_DIR, { recursive: true });

let db;
let supabaseClient;
let supabaseAuthClient;
let saveQueue = Promise.resolve();
const paymentVerificationJobs = new Map();
const rateLimitBuckets = new Map();

function now() {
  return new Date();
}

function iso(value) {
  return new Date(value).toISOString();
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('base64');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'base64'), 120000, 32, 'sha256').toString('base64');
}

function passwordMatches(user, password) {
  try {
    const expected = Buffer.from(user.passwordHash || '', 'base64');
    const algorithms = user.passwordAlgorithm === 'sha1' ? ['sha1'] : ['sha256', 'sha1'];
    return algorithms.some((algorithm) => {
      const actual = crypto.pbkdf2Sync(String(password), Buffer.from(user.salt, 'base64'), 120000, 32, algorithm);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
  } catch {
    return false;
  }
}

function startOfToday() {
  const d = now();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayOffset(days, from = startOfToday()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function cycleKey(date, frequency) {
  const d = new Date(date);
  if (frequency === 'Monthly') return d.toISOString().slice(0, 7);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function nextCycleDate(date, frequency) {
  const next = new Date(date);
  if (frequency === 'Weekly') {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function nextScheduledDueDate(date, frequency) {
  let next = nextCycleDate(date, frequency);
  const today = startOfToday();
  while (next < today) next = nextCycleDate(next, frequency);
  return next;
}

function upcomingDueDates(group) {
  const dates = new Set();
  let next = new Date(group.nextDueAt);
  if (!Number.isFinite(next.getTime())) return dates;
  const today = startOfToday();
  while (next < today) next = nextCycleDate(next, group.frequency);
  const horizon = dayOffset(365, today);
  while (next <= horizon) {
    dates.add(next.toISOString().slice(0, 10));
    next = nextCycleDate(next, group.frequency);
  }
  return dates;
}

function scheduleClash(userId, candidate, ignoreGroupId = null) {
  const candidateDates = upcomingDueDates(candidate);
  for (const group of db.groups) {
    if (group.id === ignoreGroupId || !group.members.some((member) => member.userId === userId)) continue;
    for (const date of upcomingDueDates(group)) {
      if (candidateDates.has(date)) return { groupName: group.name, date };
    }
  }
  return null;
}

function makeJoinCode() {
  let code;
  do {
    code = crypto.randomBytes(8).toString('hex').toUpperCase();
  } while (db && db.groups.some((group) => group.joinCode === code));
  return code;
}

function flutterwaveTestMode() {
  return /^FLWSECK_TEST-/.test(process.env.FLW_SECRET_KEY || '');
}

function safeEqualText(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const a = Buffer.from(first, 'utf8');
  const b = Buffer.from(second, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function allowRequest(req, bucket, limit, windowMs) {
  const address = req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${address}`;
  const time = Date.now();
  let current = rateLimitBuckets.get(key);
  if (!current || time - current.startedAt >= windowMs) {
    current = { startedAt: time, count: 0 };
    rateLimitBuckets.set(key, current);
  }
  current.count += 1;
  if (rateLimitBuckets.size > 1000) {
    for (const [entry, value] of rateLimitBuckets) {
      if (time - value.startedAt > windowMs * 2) rateLimitBuckets.delete(entry);
    }
  }
  return current.count <= limit;
}

function parseDueDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function parseBusinessEntry(body) {
  const type = String(body.type || '');
  const category = String(body.category || '');
  const amount = Number(body.amount);
  const entryDate = parseDueDate(body.entryDate);
  const note = String(body.note || '').trim();
  const today = startOfToday().toISOString().slice(0, 10);
  if (!BUSINESS_CATEGORIES[type] || !BUSINESS_CATEGORIES[type].includes(category)) {
    return { error: 'Choose a valid income or expense category.' };
  }
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000) {
    return { error: 'Enter an amount between ₦1 and ₦1,000,000,000 in whole naira.' };
  }
  if (!entryDate || entryDate.toISOString().slice(0, 10) > today) {
    return { error: 'Choose a valid date today or earlier.' };
  }
  if (note.length > 120) return { error: 'Notes must be 120 characters or fewer.' };
  return { value: { type, category, amount, entryDate: entryDate.toISOString().slice(0, 10), note } };
}

function isContributionRecorded(groupId, userId, currentCycleKey) {
  return db.contributions.some((row) => row.groupId === groupId && row.userId === userId
    && row.cycleKey === currentCycleKey && ['paid_demo', 'demo_recorded', 'paid'].includes(row.status));
}

function contributionWindowOpen(group) {
  const dueDay = String(group.nextDueAt || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dueDay) && dueDay <= startOfToday().toISOString().slice(0, 10);
}

function finishCycleIfPaid(group) {
  const cycle = group.currentCycleKey;
  const paidMembers = new Set(db.contributions
    .filter((row) => row.groupId === group.id && row.cycleKey === cycle && ['paid_demo', 'demo_recorded', 'paid'].includes(row.status))
    .map((row) => row.userId));
  if (group.members.length < group.capacity || !group.members.every((member) => paidMembers.has(member.userId))) return false;
  if (group.payoutOrder.length > 1) group.payoutOrder.push(group.payoutOrder.shift());
  group.nextDueAt = iso(nextScheduledDueDate(group.nextDueAt, group.frequency));
  group.currentCycleKey = cycleKey(group.nextDueAt, group.frequency);
  group.lastCompletedCycleKey = cycle;
  return true;
}

function seedDatabase() {
  const today = startOfToday();
  const salt = crypto.randomBytes(16).toString('base64');
  const user = {
    id: 'u_demo', name: 'Adaeze Okafor', email: 'adaeze@trustajo.example', salt,
    passwordHash: hashPassword('TrustAjoDemo2026!', salt), passwordAlgorithm: 'sha256',
    businessName: 'Adaeze Market Studio', businessType: 'Fashion & retail', emailVerified: true,
    bvnStatus: 'not_started', ninStatus: 'not_started', monthlyIncomeGoal: 350000,
    preferences: { theme: 'system', contributionReminders: true, weeklyDigest: true, shareAlerts: true },
    createdAt: iso(today),
  };
  const members1 = [
    { userId: 'u_demo', name: 'Adaeze Okafor', role: 'Member' },
    { userId: 'm_daniel', name: 'Daniel Eze', role: 'Member' },
    { userId: 'm_amaka', name: 'Amaka Bello', role: 'Member' },
    { userId: 'm_tunde', name: 'Tunde Lawal', role: 'Member' },
    { userId: 'm_zainab', name: 'Zainab Yusuf', role: 'Member' },
  ];
  const members2 = [
    { userId: 'm_kemi', name: 'Kemi Adebayo', role: 'Member' },
    { userId: 'u_demo', name: 'Adaeze Okafor', role: 'Member' },
    { userId: 'm_femi', name: 'Femi Ogun', role: 'Member' },
    { userId: 'm_chisom', name: 'Chisom Obi', role: 'Member' },
  ];
  const weeklyGroup = {
    id: 'ajo-campus-makers', ownerId: 'u_demo', name: 'Campus Makers Circle',
    joinCode: 'CAMPUS25',
    purpose: 'A weekly circle for student-run businesses', frequency: 'Weekly',
    contributionAmount: 25000, capacity: 5, currentCycleKey: cycleKey(today, 'Weekly'),
    nextDueAt: iso(dayOffset(2)),
    payoutOrder: ['Adaeze Okafor', 'Daniel Eze', 'Amaka Bello', 'Tunde Lawal', 'Zainab Yusuf'],
    members: members1,
  };
  const monthlyGroup = {
    id: 'ajo-market-women', ownerId: 'u_demo', name: 'Market Women Growth Circle',
    joinCode: 'MARKET15',
    purpose: 'Monthly stock-up savings with trusted sellers', frequency: 'Monthly',
    contributionAmount: 15000, capacity: 4, currentCycleKey: cycleKey(today, 'Monthly'),
    nextDueAt: iso(dayOffset(5)),
    payoutOrder: ['Kemi Adebayo', 'Adaeze Okafor', 'Femi Ogun', 'Chisom Obi'],
    members: members2,
  };
  const contributions = [];
  for (let i = 1; i <= 4; i += 1) {
    const past = dayOffset(-7 * i);
    contributions.push({
      id: `seed-week-${i}`, groupId: weeklyGroup.id, userId: 'u_demo',
      memberName: 'Adaeze Okafor', amount: 25000, status: 'paid_demo',
      cycleKey: cycleKey(past, 'Weekly'), dueAt: iso(past),
      createdAt: iso(new Date(past.getTime() + 9 * 60 * 60 * 1000)), note: 'Synthetic contribution history',
    });
  }
  for (const member of [{ id: 'm_daniel', name: 'Daniel Eze' }, { id: 'm_amaka', name: 'Amaka Bello' }]) {
    contributions.push({
      id: newId(), groupId: weeklyGroup.id, userId: member.id, memberName: member.name,
      amount: 25000, status: 'paid_demo', cycleKey: weeklyGroup.currentCycleKey,
      dueAt: weeklyGroup.nextDueAt, createdAt: iso(dayOffset(0)), note: 'Synthetic current-cycle entry',
    });
  }
  for (let i = 1; i <= 3; i += 1) {
    const past = new Date(today);
    past.setUTCMonth(past.getUTCMonth() - i);
    contributions.push({
      id: `seed-month-${i}`, groupId: monthlyGroup.id, userId: 'u_demo',
      memberName: 'Adaeze Okafor', amount: 15000, status: 'paid_demo',
      cycleKey: cycleKey(past, 'Monthly'), dueAt: iso(past),
      createdAt: iso(new Date(past.getTime() + 9 * 60 * 60 * 1000)), note: 'Synthetic contribution history',
    });
  }
  contributions.push({
    id: newId(), groupId: monthlyGroup.id, userId: 'm_kemi', memberName: 'Kemi Adebayo',
    amount: 15000, status: 'paid_demo', cycleKey: monthlyGroup.currentCycleKey,
    dueAt: monthlyGroup.nextDueAt, createdAt: iso(dayOffset(0)), note: 'Synthetic current-cycle entry',
  });

  const businessEntries = [];
  for (let monthOffset = 2; monthOffset < 60; monthOffset += 1) {
    const entryDay = new Date(today);
    entryDay.setUTCDate(1);
    entryDay.setUTCMonth(entryDay.getUTCMonth() - monthOffset);
    entryDay.setUTCDate(5 + (monthOffset * 3) % 21);
    const month = entryDay.toISOString().slice(0, 10);
    const income = 52000 + ((monthOffset * 7100) % 86000);
    const expense = Math.round(income * (0.38 + (monthOffset % 5) * 0.045));
    businessEntries.push(
      { id: `seed-business-income-${monthOffset}`, userId: 'u_demo', type: 'income', category: monthOffset % 3 === 0 ? 'Services' : 'Sales', amount: income, entryDate: month, note: 'Sample record', createdAt: iso(entryDay) },
      { id: `seed-business-expense-${monthOffset}`, userId: 'u_demo', type: 'expense', category: monthOffset % 2 === 0 ? 'Stock' : 'Transport', amount: expense, entryDate: month, note: 'Sample record', createdAt: iso(entryDay) },
    );
  }
  for (let offset = 13; offset >= 0; offset -= 1) {
    const entryDay = dayOffset(-offset);
    const entryDate = entryDay.toISOString().slice(0, 10);
    const income = 9000 + ((offset * 4200 + 18500) % 27000);
    const expense = 2500 + ((offset * 1900 + 6500) % 15000);
    businessEntries.push(
      { id: `seed-business-daily-income-${offset}`, userId: 'u_demo', type: 'income', category: offset % 3 === 0 ? 'Services' : 'Sales', amount: income, entryDate, note: 'Sample record', createdAt: iso(entryDay) },
      { id: `seed-business-daily-expense-${offset}`, userId: 'u_demo', type: 'expense', category: offset % 2 === 0 ? 'Stock' : 'Transport', amount: expense, entryDate, note: 'Sample record', createdAt: iso(entryDay) },
    );
  }

  return {
    schemaVersion: 2,
    users: [user], sessions: [], groups: [weeklyGroup, monthlyGroup], contributions, payments: [],
    orders: [], shares: [], audit: [], businessEntries,
    transactions: [
      { id: 'tx-in-1', userId: 'u_demo', title: 'Customer payment', category: 'Incoming', amount: 30000,
        direction: 'in', reference: 'TA-SAMPLE-730145', status: 'confirmed_demo', createdAt: iso(dayOffset(-1)), note: 'Synthetic connected-source credit' },
      { id: 'tx-in-2', userId: 'u_demo', title: 'Customer payment', category: 'Incoming', amount: 18500,
        direction: 'in', reference: 'TA-SAMPLE-110948', status: 'confirmed_demo', createdAt: iso(dayOffset(-2)), note: 'Synthetic connected-source credit' },
    ],
    products: [
      { id: 'p_beads', name: 'Handmade coral bead set', seller: 'Amaka Crafts', price: 18000, category: 'Accessories', color: 'coral', description: 'A bright handmade set from a campus maker.' },
      { id: 'p_tote', name: 'Everyday woven tote', seller: 'Loom & Co.', price: 12500, category: 'Fashion', color: 'sage', description: 'A lightweight tote made in small batches.' },
      { id: 'p_spice', name: 'Market spice bundle', seller: 'Kemi Kitchen', price: 9000, category: 'Food', color: 'gold', description: 'A pantry-ready selection from a local seller.' },
    ],
    passport: {
      monthlyInflow: 185000, incomeConsistency: 72, savingsBehaviour: 64, businessAgeMonths: 14,
      businessActivity: 'Strong', unusualAlerts: 2,
      profileNote: 'Illustrative indicators calculated from synthetic activity.',
    },
  };
}

function normalizeDatabase(value) {
  const result = value && typeof value === 'object' ? value : {};
  for (const field of ['users', 'sessions', 'groups', 'contributions', 'payments', 'orders', 'shares', 'audit', 'transactions', 'products', 'businessEntries']) {
    if (!Array.isArray(result[field])) result[field] = [];
  }
  for (const group of result.groups) {
    if (!group.joinCode) group.joinCode = makeJoinCode();
  }
  if (!result.passport) result.passport = seedDatabase().passport;
  return result;
}

function saveDb() {
  if (!supabaseClient) return Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(db));
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const { error } = await supabaseClient
      .from('app_state')
      .upsert({ id: STATE_ID, state: snapshot, updated_at: now().toISOString() }, { onConflict: 'id' });
    if (error) throw new Error(`Could not save app state to Supabase: ${error.message}`);
  });
  return saveQueue;
}

async function initializeDatabase() {
  const supabaseUrl = SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (SUPABASE_PUBLISHABLE_KEY && (!supabaseUrl || /[<>]/.test(supabaseUrl + SUPABASE_PUBLISHABLE_KEY))) {
    throw new Error('Set a valid SUPABASE_URL with SUPABASE_PUBLISHABLE_KEY in .env to enable Supabase Auth.');
  }
  if (secretKey && (!supabaseUrl || /[<>]/.test(supabaseUrl + secretKey))) {
    throw new Error('Set a valid SUPABASE_URL with SUPABASE_SECRET_KEY in .env to enable Supabase data persistence.');
  }

  const { createClient } = await import('@supabase/supabase-js');
  if (supabaseUrl && SUPABASE_PUBLISHABLE_KEY) {
    supabaseAuthClient = createClient(supabaseUrl, SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }
  if (!secretKey) {
    db = seedDatabase();
    console.log(supabaseAuthClient
      ? 'Supabase Auth is enabled; using the in-memory local demo store for app data.'
      : 'Using the in-memory local demo store. Set Supabase Auth credentials to enable Supabase Auth.');
    return;
  }
  supabaseClient = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data, error } = await supabaseClient
    .from('app_state')
    .select('state')
    .eq('id', STATE_ID)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load app state from Supabase: ${error.message}. Apply supabase/schema.sql and expose the public schema through the Data API.`);
  }

  if (data) {
    db = normalizeDatabase(data.state);
  } else {
    // Seed Supabase with fictional sample records. Local JSON data is never uploaded automatically.
    db = seedDatabase();
    await saveDb();
  }
  console.log('Connected to Supabase PostgreSQL.');
}

function addAudit(userId, action, detail) {
  db.audit.push({ id: newId(), userId, action, detail, createdAt: iso(now()) });
}

function publicUser(user) {
  return {
    id: user.id, name: user.name, email: user.email, businessName: user.businessName,
    businessType: user.businessType,
    monthlyIncomeGoal: Number.isSafeInteger(user.monthlyIncomeGoal) ? user.monthlyIncomeGoal : null,
    emailVerified: Boolean(user.emailVerified),
    bvnStatus: user.bvnStatus, ninStatus: user.ninStatus,
    preferences: user.preferences || { theme: 'system', contributionReminders: true, weeklyDigest: true, shareAlerts: true },
  };
}

function userById(id) {
  return db.users.find((user) => user.id === id) || null;
}

function newSession(userId) {
  const raw = crypto.randomBytes(32).toString('hex');
  const currentTime = Date.now();
  db.sessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > currentTime);
  db.sessions.push({ id: newId(), userId, tokenHash: hashText(raw), expiresAt: iso(currentTime + 12 * 60 * 60 * 1000) });
  const secure = BASE_URL.startsWith('https://') ? '; Secure' : '';
  return `trustajo_session=${raw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

function cookieMap(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function authUser(req) {
  const token = cookieMap(req).trustajo_session;
  if (!token) return null;
  const tokenHash = hashText(token);
  const session = db.sessions.find((item) => item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now());
  return session ? userById(session.userId) : null;
}

function supabaseProfile(authUser) {
  let user = userById(authUser.id);
  if (user) return { user, created: false };
  const metadata = authUser.user_metadata || {};
  const email = String(authUser.email || '').trim().toLowerCase();
  user = {
    id: authUser.id,
    authProvider: 'supabase',
    name: String(metadata.name || email.split('@')[0] || 'Trust Ajo member').trim().slice(0, 80),
    email,
    businessName: String(metadata.business_name || '').trim().slice(0, 80),
    businessType: String(metadata.business_type || '').trim().slice(0, 80),
    emailVerified: Boolean(authUser.email_confirmed_at || authUser.confirmed_at),
    bvnStatus: 'not_started', ninStatus: 'not_started', monthlyIncomeGoal: null,
    preferences: { theme: 'system', contributionReminders: true, weeklyDigest: true, shareAlerts: true },
    createdAt: iso(authUser.created_at || now()),
  };
  db.users.push(user);
  addAudit(user.id, 'account.created', 'Supabase Auth account connected.');
  return { user, created: true };
}

async function authenticatedUser(req) {
  if (!supabaseAuthClient) return authUser(req);
  const authorization = String(req.headers.authorization || '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await supabaseAuthClient.auth.getUser(token);
  if (error || !data?.user) return null;
  const profile = supabaseProfile(data.user);
  if (profile.created) await saveDb();
  return profile.user;
}

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function sendText(res, text, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('The request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function addTransaction(userId, title, category, amount, direction, status, note) {
  db.transactions.push({
    id: newId(), userId, title, category, amount, direction,
    reference: `SAMPLE-${crypto.randomInt(100000, 1000000)}`,
    status, createdAt: iso(now()), note,
  });
}

async function flutterwaveRequest(pathname, options = {}) {
  const response = await fetch(`https://api.flutterwave.com/v3/${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== 'success') {
    throw new Error('Flutterwave could not complete that request. Check the test key and try again.');
  }
  return payload.data;
}

async function verifyAndRecordPayment(txRef, transactionId) {
  const existing = paymentVerificationJobs.get(txRef);
  if (existing) return existing.transactionId === String(transactionId) ? existing.promise : 'review';
  const job = { transactionId: String(transactionId), promise: null };
  job.promise = verifyAndRecordPaymentOnce(txRef, transactionId);
  paymentVerificationJobs.set(txRef, job);
  try {
    return await job.promise;
  } finally {
    if (paymentVerificationJobs.get(txRef) === job) paymentVerificationJobs.delete(txRef);
  }
}

async function verifyAndRecordPaymentOnce(txRef, transactionId) {
  const payment = db.payments.find((item) => item.txRef === txRef);
  if (!payment) return 'unknown';
  if (payment.status === 'successful') return 'success';
  if (!/^\d+$/.test(String(transactionId || ''))) return 'failed';

  let tx;
  try {
    tx = await flutterwaveRequest(`transactions/${encodeURIComponent(String(transactionId))}/verify`);
  } catch {
    return 'pending';
  }

  if (tx.status !== 'successful') {
    if (['failed', 'cancelled'].includes(String(tx.status).toLowerCase())) {
      payment.status = String(tx.status).toLowerCase();
      await saveDb();
      return payment.status;
    }
    return 'pending';
  }

  const amountMatches = Number(tx.amount) === Number(payment.amount)
    && Number(tx.charged_amount ?? tx.amount) === Number(payment.amount);
  const valid = tx.tx_ref === payment.txRef && tx.currency === payment.currency && amountMatches;
  if (!valid) {
    payment.status = 'review_required';
    await saveDb();
    return 'review';
  }

  const group = db.groups.find((item) => item.id === payment.groupId);
  if (!group) return 'unknown';
  if (isContributionRecorded(payment.groupId, payment.userId, payment.cycleKey)) {
    payment.status = 'duplicate_review';
    await saveDb();
    return 'review';
  }

  const user = userById(payment.userId);
  if (!user) return 'unknown';
  payment.status = 'successful';
  payment.transactionId = String(tx.id);
  payment.providerReference = String(tx.flw_ref || '');
  payment.paidAt = iso(now());
  db.contributions.push({
    id: newId(), groupId: group.id, userId: user.id, memberName: user.name,
    amount: payment.amount, status: 'paid', cycleKey: payment.cycleKey,
    dueAt: group.nextDueAt, createdAt: payment.paidAt, paymentReference: payment.txRef,
    note: 'Flutterwave test transaction verified; no payout was sent.',
  });
  const cycleCompleted = finishCycleIfPaid(group);
  payment.cycleCompleted = cycleCompleted;
  addAudit(user.id, 'contribution.payment_verified', `Flutterwave confirmed a contribution to ${group.name}.`);
  await saveDb();
  return 'success';
}

function bootstrap(user) {
  const mine = db.contributions.filter((row) => row.userId === user.id && ['paid_demo', 'demo_recorded', 'paid'].includes(row.status));
  const businessEntries = db.businessEntries.filter((row) => row.userId === user.id)
    .sort((a, b) => String(b.entryDate).localeCompare(String(a.entryDate)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const passport = passportFor(user);
  const contributionHistory = mine.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const groups = [];
  for (const group of db.groups) {
    if (!group.members.some((member) => member.userId === user.id)) continue;
    const current = db.contributions.filter((row) => row.groupId === group.id && row.cycleKey === group.currentCycleKey);
    const paid = current.filter((row) => ['paid_demo', 'demo_recorded', 'paid'].includes(row.status));
    const mineThisCycle = paid.some((row) => row.userId === user.id);
    groups.push({
      id: group.id, name: group.name, purpose: group.purpose, frequency: group.frequency,
      contributionAmount: group.contributionAmount, capacity: group.capacity,
      memberCount: group.members.length, paidThisCycle: paid.length, nextDueAt: group.nextDueAt,
      myContributionStatus: mineThisCycle ? 'recorded' : 'due', payoutOrder: group.payoutOrder, members: group.members,
      joinCode: group.ownerId === user.id ? group.joinCode : null,
    });
  }
  const activity = db.transactions.filter((item) => item.userId === user.id).map((item) => ({ ...item }));
  for (const row of mine) {
    const group = db.groups.find((item) => item.id === row.groupId);
    activity.push({
      id: row.id, title: `${group ? group.name : 'Ajo'} contribution`, category: 'Group saving',
      amount: row.amount, direction: 'out', reference: row.paymentReference || row.id, status: row.status,
      createdAt: row.createdAt, note: row.note,
    });
  }
  activity.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const shares = db.shares.filter((share) => share.ownerId === user.id).map((share) => ({
    id: share.id, scopes: share.scopes, expiresAt: share.expiresAt, revokedAt: share.revokedAt,
  }));
  const audit = db.audit.filter((item) => item.userId === user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12);
  return {
    user: publicUser(user), groups, activity: activity.slice(0, 12), products: db.products,
    businessEntries,
    shares, audit, demoMode: true, storageMode: supabaseClient ? 'supabase' : 'local-memory',
    paymentMode: flutterwaveTestMode() ? 'flutterwave-test' : 'demo', generatedAt: iso(now()),
    passport: {
      monthlyInflow: passport.monthlyInflow, incomeConsistency: passport.incomeConsistency,
      savingsBehaviour: passport.savingsBehaviour, businessAgeMonths: passport.businessAgeMonths,
      businessActivity: passport.businessActivity, unusualAlerts: passport.unusualAlerts,
      profileNote: passport.profileNote, contributionCount: mine.length, sampleProfile: user.id === 'u_demo',
      contributionTotal: mine.reduce((total, row) => total + (Number(row.amount) || 0), 0),
      contributionHistory: contributionHistory.slice(0, 5).map((row) => ({
        groupName: db.groups.find((group) => group.id === row.groupId)?.name || 'Ajo circle',
        amount: Number(row.amount) || 0, status: row.status, createdAt: row.createdAt,
      })),
    },
  };
}

function passportFor(user) {
  if (user.id === 'u_demo') return { ...db.passport, sampleProfile: true };
  return {
    monthlyInflow: 0, incomeConsistency: 0, savingsBehaviour: 0,
    businessAgeMonths: 0, businessActivity: 'Getting started', unusualAlerts: 0,
    profileNote: 'No bank or income source is connected in this app version.', sampleProfile: false,
  };
}

function expiredOrRevoked(share) {
  return !share || Boolean(share.revokedAt) || Date.parse(share.expiresAt) < Date.now();
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const method = req.method.toUpperCase();
  const route = url.pathname;
  res.setHeader('Referrer-Policy', 'no-referrer');
  const connectSources = SUPABASE_ORIGIN ? `'self' ${SUPABASE_ORIGIN}` : "'self'";
  res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ${connectSources}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);

  if (method === 'GET' && (route === '/' || route === '/share')) {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }
  if (method === 'GET' && route === '/app.js') {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (method === 'GET' && route === '/supabase.js') {
    return sendText(res, fs.readFileSync(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (method === 'GET' && route === '/styles.css') {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8'), 'text/css; charset=utf-8');
  }
  if (method === 'GET' && route === '/professional.css') {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'professional.css'), 'utf8'), 'text/css; charset=utf-8');
  }
  if (method === 'GET' && route === '/api/health') {
    return sendJson(res, 200, {
      ok: true, app: 'Trust Ajo', mode: supabaseClient ? 'supabase' : 'local-demo',
      payments: flutterwaveTestMode() ? 'flutterwave-test' : 'local-only',
    });
  }
  if (method === 'GET' && route === '/api/config') {
    return sendJson(res, 200, {
      supabaseAuth: supabaseAuthClient ? {
        enabled: true,
        url: SUPABASE_URL,
        publishableKey: SUPABASE_PUBLISHABLE_KEY,
      } : { enabled: false },
    });
  }
  if (method === 'GET' && route === '/payments/flutterwave/callback') {
    const txRef = String(url.searchParams.get('tx_ref') || '');
    const transactionId = String(url.searchParams.get('transaction_id') || '');
    const providerStatus = String(url.searchParams.get('status') || '').toLowerCase();
    let result = 'failed';
    if (providerStatus === 'successful' && txRef && transactionId) {
      result = await verifyAndRecordPayment(txRef, transactionId);
    } else if (txRef && ['cancelled', 'failed'].includes(providerStatus)) {
      const payment = db.payments.find((item) => item.txRef === txRef);
      if (payment?.status === 'pending') {
        payment.status = providerStatus;
        await saveDb();
      }
      result = providerStatus;
    }
    res.writeHead(303, { Location: `${BASE_URL}?payment=${encodeURIComponent(result)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (method === 'POST' && route === '/api/payments/flutterwave/webhook') {
    const secretHash = process.env.FLW_SECRET_HASH || '';
    const signature = String(req.headers['verif-hash'] || '');
    if (!secretHash || !safeEqualText(signature, secretHash)) return sendJson(res, 401, { error: 'Invalid webhook signature.' });
    const payload = await readJson(req);
    const txRef = String(payload.data?.tx_ref || '');
    const transactionId = String(payload.data?.id || '');
    if (!txRef || !transactionId) return sendJson(res, 400, { error: 'Webhook is missing transaction details.' });
    const result = await verifyAndRecordPayment(txRef, transactionId);
    if (result === 'pending') return sendJson(res, 503, { error: 'Payment verification is temporarily unavailable.' });
    return sendJson(res, 200, { ok: true, result });
  }

  if (method === 'GET' && route === '/api/share') {
    const share = db.shares.find((item) => item.token === url.searchParams.get('token'));
    if (expiredOrRevoked(share)) return sendJson(res, 404, { error: 'This link expired or was revoked.' });
    const owner = userById(share.ownerId);
    if (!owner) return sendJson(res, 404, { error: 'This Passport owner is no longer available.' });
    const passport = passportFor(owner);
    const metrics = {};
    for (const scope of share.scopes) {
      if (scope === 'profile') metrics.profile = { name: owner.name, businessName: owner.businessName, businessType: owner.businessType };
      if (scope === 'businessActivity') metrics.businessActivity = passport.businessActivity;
      if (scope === 'incomePattern') metrics.incomePattern = { monthlyInflow: passport.monthlyInflow };
      if (scope === 'consistency') metrics.consistency = passport.incomeConsistency;
      if (scope === 'savingsBehaviour') metrics.savingsBehaviour = passport.savingsBehaviour;
    }
    addAudit(share.ownerId, 'passport.share_viewed', 'A recipient opened a permission-limited link.');
    await saveDb();
    return sendJson(res, 200, { metrics, scopes: share.scopes, expiresAt: share.expiresAt, sampleData: owner.id === 'u_demo' });
  }

  if (method === 'POST' && route === '/api/auth/demo') {
    if (supabaseAuthClient) return sendJson(res, 403, { error: 'Sample sign-in is disabled while Supabase Auth is configured.' });
    const user = userById('u_demo');
    const cookie = newSession(user.id);
    await saveDb();
    return sendJson(res, 200, { user: publicUser(user), demoMode: true }, { 'Set-Cookie': cookie });
  }
  if (method === 'POST' && route === '/api/auth/login') {
    if (supabaseAuthClient) return sendJson(res, 403, { error: 'Sign in with Supabase Auth in the app.' });
    if (!allowRequest(req, 'login', 8, 15 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes, then try again.' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (password.length > 128) return sendJson(res, 401, { error: 'Email or password was not recognized.' });
    const user = db.users.find((item) => item.email.toLowerCase() === email);
    if (!user || !passwordMatches(user, password)) return sendJson(res, 401, { error: 'Email or password was not recognized.' });
    const cookie = newSession(user.id);
    await saveDb();
    return sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': cookie });
  }
  if (method === 'POST' && route === '/api/register') {
    if (supabaseAuthClient) return sendJson(res, 403, { error: 'Create your account with Supabase Auth in the app.' });
    if (!allowRequest(req, 'register', 5, 15 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many account attempts. Wait 15 minutes, then try again.' });
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (name.length < 2 || name.length > 80 || email.length > 254
      || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8 || password.length > 128
      || String(body.businessName || '').length > 80 || String(body.businessType || '').length > 80) {
      return sendJson(res, 400, { error: 'Use a name under 80 characters, valid email, password from 8 to 128 characters, and business details under 80 characters.' });
    }
    if (db.users.some((item) => item.email.toLowerCase() === email)) return sendJson(res, 409, { error: 'That email already has an account.' });
    const salt = crypto.randomBytes(16).toString('base64');
    const user = {
      id: newId(), name, email, salt, passwordHash: hashPassword(password, salt), passwordAlgorithm: 'sha256', monthlyIncomeGoal: null,
      businessName: String(body.businessName || '').trim(), businessType: String(body.businessType || '').trim(),
      emailVerified: false, bvnStatus: 'not_started', ninStatus: 'not_started',
      preferences: { theme: 'system', contributionReminders: true, weeklyDigest: true, shareAlerts: true }, createdAt: iso(now()),
    };
    db.users.push(user);
    addAudit(user.id, 'account.created', 'Local demo account created.');
    const cookie = newSession(user.id);
    await saveDb();
    return sendJson(res, 201, { user: publicUser(user), demoMode: true }, { 'Set-Cookie': cookie });
  }
  if (method === 'POST' && route === '/api/auth/logout') {
    const token = cookieMap(req).trustajo_session;
    if (token) {
      const tokenHash = hashText(token);
      db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash);
      await saveDb();
    }
    const secure = BASE_URL.startsWith('https://') ? '; Secure' : '';
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `trustajo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}` });
  }

  const user = await authenticatedUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in to continue.' });
  if (method === 'GET' && route === '/api/bootstrap') return sendJson(res, 200, bootstrap(user));

  if (method === 'POST' && route === '/api/business/entries') {
    const body = await readJson(req);
    const parsed = parseBusinessEntry(body);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    db.businessEntries.push({
      id: newId(), userId: user.id, ...parsed.value,
      createdAt: iso(now()),
    });
    addAudit(user.id, 'business.entry_added', 'A business income or expense entry was saved.');
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'DELETE' && route.startsWith('/api/business/entries/')) {
    let id;
    try { id = decodeURIComponent(route.slice('/api/business/entries/'.length)); } catch { id = ''; }
    const entry = db.businessEntries.find((row) => row.id === id && row.userId === user.id);
    if (!entry) return sendJson(res, 404, { error: 'Business record not found.' });
    db.businessEntries = db.businessEntries.filter((row) => row.id !== id || row.userId !== user.id);
    addAudit(user.id, 'business.entry_deleted', 'A business income or expense entry was deleted.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'PUT' && route.startsWith('/api/business/entries/')) {
    let id;
    try { id = decodeURIComponent(route.slice('/api/business/entries/'.length)); } catch { id = ''; }
    const entry = db.businessEntries.find((row) => row.id === id && row.userId === user.id);
    if (!entry) return sendJson(res, 404, { error: 'Business record not found.' });
    const parsed = parseBusinessEntry(await readJson(req));
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    Object.assign(entry, parsed.value, { updatedAt: iso(now()) });
    addAudit(user.id, 'business.entry_updated', 'A business income or expense entry was updated.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/business/goal') {
    const body = await readJson(req);
    const rawGoal = String(body.monthlyIncomeGoal ?? '').trim();
    const goal = rawGoal === '' ? 0 : Number(rawGoal);
    if (!Number.isSafeInteger(goal) || goal < 0 || goal > 1000000000) {
      return sendJson(res, 400, { error: 'Enter a whole-naira monthly goal up to ₦1,000,000,000, or leave it blank to clear.' });
    }
    user.monthlyIncomeGoal = goal || null;
    addAudit(user.id, 'business.goal_updated', 'Monthly business income goal changed.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }

  if (method === 'POST' && route === '/api/settings') {
    const body = await readJson(req);
    if (!['system', 'light', 'dark'].includes(String(body.theme))) return sendJson(res, 400, { error: 'Choose system, light or dark theme.' });
    if (String(body.businessName || '').length > 80 || String(body.businessType || '').length > 80) {
      return sendJson(res, 400, { error: 'Business name and type must be 80 characters or fewer.' });
    }
    user.preferences.theme = String(body.theme);
    user.preferences.contributionReminders = Boolean(body.contributionReminders);
    user.preferences.weeklyDigest = Boolean(body.weeklyDigest);
    user.preferences.shareAlerts = Boolean(body.shareAlerts);
    if (Object.hasOwn(body, 'businessName')) user.businessName = String(body.businessName || '').trim();
    if (Object.hasOwn(body, 'businessType')) user.businessType = String(body.businessType || '').trim();
    addAudit(user.id, 'settings.updated', 'Profile and app preferences updated.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/verification/demo') {
    const body = await readJson(req);
    if (body.kind === 'email') user.emailVerified = true;
    else if (body.kind === 'bvn') user.bvnStatus = 'demo_verified';
    else if (body.kind === 'nin') user.ninStatus = 'demo_verified';
    else return sendJson(res, 400, { error: 'Unknown verification type.' });
    addAudit(user.id, `verification.${body.kind}.demo`, 'Mock verification only; no provider was contacted.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/create') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const amount = Number.parseInt(body.contributionAmount, 10);
    const capacity = Number.parseInt(body.capacity, 10);
    const frequency = String(body.frequency || '');
    const firstDueAt = parseDueDate(body.firstDueDate);
    const today = startOfToday();
    if (name.length < 3 || !Number.isFinite(amount) || amount < 1000 || amount > 1000000
      || !Number.isFinite(capacity) || capacity < 3 || capacity > 20 || !['Weekly', 'Monthly'].includes(frequency)
      || !firstDueAt || firstDueAt < today || firstDueAt > dayOffset(90, today)) {
      return sendJson(res, 400, { error: 'Use a name, contribution from ₦1,000 to ₦1,000,000, capacity from 3 to 20, a weekly or monthly cycle, and a first due date within 90 days.' });
    }
    const candidate = { frequency, nextDueAt: firstDueAt.toISOString() };
    const conflict = scheduleClash(user.id, candidate);
    if (conflict) return sendJson(res, 409, { error: `That due date overlaps ${conflict.groupName} on ${conflict.date}. Choose another first due date.` });
    const group = {
      id: `ajo-${newId().slice(0, 8)}`, ownerId: user.id, name,
      joinCode: makeJoinCode(), purpose: String(body.purpose || '').trim(), frequency, contributionAmount: amount, capacity,
      currentCycleKey: cycleKey(firstDueAt, frequency), nextDueAt: iso(firstDueAt),
      payoutOrder: [user.name], members: [{ userId: user.id, name: user.name, role: 'Organizer' }],
    };
    db.groups.push(group);
    addAudit(user.id, 'group.created', `Created ${name} (local mode).`);
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/invite/rotate') {
    const body = await readJson(req);
    const group = db.groups.find((item) => item.id === String(body.groupId));
    if (!group || group.ownerId !== user.id) return sendJson(res, 404, { error: 'Only the circle organizer can change this invite code.' });
    group.joinCode = makeJoinCode();
    addAudit(user.id, 'group.invite.rotated', `Changed the invite code for ${group.name}.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'GET' && route === '/api/groups/invite') {
    if (!allowRequest(req, 'invite-lookup', 20, 15 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many invite checks. Wait a few minutes, then try again.' });
    const joinCode = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const group = db.groups.find((item) => item.joinCode === joinCode);
    if (!group) return sendJson(res, 404, { error: 'That invite code was not found. Check it with the circle organizer.' });
    if (group.members.some((member) => member.userId === user.id)) return sendJson(res, 409, { error: 'You already belong to this circle.' });
    if (group.members.length >= group.capacity) return sendJson(res, 409, { error: 'This circle is full.' });
    const conflict = scheduleClash(user.id, group);
    return sendJson(res, 200, {
      group: {
        id: group.id, name: group.name, purpose: group.purpose, frequency: group.frequency,
        contributionAmount: group.contributionAmount, capacity: group.capacity,
        memberCount: group.members.length, nextDueAt: group.nextDueAt, payoutOrder: group.payoutOrder,
      },
      conflict: conflict ? { groupName: conflict.groupName, date: conflict.date } : null,
    });
  }
  if (method === 'POST' && route === '/api/groups/join') {
    const body = await readJson(req);
    const joinCode = String(body.joinCode || '').trim().toUpperCase();
    const group = db.groups.find((item) => item.joinCode === joinCode);
    if (!group) return sendJson(res, 404, { error: 'That invite code was not found. Check it with the circle organizer.' });
    if (group.members.some((member) => member.userId === user.id)) return sendJson(res, 409, { error: 'You already belong to this circle.' });
    if (group.members.length >= group.capacity) return sendJson(res, 409, { error: 'This circle is full.' });
    const conflict = scheduleClash(user.id, group);
    if (conflict) return sendJson(res, 409, { error: `Schedule clash: ${group.name} and ${conflict.groupName} are both due on ${conflict.date}. Ask an organizer to agree a different date before joining.` });
    group.members.push({ userId: user.id, name: user.name, role: 'Member' });
    group.payoutOrder.push(user.name);
    addAudit(user.id, 'group.joined', `Joined ${group.name} using an invite code.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/pay') {
    const body = await readJson(req);
    const group = db.groups.find((item) => item.id === String(body.groupId));
    if (!group || !group.members.some((member) => member.userId === user.id)) return sendJson(res, 404, { error: 'Circle not found for this member.' });
    if (group.members.length < group.capacity) return sendJson(res, 409, { error: `This circle needs ${group.capacity - group.members.length} more member(s) before contributions start.` });
    if (!contributionWindowOpen(group)) return sendJson(res, 409, { error: `Contributions open on ${String(group.nextDueAt).slice(0, 10)}. The circle cannot move to its next cycle early.` });
    if (!flutterwaveTestMode()) return sendJson(res, 503, { error: 'Flutterwave sandbox checkout is not configured. Add a FLWSECK_TEST key, or use the local test contribution record.' });
    if (isContributionRecorded(group.id, user.id, group.currentCycleKey)) return sendJson(res, 409, { error: 'Your contribution for this circle cycle is already recorded.' });
    const nowMs = Date.now();
    const existingPayment = db.payments.find((item) => item.groupId === group.id && item.userId === user.id
      && item.cycleKey === group.currentCycleKey && ['pending', 'successful'].includes(item.status)
      && (item.status === 'successful' || Date.parse(item.createdAt) > nowMs - 30 * 60 * 1000));
    if (existingPayment?.status === 'successful') return sendJson(res, 409, { error: 'Payment for this circle cycle is already confirmed.' });
    if (existingPayment?.status === 'pending') return sendJson(res, 409, { error: 'A checkout is already open for this cycle. Finish it or wait 30 minutes before trying again.' });

    const payment = {
      id: newId(), txRef: `TA-${crypto.randomBytes(18).toString('hex')}`,
      userId: user.id, groupId: group.id, cycleKey: group.currentCycleKey,
      amount: group.contributionAmount, currency: 'NGN', status: 'pending', createdAt: iso(now()),
    };
    db.payments.push(payment);
    await saveDb();
    try {
      const checkout = await flutterwaveRequest('payments', {
        method: 'POST',
        body: {
          tx_ref: payment.txRef,
          amount: payment.amount,
          currency: payment.currency,
          redirect_url: `${BASE_URL}payments/flutterwave/callback`,
          customer: { email: user.email, name: user.name },
          meta: { groupId: group.id, cycleKey: group.currentCycleKey },
          customizations: { title: 'Trust Ajo Contribution', description: `${group.name} contribution` },
        },
      });
      if (!checkout?.link) throw new Error('Flutterwave did not return a checkout link.');
      return sendJson(res, 201, { checkoutUrl: checkout.link, txRef: payment.txRef });
    } catch {
      payment.status = 'failed';
      await saveDb();
      return sendJson(res, 502, { error: 'Flutterwave could not start checkout. Confirm your test key and try again.' });
    }
  }
  if (method === 'POST' && route === '/api/groups/contribute') {
    const body = await readJson(req);
    const group = db.groups.find((item) => item.id === String(body.groupId));
    if (!group || !group.members.some((member) => member.userId === user.id)) return sendJson(res, 404, { error: 'Group not found for this member.' });
    if (group.members.length < group.capacity) return sendJson(res, 409, { error: `This circle needs ${group.capacity - group.members.length} more member(s) before contributions start.` });
    if (!contributionWindowOpen(group)) return sendJson(res, 409, { error: `Contributions open on ${String(group.nextDueAt).slice(0, 10)}. The circle cannot move to its next cycle early.` });
    if (isContributionRecorded(group.id, user.id, group.currentCycleKey)) return sendJson(res, 409, { error: 'A contribution is already recorded for this cycle.' });
    db.contributions.push({
      id: newId(), groupId: group.id, userId: user.id, memberName: user.name,
      amount: group.contributionAmount, status: 'demo_recorded', cycleKey: group.currentCycleKey,
      dueAt: group.nextDueAt, createdAt: iso(now()), note: 'Local demo ledger only; no payment was initiated.',
    });
    const cycleCompleted = finishCycleIfPaid(group);
    addAudit(user.id, 'contribution.recorded.demo', `Contribution added to ${group.name}.`);
    await saveDb();
    return sendJson(res, 201, { ...bootstrap(user), cycleCompleted });
  }
  if (method === 'POST' && route === '/api/trust/check') {
    const body = await readJson(req);
    const reference = String(body.reference || '').trim().toUpperCase();
    const amount = Number.parseInt(body.amount, 10);
    const verified = user.id === 'u_demo'
      && ((reference === 'TA-SAMPLE-730145' && amount === 30000) || (reference === 'TA-SAMPLE-110948' && amount === 18500));
    addAudit(user.id, verified ? 'trust.check.demo_match' : 'trust.check.demo_unmatched',
      verified ? 'Reference matched fictional sample records.' : 'Reference did not match fictional sample records.');
    await saveDb();
    return sendJson(res, 200, verified
      ? { verified: true, status: 'confirmed_demo', message: 'A matching credit appears in fictional sample data. This does not confirm a real payment.' }
      : { verified: false, status: 'unmatched_demo', message: 'No matching credit was found in fictional sample data. Do not release goods based on a screenshot.' });
  }
  if (method === 'POST' && route === '/api/commerce/checkout') {
    const body = await readJson(req);
    const product = db.products.find((item) => item.id === String(body.productId));
    if (!product) return sendJson(res, 404, { error: 'Product not found.' });
    db.orders.push({ id: newId(), userId: user.id, productId: product.id, productName: product.name, amount: product.price, status: 'demo_ordered', createdAt: iso(now()) });
    addTransaction(user.id, `Sample order: ${product.name}`, 'Marketplace', product.price, 'out', 'demo_only', 'Saved locally; no checkout or payment was made.');
    addAudit(user.id, 'marketplace.order.demo', `Saved a sample order for ${product.name}.`);
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/passport/share') {
    const body = await readJson(req);
    const allowed = user.id === 'u_demo'
      ? new Set(['profile', 'businessActivity', 'incomePattern', 'consistency', 'savingsBehaviour'])
      : new Set(['profile']);
    const scopes = [...new Set((Array.isArray(body.scopes) ? body.scopes : []).filter((scope) => allowed.has(scope)))];
    if (!scopes.length) return sendJson(res, 400, { error: 'Select at least one Passport section.' });
    const token = crypto.randomBytes(32).toString('hex');
    const share = { id: newId(), ownerId: user.id, token, scopes, createdAt: iso(now()), expiresAt: iso(Date.now() + 24 * 60 * 60 * 1000), revokedAt: null };
    db.shares.push(share);
    addAudit(user.id, 'passport.share.created', 'Permission-limited 24-hour link created.');
    await saveDb();
    return sendJson(res, 201, { url: `${BASE_URL}share?token=${encodeURIComponent(token)}`, id: share.id, expiresAt: share.expiresAt });
  }
  if (method === 'POST' && route === '/api/passport/revoke') {
    const body = await readJson(req);
    const share = db.shares.find((item) => item.id === String(body.id) && item.ownerId === user.id);
    if (!share) return sendJson(res, 404, { error: 'Share link not found.' });
    share.revokedAt = iso(now());
    addAudit(user.id, 'passport.share.revoked', 'Passport link revoked.');
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'GET' && route === '/api/audit') {
    const items = db.audit.filter((item) => item.userId === user.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50);
    return sendJson(res, 200, { items });
  }
  return sendJson(res, 404, { error: 'Route not found.' });
}

const server = http.createServer((req, res) => {
  Promise.resolve(handle(req, res)).catch((error) => {
    try {
      fs.appendFileSync(path.join(DATA_DIR, 'server.log'), `${iso(now())} ${error.stack || error.message}${require('node:os').EOL}`);
    } catch {}
    if (res.headersSent) return res.destroy();
    return sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Local server error. See data/server.log.' });
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Trust Ajo may already be running at ${BASE_URL}; close the other server or choose a different PORT.`);
    process.exitCode = 1;
    return;
  }
  console.error('Trust Ajo server error:', error.message);
  process.exitCode = 1;
});

async function main() {
  await initializeDatabase();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Trust Ajo is running at ${BASE_URL}`);
    console.log('Press Ctrl+C to stop the local server.');
  });
}

async function shutdown() {
  server.close(async () => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(async (error) => {
  console.error('Trust Ajo could not start:', error.message);
  process.exit(1);
});
