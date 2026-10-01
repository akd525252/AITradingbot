// --- ADMIN: SEND CUSTOM EMAIL TO SPECIFIC USERS ---
router.post('/admin/email/send', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { subject, html_content, user_ids } = req.body;
    if (!subject || !html_content) {
      return res.status(400).json({ error: 'Subject and HTML content are required.' });
    }
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'At least one user must be selected.' });
    }

    const db = await getDB();
    const placeholders = user_ids.map(() => '?').join(',');
    const users = await db.all(`SELECT id, email, username, full_name FROM users WHERE id IN (${placeholders}) AND email IS NOT NULL`, user_ids);

    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const ok = await sendSystemEmail(user.email, 'custom_email', {
          subject,
          html_content,
          username: user.username,
          full_name: user.full_name
        });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error(`[EMAIL] Failed to send custom email to ${user.email}:`, e.message);
        failed++;
      }
      // Small delay to respect rate limits
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({ success: true, sent, failed, total: users.length });
  } catch (err) {
    console.error('[EMAIL] Error sending custom emails:', err.message);
    res.status(500).json({ error: 'Failed to send emails: ' + err.message });
  }
});

// --- ADMIN: SEND CUSTOM EMAIL TO ALL ACTIVE USERS ---
router.post('/admin/email/send-all', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const { subject, html_content } = req.body;
    if (!subject || !html_content) {
      return res.status(400).json({ error: 'Subject and HTML content are required.' });
    }

    const db = await getDB();
    const users = await db.all(`SELECT id, email, username, full_name FROM users WHERE status = 'active' AND email IS NOT NULL`);

    if (!users || users.length === 0) {
      return res.json({ success: true, sent: 0, failed: 0, total: 0, message: 'No active users with email addresses found.' });
    }

    let sent = 0, failed = 0;
    for (const user of users) {
      try {
        const ok = await sendSystemEmail(user.email, 'custom_email', {
          subject,
          html_content,
          username: user.username,
          full_name: user.full_name
        });
        if (ok) sent++; else failed++;
      } catch (e) {
        console.error(`[EMAIL] Failed to send bulk email to ${user.email}:`, e.message);
        failed++;
      }
      // Rate limit: 100ms between each send
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({ success: true, sent, failed, total: users.length });
  } catch (err) {
    console.error('[EMAIL] Error sending bulk emails:', err.message);
    res.status(500).json({ error: 'Failed to send bulk emails: ' + err.message });
  }
});
