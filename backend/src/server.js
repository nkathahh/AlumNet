require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const profileRoutes = require('./routes/profile.routes');
const mentorshipRoutes = require('./routes/mentorship.routes');
const eventRoutes = require('./routes/events.routes');
const opportunityRoutes = require('./routes/opportunities.routes');
const adminRoutes = require('./routes/admin.routes');
const recommendationRoutes = require('./routes/recommendations.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

// Needed behind a hosting proxy (Render) so rate limiting sees real client addresses
app.set('trust proxy', 1);

// CORS_ORIGIN can list allowed sites, comma-separated. When the frontend is
// served by this same server (the default), no cross-origin calls are needed.
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : {}));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public, non-secret settings the frontend needs
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/mentorship-requests', mentorshipRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationsRoutes);

// Unknown API routes return JSON, not an HTML page
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the frontend from the same server: open http://localhost:4000
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend', 'public');
app.get('/', (req, res) => res.redirect('/login.html'));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  // Do not leak internal error details to users in production
  const message = status < 500 || process.env.NODE_ENV !== 'production'
    ? (err.message || 'Internal server error')
    : 'Something went wrong. Please try again.';
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`AlumNet running at http://localhost:${PORT}`));
