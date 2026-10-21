const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');
const Settings = require('./models/Settings');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ DATABASE CONNECTION ============
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 30000, socketTimeoutMS: 45000,
  maxPoolSize: 10, minPoolSize: 2, retryWrites: true, retryReads: true
}).then(() => console.log('✅ MongoDB Connected')).catch(err => console.error('❌ MongoDB Error:', err.message));

mongoose.connection.on('disconnected', () => {
  setTimeout(() => { mongoose.connect(process.env.MONGO_URI).catch(err => console.error('Reconnect failed:', err.message)); }, 5000);
});

// ============ PLAN CONFIG ============
const DEFAULT_PLANS = {
  demo: { id: 'demo', name: 'Demo', price: 0, period: 'Forever', rate: 0.025, dailyLimit: 50, features: ['✅ 50 captchas daily', '💰 ₹0.025 per captcha', '🎯 Basic practice', '📊 Daily activity tracking'], isDemo: true },
  silver: { id: 'silver', name: 'Silver', price: 90, period: 'month', rate: 0.025, dailyLimit: 1000, features: ['✅ 1000 captchas daily', '💰 ₹0.025 per captcha', '⚡ Priority support', '🚀 Fast processing', '📊 Advanced dashboard'] },
  gold: { id: 'gold', name: 'Gold', price: 199, period: 'month', rate: 0.050, dailyLimit: 99999, features: ['♾️ Unlimited captchas', '💰 2x earning (₹0.05)', '⚡ Priority support', '🚀 Fast processing', '📊 Advanced dashboard'], popular: true },
  platinum: { id: 'platinum', name: 'Platinum', price: 500, period: 'month', rate: 0.10, dailyLimit: 99999, features: ['♾️ Unlimited captchas', '💰 4x earning (₹0.10)', '⚡ 24/7 priority support', '🚀 Instant processing', '📊 Advanced analytics', '🎁 Daily bonus ₹5', '💎 Exclusive badges'] }
};
const MIN_WITHDRAWAL = 100;

// ============ HELPERS ============
async function getPlans() { try { const p = await Settings.findOne({ key: 'plans' }); if (p && p.value) return p.value; await Settings.findOneAndUpdate({ key: 'plans' }, { value: DEFAULT_PLANS }, { upsert: true }); return DEFAULT_PLANS; } catch (e) { return DEFAULT_PLANS; } }
async function checkAndUpdateSubscription(user) { if (user.plan === 'demo' || user.plan === 'free') return user; if (!user.planEndDate) return user; const now = new Date(); if (now > new Date(user.planEndDate)) { user.plan = 'demo'; user.planStartDate = null; user.planEndDate = null; user.subscriptionExpired = true; await user.save(); } return user; }
async function getUserRate(user) { const p = await getPlans(); const isD = user.plan === 'demo' || user.plan === 'free'; if (isD) return p.demo?.rate || 0.025; return p[user.plan]?.rate || 0.025; }
async function getUserDailyLimit(user) { const p = await getPlans(); const isD = user.plan === 'demo' || user.plan === 'free'; if (isD) return p.demo?.dailyLimit || 50; return p[user.plan]?.dailyLimit || 50; }

// ============ RATE LIMITING ============
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: 'Too many requests.' } });
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many attempts. Please wait 1 minute.' } });
const captchaLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, message: { error: 'Slow down!' } });

app.use('/api/', generalLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/submit-captcha', captchaLimiter);

// ============ AUTH MIDDLEWARE ============
function authUser(req, res, next) { const token = req.headers['authorization']?.split(' ')[1]; if (!token) return res.status(401).json({ error: 'Token missing' }); try { const d = jwt.verify(token, process.env.JWT_SECRET); req.userId = d.userId; next(); } catch { return res.status(401).json({ error: 'Invalid token' }); } }
function authAdmin(req, res, next) { const { username, password } = req.headers; if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) return next(); return res.status(401).json({ error: 'Invalid admin credentials' }); }

// ============ PUBLIC ROUTES ============
app.get('/', (req, res) => res.json({ status: 'API running ✅' }));
app.get('/api/settings/public', async (req, res) => { try { const m = await Settings.findOne({ key: 'marquee' }); const a = await Settings.findOne({ key: 'ads' }); const p = await getPlans(); res.json({ marquee: m ? m.value : '', ads: a ? a.value : [], plans: p }); } catch (e) { res.json({ marquee: '', ads: [], plans: DEFAULT_PLANS }); } });
app.get('/api/plans', async (req, res) => { try { const p = await getPlans(); res.json({ plans: Object.values(p) }); } catch (e) { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/payment-settings', async (req, res) => { try { const s = await Settings.findOne({ key: 'payment' }); res.json(s ? s.value : { upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' }); } catch (e) { res.json({ upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' }); } });

// ============ USER ROUTES ============
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, password, whatsapp, payment } = req.body;
    if (!name || name.length < 3) return res.status(400).json({ error: 'Valid naam daalein' });
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Mobile 10 digits' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (!/^\d{10}$/.test(whatsapp)) return res.status(400).json({ error: 'WhatsApp 10 digits' });
    if (!payment || !payment.type || !payment.value) return res.status(400).json({ error: 'Payment missing' });
    if (await User.findOne({ mobile })) return res.status(400).json({ error: 'Mobile pehle se registered hai' });
    const user = await User.create({ name, mobile, whatsapp, payment, password: await bcrypt.hash(password, 10), status: 'pending', plan: 'demo' });
    res.json({ success: true, message: 'Registration successful!', userId: user._id });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Valid mobile daalein' });
    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).json({ error: 'Invalid mobile ya password' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid mobile ya password' });
    if (user.status === 'disqualified') return res.status(403).json({ error: 'Account disqualified' });
    await checkAndUpdateSubscription(user);
    const today = new Date().toDateString();
    if (!user.lastActive || new Date(user.lastActive).toDateString() !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      user.streak = (user.lastActive && new Date(user.lastActive).toDateString() === yesterday) ? (user.streak || 0) + 1 : 1;
      user.lastActive = new Date(); await user.save();
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
    res.json({ success: true, token, user: { id: user._id, name: user.name, mobile: user.mobile, status: user.status, plan: user.plan, planEndDate: user.planEndDate, subscriptionExpired: user.subscriptionExpired || false, currentRate: await getUserRate(user), dailyLimit: await getUserDailyLimit(user), totalSolved: user.totalSolved, totalCorrect: user.totalCorrect, totalWrong: user.totalWrong, totalEarned: user.totalEarned, totalWithdrawn: user.totalWithdrawn, pendingWithdrawal: user.pendingWithdrawal, streak: user.streak } });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/profile', authUser, async (req, res) => {
  try {
    let user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const wasExpired = user.plan !== 'demo' && user.plan !== 'free' && user.planEndDate && new Date() > new Date(user.planEndDate);
    await checkAndUpdateSubscription(user);
    const userObj = user.toObject();
    userObj.isPremium = user.plan !== 'demo' && user.plan !== 'free' && (!user.planEndDate || new Date() < new Date(user.planEndDate));
    userObj.currentRate = await getUserRate(user); userObj.dailyLimit = await getUserDailyLimit(user);
    userObj.subscriptionExpired = wasExpired || user.subscriptionExpired || false;
    const today = new Date().toISOString().split('T')[0];
    const todayRec = (user.history || []).find(h => h.date === today);
    userObj.todaySolved = todayRec ? todayRec.solved : 0;
    userObj.remaining = Math.max(0, userObj.dailyLimit - userObj.todaySolved);
    const plans = await getPlans(); userObj.planFeatures = plans[user.plan]?.features || [];
    res.json(userObj);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/submit-captcha', authUser, async (req, res) => {
  try {
    const { userAnswer, correctAnswer } = req.body;
    let user = await User.findById(req.userId);
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Account approve nahi hua' });
    const wasExpired = user.plan !== 'demo' && user.plan !== 'free' && user.planEndDate && new Date() > new Date(user.planEndDate);
    await checkAndUpdateSubscription(user);
    if (wasExpired) return res.status(403).json({ error: 'Subscription expired', subscriptionExpired: true });
    const plans = await getPlans(); const userPlan = plans[user.plan] || plans.demo;
    const today = new Date().toISOString().split('T')[0];
    if (user.todayResetDate !== today) { user.todayCaptchas = 0; user.todayResetDate = today; }
    if (user.todayCaptchas >= userPlan.dailyLimit) return res.status(429).json({ error: `Daily limit reached!`, limitReached: true });
    const isCorrect = String(userAnswer).trim().toUpperCase() === String(correctAnswer).trim().toUpperCase();
    user.totalSolved++; user.todayCaptchas++; if (isCorrect) user.totalCorrect++; else user.totalWrong++;
    let dayRec = user.history.find(h => h.date === today);
    if (!dayRec) { dayRec = { date: today, solved: 0, correct: 0, wrong: 0, earned: 0, bonus: 0 }; user.history.push(dayRec); }
    dayRec.solved++;
    if (isCorrect) { dayRec.correct++; dayRec.earned += userPlan.rate; user.totalEarned += userPlan.rate; } else { dayRec.wrong++; }
    await user.save();
    res.json({ success: true, correct: isCorrect, correctAnswer, rate: userPlan.rate, totalSolved: user.totalSolved, totalCorrect: user.totalCorrect, totalWrong: user.totalWrong, totalEarned: parseFloat(user.totalEarned.toFixed(3)), todayEarned: parseFloat(dayRec.earned.toFixed(3)), todaySolved: dayRec.solved, todayCaptchas: user.todayCaptchas, dailyLimit: userPlan.dailyLimit, remaining: Math.max(0, userPlan.dailyLimit - user.todayCaptchas), plan: user.plan });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/purchase-premium', authUser, async (req, res) => {
  try {
    const { planId } = req.body; const plans = await getPlans();
    if (!plans[planId] || planId === 'demo' || planId === 'free') return res.status(400).json({ error: 'Invalid plan' });
    const user = await User.findById(req.userId);
    user.pendingPlan = planId; user.pendingPlanRequestedAt = new Date(); await user.save();
    res.json({ success: true, message: `Request pending admin approval.`, planId, planName: plans[planId].name, price: plans[planId].price });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/mark-payment-done', authUser, async (req, res) => {
  try { const user = await User.findById(req.userId); if (!user) return res.status(404).json({ error: 'User not found' }); user.paymentMarked = true; user.paymentMarkedAt = new Date(); await user.save(); res.json({ success: true, message: 'Payment marked. Send screenshot on WhatsApp.' }); } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/withdraw', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || user.status !== 'approved') return res.status(403).json({ error: 'Account approved nahi hai' });
    const requestedAmount = parseFloat(req.body.amount);
    if (!requestedAmount || requestedAmount <= 0) return res.status(400).json({ error: 'Valid amount daalein' });
    const availableBalance = user.totalEarned - user.totalWithdrawn - user.pendingWithdrawal;
    if (requestedAmount < MIN_WITHDRAWAL) return res.status(400).json({ error: `Minimum ₹${MIN_WITHDRAWAL} chahiye.` });
    if (requestedAmount > availableBalance) return res.status(400).json({ error: `Amount exceeds available balance (₹${availableBalance.toFixed(3)})` });
    if (await Withdrawal.findOne({ userId: user._id, status: 'pending' })) return res.status(400).json({ error: 'Ek withdrawal pehle se pending hai' });
    const withdrawal = await Withdrawal.create({ userId: user._id, userName: user.name, userMobile: user.mobile, amount: requestedAmount, paymentType: user.payment.type, paymentValue: user.payment.value, bankDetails: user.payment.bank, status: 'pending' });
    user.pendingWithdrawal = parseFloat(((user.pendingWithdrawal || 0) + requestedAmount).toFixed(3)); await user.save();
    res.json({ success: true, message: `₹${requestedAmount} withdrawal request submit ho gayi`, withdrawal, availableBalance: parseFloat((availableBalance - requestedAmount).toFixed(3)) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/my-withdrawals', authUser, async (req, res) => { try { res.json(await Withdrawal.find({ userId: req.userId }).sort({ requestedAt: -1 })); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

// ============ ADMIN ROUTES ============
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/users', authAdmin, async (req, res) => { try { res.json(await User.find().select('-password').sort({ registeredAt: -1 })); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/admin/pending-plans', authAdmin, async (req, res) => { try { res.json(await User.find({ pendingPlan: { $ne: null } }).select('-password').sort({ pendingPlanRequestedAt: -1 })); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

app.get('/api/admin/plans', authAdmin, async (req, res) => {
  try { let setting = await Settings.findOne({ key: 'plans' }); if (!setting || !setting.value) setting = await Settings.findOneAndUpdate({ key: 'plans' }, { key: 'plans', value: DEFAULT_PLANS }, { upsert: true, new: true }); res.json({ success: true, plans: setting.value }); } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/update-plans', authAdmin, async (req, res) => {
  try {
    let { plans } = req.body; if (!plans) return res.status(400).json({ error: 'plans required' });
    let plansObj = {}; if (Array.isArray(plans)) { plans.forEach(p => { plansObj[p.id] = p; }); } else { plansObj = plans; }
    const required = ['demo', 'silver', 'gold', 'platinum'];
    if (required.some(pid => !plansObj[pid])) return res.status(400).json({ error: `All 4 plans required.` });
    for (const pid of required) { if (!plansObj[pid].name || plansObj[pid].rate == null || plansObj[pid].dailyLimit == null) return res.status(400).json({ error: `${pid} invalid` }); }
    await Settings.findOneAndUpdate({ key: 'plans' }, { key: 'plans', value: plansObj }, { upsert: true, new: true });
    res.json({ success: true, message: 'Plans updated!', plans: plansObj });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/approve-plan/:id', authAdmin, async (req, res) => {
  try {
    const { planId } = req.body; const plans = await getPlans();
    if (!plans[planId] || planId === 'demo' || planId === 'free') return res.status(400).json({ error: 'Invalid plan' });
    const user = await User.findById(req.params.id); if (!user) return res.status(404).json({ error: 'User not found' });
    const now = new Date(); let startFrom = now;
    if (user.plan === planId && user.planEndDate && new Date(user.planEndDate) > now) startFrom = new Date(user.planEndDate);
    user.plan = planId; user.planStartDate = now; user.planEndDate = new Date(startFrom.getTime() + 30 * 24 * 60 * 60 * 1000); user.planApprovedAt = now; user.pendingPlan = null; user.paymentMarked = false; user.subscriptionExpired = false; user.totalPaidForPremium = (user.totalPaidForPremium || 0) + plans[planId].price;
    await user.save(); res.json({ success: true, message: `${plans[planId].name} activated!` });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/reject-plan/:id', authAdmin, async (req, res) => {
  try { const user = await User.findById(req.params.id); if (!user) return res.status(404).json({ error: 'User not found' }); user.pendingPlan = null; user.paymentMarked = false; await user.save(); res.json({ success: true, message: 'Plan rejected' }); } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/set-plan/:id', authAdmin, async (req, res) => {
  try {
    const { plan } = req.body; const plans = await getPlans(); if (!plans[plan]) return res.status(400).json({ error: 'Invalid plan' });
    const now = new Date(); const isDemo = plan === 'demo' || plan === 'free'; const endDate = isDemo ? null : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const user = await User.findByIdAndUpdate(req.params.id, { plan, planStartDate: isDemo ? null : now, planEndDate: endDate, subscriptionExpired: false }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// 🔥 ADMIN: ADD BONUS (Har baar alag entry banega)
app.post('/api/admin/add-bonus/:id', authAdmin, async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const bonusAmount = parseFloat(amount);
    if (!bonusAmount || bonusAmount <= 0) return res.status(400).json({ error: 'Invalid bonus amount' });
    if (bonusAmount > 10000) return res.status(400).json({ error: 'Max ₹10,000' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.totalEarned = parseFloat(((user.totalEarned || 0) + bonusAmount).toFixed(3));
    
    // 🔥 NAYA LOGIC: Har bonus ke liye ek NAYA record banega, purane din ka data change nahi hoga
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    
    // Alag entry banao dashboard pe dikhane ke liye
    user.history.push({
      date: `${dateStr} (${timeStr})`, // Date + Time dikhega
      solved: 0, correct: 0, wrong: 0,
      earned: bonusAmount, // Sirf bonus amount
      bonus: bonusAmount,  // Bonus flag
      isBonusEntry: true   // Taaki pata chale ye sirf bonus hai
    });

    await user.save();
    res.json({ success: true, message: `Bonus ₹${bonusAmount} added!`, userName: user.name, bonusAmount: bonusAmount, newTotal: user.totalEarned });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/approve-user/:id', authAdmin, async (req, res) => { try { const user = await User.findByIdAndUpdate(req.params.id, { status: 'approved' }, { new: true }).select('-password'); res.json({ success: true, user }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/disqualify-user/:id', authAdmin, async (req, res) => { try { const user = await User.findByIdAndUpdate(req.params.id, { status: 'disqualified' }, { new: true }).select('-password'); res.json({ success: true, user }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/reapprove-user/:id', authAdmin, async (req, res) => { try { const user = await User.findByIdAndUpdate(req.params.id, { status: 'approved' }, { new: true }).select('-password'); res.json({ success: true, user }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

app.delete('/api/admin/user/:id', authAdmin, async (req, res) => { try { await User.findByIdAndDelete(req.params.id); await Withdrawal.deleteMany({ userId: req.params.id }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

app.get('/api/admin/overview', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    const today = new Date().toISOString().split('T')[0];
    const activeToday = users.filter(u => u.history.some(h => h.date.startsWith(today))).length;
    res.json({ totalUsers: users.length, activeToday, totalSolved: users.reduce((s, u) => s + u.totalSolved, 0), totalPayout: parseFloat(users.reduce((s, u) => s + u.totalEarned, 0).toFixed(2)), pendingUsers: users.filter(u => u.status === 'pending').length, pendingWithdrawals: await Withdrawal.countDocuments({ status: 'pending' }), pendingPlans: users.filter(u => u.pendingPlan).length, premiumUsers: users.filter(u => u.plan !== 'demo' && u.plan !== 'free' && u.planEndDate && new Date() < new Date(u.planEndDate)).length, premiumIncome: users.reduce((s, u) => s + (u.totalPaidForPremium || 0), 0) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/activity', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('history');
    const map = {};
    users.forEach(u => {
      (u.history || []).forEach(h => {
        const d = h.date.split(' ')[0]; // Sirf date nikaalo
        if (!map[d]) map[d] = { solved: 0, correct: 0, wrong: 0, earned: 0, users: new Set() };
        map[d].solved += h.solved; map[d].correct += h.correct; map[d].wrong += h.wrong; map[d].earned += h.earned; map[d].users.add(String(u._id));
      });
    });
    res.json(Object.keys(map).sort().reverse().slice(0, 60).map(date => ({ date, solved: map[date].solved, correct: map[date].correct, wrong: map[date].wrong, earned: parseFloat(map[date].earned.toFixed(3)), activeUsers: map[date].users.size })));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/withdrawals', authAdmin, async (req, res) => { try { res.json(await Withdrawal.find().sort({ requestedAt: -1 })); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

app.post('/api/admin/approve-withdrawal/:id', authAdmin, async (req, res) => {
  try {
    const w = await Withdrawal.findById(req.params.id); if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Invalid or processed' });
    w.status = 'approved'; w.processedAt = new Date(); await w.save();
    const user = await User.findById(w.userId); if (user) { user.pendingWithdrawal = Math.max(0, user.pendingWithdrawal - w.amount); user.totalWithdrawn += w.amount; await user.save(); }
    res.json({ success: true, withdrawal: w });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/reject-withdrawal/:id', authAdmin, async (req, res) => {
  try {
    const { note } = req.body; const w = await Withdrawal.findById(req.params.id); if (!w || w.status !== 'pending') return res.status(400).json({ error: 'Invalid or processed' });
    w.status = 'rejected'; w.processedAt = new Date(); w.adminNote = note || ''; await w.save();
    const user = await User.findById(w.userId); if (user) { user.pendingWithdrawal = Math.max(0, user.pendingWithdrawal - w.amount); await user.save(); }
    res.json({ success: true, withdrawal: w });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Settings, Visitor tracking, cleanup waise hi rahenge...
app.get('/api/admin/settings', authAdmin, async (req, res) => { try { const m = await Settings.findOne({ key: 'marquee' }); const a = await Settings.findOne({ key: 'ads' }); const p = await Settings.findOne({ key: 'payment' }); res.json({ marquee: m ? m.value : '', ads: a ? a.value : [], payment: p ? p.value : { upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' } }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/settings/marquee', authAdmin, async (req, res) => { try { await Settings.findOneAndUpdate({ key: 'marquee' }, { value: req.body.text }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/settings/ads', authAdmin, async (req, res) => { try { await Settings.findOneAndUpdate({ key: 'ads' }, { value: req.body.ads }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/settings/payment', authAdmin, async (req, res) => { try { await Settings.findOneAndUpdate({ key: 'payment' }, { value: req.body.payment }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

app.post('/api/admin/deduct-balance/:id', authAdmin, async (req, res) => {
  try {
    const deductAmount = parseFloat(req.body.amount); if (!deductAmount || deductAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const user = await User.findById(req.params.id); if (!user) return res.status(404).json({ error: 'User not found' });
    const availableBalance = (user.totalEarned || 0) - (user.totalWithdrawn || 0) - (user.pendingWithdrawal || 0);
    if (deductAmount > availableBalance) return res.status(400).json({ error: `Max balance ₹${availableBalance.toFixed(3)}` });
    user.totalEarned = parseFloat(((user.totalEarned || 0) - deductAmount).toFixed(3));
    const today = new Date().toISOString().split('T')[0];
    user.history.push({ date: `${today} (Deduction)`, solved: 0, correct: 0, wrong: 0, earned: -deductAmount, bonus: 0, isBonusEntry: false });
    await user.save();
    res.json({ success: true, message: `₹${deductAmount} deducted`, newBalance: parseFloat(((user.totalEarned || 0) - (user.totalWithdrawn || 0) - (user.pendingWithdrawal || 0)).toFixed(3)) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/revoke-plan/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id); if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.plan === 'demo' || user.plan === 'free') return res.status(400).json({ error: 'Already on Demo plan' });
    user.plan = 'demo'; user.planStartDate = null; user.planEndDate = null; user.pendingPlan = null; user.subscriptionExpired = true; user.expiredAt = new Date();
    if (!user.planRevokeLogs) user.planRevokeLogs = [];
    user.planRevokeLogs.push({ revokedPlan: user.plan, reason: req.body.reason || 'Admin revoke', date: new Date() });
    await user.save(); res.json({ success: true, message: `Plan revoked. Reverted to Demo.` });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/user-password/:id', authAdmin, async (req, res) => { try { const u = await User.findById(req.params.id).select('name mobile password'); if (!u) return res.status(404).json({ error: 'User not found' }); res.json({ success: true, name: u.name, mobile: u.mobile, passwordHash: u.password, note: 'Bcrypt hashed', canReset: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/reset-password/:id', authAdmin, async (req, res) => { try { if (!req.body.newPassword || req.body.newPassword.length < 6) return res.status(400).json({ error: 'Min 6 chars' }); const u = await User.findByIdAndUpdate(req.params.id, { password: await bcrypt.hash(req.body.newPassword, 10) }, { new: true }).select('name mobile'); if (!u) return res.status(404).json({ error: 'User not found' }); res.json({ success: true, message: `Password reset`, newPassword: req.body.newPassword }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

// Visitor stats aur error handlers (Same as before)
app.post('/api/track-visit', async (req, res) => { try { const { visitorId } = req.body; const today = new Date().toISOString().split('T')[0]; let stats = await Settings.findOne({ key: 'visitorStats' }); if (!stats) stats = await Settings.create({ key: 'visitorStats', value: { totalViews: 0, todayViews: 0, lastResetDate: today, uniqueVisitors: [], todayUniqueVisitors: [], hourlyViews: {} } }); const data = stats.value; if (data.lastResetDate !== today) { data.todayViews = 0; data.todayUniqueVisitors = []; data.lastResetDate = today; } data.totalViews++; data.todayViews++; if (visitorId && !data.uniqueVisitors.includes(visitorId)) data.uniqueVisitors.push(visitorId); if (visitorId && !data.todayUniqueVisitors.includes(visitorId)) data.todayUniqueVisitors.push(visitorId); stats.value = data; stats.markModified('value'); await stats.save(); res.json({ success: true, totalViews: data.totalViews, todayViews: data.todayViews, totalUnique: data.uniqueVisitors.length, todayUnique: data.todayUniqueVisitors.length }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/visitor-stats', async (req, res) => { try { const stats = await Settings.findOne({ key: 'visitorStats' }); if (!stats) return res.json({ totalViews: 0, todayViews: 0, totalUnique: 0, todayUnique: 0 }); res.json({ totalViews: stats.value.totalViews || 0, todayViews: stats.value.todayViews || 0, totalUnique: stats.value.uniqueVisitors?.length || 0, todayUnique: stats.value.todayUniqueVisitors?.length || 0 }); } catch (err) { res.json({ totalViews: 0, todayViews: 0, totalUnique: 0, todayUnique: 0 }); } });
app.get('/api/admin/visitor-stats', authAdmin, async (req, res) => { try { const stats = await Settings.findOne({ key: 'visitorStats' }); res.json(stats ? { ...stats.value, lastResetDate: stats.value.lastResetDate } : { totalViews: 0, todayViews: 0, totalUnique: 0, todayUnique: 0 }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/update-visitor-stats', authAdmin, async (req, res) => { try { const today = new Date().toISOString().split('T')[0]; let stats = await Settings.findOne({ key: 'visitorStats' }); if (!stats) stats = await Settings.create({ key: 'visitorStats', value: {} }); const data = stats.value; if (req.body.totalViews !== undefined) data.totalViews = parseInt(req.body.totalViews); if (req.body.todayViews !== undefined) data.todayViews = parseInt(req.body.todayViews); if (req.body.totalUnique !== undefined) data.uniqueVisitors = new Array(parseInt(req.body.totalUnique)).fill('fake'); if (req.body.todayUnique !== undefined) data.todayUniqueVisitors = new Array(parseInt(req.body.todayUnique)).fill('fake'); data.lastResetDate = today; stats.value = data; stats.markModified('value'); await stats.save(); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/admin/reset-visitor-stats', authAdmin, async (req, res) => { try { await Settings.findOneAndUpdate({ key: 'visitorStats' }, { value: { totalViews: 0, todayViews: 0, lastResetDate: new Date().toISOString().split('T')[0], uniqueVisitors: [], todayUniqueVisitors: [] } }, { upsert: true }); res.json({ success: true }); } catch (err) { res.status(500).json({ error: 'Server error' }); } });

async function cleanupOldData() { try { const cut = new Date(); cut.setDate(cut.getDate() - 30); const cutoff = cut.toISOString().split('T')[0]; const users = await User.find({ 'history.0': { $exists: true } }); for (const u of users) { const oc = (u.history || []).filter(h => h.date.split(' ')[0] < cutoff).length; if (oc > 0) { u.history = u.history.filter(h => h.date.split(' ')[0] >= cutoff); await u.save(); } } } catch (e) {} }
process.on('uncaughtException', (err) => console.error('❌ Uncaught:', err.message)); process.on('unhandledRejection', (err) => console.error('❌ Unhandled:', err.message || err)); app.use((err, req, res, next) => { res.status(500).json({ error: 'Server error' }); });

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
server.timeout = 30000; server.keepAliveTimeout = 65000; server.headersTimeout = 66000;
cleanupOldData(); setInterval(cleanupOldData, 86400000);
