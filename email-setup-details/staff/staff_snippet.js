// ==================== PANEL NAVIGATION ====================
// Under panel.show(section) handler:
case 'email-events': this.loadEmailEvents(); break;

// ==================== EMAIL EVENTS CONTROLLER METHODS ====================
panel.loadEmailEvents = function() {
  const editor = document.getElementById('email-html-editor');
  if (!editor._listenerAttached) {
    editor.addEventListener('input', () => this.updateEmailPreview());
    editor._listenerAttached = true;
  }
  this.updateEmailPreview();
};

panel.updateEmailPreview = function() {
  clearTimeout(this._emailPreviewTimer);
  this._emailPreviewTimer = setTimeout(() => {
    const html = document.getElementById('email-html-editor').value;
    const frame = document.getElementById('email-preview-frame');
    const status = document.getElementById('email-preview-status');
    if (!html.trim()) {
      status.textContent = 'Waiting for HTML...';
      frame.srcdoc = '<html><body style="display:flex;align-items:center;justify-content:center;height:100%;margin:0;font-family:Outfit,sans-serif;color:#999;"><p>Your email preview will appear here</p></body></html>';
      return;
    }
    frame.srcdoc = html;
    status.textContent = 'Preview updated';
    setTimeout(() => { status.textContent = 'Live'; }, 1500);
  }, 300);
};

panel._validateEmailForm = function() {
  const subject = document.getElementById('email-subject').value.trim();
  const htmlContent = document.getElementById('email-html-editor').value.trim();
  if (!subject) {
    this.toast('Please enter an email subject.', 'error');
    document.getElementById('email-subject').focus();
    return null;
  }
  if (!htmlContent) {
    this.toast('Please enter HTML email content.', 'error');
    document.getElementById('email-html-editor').focus();
    return null;
  }
  return { subject, html_content: htmlContent };
};

panel.sendEmailToAll = async function() {
  const formData = this._validateEmailForm();
  if (!formData) return;

  let userCount = '?';
  try {
    const countRes = await fetch('/api/admin/users', { credentials: 'include' });
    const countData = await countRes.json();
    userCount = (countData.users || countData).filter(u => u.status === 'active' && u.email).length;
  } catch(e) {}

  if (!confirm(`This will send the email to ALL ${userCount} active users. Subject: "${formData.subject}". Proceed?`)) {
    return;
  }

  const progress = document.getElementById('email-send-progress');
  const progressText = document.getElementById('email-send-progress-text');
  progress.style.display = 'flex';
  progressText.textContent = `Sending to ${userCount} users...`;

  try {
    const res = await fetch('/api/admin/email/send-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(formData)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      this.toast(`Broadcast complete! Sent: ${data.sent}, Failed: ${data.failed}`, 'success');
    } else {
      this.toast(data.error || 'Failed to send emails.', 'error');
    }
  } catch (err) {
    this.toast('Network error sending emails.', 'error');
  } finally {
    progress.style.display = 'none';
  }
};

panel.openEmailUserSelector = async function() {
  const formData = this._validateEmailForm();
  if (!formData) return;

  this._emailSelectedIds.clear();
  this.openModal('email-select-users-modal');
  document.getElementById('email-user-search').value = '';

  const listEl = document.getElementById('email-user-list');
  listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">Loading users...</div>';

  try {
    const res = await fetch('/api/admin/users', { credentials: 'include' });
    const data = await res.json();
    this._emailAllUsers = (data.users || data).filter(u => u.email);
    this._renderEmailUserList(this._emailAllUsers);
  } catch (e) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--danger);padding:40px;">Failed to load users.</div>';
  }
};

panel._renderEmailUserList = function(users) {
  const listEl = document.getElementById('email-user-list');
  if (!users.length) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;">No users found.</div>';
    return;
  }
  listEl.innerHTML = users.map(u => {
    const checked = this._emailSelectedIds.has(u.id) ? 'checked' : '';
    const selectedClass = this._emailSelectedIds.has(u.id) ? ' selected' : '';
    const displayName = u.full_name || u.username || 'Unknown';
    return `<div class="email-user-item${selectedClass}" onclick="panel.toggleEmailUser(${u.id}, this)">
      <input type="checkbox" ${checked} onclick="event.stopPropagation(); panel.toggleEmailUser(${u.id}, this.parentElement)">
      <div class="user-info">
        <div class="username">${displayName}</div>
        <div class="user-email">${u.email}</div>
      </div>
    </div>`;
  }).join('');
};

panel.searchEmailUsers = function(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    this._renderEmailUserList(this._emailAllUsers);
    return;
  }
  const filtered = this._emailAllUsers.filter(u =>
    (u.username || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.full_name || '').toLowerCase().includes(q)
  );
  this._renderEmailUserList(filtered);
};

panel.toggleEmailUser = function(id, rowEl) {
  if (this._emailSelectedIds.has(id)) {
    this._emailSelectedIds.delete(id);
  } else {
    this._emailSelectedIds.add(id);
  }
  if (rowEl) {
    const cb = rowEl.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = this._emailSelectedIds.has(id);
    rowEl.classList.toggle('selected', this._emailSelectedIds.has(id));
  }
  this._updateEmailSelectionUI();
};

panel.clearEmailSelection = function() {
  this._emailSelectedIds.clear();
  document.querySelectorAll('.email-user-item').forEach(el => {
    el.classList.remove('selected');
    const cb = el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  this._updateEmailSelectionUI();
};

panel._updateEmailSelectionUI = function() {
  const count = this._emailSelectedIds.size;
  document.getElementById('email-selected-count').textContent = count;
  const btn = document.getElementById('email-send-selected-btn');
  btn.textContent = `Send to ${count} User${count !== 1 ? 's' : ''}`;
  btn.disabled = count === 0;
};

panel.sendEmailToSelected = async function() {
  if (this._emailSelectedIds.size === 0) return;

  const formData = this._validateEmailForm();
  if (!formData) return;

  const count = this._emailSelectedIds.size;
  if (!confirm(`Send this email to ${count} selected user(s)?`)) return;

  this.closeModal('email-select-users-modal');
  const progress = document.getElementById('email-send-progress');
  const progressText = document.getElementById('email-send-progress-text');
  progress.style.display = 'flex';
  progressText.textContent = `Sending to ${count} users...`;

  try {
    const res = await fetch('/api/admin/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        ...formData,
        user_ids: Array.from(this._emailSelectedIds)
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      this.toast(`Sent: ${data.sent}, Failed: ${data.failed}`, 'success');
    } else {
      this.toast(data.error || 'Failed to send emails.', 'error');
    }
  } catch (err) {
    this.toast('Network error sending emails.', 'error');
  } finally {
    progress.style.display = 'none';
  }
};
