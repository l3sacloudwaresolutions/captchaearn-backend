const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ============ DATABASE CONNECT ============
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ============ CONFIG ============
const RATE_PER_CAPTCHA = 0.25;
const DAILY_BONUS = 5;
const MIN_PAYOUT = 250;

// ============ HOME ROUTE ============
app.get('/', (req, res) => {
  res.json({ status: 'CaptchaEarn API is running ✅' });
});

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

// ============ USER ROUTES ============

// REGISTER
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, password, whatsapp, payment } = req.body;

    if (!name || name.length < 3) return res.status(400).json({ error: 'Valid naam daalein' });
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Mobile 10 digits ka hona chahiye' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
    if (!/^\d{10}$/.test(whatsapp)) return res.status(400).json({ error: 'WhatsApp number 10 digits' });
    if (!payment || !payment.type || !payment.value) return res.status(400).json({ error: 'Payment detail missing' });

    const exists = await User.findOne({ mobile });
    if (exists) return res.status(400).json({ error: 'Yeh mobile number pehle se registered hai' });

    const hashedPass = await bcrypt.hash(password, 10);
    const user = await User.create({
      name, mobile, whatsapp, payment,
      password: hashedPass
    });

    res.json({ success: true, message: 'Registration successful!', userId: user._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Valid mobile daalein' });

    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).json({ error: 'Invalid mobile ya password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid mobile ya password' });

    // Update streak
    const today = new Date().toDateString();
    const lastActive = user.lastActive ? new Date(user.lastActive).toDateString() : null;
    if (lastActive !== today) {
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      user.streak = (lastActive === yesterday) ? (user.streak || 0) + 1 : 1;
      user.lastActive = new Date();
      await user.save();
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        mobile: user.mobile,
        totalSolved: user.totalSolved,
        totalCorrect: user.totalCorrect,
        totalWrong: user.totalWrong,
        totalEarned: user.totalEarned,
        streak: user.streak
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET PROFILE
app.get('/api/profile', authUser, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

// SUBMIT CAPTCHA
app.post('/api/submit-captcha', authUser, async (req, res) => {
  try {
    const { userAnswer, correctAnswer } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = new Date().toISOString().split('T')[0];
    const isCorrect = String(userAnswer).trim().toUpperCase() === String(correctAnswer).trim().toUpperCase();

    user.totalSolved++;
    if (isCorrect) user.totalCorrect++;
    else user.totalWrong++;

    // Find or create today's history
    let dayRec = user.history.find(h => h.date === today);
    if (!dayRec) {
      dayRec = { date: today, solved: 0, correct: 0, wrong: 0, earned: 0 };
      user.history.push(dayRec);

      // Daily bonus first captcha of day
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
      success: true,
      correct: isCorrect,
      correctAnswer,
      totalSolved: user.totalSolved,
      totalEarned: user.totalEarned,
      todayEarned: dayRec.earned,
      todaySolved: dayRec.solved
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET STATS
app.get('/api/stats', authUser, async (req, res) => {
  const user = await User.findById(req.userId).select('-password');
  res.json(user);
});

// ============ ADMIN ROUTES ============

// ADMIN LOGIN CHECK
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// GET ALL USERS
app.get('/api/admin/users', authAdmin, async (req, res) => {
  const users = await User.find().select('-password').sort({ registeredAt: -1 });
  res.json(users);
});

// GET OVERVIEW STATS
app.get('/api/admin/overview', authAdmin, async (req, res) => {
  const users = await User.find().select('-password');
  const today = new Date().toISOString().split('T')[0];
  const activeToday = users.filter(u => u.history.some(h => h.date === today)).length;
  const totalSolved = users.reduce((s, u) => s + u.totalSolved, 0);
  const totalPayout = users.reduce((s, u) => s + u.totalEarned, 0);
  res.json({
    totalUsers: users.length,
    activeToday,
    totalSolved,
    totalPayout: parseFloat(totalPayout.toFixed(2))
  });
});

// GET ACTIVITY
app.get('/api/admin/activity', authAdmin, async (req, res) => {
  const users = await User.find().select('history id');
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
  const result = Object.keys(map).sort().reverse().slice(0, 30).map(date => ({
    date,
    solved: map[date].solved,
    correct: map[date].correct,
    wrong: map[date].wrong,
    earned: parseFloat(map[date].earned.toFixed(2)),
    activeUsers: map[date].users.size
  }));
  res.json(result);
});

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));