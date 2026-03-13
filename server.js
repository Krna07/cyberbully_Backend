require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Analysis = require('./models/Analysis');
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 5001;
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'https://cyberbully-ml-services-1.onrender.com';
const JWT_SECRET = process.env.JWT_SECRET || 'cyberbullying-detection-secret-key-2024-change-this-in-production';

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✓ Connected to MongoDB'))
  .catch(err => console.error('✗ MongoDB connection error:', err));

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Auth Routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Create user
    const user = new User({ username, email, password });
    await user.save();

    // Generate token
    const token = jwt.sign(
      { id: user._id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate token
    const token = jwt.sign(
      { id: user._id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Failed to login' });
  }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
});

// Protected Routes
app.post('/api/analyze', authenticateToken, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required' });
    }

    console.log('Sending request to ML service:', ML_SERVICE_URL);
    console.log('Text to analyze:', text.substring(0, 50) + '...');
    
    let result;
    let retries = 3;
    
    // Retry logic for ML service (in case it's waking up)
    while (retries > 0) {
      try {
        const response = await axios.post(`${ML_SERVICE_URL}/predict`, 
          { text },
          { 
            timeout: 60000, // 60 second timeout for first request (wake up time)
            headers: { 'Content-Type': 'application/json' }
          }
        );
        
        result = response.data;
        console.log('ML service response received successfully');
        break;
      } catch (mlError) {
        retries--;
        console.error(`ML service error (${retries} retries left):`, mlError.message);
        
        if (retries === 0) {
          // If ML service fails, use simple keyword-based detection as fallback
          console.log('Using fallback detection method');
          const textLower = text.toLowerCase();
          const toxicWords = ['stupid', 'idiot', 'hate', 'kill', 'die', 'ugly', 'loser', 'dumb'];
          const foundWords = toxicWords.filter(word => textLower.includes(word));
          const isToxic = foundWords.length > 0;
          
          result = {
            prediction: isToxic ? "Cyberbullying Detected" : "Safe Message",
            confidence: isToxic ? 0.75 : 0.85,
            categories: {
              toxic: isToxic ? 1 : 0,
              severe_toxic: 0,
              obscene: 0,
              threat: 0,
              insult: isToxic ? 1 : 0,
              identity_hate: 0
            },
            toxicKeywords: foundWords,
            language: 'english',
            fallback: true
          };
        } else {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // Save to MongoDB with userId
    try {
      const analysis = new Analysis({
        userId: req.user.id,
        text,
        prediction: result.prediction,
        confidence: result.confidence,
        toxicKeywords: result.toxicKeywords || [],
        categories: result.categories || {},
        language: result.language || 'english',
        ipAddress: req.ip
      });
      await analysis.save();
      console.log('Analysis saved to database');
    } catch (dbError) {
      console.error('Database save error:', dbError.message);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Analyze error:', error.message);
    if (error.response) {
      console.error('Error response:', error.response.data);
    }
    res.status(500).json({ 
      error: 'Failed to analyze text',
      details: error.message
    });
  }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const totalMessages = await Analysis.countDocuments({ userId });
    const bullyingCount = await Analysis.countDocuments({ 
      userId,
      prediction: 'Cyberbullying Detected' 
    });
    const safeCount = await Analysis.countDocuments({ 
      userId,
      prediction: 'Safe Message' 
    });
    
    // Category breakdown for this user only
    const analyses = await Analysis.find({ 
      userId,
      prediction: 'Cyberbullying Detected' 
    });
    const categoryBreakdown = {
      toxic: 0,
      severe_toxic: 0,
      obscene: 0,
      threat: 0,
      insult: 0,
      identity_hate: 0
    };
    
    analyses.forEach(analysis => {
      if (analysis.categories) {
        Object.keys(categoryBreakdown).forEach(key => {
          if (analysis.categories[key] === 1) {
            categoryBreakdown[key]++;
          }
        });
      }
    });
    
    const recentAnalyses = await Analysis.find({ userId })
      .sort({ timestamp: -1 })
      .limit(10)
      .select('-__v');
    
    res.json({
      totalMessages,
      bullyingCount,
      safeCount,
      toxicityPercentage: totalMessages > 0 
        ? ((bullyingCount / totalMessages) * 100).toFixed(1) 
        : 0,
      categoryBreakdown,
      recentAnalyses
    });
  } catch (error) {
    console.error('Stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    
    const history = await Analysis.find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .select('-__v');
    
    res.json(history);
  } catch (error) {
    console.error('History error:', error.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.post('/api/search', authenticateToken, async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Get prediction from ML service
    const response = await axios.post(`${ML_SERVICE_URL}/predict`, { text });
    const result = response.data;
    
    // Format response for search
    res.json({
      text,
      isToxic: result.prediction === 'Cyberbullying Detected',
      confidence: result.confidence,
      categories: result.categories || {},
      toxicKeywords: result.toxicKeywords || []
    });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ 
      error: 'Failed to search text',
      details: error.response?.data || error.message 
    });
  }
});

app.delete('/api/analysis/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Only allow users to delete their own analyses
    const deleted = await Analysis.findOneAndDelete({ _id: id, userId });
    
    if (!deleted) {
      return res.status(404).json({ error: 'Analysis not found or unauthorized' });
    }
    
    res.json({ 
      success: true, 
      message: 'Analysis deleted successfully',
      id 
    });
  } catch (error) {
    console.error('Delete error:', error.message);
    res.status(500).json({ error: 'Failed to delete analysis' });
  }
});

app.delete('/api/analysis', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Only delete analyses belonging to this user
    const result = await Analysis.deleteMany({ userId });
    
    res.json({ 
      success: true, 
      message: 'All analyses deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Delete all error:', error.message);
    res.status(500).json({ error: 'Failed to delete all analyses' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
