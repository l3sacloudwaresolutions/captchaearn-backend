const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');
const Settings = require('./models/Settings');
const Premium = require('./models/Premium');
const PlanSettings = require('./models/PlanSettings');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB Connected');
    await initializeDefaultPlans();
  })
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// ============ DEFAULT PLAN SETTINGS ============
async function initializeDefaultPlans() {
  try {
    const existing = await PlanSettings.find();
    if (existing.length === 0) {
      await PlanSettings.create([
        {
          planName: 'free',
          displayName: 'Free',
          price: 0,
          dailyLimit: 100,
          earningRate: 0.025,
          dailyBonus: 1,
          isActive: true,
          features: ['100 captchas/day', '₹0.025 per captcha', 'Daily bonus ₹1']
        },
        {
          planName: 'premium',
          displayName: 'Premium',
          price: 99,
          dailyLimit: 500,
          earningRate: 0.035,
          dailyBonus: 2,
          isActive: true,
          features: ['500 captchas/day', '₹0.035 per captcha', 'Daily bonus ₹2', 'Priority support']
        },
        {
          planName: 'premium_plus',
          displayName: 'Premium+',
          price: 199,
          dailyLimit: 9999,
          earningRate: 0.050,
          dailyBonus: 5,
          isActive: true,
          features: ['Unlimited captchas', '₹0.050 per captcha', 'Daily bonus ₹5', 'Priority support', 'Premium badge']
        }
      ]);
      console.log('✅ Default plans initialized');
    }
  } catch (err) {
    console.error('Plan init error:', err.message);
  }
}

// ============ HELPERS ============
async function getUserPlan(userId) {
  const premium = await Premium.findOne({ userId, isActive: true });
  const planName = premium ? premium.plan : 'free';
  const plan = await PlanSettings.findOne({ planName });
  return plan || { planName: 'free', dailyLimit: 100, earningRate: 0.025, dailyBonus: 1 };
}

async function checkDailyLimit(user) {
  const today = new Date().toISOString().split('T')[0];
  const dayRec = user.history.find(h => h.date === today);
  const todaySolved = dayRec ? dayRec.solved : 0;
  const plan = await getUserPlan(user._id);
  return { todaySolved, limit: plan.dailyLimit, remaining: plan.dailyLimit - todaySolved, plan };
}

// ============ MIDDLEWARE ============
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
    res.json({
      marquee: marquee ? marquee.value : '',
      ads: ads ? ads.value : []
    });
  } catch (err) {
    res.json({ marquee: '', ads: [] });
  }
});

// ============ PUBLIC PLANS ============
app.get('/api/plans', async (req, res) => {
  try {
    const plans = await PlanSettings.find({ isActive: true }).sort({ price: 1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ USER ROUTES ============

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
    const user = await User.create({ name, mobile, whatsapp, payment, password: hashedPass, status: 'pending' });

    // Create premium entry (free plan)
    await Premium.create({ userId: user._id, plan: 'free', isActive: true });

    res.json({ success: true, message: 'Registration successful! Admin approval ke baad work start kar sakte hain.', userId: user._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Valid mobile daalein' });

    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).json({ error: 'Invalid mobile ya password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid mobile ya password' });

    if (user.status === 'disqualified') {
      return res.status(403).json({ error: 'Aapka account disqualified hai.' });
    }

    // Ensure premium entry exists
    let premium = await Premium.findOne({ userId: user._id });
    if (!premium) {
      premium = await Premium.create({ userId: user._id, plan: 'free', isActive: true });
    }

    // Check if premium expired
    if (premium.plan !== 'free' && premium.endDate && new Date() > premium.endDate) {
      premium.plan = 'free';
      premium.isActive = true;
      await premium.save();
    }

    const today = new Date().toDateString();
    const lastActive = user.lastActive ? new Date(user.lastActive).toDateString() : null;
    if (lastActive !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      user.streak = (lastActive === yesterday) ? (user.streak || 0) + 1 : 1;
      user.lastActive = new Date();
      await user.save();
    }

    const plan = await getUserPlan(user._id);
    const limitInfo = await checkDailyLimit(user);

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
    res.json({
      success: true, token,
      user: {
        id: user._id, name: user.name, mobile: user.mobile, status: user.status,
        totalSolved: user.totalSolved, totalCorrect: user.totalCorrect, totalWrong: user.totalWrong,
        totalEarned: user.totalEarned, totalWithdrawn: user.totalWithdrawn,
        pendingWithdrawal: user.pendingWithdrawal, streak: user.streak,
        plan: plan.planName, planDisplay: plan.displayName,
        dailyLimit: plan.dailyLimit, todaySolved: limitInfo.todaySolved,
        remaining: limitInfo.remaining, earningRate: plan.earningRate
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    const plan = await getUserPlan(user._id);
    const limitInfo = await checkDailyLimit(user);
    res.json({
      ...user.toObject(),
      plan: plan.planName,
      planDisplay: plan.displayName,
      dailyLimit: plan.dailyLimit,
      todaySolved: limitInfo.todaySolved,
      remaining: limitInfo.remaining,
      earningRate: plan.earningRate
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ SUBMIT CAPTCHA (With Limit Check) ============
app.post('/api/submit-captcha', authUser, async (req, res) => {
  try {
    const { userAnswer, correctAnswer } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'Account approve nahi hua' });

    // Get plan
    const plan = await getUserPlan(user._id);
    const today = new Date().toISOString().split('T')[0];

    // Check daily limit
    let dayRec = user.history.find(h => h.date === today);
    const todaySolved = dayRec ? dayRec.solved : 0;

    if (todaySolved >= plan.dailyLimit) {
      return res.status(429).json({
        error: `Daily limit khatam! Aapne aaj ${plan.dailyLimit} captchas solve kar liye. Kal wapas aayein ya Premium lein.`,
        limitReached: true,
        dailyLimit: plan.dailyLimit,
        plan: plan.displayName
      });
    }

    const isCorrect = String(userAnswer).trim().toUpperCase() === String(correctAnswer).trim().toUpperCase();

    user.totalSolved++;
    if (isCorrect) user.totalCorrect++;
    else user.totalWrong++;

    if (!dayRec) {
      dayRec = { date: today, solved: 0, correct: 0, wrong: 0, earned: 0 };
      user.history.push(dayRec);
      const lastBonus = user.lastDailyBonus ? new Date(user.lastDailyBonus).toDateString() : null;
      if (lastBonus !== new Date().toDateString()) {
        user.totalEarned += plan.dailyBonus;
        dayRec.earned += plan.dailyBonus;
        user.lastDailyBonus = new Date();
      }
    }

    dayRec.solved++;
    if (isCorrect) {
      dayRec.correct++;
      dayRec.earned += plan.earningRate;
      user.totalEarned += plan.earningRate;
    } else {
      dayRec.wrong++;
    }

    await user.save();

    res.json({
      success: true, correct: isCorrect, correctAnswer,
      totalSolved: user.totalSolved,
      totalEarned: parseFloat(user.totalEarned.toFixed(3)),
      todayEarned: parseFloat(dayRec.earned.toFixed(3)),
      todaySolved: dayRec.solved,
      remaining: plan.dailyLimit - dayRec.solved,
      dailyLimit: plan.dailyLimit,
      earningRate: plan.earningRate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stats', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    const plan = await getUserPlan(user._id);
    const limitInfo = await checkDailyLimit(user);
    res.json({
      ...user.toObject(),
      plan: plan.planName,
      planDisplay: plan.displayName,
      dailyLimit: plan.dailyLimit,
      todaySolved: limitInfo.todaySolved,
      remaining: limitInfo.remaining,
      earningRate: plan.earningRate
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PREMIUM ROUTES ============

// Get my premium status
app.get('/api/premium/status', authUser, async (req, res) => {
  try {
    const premium = await Premium.findOne({ userId: req.userId });
    const plan = await getUserPlan(req.userId);
    res.json({
      premium: premium || { plan: 'free' },
      plan: plan
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Purchase premium (Mock - Razorpay integration ke baad)
app.post('/api/premium/purchase', authUser, async (req, res) => {
  try {
    const { planName, paymentId } = req.body;
    if (!['premium', 'premium_plus'].includes(planName)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const plan = await PlanSettings.findOne({ planName });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    let premium = await Premium.findOne({ userId: req.userId });
    if (!premium) {
      premium = await Premium.create({ userId: req.userId, plan: 'free' });
    }

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30); // 30 days

    premium.plan = planName;
    premium.startDate = new Date();
    premium.endDate = endDate;
    premium.isActive = true;
    premium.paymentId = paymentId || 'manual_' + Date.now();
    premium.amount = plan.price;
    await premium.save();

    res.json({ success: true, message: `${plan.displayName} activate ho gaya!`, premium });
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

    const MIN_WITHDRAWAL = 100;
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
    const usersWithPlan = await Promise.all(users.map(async u => {
      const plan = await getUserPlan(u._id);
      return { ...u.toObject(), plan: plan.planName, planDisplay: plan.displayName };
    }));
    res.json(usersWithPlan);
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
    await Premium.deleteMany({ userId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: PLAN SETTINGS ============

app.get('/api/admin/plans', authAdmin, async (req, res) => {
  try {
    const plans = await PlanSettings.find().sort({ price: 1 });
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/plans/:planName', authAdmin, async (req, res) => {
  try {
    const { planName } = req.params;
    const { displayName, price, dailyLimit, earningRate, dailyBonus, isActive, features } = req.body;

    const plan = await PlanSettings.findOneAndUpdate(
      { planName },
      {
        displayName, price, dailyLimit, earningRate, dailyBonus, isActive, features,
        updatedAt: new Date()
      },
      { new: true, upsert: true }
    );
    res.json({ success: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin set user plan manually
app.post('/api/admin/set-user-plan/:userId', authAdmin, async (req, res) => {
  try {
    const { planName, days } = req.body;
    if (!['free', 'premium', 'premium_plus'].includes(planName)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    let premium = await Premium.findOne({ userId: req.params.userId });
    if (!premium) {
      premium = await Premium.create({ userId: req.params.userId, plan: 'free' });
    }

    premium.plan = planName;
    premium.startDate = new Date();
    if (planName === 'free') {
      premium.endDate = null;
    } else {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + (days || 30));
      premium.endDate = endDate;
    }
    premium.isActive = true;
    premium.paymentId = 'admin_manual_' + Date.now();
    await premium.save();

    res.json({ success: true, premium });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN: OVERVIEW ============

app.get('/api/admin/overview', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    const today = new Date().toISOString().split('T')[0];
    const activeToday = users.filter(u => u.history.some(h => h.date === today)).length;
    const totalSolved = users.reduce((s, u) => s + u.totalSolved, 0);
    const totalPayout = users.reduce((s, u) => s + u.totalEarned, 0);
    const pendingUsers = users.filter(u => u.status === 'pending').length;
    const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
    const premiumUsers = await Premium.countDocuments({ plan: { $ne: 'free' }, isActive: true });

    res.json({
      totalUsers: users.length, activeToday, totalSolved,
      totalPayout: parseFloat(totalPayout.toFixed(2)),
      pendingUsers, pendingWithdrawals, premiumUsers
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/activity', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('history');
    const map = {};
    users.forEach(u => {
      (u.history || []).forEach(h => {
        if (!map[h.date]) map[h.date] = { solved: 0, correct: 0, wrong: 0, earned: 0, users: new Set() };
        map[h.date].solved += h.solved;
        map[h.date].correct += h.correct;
        map[h.date].wrong += h.wrong;
        map[h.date].earned += h.earned;
        map[h.date].users.add(String(u._id));
      });
    });
    const result = Object.keys(map).sort().reverse().slice(0, 60).map(date => ({
      date, solved: map[date].solved, correct: map[date].correct,
      wrong: map[date].wrong, earned: parseFloat(map[date].earned.toFixed(3)),
      activeUsers: map[date].users.size
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

app.get('/api/admin/settings', authAdmin, async (req, res) => {
  try {
    const marquee = await Settings.findOne({ key: 'marquee' });
    const ads = await Settings.findOne({ key: 'ads' });
    res.json({
      marquee: marquee ? marquee.value : '',
      ads: ads ? ads.value : []
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
