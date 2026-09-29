const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  whatsapp: { type: String, required: true },
  payment: {
    type: { type: String, enum: ['gpay', 'phonepe', 'upi', 'bank'], required: true },
    value: { type: String, required: true },
    bank: {
      account: String,
      ifsc: String,
      holder: String
    }
  },
  totalSolved: { type: Number, default: 0 },
  totalCorrect: { type: Number, default: 0 },
  totalWrong: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  streak: { type: Number, default: 0 },
  lastActive: { type: Date, default: null },
  lastDailyBonus: { type: Date, default: null },
  history: [{
    date: String,
    solved: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
    wrong: { type: Number, default: 0 },
    earned: { type: Number, default: 0 }
  }],
  registeredAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);