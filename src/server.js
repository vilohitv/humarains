/**
 * humarains — Backend Server (Ask AI only)
 */
'use strict';
require('dotenv').config();

// ── Sentry ─────────────────────────────────────────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
    integrations: [Sentry.httpIntegration()],
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') process.exit(1);
});

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const path         = require('path');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const passport     = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const db     = require('../db');
const mailer = require('./services/mailer');
const { getPlan, isUnlimited: planIsUnlimited, isValidPlan, PAID_PLAN_KEYS } = require('./config/plans');
const { hashResetToken, verifyResetToken } = require('./lib/crypto-utils');
const Stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;


let dbReady = false;
const dbInitPromise = db.init().then(ok => {
  dbReady = ok;
  if (ok) {
    console.log('[DB] Connected and ready.');
  } else if (process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
    // A database is configured but its schema could not be brought up to date. Starting anyway would
    // run new code against an old schema, so stop and let the platform keep the previous release live.
    console.error('[DB] Database setup failed — refusing to start in production.');
    process.exit(1);
  } else {
    console.warn('[DB] Running without database.');
  }
  return ok;
}).catch(() => { console.warn('[DB] Running without database.'); return false; });

const app  = express();
// Express auto-generates a weak ETag for every res.json()/res.send() by
// default. For per-user authenticated endpoints (e.g. /api/users/me) this
// means a browser can send If-None-Match and get back a 304 — reusing its
// OLD cached body — even after the underlying data changed server-side
// (e.g. an admin plan upgrade). Static assets set their own explicit
// Cache-Control below and don't need this; dynamic API responses do.
app.disable('etag');
// Compress text responses (HTML, CSS, JS, JSON). The dashboard ships several hundred KB of scripts and styles that were
// being sent raw on every login.
app.use(require('compression')({ threshold: 1024 }));
// Render (and most hosts) terminate TLS at a reverse proxy. Without this, req.ip is the proxy's address,
// so every rate limit would be shared by ALL users, and Secure session cookies would never be set.
// Set TRUST_PROXY to the number of proxy hops if your setup differs (default 1).
app.set('trust proxy', parseInt(process.env.TRUST_PROXY || '1', 10));
const PORT = process.env.PORT || 3000;

const JWT_SECRET  = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] JWT_SECRET not set in production.');
    process.exit(1);
  }
  return crypto.randomBytes(64).toString('hex');
})();
const JWT_EXPIRES   = '24h';
const BCRYPT_ROUNDS = 12;
const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// ── Sanitize user ─────────────────────────────────────────────
function sanitizeUser(user, adminSettings) {
  if (!user) return null;
  const intg = (() => {
    const raw = user.integrations;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed; // handle double-stringified legacy data
    } catch (e) { return {}; }
  })();
  // Nothing secret ever reaches the browser: WhatsApp access tokens, mailbox passwords, OAuth tokens, reset tokens.
  const safeIntg = require('./lib/redact').redactSecrets(intg);
  const planConf = getPlan(user.plan || 'free');
  // Admin can hide the WhatsApp feature entirely via the admin panel toggle.
  // When disabled, features.whatsapp is forced to false regardless of plan.
  const settings = adminSettings || {};
  const whatsappAdminEnabled = settings.whatsapp_feature_enabled !== '0';
  return {
    id:             user.id,
    name:           user.name,
    email:          user.email,
    plan:           user.plan       || 'free',
    analyses_used:  user.analyses_used  || 0,
    analyses_limit: user.analyses_limit ?? 0,
    company:        user.company    || null,
    industry:       user.industry   || null,
    avatar_url:     user.avatar_url || null,
    created_at:     user.created_at || null,
    integrations:   safeIntg,
    // Payment trouble, so the dashboard can show the "update your card" banner
    billing:        { status: (intg.billing && intg.billing.status) || 'ok' },
    // Feature flags derived from plans.js so the front-end never has to
    // hardcode plan names — it just checks features.whatsapp, etc.
    features: {
      whatsappFeatureEnabled: whatsappAdminEnabled,
      whatsapp:               whatsappAdminEnabled ? planConf.whatsapp : false,
      whatsappLimit:          whatsappAdminEnabled ? planConf.whatsappLimit : 0,
      calendar:               planConf.calendar,
      autonomousMode:         planConf.autonomousMode,
      workflowAdvancedSteps:  planConf.workflowAdvancedSteps,
      workflowsLimit:         planConf.workflowsLimit,
      leadSendsLimit:         planConf.leadSendsLimit,
      dealInsights:           planConf.dealInsights,
      leadScoring:            planConf.leadScoring,
    },
  };
}

// ── Security headers ──────────────────────────────────────────
app.use((req, res, next) => {
  if (!isDev) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  // Remove server fingerprinting on all environments
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  next();
});

app.use(helmet({
  contentSecurityPolicy: isDev ? false : {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "accounts.google.com", "fonts.googleapis.com", "js.stripe.com", "connect.facebook.net"],
      // Helmet defaults this to 'none', which blocks inline onclick/onchange/etc.
      // attributes even though scriptSrc allows 'unsafe-inline' — the dashboard
      // and workflows UI rely on inline handlers, so this must be opened up too.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "accounts.google.com"],
      fontSrc:    ["'self'"],
      imgSrc:     ["'self'", "data:", "blob:", "https:", "lh3.googleusercontent.com"],
      connectSrc: ["'self'", "accounts.google.com", "oauth2.googleapis.com", "api.stripe.com", "graph.facebook.com", "connect.facebook.net", "www.facebook.com"],
      frameSrc:   ["'self'", "accounts.google.com", "js.stripe.com", "www.facebook.com", "web.facebook.com", "staticxx.facebook.com"],
    },
  },
  crossOriginResourcePolicy: isDev ? false : { policy: 'same-origin' },
  // Must be same-origin-allow-popups: the Meta/Facebook Embedded Signup popup
  // reports its result (code, phone_number_id, waba_id) back via window.opener /
  // postMessage. A strict 'same-origin' policy severs that link, so Meta shows
  // "connected" but Humarains never receives the result.
  crossOriginOpenerPolicy:   isDev ? false : { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
  hsts:       isDev ? false : { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: isDev ? false : { action: 'sameorigin' },
  noSniff:    !isDev,
  xssFilter:  !isDev,
}));

// ── Middleware ─────────────────────────────────────────────────
// Stripe webhook must be before express.json() to receive raw body
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!Stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, message: 'Stripe not configured' });
  }
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ success: false, message: 'Missing stripe-signature header' });
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ success: false, message: 'Webhook signature verification failed' });
  }
  console.log(`[Stripe Webhook] Event received: ${event.type} (${event.id})`);
  try {
    const obj    = event.data.object;
    const userId = obj.metadata && obj.metadata.userId;
    if (event.type === 'checkout.session.completed') {
      const plan = obj.metadata && obj.metadata.plan;
      if (dbReady && userId && plan && isValidPlan(plan)) {
        const planConf = getPlan(plan);
        await db.Users.update(userId, {
          plan,
          stripe_customer_id: obj.customer,
          stripe_subscription_id: obj.subscription,
          analyses_limit:       0,
          analyses_used:        0,
          usage_reset_at:       new Date().toISOString(),
        }); // no .catch: a failure here must return 500 so Stripe retries the event
        await db.BillingHistory.create({
          id: require('crypto').randomBytes(16).toString('hex'),
          userId, stripeInvoiceId: obj.invoice || null,
          event: 'subscription.created', amount: obj.amount_total || 0,
          currency: obj.currency || 'usd', status: 'succeeded',
          description: `Upgraded to ${planConf.name} plan`,
        }).catch(err => console.error('[Stripe Webhook] BillingHistory error:', err.message));
        console.log(`[Stripe Webhook] User ${userId} upgraded to plan: ${plan}`);
      }
    }
    // Handles plan changes made via the Stripe customer portal (upgrade/downgrade
    // between tiers). checkout.session.completed only fires on the initial purchase,
    // not when a subscriber switches plans mid-cycle.
    if (event.type === 'customer.subscription.updated') {
      const customerId = obj.customer;
      // Payment trouble shows as a dashboard banner until it is fixed (services/retention.js).
      if (dbReady && customerId && ['past_due', 'unpaid', 'active'].includes(obj.status)) {
        const u = await db.Users.findByStripeCustomerId(customerId);
        if (u) {
          if (obj.status === 'active') await require('./services/retention').markPaymentRecovered(db, u);
          else if (require('./services/retention').getBilling(u).status !== 'past_due') await require('./services/retention').markPaymentFailed(db, u, { sendMail: mailer.sendMail });
        }
      }
      // Stripe stores the plan key in the price's metadata.plan field —
      // set this when creating each Price in the Stripe dashboard.
      const newPlanKey = obj.items && obj.items.data && obj.items.data[0]
        && obj.items.data[0].price && obj.items.data[0].price.metadata
        && obj.items.data[0].price.metadata.plan;
      if (dbReady && customerId && newPlanKey && isValidPlan(newPlanKey)) {
        const user = await db.Users.findByStripeCustomerId(customerId); // a DB error must reach the catch below (500 -> Stripe retries); no match returns null
        if (user) {
          const planConf = getPlan(newPlanKey);
          await db.Users.update(user.id, {
            plan: newPlanKey,
            analyses_limit: 0,
          });
          console.log(`[Stripe Webhook] User ${user.id} plan changed to: ${newPlanKey}`);
        }
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const customerId = obj.customer;
      if (dbReady && customerId) {
        const user = await db.Users.findByStripeCustomerId(customerId); // see above: errors propagate so Stripe retries the cancellation
        if (user) {
          const freeConf = getPlan('free');
          await db.Users.update(user.id, {
            plan: 'free',
            analyses_limit: 0,
            analyses_used: 0,
          });
          await require('./services/retention').recordCancellation(db, user, obj, { sendMail: mailer.sendMail })
            .catch(e => console.error('[Stripe Webhook] cancellation follow-up failed:', e.message));
        }
      }
    }
    // A successful payment clears the payment-trouble banner.
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      if (dbReady && obj.customer) {
        const u = await db.Users.findByStripeCustomerId(obj.customer).catch(() => null);
        if (u) await require('./services/retention').markPaymentRecovered(db, u).catch(() => {});
      }
    }
    if (event.type === 'invoice.payment_failed') {
      const customerId = obj.customer;
      if (dbReady && customerId) {
        const user = await db.Users.findByStripeCustomerId(customerId).catch(() => null);
        if (user) {
          console.warn(`[Stripe Webhook] Payment failed for user ${user.id} (${user.email})`);
          // Banner in the dashboard + at most one clear email every 2 days while Stripe retries. Access is kept meanwhile.
          await require('./services/retention').markPaymentFailed(db, user, { sendMail: mailer.sendMail })
            .catch(e => console.error('[Stripe Webhook] payment-failure follow-up failed:', e.message));
        }
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('[Stripe Webhook] Error processing event:', event.id, error.message);
    // Non-2xx makes Stripe retry with backoff, so a transient DB error can't leave a paying customer on the wrong plan.
    res.status(500).json({ received: false });
  }
});

// The WhatsApp webhook keeps its raw body so Meta's signature can be checked (services/whatsapp.js verifyWebhookSignature).
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { if (req.originalUrl && req.originalUrl.startsWith('/api/leads/whatsapp/webhook')) req.rawBody = buf; } }));
app.use(cookieParser());

app.get('/dashboard', (req, res) => {
  res.redirect('/dashboard.html');
});

const corsOptions = {
  origin: isDev ? '*' : function(origin, callback) {
    if (!origin) return callback(null, true);
    const raw = (process.env.ALLOWED_ORIGIN || '').replace(/\/+$/, '');
    if (!raw) return callback(new Error('Not allowed by CORS')); // fail closed: ALLOWED_ORIGIN must be set in production
    const allowedOrigins = [
      raw,
      raw.startsWith('https://www.') ? raw.replace('https://www.', 'https://') : raw.replace('https://', 'https://www.'),
    ].filter(Boolean);
    if (allowedOrigins.includes(origin.replace(/\/+$/, ''))) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
};
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ── Session ───────────────────────────────────────────────────
let sessionStore;
if (process.env.DATABASE_URL) {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: db.pool,
    tableName: 'session',
    createTableIfMissing: true,
    ttl: 86400,
    pruneSessionInterval: 900,
  });
} else if (!isDev) {
  console.error('[FATAL] DATABASE_URL not set in production.');
  process.exit(1);
}
// Sessions are only used by the Google sign-in hand-off. Everything else authenticates with the JWT cookie, so mounting
// the session store on every request cost a database round trip for each page, script and API call.
const sessionMw = session({
  secret: process.env.SESSION_SECRET || (isDev ? JWT_SECRET : (() => { console.error('[FATAL] SESSION_SECRET not set in production.'); process.exit(1); })()),
  resave: false,
  saveUninitialized: false,
  ...(sessionStore ? { store: sessionStore } : {}),
  cookie: { secure: !isDev, httpOnly: true, sameSite: 'Lax', maxAge: 24 * 60 * 60 * 1000 },
});
const passportInit = passport.initialize();
const passportSession = passport.session();
app.use('/api/auth/google', sessionMw, passportInit, passportSession);

// ── Rate limiters ─────────────────────────────────────────────
// Per-IP key so one user can't exhaust another user's auth budget.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
  message: { success: false, message: 'Too many auth attempts. Try again in 15 minutes.' },
  skip: (req) => isDev,
});

// General API rate limit — applied to all /api/* routes below
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip || 'unknown',
  message: { success: false, message: 'Too many requests. Slow down.' },
  skip: (req) => isDev,
});

// Strict limit for sensitive write ops (password change, billing)
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip || 'unknown',
  message: { success: false, message: 'Too many requests for this action.' },
  skip: (req) => isDev,
});

// ── Helpers ───────────────────────────────────────────────────
function generateId()       { return crypto.randomBytes(16).toString('hex'); }
function generateCsrfToken(){ return crypto.randomBytes(32).toString('hex'); }

// ── Security audit log ────────────────────────────────────────
async function auditLog(userId, event, req, metadata = {}) {
  if (!dbReady) return;
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ua = (req.headers['user-agent'] || '').slice(0, 512);
    await db.query(
      'INSERT INTO security_audit_log (id, user_id, event, ip_address, user_agent, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [generateId(), userId || null, event, ip, ua, JSON.stringify(metadata)]
    );
  } catch (_) { /* never throw from audit log */ }
}
function createToken(userId){ return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES }); }
function setAuthCookie(res, token) {
  res.clearCookie('bp_token', { path: '/' });
  res.cookie('bp_token', token, { httpOnly: true, secure: !isDev, sameSite: 'Lax', maxAge: 24 * 60 * 60 * 1000, path: '/' });
}
function setCsrfCookie(res, token) {
  res.clearCookie('bp_csrf', { path: '/' });
  res.cookie('bp_csrf', token, { httpOnly: false, secure: !isDev, sameSite: 'Lax', maxAge: 24 * 60 * 60 * 1000, path: '/' });
}

function verifyCsrfToken(req, res, next) {
  const tokenFromCookie = req.cookies && req.cookies.bp_csrf;
  const tokenFromHeader = req.headers['x-csrf-token'];
  if (!tokenFromCookie || !tokenFromHeader) {
    return res.status(403).json({ success: false, message: 'CSRF token validation failed.' });
  }
  // Use timing-safe comparison to prevent timing attacks on CSRF tokens
  try {
    const a = Buffer.from(tokenFromCookie, 'utf8');
    const b = Buffer.from(tokenFromHeader, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ success: false, message: 'CSRF token validation failed.' });
    }
  } catch (_) {
    return res.status(403).json({ success: false, message: 'CSRF token validation failed.' });
  }
  next();
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = (req.cookies && req.cookies.bp_token)
    || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sub || typeof payload.sub !== 'string') {
      return res.status(401).json({ success: false, message: 'Invalid token payload.' });
    }
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
}

// ── Maintenance middleware ─────────────────────────────────────
// The flag is read on every request; a few seconds of delay after an admin flips it is fine, a database query per request is not.
let _maint = { v: false, t: 0 };
async function isMaintenanceCached() {
  if (Date.now() - _maint.t < 5000) return _maint.v;
  const v = !!(await db.AdminSettings.isMaintenanceMode());
  _maint = { v, t: Date.now() };
  return v;
}
app.use(async (req, res, next) => {
  const isStaticAsset  = req.path.match(/\.(css|js|jpeg|jpg|png|ico|svg|woff|woff2|gif|webp|ttf|otf)$/i);
  const isSystemRoute  = req.path.startsWith('/api/system/');
  const isAdminRoute   = req.path.startsWith('/api/admin');
  const isMaintenancePage = req.path === '/maintenance.html';
  if (isStaticAsset || isSystemRoute || isAdminRoute || isMaintenancePage) return next();
  if (!dbReady) return next();
  try {
    const maintenance = await isMaintenanceCached();
    if (maintenance) {
      if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, message: 'Service is under maintenance.', maintenance: true });
      return res.redirect('/maintenance.html');
    }
  } catch (_) {}
  next();
});

// ── Google OAuth ───────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      if (!dbReady) return done(new Error('Database not available'));
      const email = profile.emails && profile.emails[0] && profile.emails[0].value;
      if (!email) return done(new Error('No email from Google'));
      let isNewUser = false;
      let user = await db.Users.findByGoogleId(profile.id);
      if (!user) {
        user = await db.Users.findByEmail(email);
        if (user) {
          await db.Users.update(user.id, { google_id: profile.id, avatar_url: profile.photos && profile.photos[0] && profile.photos[0].value });
          user = await db.Users.findById(user.id);
        } else {
          const signupsEnabled = await db.AdminSettings.isSignupsEnabled();
          if (!signupsEnabled) return done(null, false, { message: 'New registrations are currently disabled.' });
          const id = generateId();
          user = await db.Users.create({ id, name: profile.displayName || email.split('@')[0], email, googleId: profile.id, avatarUrl: profile.photos && profile.photos[0] && profile.photos[0].value, integrations: require('./lib/onboarding').stampRequired({}) });
          isNewUser = true;
        }
      }
      if (user.is_banned) return done(null, false, { message: 'Your account has been suspended.' });
      user._isNewUser = isNewUser;
      return done(null, user);
    } catch (err) { return done(err); }
  }));
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try { done(null, await db.Users.findById(id)); } catch (err) { done(err); }
  });
}

// ── AUTH ROUTES ────────────────────────────────────────────────
const authRouter = express.Router();

authRouter.post('/register', authLimiter,
  [
    body('name').isString().trim().isLength({ min: 2, max: 100 }).escape(),
    body('email').isEmail().customSanitizer(v => typeof v === 'string' ? v.toLowerCase().trim() : v),
    body('password').isLength({ min: 10, max: 128 }).matches(/[A-Z]/).matches(/[a-z]/).matches(/[0-9]/).withMessage('Password must be at least 10 characters and include uppercase, lowercase, and a number.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
    const signupsEnabled = await db.AdminSettings.isSignupsEnabled().catch(() => true);
    if (!signupsEnabled) return res.status(403).json({ success: false, message: 'New registrations are currently disabled.' });
    try {
      const { name, email, password } = req.body;
      const existing = await db.Users.findByEmail(email);
      if (existing) return res.status(409).json({ success: false, message: 'Email already registered.' });
      const id = generateId();
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await db.Users.create({ id, name: name.trim(), email, passwordHash, analysesLimit: 0, integrations: require('./lib/onboarding').stampRequired({}) });
      const token = createToken(id);
      const csrfToken = generateCsrfToken();
      setAuthCookie(res, token);
      setCsrfCookie(res, csrfToken);
      const createdUser = await db.Users.findById(id).catch(() => null);
      return res.status(201).json({ success: true, csrfToken, user: createdUser ? sanitizeUser(createdUser) : { id, name: name.trim(), email, plan: 'free', analyses_used: 0, analyses_limit: 0 } });
    } catch (err) {
      console.error('[register]', err.message);
      return res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
    }
  }
);

authRouter.post('/login', authLimiter,
  [
    body('email').isEmail().customSanitizer(v => typeof v === 'string' ? v.toLowerCase().trim() : v),
    body('password').isLength({ min: 1, max: 128 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
    const { email, password } = req.body;
    const user = await db.Users.findByEmail(email);

    // Always run bcrypt to prevent timing-based user enumeration
    const testHash = (user && user.password_hash) || '$2a$12$invalidhashfortimingattackprevention.XXXXX1';
    const valid = await bcrypt.compare(password, testHash);

    // ── Account lockout check ────────────────────────────────────
    const MAX_ATTEMPTS = 10;
    const LOCKOUT_MINUTES = 15;
    if (user) {
      const intg = (() => {
        try { return typeof user.integrations === 'string' ? JSON.parse(user.integrations) : (user.integrations || {}); }
        catch (_) { return {}; }
      })();
      const lockout = intg.login_lockout || {};
      // Check if currently locked out
      if (lockout.locked_until && new Date(lockout.locked_until) > new Date()) {
        const minsLeft = Math.ceil((new Date(lockout.locked_until) - Date.now()) / 60000);
        return res.status(429).json({ success: false, message: `Account temporarily locked. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.` });
      }
      if (!valid) {
        // Increment failed attempts
        const attempts = (lockout.failed_attempts || 0) + 1;
        const newLockout = attempts >= MAX_ATTEMPTS
          ? { failed_attempts: attempts, locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString(), last_failed_at: new Date().toISOString() }
          : { ...lockout, failed_attempts: attempts, last_failed_at: new Date().toISOString() };
        intg.login_lockout = newLockout;
        await db.Users.update(user.id, { integrations: intg }).catch(() => {});
        const remaining = MAX_ATTEMPTS - attempts;
        if (remaining > 0) {
          return res.status(401).json({ success: false, message: `Invalid email or password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
        }
        return res.status(429).json({ success: false, message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
      }
      // Successful login — clear lockout state
      if (lockout.failed_attempts > 0) {
        intg.login_lockout = {};
        await db.Users.update(user.id, { integrations: intg }).catch(() => {});
      }
    }

    if (!user || !valid) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (user.is_banned) return res.status(403).json({ success: false, message: 'Your account has been suspended.' });
    auditLog(user.id, 'login.success', req);
    const token = createToken(user.id);
    const csrfToken = generateCsrfToken();
    setAuthCookie(res, token);
    setCsrfCookie(res, csrfToken);
    return res.json({ success: true, csrfToken, user: sanitizeUser(user) });
  }
);

authRouter.post('/logout', verifyCsrfToken, (req, res) => {
  const userId = req.user && req.user.id;
  if (userId) auditLog(userId, 'logout', req);
  const cookieOpts = { httpOnly: true, secure: !isDev, sameSite: 'Lax', path: '/' };
  res.clearCookie('bp_token', cookieOpts);
  res.clearCookie('bp_csrf', { ...cookieOpts, httpOnly: false });
  if (req.logout) req.logout(() => {});
  res.json({ success: true });
});

authRouter.get('/google',
  (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google_not_configured');
    next();
  },
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

authRouter.get('/google/callback',
  (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google_not_configured');
    next();
  },
  passport.authenticate('google', { failureRedirect: '/login.html?error=google_failed', session: true }),
  (req, res) => {
    const token = createToken(req.user.id);
    const csrfToken = generateCsrfToken();
    const appUrl = process.env.ALLOWED_ORIGIN || 'https://humarains.com';
    const isNewUser = !!(req.user && req.user._isNewUser);
    const isCrossDomain = !req.hostname.includes('humarains.com');
    if (isCrossDomain) {
      const bridgeToken = crypto.randomBytes(32).toString('hex');
      if (!global._oauthBridgeTokens) global._oauthBridgeTokens = new Map();
      global._oauthBridgeTokens.set(bridgeToken, { token, csrfToken, isNewUser, expires: Date.now() + 60_000 });
      return res.redirect(`${appUrl}/auth-bridge.html?bt=${bridgeToken}`);
    }
    setAuthCookie(res, token);
    setCsrfCookie(res, csrfToken);
    res.redirect(appUrl + (isNewUser ? '/onboarding.html' : '/dashboard.html'));
  }
);

authRouter.get('/google/exchange', (req, res) => {
  const { bt } = req.query;
  if (!bt) return res.status(400).json({ success: false, message: 'Missing bridge token.' });
  const store = global._oauthBridgeTokens;
  const entry = store && store.get(bt);
  if (!entry || Date.now() > entry.expires) {
    if (store) store.delete(bt);
    return res.status(401).json({ success: false, message: 'Bridge token expired or invalid.' });
  }
  store.delete(bt);
  setAuthCookie(res, entry.token);
  setCsrfCookie(res, entry.csrfToken);
  res.json({ success: true, isNewUser: !!entry.isNewUser });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const user = await db.Users.findById(req.user.id).catch(() => null);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user: sanitizeUser(user) });
});

// Password reset
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

authRouter.post('/forgot-password', passwordResetLimiter,
  [body('email').isEmail().customSanitizer(v => typeof v === 'string' ? v.toLowerCase().trim() : v)],
  async (req, res) => {
    const genericOk = { success: true, message: 'If that email is registered, a reset link has been sent.' };
    if (!validationResult(req).isEmpty()) return res.json(genericOk);
    if (!dbReady) return res.json(genericOk);
    try {
      const user = await db.Users.findByEmail(req.body.email).catch(() => null);
      if (!user || !user.password_hash) return res.json(genericOk);
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const intg = getUserIntegrations(user);
      intg.password_reset = { tokenHash: hashResetToken(token), expiresAt: expiresAt.toISOString() };
      await db.Users.update(user.id, { integrations: intg });
      const baseUrl = process.env.APP_URL || ('http://localhost:' + PORT);
      const resetUrl = baseUrl + '/login.html?reset=' + token + '&email=' + encodeURIComponent(user.email);
      const emailTemplates = require('./lib/email-templates');
      const { subject, html } = emailTemplates.passwordReset({ name: user.name || 'there', resetUrl, appUrl: baseUrl });
      await mailer.sendMail({ to: user.email, subject, html });
    } catch(e) { console.error('[forgot-password]', e.message); }
    res.json(genericOk);
  }
);

authRouter.post('/reset-password', passwordResetLimiter,
  [
    body('email').isEmail().customSanitizer(v => typeof v === 'string' ? v.toLowerCase().trim() : v),
    body('token').isLength({ min: 64, max: 64 }).isHexadecimal(),
    body('password').isLength({ min: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: errors.array()[0].msg });
    if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
    try {
      const user = await db.Users.findByEmail(req.body.email).catch(() => null);
      if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });
      const intg = getUserIntegrations(user);
      const reset = intg.password_reset;
      if (!reset || !verifyResetToken(req.body.token, reset.tokenHash)) return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });
      if (new Date(reset.expiresAt) < new Date()) return res.status(400).json({ success: false, message: 'Reset link has expired.' });
      const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
      await db.Users.updatePassword(user.id, passwordHash);
      delete intg.password_reset;
      // Also clear any login lockout on password reset
      intg.login_lockout = {};
      await db.Users.update(user.id, { integrations: intg });
      auditLog(user.id, 'password.reset', req);
      res.json({ success: true, message: 'Password updated successfully.' });
    } catch(e) {
      console.error('[reset-password]', e.message);
      res.status(500).json({ success: false, message: 'Failed to reset password.' });
    }
  }
);

app.use('/api/auth', authRouter);

// ── Global API rate limit ─────────────────────────────────────
app.use('/api/', apiLimiter);

// ── OAuth bridge token cleanup (prevent memory leak) ──────────
setInterval(() => {
  const store = global._oauthBridgeTokens;
  if (!store) return;
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (now > v.expires) store.delete(k);
  }
}, 60_000);

// ── Public feature flags (no auth) ───────────────────────────
// Used by the landing page and signup page to conditionally hide features
// that the admin has disabled via the admin panel (e.g. WhatsApp).
app.get('/api/settings/public', async (req, res) => {
  try {
    const settings = dbReady ? await db.AdminSettings.getAll() : {};
    res.setHeader('Cache-Control', 'public, max-age=30'); // 30s cache — changes are not instant
    res.json({
      ok: true,
      features: {
        whatsapp: settings.whatsapp_feature_enabled !== '0',
      },
    });
  } catch (_) {
    res.json({ ok: true, features: { whatsapp: true } }); // fail open
  }
});

// ── Landing page "Talk to the AI" demo (no auth) ───────────────
// Proxies the live-chat widget on index.html through the server so the
// Anthropic API key never reaches the browser. See routes/demo-chat.js.
const { createDemoChatRouter, createOnboardRouter } = require('./routes/demo-chat');
app.use('/api/demo', createDemoChatRouter());
app.use('/api/onboard', createOnboardRouter());

// ── System status ─────────────────────────────────────────────
app.get('/api/system/status', async (req, res) => {
  try {
    const settings = dbReady ? await db.AdminSettings.getAll() : {};
    res.json({ ok: true, timestamp: new Date().toISOString(), uptime: process.uptime(), db: dbReady ? 'ok' : 'unavailable', maintenance: settings.maintenance_mode === '1' });
  } catch (_) {
    res.json({ ok: true, timestamp: new Date().toISOString(), uptime: process.uptime(), db: 'error' });
  }
});

// ── Health for uptime monitors ────────────────────────────────
//   /healthz       the process is up (liveness)
//   /readyz        the database answers (readiness)
//   /healthz/jobs  background work is alive: no job has stopped running and the inbound queue is
//                  not stuck. Point an uptime monitor at this one; it turns 503 when the worker dies.
// Set HEALTH_TOKEN to require ?token=... on /healthz/jobs.
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => {
  const p = dbReady ? await db.ping() : { ok: false };
  res.status(p.ok ? 200 : 503).json({ ok: !!p.ok });
});
app.get('/healthz/jobs', async (req, res) => {
  if (process.env.HEALTH_TOKEN && req.query.token !== process.env.HEALTH_TOKEN) return res.status(401).json({ ok: false });
  if (!dbReady) return res.status(503).json({ ok: false, reason: 'database unavailable' });
  try {
    const [st, q] = await Promise.all([jobStatus(db), inboundQueue.stats(db)]);
    const queueStuck = q.oldestWaitingSeconds > 15 * 60;
    const ok = !st.stale.length && !queueStuck;
    res.status(ok ? 200 : 503).json({ ok, staleJobs: st.stale, queueStuck, queue: { pending: q.pending, dead: q.dead } });
  } catch (e) { res.status(503).json({ ok: false, reason: e.message }); }
});

// ── User profile (/api/users/me) ──────────────────────────────
const userRouter = express.Router();
userRouter.use(requireAuth);
// Never let the browser (or any proxy/CDN in front of the app) cache or
// 304 this response. It's per-user, session-specific data that can change
// at any time (admin plan changes, Stripe webhooks, etc.) — a stale cached
// copy here is exactly what caused users to see "Free plan" after upgrade.
userRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

userRouter.get('/me', async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const [user, adminSettings] = await Promise.all([
    db.Users.findById(req.user.id).catch(() => null),
    db.AdminSettings.getAll().catch(() => ({})),
  ]);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user: sanitizeUser(user, adminSettings) });
});

// ── Setup check (/api/users/setup-status) ────────────────────
userRouter.get('/setup-status', async (req, res) => {
  if (!dbReady) return res.json({ success: true, setup_complete: false });
  try {
    const row = await db.queryOne('SELECT * FROM lead_business_settings WHERE user_id=$1', [req.user.id]);
    const setup_complete = !!(row && row.business_name && row.owner_name && row.services &&
      (Array.isArray(row.services) ? row.services.length > 0 : JSON.parse(row.services || '[]').length > 0));

    // Onboarding checklist state — lets the UI show real progress instead of
    // guessing. Cheap to compute: one extra row lookup + one count query.
    let email_connected = false;
    let whatsapp_connected = false;
    let onboarding_required = false;
    let autonomy_configured = false;
    let leads_count = 0;
    let test_lead_seen = false;
    try {
      const userRow = await db.queryOne('SELECT integrations FROM users WHERE id=$1', [req.user.id]);
      const intg = userRow && userRow.integrations
        ? (typeof userRow.integrations === 'string' ? JSON.parse(userRow.integrations) : userRow.integrations)
        : {};
      const ob = require('./lib/onboarding');
      ({ email_connected, whatsapp_connected } = ob.channelState(intg));
      onboarding_required = ob.onboardingRequired(intg);
    } catch (_) { /* leave defaults */ }
    try { autonomy_configured = !!(await require('./services/agent/autonomy').getPolicy(db, req.user.id)).configuredAt; } catch (_) { /* leave default */ }
    try {
      const countRow = await db.queryOne("SELECT COUNT(*)::int AS n FROM leads WHERE user_id=$1 AND source != 'test'", [req.user.id]);
      leads_count = (countRow && countRow.n) || 0;
      const testRow = await db.queryOne("SELECT COUNT(*)::int AS n FROM leads WHERE user_id=$1 AND source = 'test' AND ai_reply IS NOT NULL", [req.user.id]);
      test_lead_seen = !!(testRow && testRow.n > 0);
    } catch (_) { /* leave defaults */ }

    res.json({
      success: true,
      setup_complete,
      email_connected,
      whatsapp_connected,
      channel_connected: email_connected || whatsapp_connected,
      onboarding_required,
      autonomy_configured,
      profile: row ? { business_name: row.business_name || '', business_type: row.business_type || '', owner_name: row.owner_name || '', phone: row.phone || '' } : null,
      leads_count,
      has_seen_ai_reply: leads_count > 0 || test_lead_seen,
    });
  } catch(e) {
    res.json({ success: true, setup_complete: false });
  }
});

app.use('/api/users', requireAuth, userRouter);

// ── Account management routes (/api/account) ─────────────────
const createAccountRouter = require('./routes/account');
const accountRouter = createAccountRouter(db, requireAuth, strictLimiter, verifyCsrfToken, auditLog);
app.use('/api/account', accountRouter);

// ── Billing routes ────────────────────────────────────────────
const billingRouter = express.Router();
billingRouter.use(requireAuth);

// Env var naming convention: STRIPE_<PLAN>_PRICE_ID and STRIPE_<PLAN>_ANNUAL_PRICE_ID
// e.g. STRIPE_STARTER_PRICE_ID, STRIPE_GROWTH_PRICE_ID, STRIPE_BUSINESS_PRICE_ID
// (STRIPE_BUSINESS_PRICE_ID now maps to the merged $599 "Pro" tier — update
// the actual Stripe Price object's amount/product to match. STRIPE_ENTERPRISE_PRICE_ID
// is no longer read; it's fine to leave the old Stripe price archived, not deleted.)
function stripePriceIdFor(plan, isAnnual) {
  const envKey = plan.toUpperCase();
  if (isAnnual) {
    return process.env[`STRIPE_${envKey}_ANNUAL_PRICE_ID`] || process.env[`STRIPE_${envKey}_PRICE_ID`];
  }
  return process.env[`STRIPE_${envKey}_PRICE_ID`];
}

billingRouter.post('/create-checkout-session', strictLimiter, verifyCsrfToken, async (req, res) => {
  if (!Stripe) return res.status(503).json({ success: false, message: 'Stripe not configured.' });
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const { plan, billing } = req.body;
  if (!PAID_PLAN_KEYS.includes(plan)) {
    return res.status(400).json({ success: false, message: `Invalid plan. Choose one of: ${PAID_PLAN_KEYS.join(', ')}.` });
  }
  const isAnnual = billing === 'annual';
  const priceId = stripePriceIdFor(plan, isAnnual);
  if (!priceId) return res.status(503).json({ success: false, message: `Stripe price not configured for the ${plan} plan.` });
  const origin = isDev ? ('http://localhost:' + PORT) : (process.env.APP_URL || process.env.ALLOWED_ORIGIN);
  try {
    const user = await db.Users.findById(req.user.id).catch(() => null);
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: origin + '/dashboard.html?upgraded=1',
      cancel_url:  origin + '/dashboard.html?upgrade_cancelled=1',
      metadata: { userId: req.user.id, plan, billing: isAnnual ? 'annual' : 'monthly' },
    };
    if (user && user.stripe_customer_id) {
      sessionParams.customer = user.stripe_customer_id;
    } else if (user && user.email) {
      sessionParams.customer_email = user.email;
    }
    const checkoutSession = await Stripe.checkout.sessions.create(sessionParams);
    res.json({ success: true, url: checkoutSession.url });
  } catch (err) {
    console.error('[Billing] Stripe checkout session error:', err.message);
    res.status(500).json({ success: false, message: 'Could not create checkout session. Please try again.' });
  }
});

billingRouter.post('/create-portal-session', verifyCsrfToken, async (req, res) => {
  if (!Stripe) return res.status(503).json({ success: false, message: 'Stripe not configured.' });
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const user = await db.Users.findById(req.user.id).catch(() => null);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  if (!user.stripe_customer_id) return res.status(400).json({ success: false, message: 'No active subscription found.' });
  try {
    const origin = isDev ? ('http://localhost:' + PORT) : (process.env.ALLOWED_ORIGIN || 'https://humarains.com');
    // flow: 'payment' opens the card-update screen directly, 'cancel' the cancellation screen; anything else the portal home.
    const flow = ['payment', 'cancel'].includes(req.body && req.body.flow) ? req.body.flow : null;
    const url = await require('./services/retention').portalUrl({ stripe: Stripe, user, returnUrl: origin + '/dashboard.html', flow });
    res.json({ success: true, url });
  } catch (e) {
    console.error('[Billing] Portal session error:', e.message);
    res.status(500).json({ success: false, message: 'Could not open billing portal. Please try again.' });
  }
});

// Step 1 of cancelling: why are they leaving? Stores the answer and says whether a stay offer applies.
billingRouter.post('/cancel-intent', verifyCsrfToken, async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const user = await db.Users.findById(req.user.id).catch(() => null);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const retention = require('./services/retention');
  const reason = await retention.recordCancelIntent(db, user, { reason: req.body && req.body.reason, note: req.body && req.body.note });
  res.json({ success: true, reason, offer: retention.offerFor(user, reason) });
});

// They took the offer: discount the existing subscription once.
billingRouter.post('/stay-offer', strictLimiter, verifyCsrfToken, async (req, res) => {
  if (!Stripe) return res.status(503).json({ success: false, message: 'Stripe not configured.' });
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const user = await db.Users.findById(req.user.id).catch(() => null);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const r = await require('./services/retention').applyStayOffer({ stripe: Stripe, db, user });
  if (!r.ok) return res.status(400).json({ success: false, message: 'That offer is not available on your account.' });
  res.json({ success: true, percent: r.percent, months: r.months });
});

billingRouter.get('/history', async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  const history = await db.BillingHistory.listByUser(req.user.id).catch(() => []);
  res.json({ success: true, history });
});

app.use('/api/billing', requireAuth, billingRouter);


// ════════════════════════════════════════════════════════════════
// EMAIL ACCOUNT CONNECTION
// Routes: /api/pipeline/email-settings (IMAP + SMTP connect / test / disconnect)
// ════════════════════════════════════════════════════════════════
const {
  sendPipelineEmail, verifySmtp, verifyImap,
  buildEmailIntegration,
  hasEmailConfig, getEmailConfig, getEmailConfigSafe,
} = require('./services/mailbox');

const pipelineRouter = express.Router();
pipelineRouter.use(requireAuth);

// ── Helper: load user with db ─────────────────────────────────
async function loadUser(userId) {
  return dbReady ? await db.Users.findById(userId).catch(() => null) : null;
}
async function saveUserIntegrations(userId, intg) {
  if (!dbReady) return;
  await db.Users.update(userId, { integrations: JSON.stringify(intg) });
}
function getUserIntegrations(user) {
  const raw = user?.integrations;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    // Handle double-stringified data from previous bug
    if (typeof parsed === 'string') return JSON.parse(parsed);
    return parsed;
  } catch(_) { return {}; }
}


// ════════════════════════════════════════════════════════════════
// EMAIL SETTINGS — Connect via IMAP + SMTP (one combined account)
// ════════════════════════════════════════════════════════════════

// GET /api/pipeline/email-settings — get current config (safe, no credentials)
pipelineRouter.get('/email-settings', async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const config = getEmailConfigSafe(user);
  res.json({ success: true, config, connected: !!config });
});

// POST /api/pipeline/email-settings — save IMAP + SMTP credentials
// Same email/password authenticates both directions (reading via IMAP,
// sending via SMTP).
pipelineRouter.post('/email-settings', verifyCsrfToken, async (req, res) => {
  const { user: acctUser, pass, imapHost, imapPort, smtpHost, smtpPort, fromName } = req.body;
  if (!acctUser || !pass || !imapHost || !smtpHost) {
    return res.status(400).json({ success: false, message: 'user, pass, imapHost, and smtpHost are required.' });
  }

  const candidate = {
    user: acctUser, pass,
    imapHost, imapPort: imapPort || '993',
    smtpHost, smtpPort: smtpPort || '587',
  };

  // Verify both connections before saving
  try {
    await verifyImap(candidate);
  } catch (verifyErr) {
    return res.status(400).json({ success: false, message: 'IMAP connection failed: ' + verifyErr.message + '. Check your credentials.' });
  }
  try {
    await verifySmtp(candidate);
  } catch (verifyErr) {
    return res.status(400).json({ success: false, message: 'SMTP connection failed: ' + verifyErr.message + '. Check your credentials.' });
  }

  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  intg.pipeline_email = buildEmailIntegration({ user: acctUser, pass, imapHost, imapPort, smtpHost, smtpPort, fromName });
  await saveUserIntegrations(req.user.id, intg);

  res.json({ success: true, message: 'Email connected successfully.', config: { type: 'email', user: acctUser, fromName: fromName || acctUser, imapHost, smtpHost } });
});

// POST /api/pipeline/email-settings/test — send a test email
pipelineRouter.post('/email-settings/test', async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  if (!hasEmailConfig(user)) {
    return res.status(400).json({ success: false, message: 'No email account connected.' });
  }

  try {
    const config = getEmailConfig(user);
    await sendPipelineEmail({
      user,
      to:      config.fromEmail,
      subject: 'Pipeline email test ✓',
      body:    'This is a test email from your Pipeline outreach tool.\n\nYour email account is connected and working correctly.\n\n— Pipeline',
      fromName: config.fromName,
    });
    res.json({ success: true, message: 'Test email sent to ' + config.fromEmail });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Test failed: ' + err.message });
  }
});

// DELETE /api/pipeline/email-settings — disconnect email
pipelineRouter.delete('/email-settings', async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const intg = getUserIntegrations(user);
  delete intg.pipeline_email;
  await saveUserIntegrations(req.user.id, intg);

  res.json({ success: true, message: 'Email account disconnected.' });
});

// ── Google Calendar OAuth callback ───────────────────────────
// GET /api/leads/calendar/callback
// Registered directly on app (not the leads router) because it must be
// accessible before the session/auth middleware to receive the redirect.
app.get('/api/leads/calendar/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const appUrl = process.env.APP_URL || process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

  if (error) {
    return res.redirect(`${appUrl}/dashboard.html?cal_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(`${appUrl}/dashboard.html?cal_error=missing_params`);
  }

  try {
    const { handleCalendarCallback, buildCalendarIntegration } = require('./services/google-calendar');

    const { userId, email } = await handleCalendarCallback(code, state,
      async (uid, calEmail, accessToken, refreshToken, expiryDate) => {
        const user = await db.Users.findById(uid);
        if (!user) throw new Error('user_not_found');

        let intg = {};
        try {
          const raw = user.integrations;
          if (raw) {
            intg = typeof raw === 'object' ? raw : JSON.parse(raw);
            if (typeof intg === 'string') intg = JSON.parse(intg);
          }
        } catch(_) { intg = {}; }

        intg.google_calendar = buildCalendarIntegration(calEmail, accessToken, refreshToken, expiryDate);
        await db.Users.update(uid, { integrations: JSON.stringify(intg) });
      }
    );

    res.redirect(`${appUrl}/dashboard.html?cal_connected=1&cal_email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('[Calendar OAuth callback]', err.message);
    const errKey = err.message === 'state_expired' ? 'state_expired' : encodeURIComponent(err.message);
    res.redirect(`${appUrl}/dashboard.html?cal_error=${errKey}`);
  }
});

app.use('/api/pipeline', requireAuth, pipelineRouter);

// ════════════════════════════════════════════════════════════════
// LEAD CONVERSION SYSTEM
// Routes: /api/leads/*
// ════════════════════════════════════════════════════════════════
const { createLeadsRouter } = require('./routes/leads');
const leadsPoller          = require('./services/leads/poller');
const inboundQueue          = require('./services/inbound-queue');
const backupJob             = require('./services/backup-job');
const maintenanceJob        = require('./services/maintenance-job');
const { jobStatus }         = require('./lib/jobs');
const { processWhatsAppBatch } = require('./services/whatsapp-inbound');

// PROCESS_ROLE decides which processes do background work (poller, follow-ups, workflow waits,
// inbound-message queue). 'all' (default) = this process does it, as before; 'web' = only serve
// HTTP, leave the work to a separate `node src/worker.js`; the worker itself uses 'worker'.
// Several processes can run the work safely: each job takes a database lock (lib/jobs.js) and
// the queue claims rows with SKIP LOCKED.
const PROCESS_ROLE = (process.env.PROCESS_ROLE || 'all').toLowerCase();

// Leads access: all authenticated users get full feature access.
// Free plan limits are enforced inside routes/leads.js.
async function attachLeadsUser(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database not available.' });
  try {
    const dbUser = await db.Users.findById(req.user.id);
    if (!dbUser) return res.status(401).json({ success: false, message: 'User not found.' });
    if (dbUser.is_banned) return res.status(403).json({ success: false, message: 'Your account has been suspended.' });
    req.user   = { ...req.user, plan: dbUser.plan, analyses_used: dbUser.analyses_used, analyses_limit: dbUser.analyses_limit };
    req.dbUser = dbUser;

    return next();
  } catch(e) {
    console.error('[attachLeadsUser]', e.message);
    return res.status(500).json({ success: false, message: 'Could not verify account.' });
  }
}

// ── WhatsApp webhook — PUBLIC (no auth, Meta calls this directly) ─
// The webhook routes are also registered in routes/leads.js under the router
// (for the auth'd test/send endpoints). These server-level registrations handle
// the unauthenticated inbound flow from Meta.
{
  // Expose db on app.locals so the webhook handler can find it
  app.locals._db = db;

  // Webhook verification (GET)
  app.get('/api/leads/whatsapp/webhook',  (req, res) => {
    const { verifyWebhookChallenge } = require('./services/whatsapp');
    const challenge = verifyWebhookChallenge(req.query);
    if (challenge !== null) {
      console.log('[WhatsApp] Webhook verified ✓');
      return res.status(200).send(challenge);
    }
    console.warn('[WhatsApp] Webhook verification failed — check WHATSAPP_VERIFY_TOKEN');
    res.sendStatus(403);
  });

  // The webhook only records the message and answers Meta. The work (AI, quote, reply) happens in
  // the queue worker (services/inbound-queue.js + services/whatsapp-inbound.js), which batches a
  // burst of photos/texts, retries failures with backoff, and cannot send a reply twice.
  app.post('/api/leads/whatsapp/webhook', express.json(), async (req, res) => {
    const { parseWebhookPayload } = require('./services/whatsapp');

    // Diagnostics: log delivery receipts and unsupported types so a "no reply" can be traced.
    try {
      for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          for (const st of v.statuses || []) {
            const e0 = (st.errors || [])[0];
            console.log(`[WhatsApp] status ${st.status} for ${st.recipient_id} (${st.id})` +
              (e0 ? ` — error ${e0.code}: ${e0.title || e0.message || ''}` : ''));
          }
          for (const m of v.messages || []) {
            if (m.type !== 'text' && m.type !== 'image' && m.type !== 'button') console.log(`[WhatsApp] ignoring unsupported inbound message (type: ${m.type}) from ${m.from} — only text, photos and quick-reply button taps are handled`);
          }
        }
      }
    } catch (_) {}

    // Delivery failures and Meta account notices: act on them in the background (never blocks the answer to Meta).
    require('./services/whatsapp-maintenance').handleWebhookEvents(db, req.body).catch(() => {});
    // Customer calls that nobody answered: queue the owner's text-back (services/whatsapp-calls.js).
    // A call event makes the business send a message to the caller, so unlike a message it is only trusted when Meta's signature checks out.
    if (require('./services/whatsapp').verifyWebhookSignature(req.rawBody, req.get('x-hub-signature-256'))) {
      require('./services/whatsapp-calls').handleCallEvents(db, req.body).catch(() => {});
    } else if ((req.body?.entry || []).some(e => (e.changes || []).some(c => c.field === 'calls'))) {
      console.warn('[WhatsApp] ignored a calls webhook: signature missing or invalid (is META_APP_SECRET set?)');
    }

    const inbound = parseWebhookPayload(req.body);
    if (!inbound.length) return res.sendStatus(200);

    // A 200 means "stored". If we cannot store the messages, answer 500 so Meta retries the webhook.
    try {
      let fresh = 0;
      for (const m of inbound) if (await inboundQueue.enqueue(db, m)) fresh++;
      console.log(`[WhatsApp] webhook received: ${inbound.length} message(s), ${fresh} new (${inbound.length - fresh} duplicate), queued`);
      res.sendStatus(200);
    } catch (e) {
      console.error('[WhatsApp] could not queue inbound message(s):', e.message);
      res.sendStatus(500);
    }
  });
}


app.use('/api/leads', requireAuth, attachLeadsUser, createLeadsRouter(db, requireAuth));

// ════════════════════════════════════════════════════════════════
// WORKFLOW BUILDER
// Routes: /api/workflows/*
// Reuses attachLeadsUser (auth + dbUser attach) — same access model
// as the lead conversion system itself.
// ════════════════════════════════════════════════════════════════
const { createWorkflowsRouter } = require('./routes/workflows');
app.use('/api/workflows', requireAuth, attachLeadsUser, createWorkflowsRouter(db));

// ════════════════════════════════════════════════════════════════
// Routes: /api/knowledge/*  — Company Knowledge AI
// Reuses attachLeadsUser, same access model as /api/workflows.
// ════════════════════════════════════════════════════════════════
const { createKnowledgeRouter } = require('./routes/knowledge');
app.use('/api/knowledge', requireAuth, attachLeadsUser, createKnowledgeRouter(db));

// The Agent — natural-language control layer over everything above
const { createAgentRouter } = require('./routes/agent');
app.use('/api/agent', requireAuth, attachLeadsUser, createAgentRouter(db));
// What the Agent may do on its own (permissions, limits, activity log)
const { createAutonomyRouter } = require('./routes/autonomy');
app.use('/api/autonomy', requireAuth, attachLeadsUser, createAutonomyRouter(db));
const { createMediaRouter } = require('./services/media-library');
app.use('/api/media', requireAuth, attachLeadsUser, createMediaRouter(db));

// ── Admin Panel ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  let adminEmail = process.env.ADMIN_EMAIL;
  let adminPass  = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPass) {
    if (!isDev) {
      console.error('[Admin] ADMIN_EMAIL and ADMIN_PASSWORD env vars must be set in production.');
      return res.status(503).json({ success: false, message: 'Admin panel not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD env vars.' });
    }
    if (!requireAdmin._devCreds) {
      const devPass = crypto.randomBytes(12).toString('hex');
      requireAdmin._devCreds = { email: 'admin@humarains.local', pass: devPass };
      console.warn('\n[Admin] No ADMIN_EMAIL/ADMIN_PASSWORD set. Using temporary dev credentials:');
      console.warn('   Email:    admin@humarains.local');
      console.warn('   Password: ' + devPass);
      console.warn('   Set ADMIN_EMAIL and ADMIN_PASSWORD in your .env to use your own credentials.\n');
    }
    adminEmail = requireAdmin._devCreds.email;
    adminPass  = requireAdmin._devCreds.pass;
  }

  const key = req.headers['x-admin-key'];
  if (!key) return res.status(401).json({ success: false, message: 'Unauthorized: No key provided.' });
  try {
    const decoded  = Buffer.from(key, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) return res.status(401).json({ success: false, message: 'Unauthorized: Invalid key format.' });
    const email = decoded.slice(0, colonIdx);
    const pass  = decoded.slice(colonIdx + 1);

    const emailBuf      = Buffer.from(email);
    const passBuf       = Buffer.from(pass);
    const adminEmailBuf = Buffer.from(adminEmail);
    const adminPassBuf  = Buffer.from(adminPass);

    const emailMatch = emailBuf.length === adminEmailBuf.length && crypto.timingSafeEqual(emailBuf, adminEmailBuf);
    const passMatch  = passBuf.length  === adminPassBuf.length  && crypto.timingSafeEqual(passBuf,  adminPassBuf);

    if (emailMatch && passMatch) return next();
    console.warn('[Admin] Failed login attempt.');
  } catch (err) {
    console.error('[Admin] Error decoding key:', err.message);
  }
  return res.status(401).json({ success: false, message: 'Unauthorized: Invalid credentials.' });
}

const adminRouter = express.Router();
// Only failed attempts count, so legitimate admin use is never throttled but guessing the key is.
const adminFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true, skip: () => isDev,
  message: { success: false, message: 'Too many failed admin attempts. Try again in 15 minutes.' },
});
adminRouter.use(adminFailLimiter, requireAdmin);

adminRouter.post('/login', (req, res) => {
  res.json({ success: true, message: 'Login successful' });
});

// ── Operations: background jobs, inbound queue, dead messages ──
adminRouter.get('/ops', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const [jobs, queue, dead] = await Promise.all([
      jobStatus(db),
      inboundQueue.stats(db),
      db.queryAll(`SELECT id, channel, attempts, last_error, received_at, processed_at, progress FROM inbound_events WHERE status = 'dead' ORDER BY id DESC LIMIT 25`, []),
    ]);
    res.json({ success: true, role: PROCESS_ROLE, jobs: jobs.jobs, staleJobs: jobs.stale, queue, deadMessages: dead });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// Put a dead message back in the queue. Its saved progress is kept, so a reply that was already sent is not sent again.
adminRouter.post('/ops/inbound/:id/retry', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const r = await db.query(`UPDATE inbound_events SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_at = NULL WHERE id = $1 AND status = 'dead'`, [req.params.id]);
    res.json({ success: r.rowCount === 1, message: r.rowCount === 1 ? 'Queued again.' : 'No dead message with that id.' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

adminRouter.get('/stats', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const usersCount = await db.Users.count();
    const proRow     = await db.queryOne("SELECT COUNT(*) AS n FROM users WHERE plan != 'free'").catch(() => ({ n: 0 }));
    const leadsRow   = await db.queryOne('SELECT COUNT(*) AS n FROM leads').catch(() => ({ n: 0 }));
    const recent     = await db.Users.listAll(10).catch(() => []);
    res.json({
      success: true,
      users:    usersCount,
      leads:    parseInt((leadsRow && leadsRow.n) || 0, 10),
      proUsers: parseInt((proRow   && proRow.n)   || 0, 10),
      recent:   recent.map(u => ({ name: u.name, email: u.email, created_at: u.created_at })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load stats.' });
  }
});

adminRouter.get('/users', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const users      = await db.Users.listAll(500);
    const leadCounts = await db.queryAll('SELECT user_id, COUNT(*) AS n FROM leads GROUP BY user_id').catch(() => []);
    const countMap   = {};
    leadCounts.forEach(r => { countMap[r.user_id] = parseInt(r.n, 10); });
    res.json({
      success: true,
      users: users.map(u => ({
        id: u.id, name: u.name, email: u.email, plan: u.plan,
        is_banned: u.is_banned, created_at: u.created_at,
        leads_count: countMap[u.id] || 0,
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load users.' });
  }
});

adminRouter.get('/leads', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const leads = await db.queryAll(
      `SELECT l.*, u.email AS user_email FROM leads l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC LIMIT 500`
    );
    res.json({ success: true, leads });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load leads.' });
  }
});

adminRouter.get('/db-status', async (req, res) => {
  try {
    const p          = await db.ping();
    const usersCount = dbReady ? await db.Users.count().catch(() => 0) : 0;
    const leadsRow   = dbReady ? await db.queryOne('SELECT COUNT(*) AS n FROM leads').catch(() => ({ n: 0 })) : { n: 0 };
    res.json({
      ok: p.ok, success: p.ok, usersCount,
      leadsCount: parseInt((leadsRow && leadsRow.n) || 0, 10),
      info: {
        Driver:   'Supabase (PostgreSQL)',
        Host:     (process.env.DATABASE_URL || '').split('@')[1]?.split('/')[0] || 'supabase',
        Database: 'postgres',
        Version:  p.version || '-',
      }
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

adminRouter.get('/settings', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const settings = await db.AdminSettings.getAll();
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load settings.' });
  }
});

adminRouter.post('/settings', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  const { key, value } = req.body;
  const allowed = ['maintenance_mode', 'signups_enabled', 'free_tier_analyses', 'whatsapp_feature_enabled'];
  if (!allowed.includes(key)) return res.status(400).json({ success: false, message: 'Invalid setting key.' });
  if (value === undefined || value === null) return res.status(400).json({ success: false, message: 'Setting value is required.' });
  try {
    await db.AdminSettings.set(key, String(value));
    res.json({ success: true });
  } catch (e) {
    console.error(`[Admin] Failed to update setting ${key}:`, e.message);
    res.status(500).json({ success: false, message: 'Failed to update setting: ' + e.message });
  }
});

adminRouter.post('/users/:id/ban', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const user = await db.Users.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const newBanned = !user.is_banned;
    // If unbanning, also clear any login lockout so the user can log in immediately
    const updates = { is_banned: newBanned };
    if (!newBanned) {
      try {
        const intg = typeof user.integrations === 'string' ? JSON.parse(user.integrations) : (user.integrations || {});
        intg.login_lockout = {};
        updates.integrations = intg;
      } catch (_) {}
    }
    await db.Users.update(req.params.id, updates);
    res.json({ success: true, banned: newBanned === 1 });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update user.' });
  }
});

adminRouter.post('/users/:id/plan', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  const { plan } = req.body;
  if (!isValidPlan(plan)) return res.status(400).json({ success: false, message: 'Invalid plan. Choose one of: free, starter, growth, business.' });
  try {
    const planConf = getPlan(plan);
    await db.Users.update(req.params.id, {
      plan,
      analyses_limit:       0,
      analyses_used:        0,
      usage_reset_at:       new Date().toISOString(),
    });
    res.json({ success: true, plan, analyses_limit: 0 });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update user.' });
  }
});

adminRouter.delete('/users/:id', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    await db.Users.delete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
});

adminRouter.delete('/leads/:id', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    await db.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete lead.' });
  }
});

// ── OAuth state cleanup ───────────────────────────────────────
// Sweep expired bridge/state tokens every 5 minutes to prevent memory leaks.
// NOTE: These Maps are in-process only — OAuth will break if multiple server
// instances are running. Move to DB/Redis if you scale horizontally.
setInterval(() => {
  const now = Date.now();
  if (global._oauthBridgeTokens) {
    for (const [k, v] of global._oauthBridgeTokens) if (now > v.expires) global._oauthBridgeTokens.delete(k);
  }
}, 5 * 60_000).unref();

// Support page: owners write to the admin; the admin answers from the admin panel
const { createSupportRouter, createSupportAdminRouter } = require('./routes/support');
adminRouter.use('/support', createSupportAdminRouter(db));
app.use('/api/support', requireAuth, (req, res, next) => (req.method === 'GET' ? next() : verifyCsrfToken(req, res, next)), createSupportRouter(db));

app.use('/api/admin', adminRouter);

// ── Onboard requests (demo bookings + support messages) ────────
// Public POST — no auth — called by the floating widget
const onboardRequestLimiter = rateLimit({
  windowMs: 60_000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests — please wait a moment.' },
});

app.post('/api/onboard/request', onboardRequestLimiter, async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, message: 'Database unavailable.' });
  const { type, name, email, message, requested_slot, business_name, industry } = req.body || {};
  if (!type || !['demo','support'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid type.' });
  if (!email || typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ success: false, message: 'Valid email required.' });
  try {
    const id = require('crypto').randomBytes(16).toString('hex');
    await db.query(
      `INSERT INTO onboard_requests (id,type,name,email,message,requested_slot,business_name,industry,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW())`,
      [
        id, type,
        (name         || '').slice(0, 200) || null,
        email.trim().slice(0, 300),
        (message      || '').slice(0, 2000) || null,
        (type === 'demo' && requested_slot) ? requested_slot : null,
        (business_name|| '').slice(0, 200) || null,
        (industry     || '').slice(0, 100) || null,
      ]
    );
    res.json({ success: true, id });
  } catch (e) {
    console.error('[onboard-request] insert error:', e.message);
    res.status(500).json({ success: false, message: 'Failed to save request.' });
  }
});

// Admin: list requests
adminRouter.get('/requests', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  const type   = req.query.type;
  const status = req.query.status;
  try {
    let sql    = 'SELECT * FROM onboard_requests';
    const vals = [];
    const cond = [];
    if (type   && ['demo','support'].includes(type))                              { vals.push(type);   cond.push(`type=$${vals.length}`); }
    if (status && ['pending','confirmed','cancelled','resolved'].includes(status)) { vals.push(status); cond.push(`status=$${vals.length}`); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = await db.queryAll(sql, vals);
    res.json({ success: true, requests: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load requests.' });
  }
});

// Admin: update status / note
adminRouter.post('/requests/:id', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  const { status, admin_note, requested_slot } = req.body || {};
  const allowed = ['pending','confirmed','cancelled','resolved'];
  if (status && !allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  try {
    const sets = [];
    const vals = [];
    if (status !== undefined)      { vals.push(status);                          sets.push(`status=$${vals.length}`); }
    if (admin_note !== undefined)  { vals.push((admin_note||'').slice(0,1000));   sets.push(`admin_note=$${vals.length}`); }
    if (requested_slot !== undefined) { vals.push(requested_slot);               sets.push(`requested_slot=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update.' });
    vals.push(req.params.id);
    await db.query(`UPDATE onboard_requests SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to update request.' });
  }
});

// Admin: delete a request
adminRouter.delete('/requests/:id', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    await db.query('DELETE FROM onboard_requests WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to delete request.' });
  }
});

// Admin: get + set demo availability windows
adminRouter.get('/demo-slots', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  try {
    const row = await db.AdminSettings.get('demo_availability').catch(() => null);
    const slots = row ? JSON.parse(row) : [
      { day:'monday',    start:'09:00', end:'17:00' },
      { day:'tuesday',   start:'09:00', end:'17:00' },
      { day:'wednesday', start:'09:00', end:'17:00' },
      { day:'thursday',  start:'09:00', end:'17:00' },
      { day:'friday',    start:'09:00', end:'17:00' },
    ];
    res.json({ success: true, slots });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to load demo slots.' });
  }
});

adminRouter.post('/demo-slots', async (req, res) => {
  if (!dbReady) return res.json({ success: false, message: 'Database not available.' });
  const { slots } = req.body || {};
  if (!Array.isArray(slots)) return res.status(400).json({ success: false, message: 'slots must be an array.' });
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const clean = slots.filter(s => s && days.includes(s.day) && /^\d{2}:\d{2}$/.test(s.start||'') && /^\d{2}:\d{2}$/.test(s.end||''));
  try {
    await db.AdminSettings.set('demo_availability', JSON.stringify(clean));
    res.json({ success: true, slots: clean });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed to save demo slots.' });
  }
});

// Public: concrete 30-min slots for the widget slot picker
app.get('/api/onboard/demo-slots', async (req, res) => {
  if (!dbReady) return res.json({ success: true, slots: [] });
  try {
    const row   = await db.AdminSettings.get('demo_availability').catch(() => null);
    const avail = row ? JSON.parse(row) : [
      { day:'monday',    start:'09:00', end:'17:00' },
      { day:'tuesday',   start:'09:00', end:'17:00' },
      { day:'wednesday', start:'09:00', end:'17:00' },
      { day:'thursday',  start:'09:00', end:'17:00' },
      { day:'friday',    start:'09:00', end:'17:00' },
    ];
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const slots = [];
    const now = new Date();
    for (let d = 0; d < 14; d++) {
      const date = new Date(now);
      date.setDate(now.getDate() + d + 1);
      date.setHours(0,0,0,0);
      const dayName = dayNames[date.getDay()];
      const window  = avail.find(a => a.day === dayName);
      if (!window) continue;
      const [sh, sm] = window.start.split(':').map(Number);
      const [eh, em] = window.end.split(':').map(Number);
      let cur = sh * 60 + sm;
      const end = eh * 60 + em;
      while (cur + 30 <= end) {
        const slotDate = new Date(date);
        slotDate.setHours(Math.floor(cur/60), cur%60, 0, 0);
        slots.push(slotDate.toISOString());
        cur += 30;
      }
    }
    res.json({ success: true, slots });
  } catch (e) {
    res.json({ success: true, slots: [] });
  }
});

// ── Static files ──────────────────────────────────────────────
// ── Build ID: changes on every server start, busts CSS/JS cache ─
const BUILD_ID = Date.now().toString(36);

// Serve HTML files with injected build ID so CSS/JS are always fresh
function serveHtmlWithBuildId(req, res) {
  const fileName = req.path.replace(/^\//, '') || 'index.html';
  const filePath = path.join(__dirname, '..', 'public', fileName);
  let html;
  try { html = require('fs').readFileSync(filePath, 'utf8'); } catch(e) { return res.status(404).send('Not found'); }
  // Bust cache for ALL versioned CSS and JS assets (leads, dashboard, pipeline, etc.)
  html = html.replace(/\.(?:css|js)\?v=[^"']*/g, (m) => m.replace(/\?v=.*/, `?v=${BUILD_ID}`));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(html);
}
app.get('/dashboard.html', serveHtmlWithBuildId);
app.get('/leads.html',     serveHtmlWithBuildId);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (filePath.endsWith('.html')) {
      // HTML: never cache — always serve fresh
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(css|js)$/.test(filePath)) {
      // CSS/JS: must-revalidate so browser checks with server on every load.
      // 'immutable' was wrong here — it prevented cache invalidation even with new ?v= strings.
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    } else if (/\.(woff2?|ttf|eot|png|jpg|jpeg|webp|ico|svg)$/.test(filePath)) {
      // Fonts/images: safe to cache long-term, they don't change
      res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }
  next();
});

app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `API route not found: ${req.method} ${req.path}` });
});

if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ success: false, message: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('[Server] Running on http://localhost:' + PORT);
  mailer.verifyConnection().catch(() => {});
  // Reuse the original dbInitPromise so db.init() is never called twice.
  dbInitPromise.then(ok => {
    if (!ok) return;
    if (PROCESS_ROLE === 'web') { console.log('[Server] PROCESS_ROLE=web: background jobs and the inbound queue run in the worker process.'); return; }
    leadsPoller.start(db);
    inboundQueue.start(db, (msg, ctx) => processWhatsAppBatch(db, msg, ctx));
    backupJob.start(db);
    maintenanceJob.start(db);
    require('./services/whatsapp-maintenance').start(db);
    require('./services/retention-job').start(db);
  }).catch(() => {});
});

function gracefulShutdown(signal) {
  console.log(`[Server] ${signal} received — draining connections…`);
  leadsPoller.stop();
  inboundQueue.stop();
  backupJob.stop();
  maintenanceJob.stop();
  require('./services/whatsapp-maintenance').stop();
  require('./services/retention-job').stop();
  server.close(() => { console.log('[Server] All connections closed.'); process.exit(0); });
  setTimeout(() => { console.error('[Server] Drain timeout — forcing exit'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
