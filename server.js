const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');
const Settings = require('./models/Settings');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// ============ PLAN CONFIG (Admin editable) ============
const DEFAULT_PLANS = {
  free: { 
    id: 'free', 
    name: 'Free', 
    price: 0, 
    period: 'Forever', 
    rate: 0.025, 
    dailyLimit: 100,
    features: ['100 captchas daily', '₹0.025 per captcha', 'Basic support', 'Weekly payout'],
    color: 'gray'
  },
  premium: { 
    id: 'premium', 
    name: 'Premium', 
    price: 199, 
    period: 'month', 
    rate: 0.05, 
    dailyLimit: 99999,
    features: ['♾️ Unlimited captchas', '💰 2x earning (₹0.05)', '⚡ Priority support', '🚀 Fast processing'],
    color: 'purple'
  },
  premium_plus: { 
    id: 'premium_plus', 
    name: 'Premium+', 
    price: 500, 
    period: 'month', 
    rate: 0.10, 
    dailyLimit: 99999,
    features: ['♾️ Unlimited captchas', '💰 4x earning (₹0.10)', '⚡ 24/7 support', '🚀 Instant processing', '🎁 Daily bonus ₹5'],
    color: 'gold'
  }
};

const DAILY_BONUS = 1;
const MIN_WITHDRAWAL = 100;

// ============ GET PLANS FROM DB OR DEFAULT ============
// ============ PLAN CONFIG ============
const DEFAULT_PLANS = {
  free: { 
    id: 'free', 
    name: 'Free', 
    price: 0, 
    period: 'Forever', 
    rate: 0.025, 
    dailyLimit: 100,
    features: ['100 captchas daily', '₹0.025 per captcha', 'Basic support', 'Weekly payout']
  },
  premium: { 
    id: 'premium', 
    name: 'Premium', 
    price: 199, 
    period: 'month', 
    rate: 0.05, 
    dailyLimit: 99999,
    features: ['♾️ Unlimited captchas', '💰 2x earning (₹0.05)', '⚡ Priority support', '🚀 Fast processing']
  },
  premium_plus: { 
    id: 'premium_plus', 
    name: 'Premium+', 
    price: 500, 
    period: 'month', 
    rate: 0.10, 
    dailyLimit: 99999,
    features: ['♾️ Unlimited captchas', '💰 4x earning (₹0.10)', '⚡ 24/7 support', '🚀 Instant processing', '🎁 Daily bonus ₹5']
  }
};

// ============ GET PLANS FROM DB OR DEFAULT ============
async function getPlans() {
  try {
    const plansDoc = await Settings.findOne({ key: 'plans' });
    if (plansDoc && plansDoc.value) {
      return plansDoc.value;
    }
    await Settings.findOneAndUpdate({ key: 'plans' }, { value: DEFAULT_PLANS }, { upsert: true });
    return DEFAULT_PLANS;
  } catch (err) {
    return DEFAULT_PLANS;
  }
}
async function getPlans() {
  try {
    const plansDoc = await Settings.findOne({ key: 'plans' });
    if (plansDoc && plansDoc.value) {
      return plansDoc.value;
    }
    // Save defaults
    await Settings.findOneAndUpdate({ key: 'plans' }, { value: DEFAULT_PLANS }, { upsert: true });
    return DEFAULT_PLANS;
  } catch (err) {
    return DEFAULT_PLANS;
  }
}

// ============ CHECK IF SUBSCRIPTION EXPIRED ============
async function checkAndUpdateSubscription(user) {
  if (user.plan === 'free') return user;
  if (!user.planEndDate) return user;
  
  const now = new Date();
  if (now > new Date(user.planEndDate)) {
    // Subscription expired - reset to free
    user.plan = 'free';
    user.planStartDate = null;
    user.planEndDate = null;
    user.planAutoRenew = false;
    user.subscriptionExpired = true;
    user.expiredAt = now;
    await user.save();
  }
  return user;
}

// ============ GET RATE FOR USER ============
async function getUserRate(user) {
  const plans = await getPlans();
  if (user.plan === 'free') return plans.free.rate;
  // Check if expired
  if (user.planEndDate && new Date() > new Date(user.planEndDate)) {
    return plans.free.rate;
  }
  return plans[user.plan]?.rate || plans.free.rate;
}

// ============ GET DAILY LIMIT FOR USER ============
async function getUserDailyLimit(user) {
  const plans = await getPlans();
  if (user.plan === 'free') return plans.free.dailyLimit;
  // Check if expired
  if (user.planEndDate && new Date() > new Date(user.planEndDate)) {
    return plans.free.dailyLimit;
  }
  return plans[user.plan]?.dailyLimit || plans.free.dailyLimit;
}

// ============ AUTH MIDDLEWARE ============
function authUser(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authAdmin(req, res, next) {
  const { username, password } = req.headers;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'Invalid admin credentials' });
}

// ============ HOME ============
app.get('/', (req, res) => {
  res.json({ status: 'TypeCaptchaToEarn API is running ✅' });
});

// ============ PUBLIC SETTINGS ============
app.get('/api/settings/public', async (req, res) => {
  try {
    const marquee = await Settings.findOne({ key: 'marquee' });
    const ads = await Settings.findOne({ key: 'ads' });
    const plans = await getPlans();
    res.json({
      marquee: marquee ? marquee.value : '',
      ads: ads ? ads.value : [],
      plans: plans
    });
  } catch (err) {
    res.json({ marquee: '', ads: [], plans: DEFAULT_PLANS });
  }
});

// ============ PUBLIC PLANS ============
app.get('/api/plans', async (req, res) => {
  try {
    const plans = await getPlans();
    const plansArray = Object.values(plans);
    res.json({ plans: plansArray });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ REGISTER ============
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, password, whatsapp, payment } = req.body;
    if (!name || name.length < 3) return res.status(400).json({ error: 'Valid naam daalein' });
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Mobile 10 digits' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (!/^\d{10}$/.test(whatsapp)) return res.status(400).json({ error: 'WhatsApp 10 digits' });
    if (!payment || !payment.type || !payment.value) return res.status(400).json({ error: 'Payment detail missing' });

    const exists = await User.findOne({ mobile });
    if (exists) return res.status(400).json({ error: 'Yeh mobile number pehle se registered hai' });

    const hashedPass = await bcrypt.hash(password, 10);
    const user = await User.create({
      name, mobile, whatsapp, payment,
      password: hashedPass,
      status: 'pending',
      plan: 'free'
    });

    res.json({ success: true, message: 'Registration successful! Admin approval ke baad aap work start kar sakte hain.', userId: user._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ LOGIN ============
app.post('/api/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Valid mobile daalein' });

    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).json({ error: 'Invalid mobile ya password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid mobile ya password' });

    if (user.status === 'disqualified') {
      return res.status(403).json({ error: 'Aapka account disqualified hai. Support se contact karein.' });
    }

    // Check subscription expiry
    await checkAndUpdateSubscription(user);

    const today = new Date().toDateString();
    const lastActive = user.lastActive ? new Date(user.lastActive).toDateString() : null;
    if (lastActive !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      user.streak = (lastActive === yesterday) ? (user.streak || 0) + 1 : 1;
      user.lastActive = new Date();
      await user.save();
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
    
    // Get current rate & limit
    const currentRate = await getUserRate(user);
    const dailyLimit = await getUserDailyLimit(user);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        mobile: user.mobile,
        status: user.status,
        plan: user.plan,
        planEndDate: user.planEndDate,
        subscriptionExpired: user.subscriptionExpired || false,
        currentRate: currentRate,
        dailyLimit: dailyLimit,
        totalSolved: user.totalSolved,
        totalCorrect: user.totalCorrect,
        totalWrong: user.totalWrong,
        totalEarned: user.totalEarned,
        totalWithdrawn: user.totalWithdrawn,
        pendingWithdrawal: user.pendingWithdrawal,
        streak: user.streak
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ GET PROFILE ============
app.get('/api/profile', authUser, async (req, res) => {
  try {
    let user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Check subscription
    const wasExpired = user.plan !== 'free' && user.planEndDate && new Date() > new Date(user.planEndDate);
    await checkAndUpdateSubscription(user);
    
    const currentRate = await getUserRate(user);
    const dailyLimit = await getUserDailyLimit(user);
    const plans = await getPlans();
    
    const userObj = user.toObject();
    userObj.isPremium = user.plan !== 'free' && (!user.planEndDate || new Date() < new Date(user.planEndDate));
    userObj.currentRate = currentRate;
    userObj.dailyLimit = dailyLimit;
    userObj.subscriptionExpired = wasExpired || user.subscriptionExpired || false;
    
    // Calculate remaining captchas
    const today = new Date().toISOString().split('T')[0];
    const todayRec = (user.history || []).find(h => h.date === today);
    const todaySolved = todayRec ? todayRec.solved : 0;
    userObj.todaySolved = todaySolved;
    userObj.remaining = Math.max(0, dailyLimit - todaySolved);
    userObj.planFeatures = plans[user.plan]?.features || plans.free.features;
    
    res.json(userObj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SUBMIT CAPTCHA ============
app.post('/api/submit-captcha', authUser, async (req, res) => {
  try {
    const { userAnswer, correctAnswer } = req.body;
    let user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.status !== 'approved') {
      return res.status(403).json({ error: 'Account approve nahi hua' });
    }

    // Check subscription expiry
    const wasExpired = user.plan !== 'free' && user.planEndDate && new Date() > new Date(user.planEndDate);
    await checkAndUpdateSubscription(user);
    
    if (wasExpired) {
      return res.status(403).json({ 
        error: 'Your subscription has expired. Please purchase a plan to continue working.',
        subscriptionExpired: true,
        plan: user.plan
      });
    }

    // Get user's plan settings
    const plans = await getPlans();
    const userPlan = plans[user.plan] || plans.free;
    const currentRate = userPlan.rate;
    const dailyLimit = userPlan.dailyLimit;

    // Daily limit check
    const today = new Date().toISOString().split('T')[0];
    if (user.todayResetDate !== today) {
      user.todayCaptchas = 0;
      user.todayResetDate = today;
    }

    if (user.todayCaptchas >= dailyLimit) {
      return res.status(429).json({
        error: `Daily limit (${dailyLimit} captchas) reached! Upgrade to Premium for unlimited captchas.`,
        limitReached: true,
        currentPlan: user.plan
      });
    }

    const isCorrect = String(userAnswer).trim().toUpperCase() === String(correctAnswer).trim().toUpperCase();

    user.totalSolved++;
    user.todayCaptchas++;
    if (isCorrect) user.totalCorrect++;
    else user.totalWrong++;

    let dayRec = user.history.find(h => h.date === today);
    if (!dayRec) {
      dayRec = { date: today, solved: 0, correct: 0, wrong: 0, earned: 0 };
      user.history.push(dayRec);
      
      const lastBonus = user.lastDailyBonus ? new Date(user.lastDailyBonus).toDateString() : null;
      if (lastBonus !== new Date().toDateString()) {
        user.totalEarned += DAILY_BONUS;
        dayRec.earned += DAILY_BONUS;
        user.lastDailyBonus = new Date();
      }
    }

    dayRec.solved++;
    if (isCorrect) {
      dayRec.correct++;
      dayRec.earned += currentRate;
      user.totalEarned += currentRate;
    } else {
      dayRec.wrong++;
    }

    await user.save();

    res.json({
      success: true,
      correct: isCorrect,
      correctAnswer,
      rate: currentRate,
      totalSolved: user.totalSolved,
      totalCorrect: user.totalCorrect,
      totalWrong: user.totalWrong,
      totalEarned: parseFloat(user.totalEarned.toFixed(3)),
      todayEarned: parseFloat(dayRec.earned.toFixed(3)),
      todaySolved: dayRec.solved,
      todayCaptchas: user.todayCaptchas,
      dailyLimit: dailyLimit,
      remaining: Math.max(0, dailyLimit - user.todayCaptchas),
      plan: user.plan
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PURCHASE PREMIUM ============
app.post('/api/purchase-premium', authUser, async (req, res) => {
  try {
    const { planId } = req.body;
    const plans = await getPlans();
    
    if (!plans[planId] || planId === 'free') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Save pending plan
    user.pendingPlan = planId;
    user.pendingPlanRequestedAt = new Date();
    await user.save();

    res.json({ 
      success: true, 
      message: `Your ${plans[planId].name} plan request is pending admin approval.`,
      planId: planId,
      planName: plans[planId].name,
      price: plans[planId].price
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ MARK PAYMENT DONE ============
app.post('/api/mark-payment-done', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.paymentMarked = true;
    user.paymentMarkedAt = new Date();
    await user.save();

    res.json({ success: true, message: 'Payment marked. Please send screenshot on WhatsApp for verification.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ WITHDRAW ============
app.post('/api/withdraw', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'Account approved nahi hai' });

    const availableBalance = user.totalEarned - user.totalWithdrawn - user.pendingWithdrawal;
    if (availableBalance < MIN_WITHDRAWAL) {
      return res.status(400).json({ error: `Minimum ₹${MIN_WITHDRAWAL} chahiye. Available: ₹${availableBalance.toFixed(3)}` });
    }

    const existing = await Withdrawal.findOne({ userId: user._id, status: 'pending' });
    if (existing) return res.status(400).json({ error: 'Ek withdrawal request pehle se pending hai' });

    const withdrawal = await Withdrawal.create({
      userId: user._id, userName: user.name, userMobile: user.mobile,
      amount: availableBalance, paymentType: user.payment.type,
      paymentValue: user.payment.value, bankDetails: user.payment.bank, status: 'pending'
    });

    user.pendingWithdrawal += availableBalance;
    await user.save();

    res.json({ success: true, message: 'Withdrawal request submit ho gayi', withdrawal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/my-withdrawals', authUser, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ requestedAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PAYMENT SETTINGS (PUBLIC) ============
app.get('/api/payment-settings', async (req, res) => {
  try {
    const settings = await Settings.findOne({ key: 'payment' });
    res.json(settings ? settings.value : { upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' });
  } catch (err) {
    res.json({ upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' });
  }
});

// ============ ADMIN ROUTES ============

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ registeredAt: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/approve-user/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'approved' }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/disqualify-user/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'disqualified' }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reapprove-user/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { status: 'approved' }, { new: true }).select('-password');
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/user/:id', authAdmin, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await Withdrawal.deleteMany({ userId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: APPROVE PLAN PURCHASE ============
app.post('/api/admin/approve-plan/:id', authAdmin, async (req, res) => {
  try {
    const { planId } = req.body;
    const plans = await getPlans();
    
    if (!plans[planId] || planId === 'free') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    // If user already has a plan, extend from current end date or now
    let startFrom = now;
    if (user.plan === planId && user.planEndDate && new Date(user.planEndDate) > now) {
      startFrom = new Date(user.planEndDate);
    }
    const endDate = new Date(startFrom.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    user.plan = planId;
    user.planStartDate = now;
    user.planEndDate = endDate;
    user.planApprovedAt = now;
    user.pendingPlan = null;
    user.paymentMarked = false;
    user.subscriptionExpired = false;
    user.totalPaidForPremium = (user.totalPaidForPremium || 0) + plans[planId].price;
    await user.save();

    res.json({ success: true, message: `${plans[planId].name} plan activated!`, user: user.toObject() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: REJECT PLAN PURCHASE ============
app.post('/api/admin/reject-plan/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.pendingPlan = null;
    user.paymentMarked = false;
    await user.save();
    
    res.json({ success: true, message: 'Plan request rejected' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: SET PLAN MANUALLY ============
app.post('/api/admin/set-plan/:id', authAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    const plans = await getPlans();
    if (!plans[plan]) return res.status(400).json({ error: 'Invalid plan' });
    
    const now = new Date();
    const endDate = plan === 'free' ? null : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const user = await User.findByIdAndUpdate(req.params.id, {
      plan: plan,
      planStartDate: plan === 'free' ? null : now,
      planEndDate: endDate,
      subscriptionExpired: false
    }, { new: true }).select('-password');
    
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: GET PLANS ============
app.get('/api/admin/plans', authAdmin, async (req, res) => {
  try {
    const plans = await getPlans();
    res.json({ plans: plans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ============ ADMIN: PENDING PLANS ============
app.get('/api/admin/pending-plans', authAdmin, async (req, res) => {
  try {
    const users = await User.find({ pendingPlan: { $ne: null } })
      .select('-password')
      .sort({ pendingPlanRequestedAt: -1 });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
// ============ ADMIN: UPDATE PLANS ============
app.post('/api/admin/update-plans', authAdmin, async (req, res) => {
  try {
    const { plans } = req.body;
    if (!plans || !plans.free || !plans.premium || !plans.premium_plus) {
      return res.status(400).json({ error: 'All 3 plans required' });
    }
    
    await Settings.findOneAndUpdate({ key: 'plans' }, { value: plans }, { upsert: true });
    res.json({ success: true, message: 'Plans updated successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: APPROVE PLAN ============
app.post('/api/admin/approve-plan/:id', authAdmin, async (req, res) => {
  try {
    const { planId } = req.body;
    const plans = await getPlans();
    
    if (!plans[planId] || planId === 'free') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = new Date();
    let startFrom = now;
    if (user.plan === planId && user.planEndDate && new Date(user.planEndDate) > now) {
      startFrom = new Date(user.planEndDate);
    }
    const endDate = new Date(startFrom.getTime() + 30 * 24 * 60 * 60 * 1000);

    user.plan = planId;
    user.planStartDate = now;
    user.planEndDate = endDate;
    user.planApprovedAt = now;
    user.pendingPlan = null;
    user.paymentMarked = false;
    user.subscriptionExpired = false;
    user.totalPaidForPremium = (user.totalPaidForPremium || 0) + plans[planId].price;
    await user.save();

    res.json({ success: true, message: `${plans[planId].name} plan activated!` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: REJECT PLAN ============
app.post('/api/admin/reject-plan/:id', authAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.pendingPlan = null;
    user.paymentMarked = false;
    await user.save();
    
    res.json({ success: true, message: 'Plan request rejected' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: SET PLAN MANUALLY ============
app.post('/api/admin/set-plan/:id', authAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    const plans = await getPlans();
    if (!plans[plan]) return res.status(400).json({ error: 'Invalid plan' });
    
    const now = new Date();
    const endDate = plan === 'free' ? null : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    
    const user = await User.findByIdAndUpdate(req.params.id, {
      plan: plan,
      planStartDate: plan === 'free' ? null : now,
      planEndDate: endDate,
      subscriptionExpired: false
    }, { new: true }).select('-password');
    
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: WITHDRAWALS ============
app.get('/api/admin/withdrawals', authAdmin, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find().sort({ requestedAt: -1 });
    res.json(withdrawals);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/approve-withdrawal/:id', authAdmin, async (req, res) => {
  try {
    const w = await Withdrawal.findById(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    w.status = 'approved';
    w.processedAt = new Date();
    await w.save();

    const user = await User.findById(w.userId);
    if (user) {
      user.pendingWithdrawal = Math.max(0, user.pendingWithdrawal - w.amount);
      user.totalWithdrawn += w.amount;
      await user.save();
    }
    res.json({ success: true, withdrawal: w });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject-withdrawal/:id', authAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    const w = await Withdrawal.findById(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    w.status = 'rejected';
    w.processedAt = new Date();
    w.adminNote = note || '';
    await w.save();

    const user = await User.findById(w.userId);
    if (user) {
      user.pendingWithdrawal = Math.max(0, user.pendingWithdrawal - w.amount);
      await user.save();
    }
    res.json({ success: true, withdrawal: w });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: SETTINGS (Marquee + Ads + Payment) ============
app.get('/api/admin/settings', authAdmin, async (req, res) => {
  try {
    const marquee = await Settings.findOne({ key: 'marquee' });
    const ads = await Settings.findOne({ key: 'ads' });
    const payment = await Settings.findOne({ key: 'payment' });
    res.json({
      marquee: marquee ? marquee.value : '',
      ads: ads ? ads.value : [],
      payment: payment ? payment.value : { upiId: 'example@upi', upiName: 'TypeCaptchaToEarn', whatsapp: '919550104511' }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/settings/marquee', authAdmin, async (req, res) => {
  try {
    const { text } = req.body;
    await Settings.findOneAndUpdate({ key: 'marquee' }, { value: text }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/settings/ads', authAdmin, async (req, res) => {
  try {
    const { ads } = req.body;
    await Settings.findOneAndUpdate({ key: 'ads' }, { value: ads }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/settings/payment', authAdmin, async (req, res) => {
  try {
    const { payment } = req.body;
    await Settings.findOneAndUpdate({ key: 'payment' }, { value: payment }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
