const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  whatsapp: { type: String, required: true },
  payment: {
    type: { type: String, enum: ['gpay', 'phonepe', 'upi', 'bank'], required: true },
    value: { type: String, required: true },
    bank: { account: String, ifsc: String, holder: String }
  },
  status: { type: String, enum: ['pending', 'approved', 'disqualified'], default: 'pending' },
  
  // Premium plan
  plan: { type: String, enum: ['free', 'premium', 'premium_plus'], default: 'free' },
  pendingPlan: { type: String, enum: ['premium', 'premium_plus', null], default: null },
  planStartDate: { type: Date, default: null },
  planEndDate: { type: Date, default: null },
  planPaymentId: { type: String, default: null },
  paymentDone: { type: Boolean, default: false },
  paymentNote: { type: String, default: '' },
  paymentDoneAt: { type: Date, default: null },
  totalPaidForPremium: { type: Number, default: 0 },
  
  // Daily tracking
  todayCaptchas: { type: Number, default: 0 },
  todayResetDate: { type: String, default: null },
  
  totalSolved: { type: Number, default: 0 },
  totalCorrect: { type: Number, default: 0 },
  totalWrong: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  pendingWithdrawal: { type: Number, default: 0 },
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

userSchema.methods.isPremiumActive = function() {
  if (this.plan === 'free') return false;
  if (!this.planEndDate) return false;
  return new Date() < new Date(this.planEndDate);
};

userSchema.methods.getRate = function() {
  if (!this.isPremiumActive()) return 0.025;
  if (this.plan === 'premium') return 0.05;
  if (this.plan === 'premium_plus') return 0.10;
  return 0.025;
};

userSchema.methods.getDailyLimit = function() {
  if (!this.isPremiumActive()) return 50;
  return Infinity;
};

module.exports = mongoose.model('User', userSchema);
