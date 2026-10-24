const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: String,
  userMobile: String,
  amount: { type: Number, required: true },
  paymentType: String,
  paymentValue: String,
  bankDetails: Object,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  processedAt: Date,
  adminNote: String
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
