const mongoose = require('mongoose');

const analysisSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  text: {
    type: String,
    required: true
  },
  prediction: {
    type: String,
    required: true,
    enum: ['Cyberbullying Detected', 'Safe Message']
  },
  confidence: {
    type: Number,
    required: true,
    min: 0,
    max: 1
  },
  toxicKeywords: [{
    type: String
  }],
  categories: {
    toxic: { type: Number, default: 0 },
    severe_toxic: { type: Number, default: 0 },
    obscene: { type: Number, default: 0 },
    threat: { type: Number, default: 0 },
    insult: { type: Number, default: 0 },
    identity_hate: { type: Number, default: 0 }
  },
  language: {
    type: String,
    default: 'english'
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  ipAddress: String
});

module.exports = mongoose.model('Analysis', analysisSchema);
