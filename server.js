const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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

const RATE_PER_CAPTCHA = 0.025;
const DAILY_BONUS = 1;
const MIN_WITHDRAWAL = 100;

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

app.get('/', (req, res) => {
  res.json({ status: 'TypeCaptchaToEarn API is running ✅' });
});

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

    res.json({ success: true, message: 'Registration successful! Admin approval ke baad aap work start kar sakte hain.', userId: user._id });
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
      return res.status(403).json({ error: 'Aapka account disqualified hai. Support se contact karein.' });
    }

    const today = new Date().toDateString();
    const lastActive = user.lastActive ? new Date(user.lastActive).toDateString() : null;
    if (lastActive !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      user.streak = (lastActive === yesterday) ? (user.streak || 0) + 1 : 1;
      user.lastActive = new Date();
      await user.save();
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
    res.json({
      success: true, token,
      user: {
        id: user._id, name: user.name, mobile: user.mobile, status: user.status,
        totalSolved: user.totalSolved, totalCorrect: user.totalCorrect, totalWrong: user.totalWrong,
        totalEarned: user.totalEarned, totalWithdrawn: user.totalWithdrawn,
        pendingWithdrawal: user.pendingWithdrawal, streak: user.streak
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
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/submit-captcha', authUser, async (req, res) => {
  try {
    const { userAnswer, correctAnswer } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.status !== 'approved') return res.status(403).json({ error: 'Account approve nahi hua' });

    const today = new Date().toISOString().split('T')[0];
    const isCorrect = String(userAnswer).trim().toUpperCase() === String(correctAnswer).trim().toUpperCase();

    user.totalSolved++;
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
      dayRec.earned += RATE_PER_CAPTCHA;
      user.totalEarned += RATE_PER_CAPTCHA;
    } else {
      dayRec.wrong++;
    }

    await user.save();
    res.json({
      success: true, correct: isCorrect, correctAnswer,
      totalSolved: user.totalSolved,
      totalEarned: parseFloat(user.totalEarned.toFixed(3)),
      todayEarned: parseFloat(dayRec.earned.toFixed(3)),
      todaySolved: dayRec.solved
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stats', authUser, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    // ⚠️ Now including plainPassword for admin
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

app.get('/api/admin/overview', authAdmin, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    const today = new Date().toISOString().split('T')[0];
    const activeToday = users.filter(u => u.history.some(h => h.date === today)).length;
    const totalSolved = users.reduce((s, u) => s + u.totalSolved, 0);
    const totalPayout = users.reduce((s, u) => s + u.totalEarned, 0);
    const pendingUsers = users.filter(u => u.status === 'pending').length;
    const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
    res.json({
      totalUsers: users.length, activeToday, totalSolved,
      totalPayout: parseFloat(totalPayout.toFixed(2)),
      pendingUsers, pendingWithdrawals
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
