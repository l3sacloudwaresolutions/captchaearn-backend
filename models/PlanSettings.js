const mongoose = require('mongoose');

const planSettingsSchema = new mongoose.Schema({
  planName: { type: String, required: true, unique: true },
  displayName: String,
  price: { type: Number, default: 0 },
  dailyLimit: { type: Number, default: 100 },
  earningRate: { type: Number, default: 0.025 },
  dailyBonus: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true },
  features: [String],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('PlanSettings', planSettingsSchema);
