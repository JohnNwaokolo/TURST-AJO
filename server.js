'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'trust-ajo') : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const BASE_URL = `${(process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`)).replace(/\/+$/, '')}/`;
const STATE_ID = 'main';
const MAX_BODY_BYTES = 1024 * 1024;
const INVITE_CODE_TTL_MS = 10 * 60 * 1000;
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
let initializationPromise;
let supabaseAuthClient;
let saveQueue = Promise.resolve();
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
  const horizon = dayOffset(90, today);
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

function inviteCodeExpiry(from = now()) {
  return iso(new Date(new Date(from).getTime() + INVITE_CODE_TTL_MS));
}

function rotateInviteCode(group) {
  if (group.joinCode) group.lastExpiredJoinCodeHash = hashText(group.joinCode);
  group.joinCode = makeJoinCode();
  group.joinCodeExpiresAt = inviteCodeExpiry();
}

async function rotateExpiredInviteCodes() {
  const currentTime = Date.now();
  let rotated = false;
  for (const group of db.groups) {
    if (!Number.isFinite(Date.parse(group.joinCodeExpiresAt)) || Date.parse(group.joinCodeExpiresAt) <= currentTime) {
      rotateInviteCode(group);
      addAudit(group.ownerId, 'group.invite.expired', `Automatically replaced the expired invite code for ${group.name}.`);
      rotated = true;
    }
  }
  if (rotated) await saveDb();
}

function isExpiredInviteCode(code) {
  const codeHash = hashText(code);
  return db.groups.some((group) => group.lastExpiredJoinCodeHash === codeHash);
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
  group.nextDueAt = iso(nextScheduledDueDate(group.nextDueAt, group.frequency));
  group.currentCycleKey = cycleKey(group.nextDueAt, group.frequency);
  group.lastCompletedCycleKey = cycle;
  const recipientName = group.payoutOrder[0];
  const recipient = group.members.find((member) => member.name === recipientName);
  const payoutAmount = group.contributionAmount * group.members.length;
  if (recipient) {
    const recipientUser = userById(recipient.userId);
    if (recipientUser) {
      recipientUser.walletBalance = Number(recipientUser.walletBalance || 0) + payoutAmount;
      addTransaction(recipient.userId, `Ajo payout · ${group.name}`, 'Ajo payout', payoutAmount, 'in', 'demo_only', 'Sample wallet credit after all group contributions were recorded.');
      db.walletTransactions.push({ id: newId(), userId: recipient.userId, title: `Ajo payout · ${group.name}`, amount: payoutAmount, direction: 'in', fee: 0, kind: 'payout', status: 'demo_only', createdAt: iso(now()) });
    }
  }
  group.payoutTurnsInCurrentRotation = Number(group.payoutTurnsInCurrentRotation || 0) + 1;
  if (group.payoutTurnsInCurrentRotation >= group.members.length) {
    group.completedRotations = Number(group.completedRotations || 0) + 1;
    group.payoutTurnsInCurrentRotation = 0;
    group.memberEndChoices = {};
    group.endDecisionStatus = 'awaiting_members';
  }
  if (group.payoutOrder.length > 1) group.payoutOrder.push(group.payoutOrder.shift());
  return true;
}

function seedDatabase() {
  const today = startOfToday();
  const salt = crypto.randomBytes(16).toString('base64');
  const samplePassword = 'TrustAjoSample2026!';
  const sampleHash = hashPassword(samplePassword, salt);
  const user = {
    id: 'u_demo', name: 'Adaeze Okafor', email: 'adaeze@trustajo.example', salt,
    passwordHash: hashPassword('TrustAjoDemo2026!', salt), passwordAlgorithm: 'sha256',
    businessName: 'Adaeze Market Studio', businessType: 'Fashion & retail', emailVerified: true,
    bvnStatus: 'not_started', ninStatus: 'not_started', monthlyIncomeGoal: 350000,
    walletBalance: 48500, ratingEligibleSince: iso(new Date(Date.now() - 120 * 86400000)),
    preferences: { theme: 'system', contributionReminders: true, weeklyDigest: true, shareAlerts: true },
    createdAt: iso(dayOffset(-120)),
  };
  const scenarioUsers = ['multiple', 'organizer', 'attention'].map((scenario) => ({
    id: `u_demo_${scenario}`,
    name: scenario === 'multiple' ? 'John Olawapamilerin Nwaokolo' : scenario === 'organizer' ? 'Mariam Yusuf' : 'Chidi Okafor',
    email: `demo.${scenario}@trustajo.example`, salt, passwordHash: sampleHash, passwordAlgorithm: 'sha256',
    businessName: '', businessType: '', emailVerified: true, bvnStatus: 'not_started', ninStatus: 'not_started',
    walletBalance: scenario === 'attention' ? 800 : 42000,
    preferences: { theme: 'light', contributionReminders: true, weeklyDigest: true, shareAlerts: true },
    createdAt: iso(dayOffset(scenario === 'multiple' ? -120 : -12)), demoScenario: scenario,
  }));
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
    joinCode: makeJoinCode(), joinCodeExpiresAt: inviteCodeExpiry(),
    frequency: 'Weekly',
    contributionAmount: 25000, capacity: 5, currentCycleKey: cycleKey(today, 'Weekly'),
    nextDueAt: iso(dayOffset(2)),
    payoutOrder: ['Adaeze Okafor', 'Daniel Eze', 'Amaka Bello', 'Tunde Lawal', 'Zainab Yusuf'],
    members: members1, completedRotations: 18, memberEndChoices: { m_daniel: 'leave', m_amaka: 'leave', m_tunde: 'leave', m_zainab: 'leave' }, endDecisionStatus: 'awaiting_members', status: 'active', chat: [{ id: 'seed-chat-1', userId: 'm_daniel', name: 'Daniel Eze', text: 'Please confirm the new due date before we start the next rotation.', createdAt: iso(dayOffset(-1)) }], swapRequests: [{ id: 'seed-swap-1', from: 'Daniel Eze', to: 'Adaeze Okafor', status: 'pending', createdAt: iso(dayOffset(-1)) }],
  };
  const monthlyGroup = {
    id: 'ajo-market-women', ownerId: 'u_demo', name: 'Market Women Ajo Group',
    joinCode: makeJoinCode(), joinCodeExpiresAt: inviteCodeExpiry(),
    frequency: 'Monthly',
    contributionAmount: 15000, capacity: 4, currentCycleKey: cycleKey(today, 'Monthly'),
    nextDueAt: iso(dayOffset(0)),
    payoutOrder: ['Adaeze Okafor', 'Kemi Adebayo', 'Femi Ogun', 'Chisom Obi'],
    members: members2, completedRotations: 4, status: 'active', chat: [],
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
  for (const member of [{ id: 'm_daniel', name: 'Daniel Eze' }, { id: 'm_amaka', name: 'Amaka Bello' }, { id: 'm_tunde', name: 'Tunde Lawal' }, { id: 'm_zainab', name: 'Zainab Yusuf' }]) {
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
  for (const member of [{ id: 'm_kemi', name: 'Kemi Adebayo' }, { id: 'm_femi', name: 'Femi Ogun' }, { id: 'm_chisom', name: 'Chisom Obi' }]) {
    contributions.push({ id: newId(), groupId: monthlyGroup.id, userId: member.id, memberName: member.name,
      amount: 15000, status: 'paid_demo', cycleKey: monthlyGroup.currentCycleKey,
      dueAt: monthlyGroup.nextDueAt, createdAt: iso(dayOffset(0)), note: 'Synthetic current-cycle entry' });
  }

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

  const makeScenarioGroup = (id, ownerId, name, frequency, amount, memberSpecs, dueAt, status = 'active') => ({
    id, ownerId, name, joinCode: makeJoinCode(), joinCodeExpiresAt: inviteCodeExpiry(), frequency,
    contributionAmount: amount, capacity: memberSpecs.length, currentCycleKey: cycleKey(dueAt, frequency),
    nextDueAt: iso(dueAt), payoutOrder: memberSpecs.map((member) => member.name),
    members: memberSpecs.map((member, index) => ({ userId: member.id, name: member.name, role: index === 0 ? 'Organizer' : 'Member' })),
    completedRotations: 0, status, chat: [], swapRequests: [], memberEndChoices: {}, endDecisionStatus: 'active',
  });
  const multipleUser = { id: 'u_demo_multiple', name: 'John Olawapamilerin Nwaokolo' };
  const attentionUser = { id: 'u_demo_attention', name: 'Chidi Okafor' };
  const scenarioGroups = [
    makeScenarioGroup('ajo-multiple-weekly', multipleUser.id, 'Weekend Market Ajo', 'Weekly', 5000, [multipleUser, { id: 'm_daniel', name: 'Daniel Eze' }, { id: 'm_amaka', name: 'Amaka Bello' }], dayOffset(4)),
    makeScenarioGroup('ajo-multiple-monthly', multipleUser.id, 'Family Support Ajo', 'Monthly', 15000, [multipleUser, { id: 'm_femi', name: 'Femi Ogun' }, { id: 'm_kemi', name: 'Kemi Adebayo' }], dayOffset(12)),
    makeScenarioGroup('ajo-multiple-stock', multipleUser.id, 'Small Business Stock Ajo', 'Weekly', 25000, [multipleUser, { id: 'm_tunde', name: 'Tunde Lawal' }, { id: 'm_zainab', name: 'Zainab Yusuf' }], dayOffset(20)),
    makeScenarioGroup('ajo-attention-group', attentionUser.id, 'Chidi’s Starter Ajo', 'Weekly', 10000, [attentionUser, { id: 'm_daniel', name: 'Daniel Eze' }, { id: 'm_amaka', name: 'Amaka Bello' }], dayOffset(-1)),
  ];
  for (const group of scenarioGroups.filter((item) => item.id === 'ajo-attention-group')) {
    for (const member of group.members.slice(1)) contributions.push({ id: newId(), groupId: group.id, userId: member.userId, memberName: member.name, amount: group.contributionAmount, status: 'paid_demo', cycleKey: group.currentCycleKey, dueAt: group.nextDueAt, createdAt: iso(dayOffset(-1)), note: 'Synthetic scenario contribution' });
  }

  return {
    schemaVersion: 3,
    users: [user, ...scenarioUsers, ...members1.map((member) => ({ id: member.userId, name: member.name, email: member.name.toLowerCase().replace(/[^a-z0-9]+/g, '.') + '@trustajo.example', salt, passwordHash: sampleHash, passwordAlgorithm: 'sha256', emailVerified: true, bvnStatus: 'not_started', ninStatus: 'not_started', walletBalance: 0, createdAt: iso(dayOffset(-120)), preferences: { theme: 'light', contributionReminders: true, weeklyDigest: true, shareAlerts: true } })), ...members2.filter((member) => !members1.some((other) => other.userId === member.userId)).map((member) => ({ id: member.userId, name: member.name, email: member.name.toLowerCase().replace(/[^a-z0-9]+/g, '.') + '@trustajo.example', salt, passwordHash: sampleHash, passwordAlgorithm: 'sha256', emailVerified: true, bvnStatus: 'not_started', ninStatus: 'not_started', walletBalance: 0, createdAt: iso(dayOffset(-120)), preferences: { theme: 'light', contributionReminders: true, weeklyDigest: true, shareAlerts: true } }))], sessions: [], groups: [weeklyGroup, monthlyGroup, ...scenarioGroups], contributions, payments: [],
    orders: [], shares: [], audit: [], businessEntries,
    publicOffers: [
      { id: 'offer-demo-organizer', userId: 'u_demo_organizer', authorName: 'Mariam Yusuf', name: 'Starter stock Ajo', amount: 10000, frequency: 'Weekly', duration: 5, capacity: 4, nextDueAt: iso(dayOffset(7)), description: 'Looking for members building a steady savings habit.', interests: ['m_daniel', 'm_amaka'], comments: [], createdAt: iso(dayOffset(-1)) },
      { id: 'offer-market-run', userId: 'm_kemi', name: 'Market stock-up Ajo', amount: 5000, frequency: 'Weekly', duration: 6, capacity: 5, nextDueAt: iso(dayOffset(7)), description: 'Looking for reliable members for six turns. Let us agree terms together.', interests: [], comments: [{ id: 'offer-comment-1', userId: 'm_femi', name: 'Femi Ogun', text: 'Can we keep the due date on Fridays?', createdAt: iso(dayOffset(-1)) }], createdAt: iso(dayOffset(-2)) },
      { id: 'offer-makers', userId: 'm_amaka', name: 'Makers Ajo group', amount: 25000, frequency: 'Monthly', duration: 5, capacity: 5, nextDueAt: iso(dayOffset(14)), description: 'For makers planning business stock purchases.', interests: [], comments: [], createdAt: iso(dayOffset(-1)) },
    ],
    walletTransactions: [
      { id: 'wallet-seed-1', userId: 'u_demo', title: 'Sample wallet opening balance', amount: 48500, direction: 'in', fee: 0, kind: 'seed', status: 'demo_only', createdAt: iso(dayOffset(-3)) },
    ],
    disputes: [], guarantorRequests: [],
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
  const seeded = seedDatabase();
  for (const field of ['users', 'sessions', 'groups', 'contributions', 'payments', 'orders', 'shares', 'audit', 'transactions', 'products', 'businessEntries', 'publicOffers', 'walletTransactions', 'disputes', 'guarantorRequests']) {
    if (!Array.isArray(result[field])) result[field] = ['publicOffers', 'walletTransactions'].includes(field) ? seeded[field] : [];
  }
  for (const member of seeded.users) if (!result.users.some((user) => user.id === member.id)) result.users.push(member);
  if (!result.groups.some((group) => group.id === 'ajo-campus-makers')) result.groups.unshift(seeded.groups[0]);
  if (!result.groups.some((group) => group.id === 'ajo-market-women')) result.groups.push(seeded.groups[1]);
  for (const group of seeded.groups.filter((item) => item.id.startsWith('ajo-multiple-') || item.id === 'ajo-attention-group')) {
    if (!result.groups.some((existing) => existing.id === group.id)) result.groups.push(group);
  }
  for (const offer of seeded.publicOffers.filter((item) => item.id === 'offer-demo-organizer')) {
    if (!result.publicOffers.some((existing) => existing.id === offer.id)) result.publicOffers.push(offer);
  }
  for (const group of result.groups) {
    if (!group.joinCode) group.joinCode = makeJoinCode();
    if (!Number.isFinite(Date.parse(group.joinCodeExpiresAt))) group.joinCodeExpiresAt = iso(new Date(0));
    if (!Array.isArray(group.chat)) group.chat = [];
    if (!Number.isFinite(group.completedRotations)) group.completedRotations = 0;
    if (!group.memberEndChoices) group.memberEndChoices = {};
    if (!group.endDecisionStatus) group.endDecisionStatus = 'active';
    if (!group.status) group.status = 'active';
  }
  for (const member of result.users) if (!Number.isFinite(member.walletBalance)) member.walletBalance = 0;
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

function applyDemoScenario(user, scenario) {
  user.demoScenario = scenario;
  user.walletBalance = scenario === 'member' ? 25000 : scenario === 'attention' ? 800 : 42000;
  if (scenario === 'organizer') db.groups = db.groups.filter((group) => group.sourceOfferId !== 'offer-demo-organizer');
  if (scenario === 'organizer') {
    const offer = db.publicOffers.find((item) => item.id === 'offer-demo-organizer');
    if (offer) { offer.userId = user.id; offer.authorName = user.name; offer.interests = ['m_daniel', 'm_amaka']; offer.formedGroupId = null; }
  }
  if (scenario === 'attention') user.walletBalance = 800;
}

function newSession(userId) {
  // The Vercel prototype uses an in-memory store, so a database-backed session
  // disappears when a request lands on another serverless instance. The sample
  // account is public by design; use a stateless sample-only cookie for it.
  if (userId === 'u_demo' && !supabaseAuthClient) {
    const secure = BASE_URL.startsWith('https://') ? '; Secure' : '';
    return `trustajo_session=trust-ajo-public-demo-v1; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
  }
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
  if (token === 'trust-ajo-public-demo-v1' && !supabaseAuthClient) return userById('u_demo');
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

function bootstrap(user) {
  const mine = db.contributions.filter((row) => row.userId === user.id && ['paid_demo', 'demo_recorded', 'paid'].includes(row.status));
  const businessEntries = db.businessEntries.filter((row) => row.userId === user.id)
    .sort((a, b) => String(b.entryDate).localeCompare(String(a.entryDate)) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const passport = passportFor(user);
  const contributionHistory = mine.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const groups = [];
  for (const group of db.groups) {
    if (!group.members.some((member) => member.userId === user.id)) continue;
    if (user.demoScenario === 'member' && group.id !== 'ajo-campus-makers') continue;
    if (user.demoScenario === 'multiple' && !group.id.startsWith('ajo-multiple-')) continue;
    if (user.demoScenario === 'attention' && group.id !== 'ajo-attention-group') continue;
    const current = db.contributions.filter((row) => row.groupId === group.id && row.cycleKey === group.currentCycleKey);
    const paid = current.filter((row) => ['paid_demo', 'demo_recorded', 'paid'].includes(row.status));
    const mineThisCycle = paid.some((row) => row.userId === user.id);
    groups.push({
      id: group.id, name: group.name, frequency: group.frequency,
      contributionAmount: group.contributionAmount, capacity: group.capacity,
      memberCount: group.members.length, paidThisCycle: paid.length, nextDueAt: group.nextDueAt,
      myContributionStatus: mineThisCycle ? 'recorded' : 'due', payoutOrder: group.payoutOrder, members: group.members,
      chat: group.chat || [], swapRequests: group.swapRequests || [], completedRotations: group.completedRotations || 0,
      memberEndChoices: group.memberEndChoices || {}, endDecisionStatus: group.endDecisionStatus || 'active', status: group.status || 'active',
      joinCode: group.ownerId === user.id ? group.joinCode : null,
      joinCodeExpiresAt: group.ownerId === user.id ? group.joinCodeExpiresAt : null,
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
  const completedEntries = mine.length;
  const ageDays = Math.floor((Date.now() - Date.parse(user.createdAt || now())) / 86400000);
  const ratingEligible = completedEntries >= 20;
  const onTime = mine.filter((row) => !row.dueAt || Date.parse(row.createdAt) <= Date.parse(row.dueAt) + 86400000).length;
  const ratingScore = ratingEligible ? Math.max(3.5, Math.min(5, 3.5 + 1.5 * (onTime / Math.max(1, completedEntries)))) : null;
  return {
    user: publicUser(user), groups, activity: activity.slice(0, 100), products: db.products,
    wallet: { balance: Number(user.walletBalance || 0), transactions: db.walletTransactions.filter((row) => row.userId === user.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12), fees: 'Illustrative sample fees: ₦15 up to ₦10,000; ₦30 up to ₦50,000; ₦50 up to ₦100,000; ₦100 above.' },
    publicOffers: db.publicOffers.map((offer) => ({ ...offer, comments: (offer.comments || []).slice(-12), interested: (offer.interests || []).includes(user.id), isOwner: offer.userId === user.id, author: userById(offer.userId)?.name || offer.authorName || 'Trust Ajo member', interestCount: (offer.interests || []).length })),
    rating: { eligible: user.demoScenario === 'member' ? false : ratingEligible, score: user.demoScenario === 'member' ? null : ratingScore, completedActivity: user.demoScenario === 'member' ? 0 : completedEntries, daysOnApp: ageDays, onTimeCount: onTime, totalCount: completedEntries, note: user.demoScenario === 'member' ? 'New member scenario: participation ratings unlock after 20 recorded contributions.' : ratingEligible ? 'Sample participation signal from recorded Ajo activity.' : 'Available after 20 completed contribution records.' },
    verification: { email: user.emailVerified ? 'verified_demo' : 'not_started', bvn: user.bvnStatus || 'not_started', nin: user.ninStatus || 'not_started', note: 'Mock status only. Do not enter real identity numbers or upload real documents.' },
    disputes: db.disputes.filter((item) => item.reporterId === user.id || item.reportedUserId === user.id),
    guarantorCandidates: db.users.filter((candidate) => candidate.id.startsWith('u_demo_') && candidate.id !== user.id).map((candidate) => ({ id: candidate.id, name: candidate.name })),
    guarantorRequests: db.guarantorRequests.filter((item) => item.memberUserId === user.id || item.guarantorUserId === user.id).map((item) => ({
      id: item.id, groupId: item.groupId, groupName: db.groups.find((group) => group.id === item.groupId)?.name || 'Ajo group',
      memberName: userById(item.memberUserId)?.name || 'Sample member', guarantorName: userById(item.guarantorUserId)?.name || 'Sample guarantor',
      maxLiability: item.maxLiability, durationLabel: item.durationLabel, status: item.status,
      incoming: item.guarantorUserId === user.id,
    })),
    businessEntries,
    shares, audit, demoMode: true, storageMode: supabaseClient ? 'supabase' : 'local-memory',
    paymentMode: 'simulated-wallet', generatedAt: iso(now()),
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
  await rotateExpiredInviteCodes();

  if (method === 'GET' && (route === '/' || route === '/share')) {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }
  if (method === 'GET' && route === '/app.js') {
    return sendText(res, fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (method === 'GET' && route === '/supabase.js') {
    return sendText(res, fs.readFileSync(path.join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'), 'utf8'), 'text/javascript; charset=utf-8');
  }
  if (method === 'GET' && route === '/api/supabase-js') {
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
      payments: 'simulated-wallet',
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
  if ((method === 'GET' && route === '/payments/flutterwave/callback')
    || (method === 'POST' && route === '/api/payments/flutterwave/webhook')) {
    return sendJson(res, 410, { error: 'External payment processing is disabled in the simulated-wallet prototype.' });
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
    const body = await readJson(req);
    const scenario = ['member', 'multiple', 'organizer', 'attention'].includes(String(body.scenario)) ? String(body.scenario) : 'member';
    const user = userById(scenario === 'member' ? 'u_demo' : `u_demo_${scenario}`) || userById('u_demo');
    applyDemoScenario(user, scenario);
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
  if (method === 'POST' && route === '/api/guarantors/demo/request') {
    const body = await readJson(req);
    const group = db.groups.find((item) => item.id === String(body.groupId || '') && item.members.some((member) => member.userId === user.id));
    const guarantorUser = userById(String(body.guarantorUserId || ''));
    const maxLiability = Number(body.maxLiability);
    const maxExposure = group ? Number(group.contributionAmount) * Number(group.capacity) : 0;
    if (!group) return sendJson(res, 404, { error: 'Choose an Ajo group you belong to.' });
    if (!guarantorUser || !guarantorUser.id.startsWith('u_demo_') || guarantorUser.id === user.id) return sendJson(res, 400, { error: 'Choose another sample account to review this request.' });
    if (body.termsAcknowledged !== 'on') return sendJson(res, 400, { error: 'Confirm that you understand this is a sample request.' });
    if (!Number.isSafeInteger(maxLiability) || maxLiability < 500 || maxLiability > maxExposure) return sendJson(res, 400, { error: `Set a sample maximum between ₦500 and ${new Intl.NumberFormat('en-NG').format(maxExposure)}.` });
    if (db.guarantorRequests.some((item) => item.memberUserId === user.id && item.guarantorUserId === guarantorUser.id && item.groupId === group.id && item.status === 'pending_demo')) return sendJson(res, 409, { error: 'There is already a pending sample request for this person and group.' });
    db.guarantorRequests.push({ id: `guar-${newId().slice(0, 12)}`, groupId: group.id, memberUserId: user.id, guarantorUserId: guarantorUser.id, maxLiability, durationLabel: `Up to ${group.capacity} group turns`, status: 'pending_demo', createdAt: iso(now()), updatedAt: iso(now()) });
    addAudit(user.id, 'guarantor.request.demo', `Sample guarantor request sent for ${group.name}; no legal obligation or money movement.`);
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/guarantors/demo/respond') {
    const body = await readJson(req);
    const request = db.guarantorRequests.find((item) => item.id === String(body.requestId || '') && item.guarantorUserId === user.id);
    const decision = String(body.decision || '');
    if (!request) return sendJson(res, 404, { error: 'Sample guarantor request not found for this account.' });
    if (request.status !== 'pending_demo') return sendJson(res, 409, { error: 'This sample request has already been answered.' });
    if (!['accepted', 'declined'].includes(decision)) return sendJson(res, 400, { error: 'Choose accept or decline.' });
    request.status = `${decision}_demo`;
    request.updatedAt = iso(now());
    addAudit(user.id, `guarantor.${decision}.demo`, `Sample request ${request.id} marked ${decision}; no legal obligation was created.`);
    addAudit(request.memberUserId, `guarantor.${decision}.demo`, `The sample guarantor marked request ${request.id} ${decision}.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/wallet/move') {
    const body = await readJson(req);
    const kind = String(body.kind || '');
    const amount = Number(body.amount);
    if (!['deposit', 'withdraw'].includes(kind) || !Number.isSafeInteger(amount) || amount < 500 || amount > 1000000) return sendJson(res, 400, { error: 'Choose a sample deposit or withdrawal from ₦500 to ₦1,000,000.' });
    const fee = amount <= 10000 ? 15 : amount <= 50000 ? 30 : amount <= 100000 ? 50 : 100;
    const total = amount + (kind === 'deposit' ? fee : 0);
    if (kind === 'withdraw' && Number(user.walletBalance || 0) < amount + fee) return sendJson(res, 409, { error: 'Wallet balance does not cover this withdrawal and sample fee.' });
    user.walletBalance = Number(user.walletBalance || 0) + (kind === 'deposit' ? amount : -amount - fee);
    const row = { id: newId(), userId: user.id, title: kind === 'deposit' ? 'Sample wallet deposit' : 'Sample wallet withdrawal', amount, direction: kind === 'deposit' ? 'in' : 'out', fee, kind, status: 'demo_only', createdAt: iso(now()) };
    db.walletTransactions.push(row);
    addAudit(user.id, `wallet.${kind}.demo`, `${kind} of ₦${amount} with illustrative ₦${fee} service fee; no funds moved.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/community/offers/create') {
    const body = await readJson(req);
    const amount = Number(body.amount), capacity = Number(body.capacity), duration = Number(body.duration);
    const frequency = String(body.frequency || '');
    const name = String(body.name || '').trim(), description = String(body.description || '').trim();
    if (name.length < 4 || name.length > 70 || !Number.isSafeInteger(amount) || amount < 1000 || amount > 1000000 || !Number.isSafeInteger(capacity) || capacity < 3 || capacity > 20 || !Number.isSafeInteger(duration) || duration < 2 || duration > 52 || !['Weekly', 'Monthly'].includes(frequency) || description.length > 240) return sendJson(res, 400, { error: 'Enter an offer name, amount, weekly or monthly frequency, 2–52 turns, 3–20 seats and a short description.' });
    db.publicOffers.unshift({ id: `offer-${newId().slice(0, 8)}`, userId: user.id, name, amount, frequency, duration, capacity, nextDueAt: String(body.nextDueAt || iso(dayOffset(7))), description, interests: [], comments: [], createdAt: iso(now()) });
    addAudit(user.id, 'community.offer.created', `Posted public Ajo offer: ${name}.`);
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/community/offers/comment') {
    const body = await readJson(req), offer = db.publicOffers.find((item) => item.id === String(body.offerId));
    const text = String(body.text || '').trim();
    if (!offer) return sendJson(res, 404, { error: 'Community offer not found.' });
    if (text.length < 1 || text.length > 240) return sendJson(res, 400, { error: 'Comments must be 1–240 characters.' });
    offer.comments.push({ id: newId(), userId: user.id, name: user.name, text, createdAt: iso(now()) });
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/community/offers/interest') {
    const body = await readJson(req), offer = db.publicOffers.find((item) => item.id === String(body.offerId));
    if (!offer) return sendJson(res, 404, { error: 'Community offer not found.' });
    if (offer.userId === user.id) return sendJson(res, 409, { error: 'You posted this offer.' });
    if (!Array.isArray(offer.interests)) offer.interests = [];
    if (offer.interests.includes(user.id)) offer.interests = offer.interests.filter((id) => id !== user.id);
    else if (offer.interests.length < offer.capacity - 1) offer.interests.push(user.id);
    else return sendJson(res, 409, { error: 'This offer has no more available interest spots.' });
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/community/offers/form-group') {
    const body = await readJson(req), offer = db.publicOffers.find((item) => item.id === String(body.offerId));
    if (!offer || offer.userId !== user.id) return sendJson(res, 404, { error: 'Only the offer author can form the private Ajo group.' });
    if (offer.formedGroupId) return sendJson(res, 409, { error: 'This offer has already formed a private Ajo group.' });
    const interestedUsers = (offer.interests || []).map(userById).filter(Boolean).slice(0, offer.capacity - 1);
    const frequency = offer.frequency, firstDueAt = parseDueDate(String(offer.nextDueAt).slice(0, 10)) || dayOffset(frequency === 'Weekly' ? 7 : 30);
    const members = [{ userId: user.id, name: user.name, role: 'Organizer' }, ...interestedUsers.map((member) => ({ userId: member.id, name: member.name, role: 'Member' }))];
    const group = { id: `ajo-${newId().slice(0, 8)}`, ownerId: user.id, sourceOfferId: offer.id, name: offer.name, joinCode: makeJoinCode(), joinCodeExpiresAt: inviteCodeExpiry(), frequency, contributionAmount: offer.amount, capacity: offer.capacity, currentCycleKey: cycleKey(firstDueAt, frequency), nextDueAt: iso(firstDueAt), payoutOrder: members.map((member) => member.name), members, completedRotations: 0, status: 'active', chat: [], memberEndChoices: {}, endDecisionStatus: 'active' };
    db.groups.push(group);
    offer.formedGroupId = group.id;
    addAudit(user.id, 'community.offer.group_formed', `Formed a private Ajo group from ${offer.name}.`);
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/chat') {
    const body = await readJson(req), group = db.groups.find((item) => item.id === String(body.groupId));
    const text = String(body.text || '').trim();
    if (!group || !group.members.some((member) => member.userId === user.id)) return sendJson(res, 404, { error: 'Private Ajo group not found.' });
    if (!text || text.length > 500) return sendJson(res, 400, { error: 'Messages must be 1–500 characters.' });
    group.chat.push({ id: newId(), userId: user.id, name: user.name, text, createdAt: iso(now()) });
    group.chat = group.chat.slice(-100);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/swap') {
    const body = await readJson(req), group = db.groups.find((item) => item.id === String(body.groupId));
    const from = String(body.from || ''), to = String(body.to || '');
    if (!group || !group.members.some((member) => member.userId === user.id) || !group.payoutOrder.includes(from) || !group.payoutOrder.includes(to) || from === to || (body.accept ? to !== user.name || from === user.name : from !== user.name)) return sendJson(res, 400, { error: 'Choose your payout turn and another member in your Ajo group.' });
    if (!Array.isArray(group.swapRequests)) group.swapRequests = [];
    const pending = group.swapRequests.find((item) => item.status === 'pending' && item.from === from && item.to === to);
    if (body.accept) {
      if (!pending || !group.members.some((member) => member.userId === user.id && member.name === to)) return sendJson(res, 404, { error: 'No matching swap request to accept.' });
      const a = group.payoutOrder.indexOf(from), b = group.payoutOrder.indexOf(to);
      [group.payoutOrder[a], group.payoutOrder[b]] = [group.payoutOrder[b], group.payoutOrder[a]];
      pending.status = 'accepted'; pending.respondedAt = iso(now());
    } else {
      if (!group.members.some((member) => member.name === to)) return sendJson(res, 404, { error: 'The selected member is not in this group.' });
      group.swapRequests.push({ id: newId(), from, to, status: 'pending', createdAt: iso(now()) });
    }
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/end-choice') {
    const body = await readJson(req), group = db.groups.find((item) => item.id === String(body.groupId));
    const choice = String(body.choice || '');
    if (!group || !group.members.some((member) => member.userId === user.id) || !['continue', 'replace', 'leave'].includes(choice)) return sendJson(res, 400, { error: 'Choose continue, find replacements, or leave for your Ajo group.' });
    if (group.status === 'ended' || group.status === 'recruiting') return sendJson(res, 409, { error: 'This Ajo group is not collecting rotation choices right now.' });
    if (group.memberEndChoices?.[user.id]) return sendJson(res, 409, { error: 'Your rotation choice is already recorded.' });
    group.memberEndChoices[user.id] = choice;
    if (group.members.every((member) => group.memberEndChoices[member.userId])) {
      const choices = new Set(Object.values(group.memberEndChoices));
      const leaving = group.members.filter((member) => group.memberEndChoices[member.userId] === 'leave');
      if (leaving.length === group.members.length) {
        group.endDecisionStatus = 'ended'; group.status = 'ended';
      } else if (leaving.length) {
        const leavingIds = new Set(leaving.map((member) => member.userId));
        group.members = group.members.filter((member) => !leavingIds.has(member.userId));
        group.payoutOrder = group.payoutOrder.filter((name) => group.members.some((member) => member.name === name));
        group.endDecisionStatus = 'recruiting'; group.status = 'recruiting';
      } else if (choices.size === 1 && choices.has('continue')) {
        group.endDecisionStatus = 'active'; group.status = 'active'; group.memberEndChoices = {};
      } else group.endDecisionStatus = 'needs_discussion';
    } else group.endDecisionStatus = 'awaiting_members';
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/disputes/demo') {
    const body = await readJson(req), group = db.groups.find((item) => item.id === String(body.groupId));
    if (!group || !group.members.some((member) => member.userId === user.id)) return sendJson(res, 404, { error: 'Ajo group not found.' });
    const reportedUser = group.members.find((member) => member.userId === String(body.reportedUserId));
    if (!reportedUser || reportedUser.userId === user.id) return sendJson(res, 400, { error: 'Choose another member from this group.' });
    const dispute = { id: newId(), reporterId: user.id, reportedUserId: reportedUser.userId, groupId: group.id, reason: 'Sample missed-payment report', status: 'demo_review', evidenceNote: String(body.evidenceNote || '').slice(0, 240), createdAt: iso(now()) };
    db.disputes.push(dispute);
    addAudit(user.id, 'dispute.demo_created', 'Sample non-payment report; no identity provider was contacted.');
    await saveDb();
    return sendJson(res, 201, bootstrap(user));
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
      joinCode: makeJoinCode(), joinCodeExpiresAt: inviteCodeExpiry(), frequency, contributionAmount: amount, capacity, status: 'active',
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
    rotateInviteCode(group);
    addAudit(user.id, 'group.invite.rotated', `Changed the invite code for ${group.name}.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'GET' && route === '/api/groups/invite') {
    if (!allowRequest(req, 'invite-lookup', 20, 15 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many invite checks. Wait a few minutes, then try again.' });
    const joinCode = String(url.searchParams.get('code') || '').trim().toUpperCase();
    const group = db.groups.find((item) => item.joinCode === joinCode);
    if (!group) return sendJson(res, isExpiredInviteCode(joinCode) ? 410 : 404, { error: isExpiredInviteCode(joinCode) ? 'That invite code expired. Ask the organizer for the current code.' : 'That invite code was not found. Check it with the circle organizer.' });
    if (group.members.some((member) => member.userId === user.id)) return sendJson(res, 409, { error: 'You already belong to this circle.' });
    if (group.members.length >= group.capacity) return sendJson(res, 409, { error: 'This circle is full.' });
    const conflict = scheduleClash(user.id, group);
    return sendJson(res, 200, {
      group: {
        id: group.id, name: group.name, frequency: group.frequency,
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
    if (!group) return sendJson(res, isExpiredInviteCode(joinCode) ? 410 : 404, { error: isExpiredInviteCode(joinCode) ? 'That invite code expired. Ask the organizer for the current code.' : 'That invite code was not found. Check it with the circle organizer.' });
    if (group.status === 'ended') return sendJson(res, 410, { error: 'This Ajo group has ended.' });
    if (group.members.some((member) => member.userId === user.id)) return sendJson(res, 409, { error: 'You already belong to this circle.' });
    if (group.members.length >= group.capacity) return sendJson(res, 409, { error: 'This circle is full.' });
    const conflict = scheduleClash(user.id, group);
    if (conflict) return sendJson(res, 409, { error: `Schedule clash: ${group.name} and ${conflict.groupName} are both due on ${conflict.date}. Ask an organizer to agree a different date before joining.` });
    group.members.push({ userId: user.id, name: user.name, role: 'Member' });
    group.payoutOrder.push(user.name);
    if (group.status === 'recruiting' && group.members.length === group.capacity) {
      group.status = 'active'; group.endDecisionStatus = 'active'; group.memberEndChoices = {};
    }
    addAudit(user.id, 'group.joined', `Joined ${group.name} using an invite code.`);
    await saveDb();
    return sendJson(res, 200, bootstrap(user));
  }
  if (method === 'POST' && route === '/api/groups/pay') {
    return sendJson(res, 410, { error: 'Hosted payment checkout is disabled in this prototype. Use the simulated wallet contribution flow.' });
  }
  if (method === 'POST' && route === '/api/groups/contribute') {
    const body = await readJson(req);
    const group = db.groups.find((item) => item.id === String(body.groupId));
    if (!group || !group.members.some((member) => member.userId === user.id)) return sendJson(res, 404, { error: 'Group not found for this member.' });
    if (group.status === 'ended') return sendJson(res, 409, { error: 'This Ajo group has ended.' });
    if (group.members.length < group.capacity) return sendJson(res, 409, { error: `This circle needs ${group.capacity - group.members.length} more member(s) before contributions start.` });
    if (!contributionWindowOpen(group)) return sendJson(res, 409, { error: `Contributions open on ${String(group.nextDueAt).slice(0, 10)}. The circle cannot move to its next cycle early.` });
    if (isContributionRecorded(group.id, user.id, group.currentCycleKey)) return sendJson(res, 409, { error: 'A contribution is already recorded for this cycle.' });
    if (Number(user.walletBalance || 0) < group.contributionAmount) return sendJson(res, 409, { error: 'Wallet balance is too low. Add sample funds before recording this Ajo contribution.' });
    user.walletBalance -= group.contributionAmount;
    db.walletTransactions.push({ id: newId(), userId: user.id, title: `Ajo contribution · ${group.name}`, amount: group.contributionAmount, direction: 'out', fee: 0, kind: 'contribution', status: 'demo_only', createdAt: iso(now()) });
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

async function initializeOnce() {
  if (!initializationPromise) initializationPromise = initializeDatabase();
  return initializationPromise;
}

async function vercelHandler(req, res) {
  try {
    await initializeOnce();
    server.emit('request', req, res);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    return sendJson(res, 500, { error: 'Trust Ajo could not initialize.' });
  }
}

async function main() {
  await initializeOnce();
  const inviteRotationTimer = setInterval(() => {
    rotateExpiredInviteCodes().catch((error) => console.error('Invite code rotation failed:', error.message));
  }, 10000);
  inviteRotationTimer.unref();
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

if (require.main === module) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  main().catch(async (error) => {
    console.error('Trust Ajo could not start:', error.message);
    process.exit(1);
  });
}

module.exports = vercelHandler;
module.exports.handle = handle;
module.exports.initializeOnce = initializeOnce;
