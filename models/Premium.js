const mongoose = require('mongoose');

const premiumSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  plan: { type: String, enum: ['free', 'premium', 'premium_plus'], default: 'free' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
  paymentId: String,
  amount: Number,
  autoRenew: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Premium', premiumSchema);
