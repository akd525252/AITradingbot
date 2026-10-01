/* ================================================
   Gain EX — Admin Account Security Settings
   Handles: Password Change, Email Change, 2FA
   Mounted at: /api/admin-settings
   ================================================ */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { getDB } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'gainex-secret-super-key-123';

// ---- In-memory OTP stores ----
const emailChangeOtps = new Map();
const twoFaOtps       = new Map();

// ---- Auth middleware (admin/employee only) ----
async function requireStaff(req, res, next) {
  let token = req.cookies && (req.cookies.staff_token || req.cookies.token);
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = await getDB();
    const user = await db.get('SELECT id, username, email, role, status FROM users WHERE id = ?', [decoded.id]);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    if (user.role === 'user') return res.status(403).json({ error: 'Admin or employee access required.' });
    if (user.status === 'blocked') return res.status(403).json({ error: 'Account is blocked.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// ---- Email helper ----
async function sendAdminEmail(to, subject, html) {
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) {
    console.warn('[ADMIN-SETTINGS] SMTP not configured.');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false }
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html
    });
  } catch (err) {
    console.error('[ADMIN-SETTINGS EMAIL ERROR]:', err.message);
  }
}

// ---- OTP email template (string concatenation — no template literals) ----
function buildOtpEmail(title, subtitle, otp, expiryText) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:32px 16px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">'
    + '<div style="max-width:480px;margin:0 auto;background:#1e293b;border-radius:16px;border:1px solid rgba(255,255,255,0.06);padding:36px;">'
    + '<div style="font-size:22px;font-weight:800;color:#22c55e;margin-bottom:6px;">Gain EX <span style="color:#fff;font-weight:400;">Admin</span></div>'
    + '<div style="width:40px;height:2px;background:linear-gradient(90deg,#22c55e,transparent);margin-bottom:28px;border-radius:2px;"></div>'
    + '<h2 style="margin:0 0 10px;font-size:18px;font-weight:700;color:#f1f5f9;">' + title + '</h2>'
    + '<p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">' + subtitle + '</p>'
    + '<div style="background:rgba(34,197,94,0.08);border:1px dashed #22c55e;border-radius:10px;padding:18px 24px;text-align:center;margin-bottom:20px;">'
    + '<div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#22c55e;font-family:monospace;">' + otp + '</div></div>'
    + '<p style="color:#475569;font-size:12px;margin:0;">This code expires in ' + expiryText + '. Do not share it with anyone.</p>'
    + '</div></body></html>';
}

// ---- Ensure 2FA and Demo columns exist ----
async function ensureColumns() {
  try {
    const db = await getDB();
    if (db.isPg) {
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled BOOLEAN DEFAULT FALSE');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_email VARCHAR(255) DEFAULT NULL');
      await db.run("ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_force_next_trade VARCHAR(50) DEFAULT 'none'");
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_trade_win_chance INTEGER DEFAULT NULL');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_slippage_delay_ms INTEGER DEFAULT 0');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_slippage_pct NUMERIC(15,2) DEFAULT 0.0');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_auto_loss_balance NUMERIC(15,2) DEFAULT NULL');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_auto_loss_pct NUMERIC(15,2) DEFAULT NULL');
      await db.run('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_initial_balance NUMERIC(15,2) DEFAULT 10000.0');
    } else {
      try { await db.run('ALTER TABLE users ADD COLUMN two_fa_enabled INTEGER DEFAULT 0'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN two_fa_email TEXT DEFAULT NULL'); } catch (_) {}
      try { await db.run("ALTER TABLE users ADD COLUMN demo_force_next_trade TEXT DEFAULT 'none'"); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_trade_win_chance INTEGER DEFAULT NULL'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_slippage_delay_ms INTEGER DEFAULT 0'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_slippage_pct REAL DEFAULT 0.0'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_auto_loss_balance REAL DEFAULT NULL'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_auto_loss_pct REAL DEFAULT NULL'); } catch (_) {}
      try { await db.run('ALTER TABLE users ADD COLUMN demo_initial_balance REAL DEFAULT 10000.0'); } catch (_) {}
    }
    console.log('[ADMIN-SETTINGS] Columns migration successfully completed.');
  } catch (err) {
    console.warn('[ADMIN-SETTINGS] Column migration warning:', err.message);
  }
}
ensureColumns().catch(console.error);

// GET /api/admin-settings/profile
router.get('/profile', requireStaff, async (req, res) => {
  try {
    const db = await getDB();
    let user;
    try {
      user = await db.get('SELECT email, two_fa_enabled, two_fa_email FROM users WHERE id = ?', [req.user.id]);
    } catch (_) {
      user = await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]);
    }
    res.json({
      success: true,
      email: (user && user.email) || '',
      two_fa_enabled: !!(user && user.two_fa_enabled),
      two_fa_email: (user && (user.two_fa_email || user.email)) || ''
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/change-password
router.post('/change-password', requireStaff, async (req, res) => {
  const current_password  = req.body.current_password;
  const new_password      = req.body.new_password;
  const confirm_password  = req.body.confirm_password;
  if (!current_password || !new_password || !confirm_password) return res.status(400).json({ error: 'All fields are required.' });
  if (new_password !== confirm_password) return res.status(400).json({ error: 'New passwords do not match.' });
  if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  try {
    const db = await getDB();
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(new_password, salt);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/change-email/request
router.post('/change-email/request', requireStaff, async (req, res) => {
  const new_email = req.body.new_email;
  if (!new_email || !new_email.includes('@')) return res.status(400).json({ error: 'A valid email address is required.' });
  try {
    const db = await getDB();
    const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [new_email.trim().toLowerCase(), req.user.id]);
    if (existing) return res.status(400).json({ error: 'This email is already registered to another account.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    emailChangeOtps.set(req.user.id, { otp, newEmail: new_email.trim().toLowerCase(), expires });
    const subtitle = 'You requested to update your admin email to <strong style="color:#f1f5f9;">' + new_email.trim() + '</strong>. Use the code below to confirm.';
    const html = buildOtpEmail('Email Change Verification', subtitle, otp, '10 minutes');
    await sendAdminEmail(new_email.trim(), 'Admin Email Change OTP — Gain EX', html);
    res.json({ success: true, message: 'Verification code sent to ' + new_email.trim() + '.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/change-email/verify
router.post('/change-email/verify', requireStaff, async (req, res) => {
  const otp = req.body.otp;
  if (!otp) return res.status(400).json({ error: 'OTP code is required.' });
  const pending = emailChangeOtps.get(req.user.id);
  if (!pending) return res.status(400).json({ error: 'No pending email change. Request a new code.' });
  if (Date.now() > pending.expires) { emailChangeOtps.delete(req.user.id); return res.status(400).json({ error: 'Code expired. Request a new one.' }); }
  if (pending.otp !== otp.trim()) return res.status(400).json({ error: 'Invalid verification code.' });
  try {
    const db = await getDB();
    await db.run('UPDATE users SET email = ? WHERE id = ?', [pending.newEmail, req.user.id]);
    emailChangeOtps.delete(req.user.id);
    res.json({ success: true, message: 'Email updated successfully.', new_email: pending.newEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/2fa/toggle
router.post('/2fa/toggle', requireStaff, async (req, res) => {
  const enable      = req.body.enable;
  const two_fa_email = req.body.two_fa_email;
  try {
    const db = await getDB();
    let user;
    try { user = await db.get('SELECT email, two_fa_email FROM users WHERE id = ?', [req.user.id]); }
    catch (_) { user = await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]); }
    const targetEmail = (two_fa_email && two_fa_email.trim()) || (user && (user.two_fa_email || user.email)) || '';
    if (enable && !targetEmail) return res.status(400).json({ error: 'An email address is required to enable 2FA.' });
    try {
      await db.run('UPDATE users SET two_fa_enabled = ?, two_fa_email = ? WHERE id = ?', [enable ? 1 : 0, targetEmail || null, req.user.id]);
    } catch (_) {
      return res.status(500).json({ error: 'Could not save 2FA settings. Please refresh and try again.' });
    }
    res.json({ success: true, message: enable ? '2FA enabled successfully.' : '2FA has been disabled.', two_fa_enabled: !!enable, two_fa_email: targetEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/2fa/request-otp
router.post('/2fa/request-otp', requireStaff, async (req, res) => {
  try {
    const db = await getDB();
    let user;
    try { user = await db.get('SELECT email, two_fa_enabled, two_fa_email FROM users WHERE id = ?', [req.user.id]); }
    catch (_) { user = await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]); }
    if (!(user && user.two_fa_enabled)) return res.status(400).json({ error: '2FA is not enabled for this account.' });
    const targetEmail = (user && (user.two_fa_email || user.email)) || '';
    if (!targetEmail) return res.status(400).json({ error: 'No email configured for 2FA.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000;
    twoFaOtps.set(req.user.id, { otp, expires });
    const html = buildOtpEmail('Two-Factor Authentication', 'A login attempt was detected on your Gain EX Staff Panel. Use the code below to verify your identity.', otp, '5 minutes');
    await sendAdminEmail(targetEmail, '2FA Login Code — Gain EX Admin', html);
    const masked = targetEmail.replace(/(.{2})([^@]*)(@.*)/, '$1***$3');
    res.json({ success: true, message: '2FA code sent to ' + masked + '.', email_hint: masked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-settings/2fa/verify-session
router.post('/2fa/verify-session', requireStaff, async (req, res) => {
  const otp = req.body.otp;
  if (!otp) return res.status(400).json({ error: 'OTP code is required.' });
  const pending = twoFaOtps.get(req.user.id);
  if (!pending) return res.status(400).json({ error: 'No 2FA session pending. Log in again to get a new code.' });
  if (Date.now() > pending.expires) { twoFaOtps.delete(req.user.id); return res.status(400).json({ error: 'Code expired. Please log in again.' }); }
  if (pending.otp !== otp.trim()) return res.status(400).json({ error: 'Incorrect code. Please try again.' });
  twoFaOtps.delete(req.user.id);
  res.json({ success: true, message: '2FA verified. Welcome back.' });
});

module.exports = router;
