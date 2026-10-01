/* ================================================
   Gain EX — Staff Control Panel JavaScript
   All admin/employee functions
   ================================================ */

// Intercept all local API fetch calls to include credentials and support Authorization header fallback
const originalFetch = window.fetch;
window.fetch = function (url, options) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    options = options || {};
    options.credentials = 'include';

    // Inject Authorization header if staff_token exists in localStorage
    try {
      const token = localStorage.getItem('staff_token');
      if (token) {
        options.headers = options.headers || {};
        if (typeof Headers !== 'undefined' && options.headers instanceof Headers) {
          if (!options.headers.has('Authorization')) {
            options.headers.set('Authorization', `Bearer ${token}`);
          }
        } else {
          if (!options.headers['Authorization']) {
            options.headers['Authorization'] = `Bearer ${token}`;
          }
        }
      }
    } catch (e) {
      console.warn('LocalStorage staff_token fetch failed:', e);
    }
  }
  return originalFetch(url, options);
};

const panel = {
  user: null,
  permissions: null,
  currentSection: 'dashboard',
  depositFilter: 'pending',
  withdrawalFilter: 'pending',
  tradeFilter: 'active',
  allUsersCache: [],
  tradesRefreshInterval: null,
  usersRefreshInterval: null,

  // Alarm states
  lastPendingDeposits: null,
  lastPendingWithdrawals: null,
  lastPendingKycs: null,
  activeAlarmsCount: 0,
  alarmAudioContext: null,
  alarmInterval: null,
  backgroundAlertInterval: null,

  // Full Countries List (192 Countries)
  allCountries: [
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
    "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
    "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia",
    "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica",
    "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt",
    "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon",
    "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guyana", "Haiti",
    "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy",
    "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia",
    "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia",
    "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco",
    "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand",
    "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine",
    "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia",
    "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia",
    "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan",
    "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania",
    "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda",
    "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Venezuela", "Vietnam", "Yemen",
    "Zambia", "Zimbabwe"
  ],

  initCountrySelects() {
    const list = this.allCountries;
    const datalist = document.getElementById('all-countries-list');
    if (datalist && datalist.options && datalist.options.length === 0) {
      datalist.innerHTML = list.map(c => `<option value="${c}">`).join('');
    }

    const ewSelect = document.getElementById('ewallet-country');
    const userSelect = document.getElementById('manage-kyc-country');

    if (ewSelect && ewSelect.tagName === 'SELECT' && ewSelect.options.length <= 1) {
      const currentVal = ewSelect.value || 'Pakistan';
      ewSelect.innerHTML = list.map(c => `<option value="${c}" ${c === 'Pakistan' ? 'selected' : ''}>${c}</option>`).join('');
      ewSelect.value = currentVal;
    }

    if (userSelect && userSelect.tagName === 'SELECT' && userSelect.options.length <= 1) {
      const currentVal = userSelect.value || '';
      userSelect.innerHTML = `<option value="">-- Select Country --</option>` + list.map(c => `<option value="${c}">${c}</option>`).join('');
      userSelect.value = currentVal;
    }
  },

  setCountrySelect(id, value, defaultValue = '') {
    this.initCountrySelects();
    const el = document.getElementById(id);
    if (!el) return;
    const target = (value !== undefined && value !== null && String(value).trim() !== '') ? String(value).trim() : (defaultValue || '');
    
    if (el.tagName === 'INPUT') {
      el.value = target;
      return;
    }

    if (!target) {
      el.value = '';
      return;
    }
    let matched = false;
    for (let i = 0; i < el.options.length; i++) {
      if (el.options[i].value.toLowerCase() === target.toLowerCase()) {
        el.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched && target) {
      const opt = new Option(target, target, true, true);
      el.appendChild(opt);
      el.value = target;
    }
  },

  // ==================== INIT ====================
  async init() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.user.role === 'user') {
          // Regular users cannot access staff panel
          window.location.href = '/';
          return;
        }
        this.user = data.user;
        this.permissions = data.permissions;
        this.bootPanel();
      } else {
        console.warn('Staff session check rejected:', res.status);
        this.showLogin();
      }
    } catch (e) {
      console.error('Staff session check failed with exception:', e);
      this.showLogin();
    }
  },

  showLogin() {
    document.getElementById('login-page').classList.remove('hidden');
    document.getElementById('main-panel').classList.add('hidden');
  },

  bootPanel() {
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('main-panel').classList.remove('hidden');

    // Remove any browser extension injected iframes (TronLink, MetaMask, etc.)
    // that can create invisible overlays and block all click events
    const removeExtIframes = () => {
      document.querySelectorAll('body > iframe, body > div > iframe').forEach(f => {
        // Only remove iframes with no meaningful src (injected overlays)
        const src = f.getAttribute('src') || '';
        if (!src || src === 'about:blank' || src.startsWith('chrome-extension://') || src.startsWith('moz-extension://')) {
          f.style.pointerEvents = 'none';
          f.style.display = 'none';
        }
      });
    };
    removeExtIframes();
    // Also watch for late-injected iframes
    setTimeout(removeExtIframes, 500);
    setTimeout(removeExtIframes, 1500);

    // Set sidebar user info
    const u = this.user;
    document.getElementById('sidebar-username').textContent = u.username;
    document.getElementById('sidebar-role').textContent = u.role === 'admin' ? 'Administrator' : 'Employee';
    document.getElementById('sidebar-avatar').textContent = u.username.charAt(0).toUpperCase();
    document.getElementById('dash-role-badge').textContent = u.role === 'admin' ? 'Admin' : 'Employee';

    // Show and populate employee invite code if the user is an employee
    const isEmp = u.role === 'employee';
    const sidebarRefContainer = document.getElementById('sidebar-refcode-container');
    const dashRefContainer = document.getElementById('dash-refcode-banner');
    
    if (isEmp && u.invite_code) {
      if (sidebarRefContainer) {
        sidebarRefContainer.style.display = 'flex';
        const codeEl = document.getElementById('sidebar-refcode');
        if (codeEl) codeEl.textContent = u.invite_code;
      }
      if (dashRefContainer) {
        dashRefContainer.style.display = 'flex';
        const codeEl = document.getElementById('dash-refcode');
        if (codeEl) codeEl.textContent = u.invite_code;
      }
    } else {
      if (sidebarRefContainer) sidebarRefContainer.style.display = 'none';
      if (dashRefContainer) dashRefContainer.style.display = 'none';
    }

    // Apply permission-based visibility
    this.applyPermissions();

    // Route based on URL path
    const getRouteFromPath = () => {
      const path = window.location.pathname;
      const match = path.match(/^\/staff\/(.+)$/);
      if (match && match[1]) {
        return match[1].replace(/\/$/, '') || 'dashboard';
      }
      return 'dashboard';
    };

    const initialSection = getRouteFromPath();
    if (document.getElementById(`section-${initialSection}`)) {
      this.show(initialSection, false);
    } else {
      this.show('dashboard', false);
    }

    if (!window.staffPopstateBound) {
      window.addEventListener('popstate', () => {
        const section = getRouteFromPath();
        if (document.getElementById(`section-${section}`)) {
          this.show(section, false);
        }
      });
      window.staffPopstateBound = true;
    }

    // Start background alert polling for new KYCs, deposits, and withdrawals
    this.startBackgroundAlertPolling();
  },

  copyRefCode() {
    const code = this.user?.invite_code;
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        this.toast('Referral code copied to clipboard!', 'success');
      }).catch(err => {
        this.toast('Failed to copy referral code.', 'error');
      });
    }
  },

  copyRefLink() {
    const code = this.user?.invite_code;
    if (code) {
      const link = `${window.location.origin}/?ref=${code}`;
      navigator.clipboard.writeText(link).then(() => {
        this.toast('Referral link copied to clipboard!', 'success');
      }).catch(err => {
        this.toast('Failed to copy referral link.', 'error');
      });
    }
  },

  async loadAiBotKeys(searchQuery = '') {
    // Also load Bot Platform components in parallel
    this.loadBotServices();
    this.loadBotPaymentMethods();
    this.loadBotOrders();
    this.loadBotTickets();

    try {
      const res = await fetch(`/api/admin/aibot/keys?search=${encodeURIComponent(searchQuery)}&t=${Date.now()}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch keys');
      }
      const data = await res.json();
      this._cachedKeys = data.keys || [];
      const tbody = document.getElementById('aibot-keys-table-body');
      if (!tbody) return;

      if (!data.keys || data.keys.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">
              No activation keys generated yet.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = data.keys.map(k => {
        const isUsed = (k.is_used === true || k.is_used === 1 || k.is_used === 'true' || k.is_used === '1');
        const isRevoked = (k.is_revoked === true || k.is_revoked === 1 || k.is_revoked === 'true' || k.is_revoked === '1');

        let statusBadge = `<span class="badge badge-gray">Unused</span>`;
        if (isRevoked) {
          statusBadge = `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">Revoked</span>`;
        } else if (isUsed) {
          statusBadge = `<span class="badge badge-green">Activated</span>`;
        }

        const isEnabled = (k.is_enabled !== 0 && k.is_enabled !== '0' && k.is_enabled !== false && k.is_enabled !== 'false');

        const statusColumn = `
          <div style="display: flex; align-items: center; gap: 8px;">
            ${statusBadge}
            <label class="toggle-switch" style="transform: scale(0.85); margin: 0; min-width: 44px; display: inline-block;">
              <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="panel.toggleIndividualAiBotKey(${k.id}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </div>
        `;
        
        const activatedBy = isUsed && k.username
          ? `<span style="font-weight: 700; color: var(--primary);">${this.esc(k.username)}${k.full_name ? ` (${this.esc(k.full_name)})` : ''}</span>`
          : `<span style="color: var(--text-muted);">--</span>`;

        const createdAt = k.created_at ? new Date(k.created_at).toLocaleString() : '--';
        const activatedAt = k.activated_at ? new Date(k.activated_at).toLocaleString() : '--';
        const timer = k.bot_timer ? `${k.bot_timer}s` : '60s';
        const invest = k.investment_pct ? `${k.investment_pct}%` : '10%';
        const limit = (k.daily_limit !== undefined && k.daily_limit !== null) ? k.daily_limit : 100;

        let actionBtn = '';
        if (isRevoked) {
          actionBtn = `
            <button class="btn-action btn-approve" onclick="panel.restoreAiBotKey(${k.id})" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; margin-right: 6px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">
              Restore
            </button>
          `;
        } else {
          actionBtn = `
            <button class="btn-action btn-danger" onclick="panel.revokeAiBotKey(${k.id})" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; margin-right: 6px;">
              Revoke
            </button>
          `;
        }

        return `
          <tr>
            <td style="font-family: monospace; font-weight: 700; font-size: 13.5px; color: var(--text);">${this.esc(k.key_code)}</td>
            <td>${statusColumn}</td>
            <td>${activatedBy}</td>
            <td style="font-weight: 600; color: var(--text-sec);">${timer}</td>
            <td style="font-weight: 600; color: var(--text-sec);">${invest}</td>
            <td style="font-weight: 600; color: var(--text-sec);">${limit}</td>
            <td style="font-size: 12px; color: var(--text-sec);">${createdAt}</td>
            <td style="font-size: 12px; color: var(--text-sec);">${activatedAt}</td>
            <td style="text-align: right; padding-right: 16px; white-space: nowrap;">
              <button class="btn-action btn-approve" onclick="panel.openEditAiBotKeyModal(${k.id})" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; margin-right: 6px;">
                Edit
              </button>
              ${actionBtn}
              <button class="btn-action btn-danger" onclick="panel.deleteAiBotKey(${k.id})" style="padding: 4px 10px; font-size: 11px; border-radius: 4px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);">
                Delete
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  onAiBotKeysSearchChange(val) {
    if (this._aiBotKeysSearchTimeout) clearTimeout(this._aiBotKeysSearchTimeout);
    this._aiBotKeysSearchTimeout = setTimeout(() => {
      this.loadAiBotKeys(val);
    }, 300);
  },

  async generateAiBotKey() {
    try {
      const timerInput = document.getElementById('aibot-gen-timer');
      const pctInput = document.getElementById('aibot-gen-pct');
      const limitInput = document.getElementById('aibot-gen-limit');

      const bot_timer = parseInt(timerInput ? timerInput.value : 60) || 60;
      const investment_pct = parseInt(pctInput ? pctInput.value : 10) || 10;
      const daily_limit = parseInt(limitInput ? limitInput.value : 100) || 100;

      const res = await fetch('/api/admin/aibot/keys/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_timer, investment_pct, daily_limit }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to generate key');
      }
      this.toast('AI Bot key generated successfully!', 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async loadAiBotMinBalance() {
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const minBal = data.settings && data.settings.aibot_min_balance != null
        ? parseFloat(data.settings.aibot_min_balance)
        : 200;
      const input = document.getElementById('aibot-min-balance-input');
      if (input) input.value = isNaN(minBal) ? 200 : minBal;
    } catch (e) {
      // silently fail — input keeps its default value
    }
  },

  async saveAiBotMinBalance() {
    const input = document.getElementById('aibot-min-balance-input');
    const val = parseFloat(input ? input.value : 200);
    if (isNaN(val) || val < 0) {
      this.toast('Please enter a valid minimum balance (0 or greater).', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ aibot_min_balance: String(val) })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Bot minimum balance requirement set to $${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`, 'success');
      } else {
        this.toast(data.error || 'Failed to save setting.', 'error');
      }
    } catch (e) {
      this.toast('Network error saving bot minimum balance.', 'error');
    }
  },

  openEditAiBotKeyModal(keyId) {
    const key = (this._cachedKeys || []).find(k => k.id === keyId);
    if (!key) return;
    document.getElementById('edit-aibot-key-id').value = key.id;
    document.getElementById('edit-aibot-key-code').value = key.key_code;
    document.getElementById('edit-aibot-key-limit').value = key.daily_limit !== undefined && key.daily_limit !== null ? key.daily_limit : 100;
    // Populate per-key min balance (empty = use global default)
    const minBalInput = document.getElementById('edit-aibot-key-min-balance');
    if (minBalInput) {
      minBalInput.value = (key.min_balance !== undefined && key.min_balance !== null) ? key.min_balance : '';
    }
    const notesInput = document.getElementById('edit-aibot-key-notes');
    if (notesInput) {
      notesInput.value = key.notes || '';
    }

    const errorToggle = document.getElementById('edit-aibot-key-custom-error-toggle');
    const errorMsgContainer = document.getElementById('edit-aibot-key-custom-error-msg-container');
    const errorMsgInput = document.getElementById('edit-aibot-key-custom-error-msg');
    if (errorToggle && errorMsgContainer && errorMsgInput) {
      const errorEnabled = (key.custom_error_enabled === true || key.custom_error_enabled === 1 || key.custom_error_enabled === 'true' || key.custom_error_enabled === '1');
      errorToggle.checked = errorEnabled;
      errorMsgInput.value = key.custom_error_message || '';
      errorMsgContainer.style.display = errorEnabled ? 'block' : 'none';
    }

    // Parse Real sequence
    let sequence = [];
    if (key.trade_sequence) {
      try { sequence = JSON.parse(key.trade_sequence); } catch(e) { sequence = []; }
    }
    if (!Array.isArray(sequence) || sequence.length === 0) {
      sequence = [{ timer: key.bot_timer || 60, pct: key.investment_pct || 10, outcome: 'win' }];
    }

    // Parse Demo sequence
    let demoSequence = [];
    if (key.demo_trade_sequence) {
      try { demoSequence = JSON.parse(key.demo_trade_sequence); } catch(e) { demoSequence = []; }
    }
    if (!Array.isArray(demoSequence) || demoSequence.length === 0) {
      demoSequence = [{ timer: key.bot_timer || 60, pct: key.investment_pct || 10, outcome: 'win' }];
    }

    // Cache local values
    this._aibotActiveTab = 'real';
    this._aibotRealSequence = sequence;
    this._aibotDemoSequence = demoSequence;
    this._aibotDemoType = key.demo_sequence_type || 'random';

    // Show Real tab as active
    const tabReal = document.getElementById('edit-aibot-tab-real');
    const tabDemo = document.getElementById('edit-aibot-tab-demo');
    if (tabReal) tabReal.classList.add('active');
    if (tabDemo) tabDemo.classList.remove('active');

    // Hide demo type controls
    const demoTypeGroup = document.getElementById('aibot-demo-type-group');
    if (demoTypeGroup) demoTypeGroup.style.display = 'none';

    // Hide demo info alert
    const demoRandomInfo = document.getElementById('aibot-demo-random-info');
    if (demoRandomInfo) demoRandomInfo.style.display = 'none';

    // Show custom sequence builder
    const customContainer = document.getElementById('aibot-custom-sequence-container');
    if (customContainer) customContainer.style.display = 'block';

    // Render Real sequence
    this._renderBotSequence(this._aibotRealSequence);

    const isRevoked = (key.is_revoked === true || key.is_revoked === 1 || key.is_revoked === 'true' || key.is_revoked === '1');
    const restoreBtn = document.getElementById('edit-aibot-key-restore-btn');
    const revokeBtn = document.getElementById('edit-aibot-key-revoke-btn');
    if (restoreBtn && revokeBtn) {
      if (isRevoked) {
        restoreBtn.style.display = 'inline-block';
        revokeBtn.style.display = 'none';
      } else {
        restoreBtn.style.display = 'none';
        revokeBtn.style.display = 'inline-block';
      }
    }

    const isUsed = (key.is_used === true || key.is_used === 1 || key.is_used === 'true' || key.is_used === '1' || key.used_by_user_id || key.username);
    const signoutBtn = document.getElementById('edit-aibot-key-signout-btn');
    if (signoutBtn) {
      signoutBtn.style.display = isUsed ? 'inline-block' : 'none';
    }

    const modalToggle = document.getElementById('edit-aibot-key-status-toggle');
    const modalLabel = document.getElementById('edit-aibot-key-status-label');
    if (modalToggle && modalLabel) {
      const isEnabled = (key.is_enabled !== 0 && key.is_enabled !== '0' && key.is_enabled !== false && key.is_enabled !== 'false');
      modalToggle.checked = isEnabled;
      modalLabel.textContent = isEnabled ? 'SHOWING (USER SIDE)' : 'HIDDEN (DISABLED)';
      modalLabel.style.color = isEnabled ? '#10b981' : '#ef4444';
    }

    document.getElementById('aibot-key-edit-modal').classList.remove('hidden');
  },

  _getBotSequenceFromDom() {
    const container = document.getElementById('bot-sequence-rows');
    if (!container) return [];
    const rows = container.querySelectorAll('.bot-seq-row');
    const seq = [];
    for (const row of rows) {
      const timerVal = row.querySelector('.bot-seq-timer');
      const pctVal = row.querySelector('.bot-seq-pct');
      const outcomeVal = row.querySelector('.bot-seq-outcome');
      const timer = timerVal ? (parseInt(timerVal.value) || 60) : 60;
      const pct = pctVal ? (parseInt(pctVal.value) || 10) : 10;
      const outcome = outcomeVal ? (outcomeVal.value || 'win') : 'win';
      seq.push({ timer, pct, outcome });
    }
    return seq;
  },

  _renderBotSequence(sequence) {
    const container = document.getElementById('bot-sequence-rows');
    if (!container) return;
    container.innerHTML = '';
    sequence.forEach((step, idx) => {
      container.appendChild(this._makeBotSequenceRow(idx + 1, step.timer, step.pct, step.outcome));
    });
  },

  switchAiBotTab(tab) {
    if (this._aibotActiveTab === tab) return;

    // Collect and save current rows to the active tab's sequence cache
    if (this._aibotActiveTab === 'real') {
      this._aibotRealSequence = this._getBotSequenceFromDom();
    } else {
      if (this._aibotDemoType === 'custom') {
        this._aibotDemoSequence = this._getBotSequenceFromDom();
      }
    }

    this._aibotActiveTab = tab;

    // Toggle active tab buttons
    const tabReal = document.getElementById('edit-aibot-tab-real');
    const tabDemo = document.getElementById('edit-aibot-tab-demo');
    if (tab === 'real') {
      if (tabReal) tabReal.classList.add('active');
      if (tabDemo) tabDemo.classList.remove('active');
      
      // Hide demo type group & demo alert
      const demoTypeGroup = document.getElementById('aibot-demo-type-group');
      if (demoTypeGroup) demoTypeGroup.style.display = 'none';
      const demoRandomInfo = document.getElementById('aibot-demo-random-info');
      if (demoRandomInfo) demoRandomInfo.style.display = 'none';

      // Show sequence builder
      const customContainer = document.getElementById('aibot-custom-sequence-container');
      if (customContainer) customContainer.style.display = 'block';

      this._renderBotSequence(this._aibotRealSequence);
    } else {
      if (tabReal) tabReal.classList.remove('active');
      if (tabDemo) tabDemo.classList.add('active');

      // Show demo type group
      const demoTypeGroup = document.getElementById('aibot-demo-type-group');
      if (demoTypeGroup) demoTypeGroup.style.display = 'block';

      // Set value of select
      const demoSelect = document.getElementById('edit-aibot-demo-type');
      if (demoSelect) demoSelect.value = this._aibotDemoType;

      this.onChangeDemoSequenceType(this._aibotDemoType);
    }
  },

  onChangeDemoSequenceType(val) {
    this._aibotDemoType = val;
    const demoRandomInfo = document.getElementById('aibot-demo-random-info');
    const customContainer = document.getElementById('aibot-custom-sequence-container');

    if (val === 'random') {
      if (demoRandomInfo) demoRandomInfo.style.display = 'block';
      if (customContainer) customContainer.style.display = 'none';
    } else {
      if (demoRandomInfo) demoRandomInfo.style.display = 'none';
      if (customContainer) customContainer.style.display = 'block';
      this._renderBotSequence(this._aibotDemoSequence);
    }

    const isRevoked = (key.is_revoked === true || key.is_revoked === 1 || key.is_revoked === 'true' || key.is_revoked === '1');
    const restoreBtn = document.getElementById('edit-aibot-key-restore-btn');
    const revokeBtn = document.getElementById('edit-aibot-key-revoke-btn');
    if (restoreBtn && revokeBtn) {
      if (isRevoked) {
        restoreBtn.style.display = 'inline-block';
        revokeBtn.style.display = 'none';
      } else {
        restoreBtn.style.display = 'none';
        revokeBtn.style.display = 'inline-block';
      }
    }

    const modalToggle = document.getElementById('edit-aibot-key-status-toggle');
    const modalLabel = document.getElementById('edit-aibot-key-status-label');
    if (modalToggle && modalLabel) {
      const isEnabled = (key.is_enabled !== 0 && key.is_enabled !== '0' && key.is_enabled !== false && key.is_enabled !== 'false');
      modalToggle.checked = isEnabled;
      modalLabel.textContent = isEnabled ? 'SHOWING (USER SIDE)' : 'HIDDEN (DISABLED)';
      modalLabel.style.color = isEnabled ? '#10b981' : '#ef4444';
    }

    document.getElementById('aibot-key-edit-modal').classList.remove('hidden');
  },

  _makeBotSequenceRow(num, timer, pct, outcome = 'win') {
    const row = document.createElement('div');
    row.className = 'bot-seq-row';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;background:var(--bg-deep);border:1px solid var(--border);border-radius:8px;padding:8px 10px;';
    row.innerHTML = `
      <span style="flex:1;font-size:12px;font-weight:700;color:var(--text-muted);min-width:20px;">${num}</span>
      <input type="number" class="form-control bot-seq-timer" value="${timer}" min="10" placeholder="60"
        style="flex:3;height:34px;font-size:13px;padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;">
      <input type="number" class="form-control bot-seq-pct" value="${pct}" min="1" max="100" placeholder="10"
        style="flex:3;height:34px;font-size:13px;padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;">
      <select class="form-control bot-seq-outcome"
        style="flex:3;height:34px;font-size:13px;padding:4px 8px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;">
        <option value="win" ${outcome === 'win' ? 'selected' : ''}>Win</option>
        <option value="lose" ${outcome === 'lose' ? 'selected' : ''}>Loss</option>
      </select>
      <button type="button" onclick="panel.removeBotSequenceRow(this)"
        style="flex:1;height:34px;border:none;border-radius:6px;background:rgba(239,68,68,0.15);color:#ef4444;font-weight:700;font-size:15px;cursor:pointer;min-width:30px;">×</button>
    `;
    return row;
  },

  addBotSequenceRow() {
    const container = document.getElementById('bot-sequence-rows');
    const rows = container.querySelectorAll('.bot-seq-row');
    const num = rows.length + 1;
    container.appendChild(this._makeBotSequenceRow(num, 60, 10, 'win'));
    this._renumberBotSequenceRows();
  },

  removeBotSequenceRow(btn) {
    const row = btn.closest('.bot-seq-row');
    if (row) row.remove();
    this._renumberBotSequenceRows();
  },

  _renumberBotSequenceRows() {
    const container = document.getElementById('bot-sequence-rows');
    container.querySelectorAll('.bot-seq-row').forEach((row, idx) => {
      const numEl = row.querySelector('span');
      if (numEl) numEl.textContent = idx + 1;
    });
  },

  async saveAiBotKeySettings() {
    try {
      const keyId = document.getElementById('edit-aibot-key-id').value;
      const daily_limit = parseInt(document.getElementById('edit-aibot-key-limit').value) || 100;

      // Collect active sequence from DOM
      const activeSequence = this._getBotSequenceFromDom();

      if (this._aibotActiveTab === 'real') {
        this._aibotRealSequence = activeSequence;
      } else if (this._aibotActiveTab === 'demo' && this._aibotDemoType === 'custom') {
        this._aibotDemoSequence = activeSequence;
      }

      if (this._aibotRealSequence.length === 0) {
        this.toast('Real sequence must contain at least one trade.', 'error');
        return;
      }

      if (this._aibotDemoType === 'custom' && this._aibotDemoSequence.length === 0) {
        this.toast('Custom Demo sequence must contain at least one trade.', 'error');
        return;
      }

      // Use first row of Real sequence as global fallback
      const bot_timer = this._aibotRealSequence[0].timer;
      const investment_pct = this._aibotRealSequence[0].pct;

      // Read per-key min balance override (empty string = null = use global)
      const minBalRaw = document.getElementById('edit-aibot-key-min-balance') ? document.getElementById('edit-aibot-key-min-balance').value.trim() : '';
      const min_balance = minBalRaw !== '' ? parseFloat(minBalRaw) : null;

      const custom_error_enabled = document.getElementById('edit-aibot-key-custom-error-toggle') ? document.getElementById('edit-aibot-key-custom-error-toggle').checked : false;
      const custom_error_message = document.getElementById('edit-aibot-key-custom-error-msg') ? document.getElementById('edit-aibot-key-custom-error-msg').value.trim() : '';

      const res = await fetch('/api/admin/aibot/keys/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyId,
          bot_timer,
          investment_pct,
          daily_limit,
          trade_sequence: this._aibotRealSequence,
          demo_trade_sequence: this._aibotDemoSequence,
          demo_sequence_type: this._aibotDemoType,
          min_balance,
          notes: document.getElementById('edit-aibot-key-notes') ? document.getElementById('edit-aibot-key-notes').value.trim() : '',
          custom_error_enabled,
          custom_error_message
        }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save settings');
      }
      this.toast('AI Bot key settings updated successfully!', 'success');
      this.closeModal('aibot-key-edit-modal');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  onCustomErrorToggle(checked) {
    const container = document.getElementById('edit-aibot-key-custom-error-msg-container');
    if (container) {
      container.style.display = checked ? 'block' : 'none';
    }
  },

  async revokeAiBotKey(keyId) {
    if (!confirm('Are you sure you want to revoke this key? This will suspend the key and immediately disable AI Bot access for the user.')) {
      return;
    }
    try {
      const res = await fetch('/api/admin/aibot/keys/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to revoke key');
      }
      this.toast('Key successfully revoked!', 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async restoreAiBotKey(keyId) {
    if (!confirm('Are you sure you want to restore this key? This will re-enable the key and restore the AI Bot connection.')) {
      return;
    }
    try {
      const res = await fetch('/api/admin/aibot/keys/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to restore key');
      }
      this.toast('Key successfully restored!', 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async deleteAiBotKey(keyId) {
    if (!confirm('Are you sure you want to completely delete this key? This action is irreversible.')) {
      return;
    }
    try {
      const res = await fetch('/api/admin/aibot/keys/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete key');
      }
      this.toast('Key successfully deleted!', 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async loadAiBotGlobalStatus() {
    try {
      const res = await fetch('/api/admin/aibot/global-status', { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load global status');
      }
      const data = await res.json();
      const toggle = document.getElementById('aibot-global-status-toggle');
      const label = document.getElementById('aibot-global-status-label');
      if (toggle) toggle.checked = !!data.enabled;
      if (label) {
        label.textContent = data.enabled ? 'ACTIVE (SHOW)' : 'INACTIVE (HIDDEN)';
        label.style.color = data.enabled ? '#10b981' : '#ef4444';
      }
    } catch (err) {
      console.warn('Failed to load global bot status:', err);
    }
  },

  async toggleAiBotGlobalStatus(enabled) {
    try {
      const res = await fetch('/api/admin/aibot/global-status/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to toggle status');
      }
      const data = await res.json();
      const label = document.getElementById('aibot-global-status-label');
      if (label) {
        label.textContent = data.enabled ? 'ACTIVE (SHOW)' : 'INACTIVE (HIDDEN)';
        label.style.color = data.enabled ? '#10b981' : '#ef4444';
      }
      this.toast(`AI Bot globally turned ${data.enabled ? 'ON' : 'OFF'}!`, 'success');
    } catch (err) {
      this.toast(err.message, 'error');
      // Revert checkbox state
      const toggle = document.getElementById('aibot-global-status-toggle');
      if (toggle) toggle.checked = !enabled;
    }
  },
   async onEditModalRestoreKey() {
    const keyId = parseInt(document.getElementById('edit-aibot-key-id').value);
    if (keyId) {
      await this.restoreAiBotKey(keyId);
      this.closeModal('aibot-key-edit-modal');
    }
  },

  async onEditModalRevokeKey() {
    const keyId = parseInt(document.getElementById('edit-aibot-key-id').value);
    if (keyId) {
      await this.revokeAiBotKey(keyId);
      this.closeModal('aibot-key-edit-modal');
    }
  },

  async onEditModalDeleteKey() {
    const keyId = parseInt(document.getElementById('edit-aibot-key-id').value);
    if (keyId) {
      await this.deleteAiBotKey(keyId);
      this.closeModal('aibot-key-edit-modal');
    }
  },

  async onEditModalSignOutKey() {
    const keyId = parseInt(document.getElementById('edit-aibot-key-id').value);
    if (keyId) {
      await this.signOutAiBotKey(keyId);
      this.closeModal('aibot-key-edit-modal');
    }
  },

  async signOutAiBotKey(keyId) {
    if (!confirm('Are you sure you want to sign out this key? This will remove the key from the linked user account, end their bot session, and make this key fresh and new for any other user to activate.')) {
      return;
    }
    try {
      const res = await fetch('/api/admin/aibot/keys/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to sign out key');
      }
      this.toast('Key successfully signed out! It is now fresh and ready for any user to use.', 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async toggleIndividualAiBotKey(keyId, enabled) {
    try {
      const res = await fetch('/api/admin/aibot/keys/toggle-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, enabled }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to toggle key visibility');
      }
      const data = await res.json();
      this.toast(data.message || `Bot visibility successfully toggled!`, 'success');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    }
  },

  async toggleEditModalKeyStatus(enabled) {
    const keyId = parseInt(document.getElementById('edit-aibot-key-id').value);
    if (!keyId) return;
    try {
      const res = await fetch('/api/admin/aibot/keys/toggle-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, enabled }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to toggle key visibility');
      }
      const data = await res.json();
      this.toast(data.message || `Bot visibility successfully toggled!`, 'success');
      
      // Update modal label styles immediately
      const modalLabel = document.getElementById('edit-aibot-key-status-label');
      if (modalLabel) {
        modalLabel.textContent = enabled ? 'SHOWING (USER SIDE)' : 'HIDDEN (DISABLED)';
        modalLabel.style.color = enabled ? '#10b981' : '#ef4444';
      }

      const searchInput = document.getElementById('aibot-keys-search');
      this.loadAiBotKeys(searchInput ? searchInput.value : '');
    } catch (err) {
      this.toast(err.message, 'error');
      // Revert status toggle state
      const toggle = document.getElementById('edit-aibot-key-status-toggle');
      if (toggle) toggle.checked = !enabled;
    }
  },

  // ==================== BOT SERVICES & PRICING MANAGER ====================
  async loadBotServices() {
    try {
      const res = await fetch(`/api/admin/bot-services?t=${Date.now()}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load bot services');
      }
      const data = await res.json();
      this._cachedBotServices = data.services || [];
      const tbody = document.getElementById('bot-services-table-body');
      if (!tbody) return;

      if (!this._cachedBotServices.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="10" style="text-align: center; color: var(--text-muted); padding: 30px;">
              No bot services configured yet. Click "+ Add New Service" to create one.
            </td>
          </tr>
        `;
        return;
      }

      const now = new Date();

      tbody.innerHTML = this._cachedBotServices.map(s => {
        const isHighlight = !!s.is_highlighted;
        const isActive = !!s.is_active;
        const isTimerOn = !!s.offer_timer_enabled;
        const offerEnds = s.offer_ends_at ? new Date(s.offer_ends_at) : null;
        const hasValidDate = offerEnds && !isNaN(offerEnds.getTime());

        let timerHtml = '<span style="color: var(--text-muted); font-size: 11px;">Disabled</span>';
        if (isTimerOn && hasValidDate) {
          const diffMs = offerEnds.getTime() - now.getTime();
          if (diffMs > 0) {
            const hrs = Math.floor(diffMs / (1000 * 60 * 60));
            const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            timerHtml = `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 10px; font-weight: 700;">⏳ ${hrs}h ${mins}m left</span>`;
          } else {
            timerHtml = `<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #ff6251; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 10px; font-weight: 700;">⏱️ Expired (00:00:00)</span>`;
          }
        }

        const logoImg = s.logo_url ? `<img src="${this.esc(s.logo_url)}" style="width:28px; height:28px; object-fit:contain; border-radius:6px; background:rgba(255,255,255,0.05); padding:2px; border:1px solid var(--border);" onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-block';"><span style="display:none; font-size:18px;">${this.esc(s.icon || '🤖')}</span>` : `<span style="font-size:20px;">${this.esc(s.icon || '🤖')}</span>`;

        const offerPriceVal = parseFloat(String(s.price).replace(/[^0-9.]/g, '') || 0).toFixed(2);
        const actualPriceVal = parseFloat(String(s.actual_price || s.price).replace(/[^0-9.]/g, '') || 0).toFixed(2);

        return `
          <tr style="${isHighlight ? 'background: rgba(16, 185, 129, 0.05);' : ''}">
            <td style="text-align: center; vertical-align: middle;">${logoImg}</td>
            <td>
              <div style="font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 6px;">
                ${this.esc(s.name)}
                ${isHighlight ? '<span class="badge badge-green" style="font-size: 10px; padding: 2px 6px;">FEATURED</span>' : ''}
              </div>
              <div style="font-size: 11px; color: var(--text-muted); max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${this.esc(s.description || '')}
              </div>
            </td>
            <td><code style="font-size: 12px; color: var(--primary); background: rgba(16,185,129,0.1); padding: 2px 6px; border-radius: 4px;">${this.esc(s.service_key)}</code></td>
            <td>
              <span style="font-size: 14px; font-weight: 800; color: #3b82f6;">$${offerPriceVal}</span>
            </td>
            <td>
              <span style="font-size: 14px; font-weight: 700; color: #10b981;">$${actualPriceVal}</span>
            </td>
            <td>${timerHtml}</td>
            <td>
              ${s.badge ? `<span class="badge" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 10px;">${this.esc(s.badge)}</span>` : '<span style="color: var(--text-muted); font-size: 12px;">--</span>'}
            </td>
            <td>
              <label class="toggle-switch" style="transform: scale(0.8); margin: 0;">
                <input type="checkbox" ${isHighlight ? 'checked' : ''} onchange="panel.toggleServiceHighlight(${s.id}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <label class="toggle-switch" style="transform: scale(0.8); margin: 0;">
                <input type="checkbox" ${isActive ? 'checked' : ''} onchange="panel.toggleServiceActive(${s.id}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td style="text-align: right; padding-right: 16px;">
              <button class="btn-action btn-edit" onclick="panel.openEditServiceModal(${s.id})" title="Edit Service" style="padding: 4px 8px; font-size: 11px; border-radius: 4px; margin-right: 4px;">
                Edit
              </button>
              <button class="btn-action btn-reject" onclick="panel.deleteBotService(${s.id})" title="Delete Service" style="padding: 4px 8px; font-size: 11px; border-radius: 4px;">
                Delete
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load bot services:', err);
      const tbody = document.getElementById('bot-services-table-body');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger); padding: 20px;">Failed to load services: ${this.esc(err.message)}</td></tr>`;
      }
    }
  },

  setServiceTimerPreset(hours) {
    const target = new Date(Date.now() + hours * 60 * 60 * 1000);
    // Format for datetime-local (YYYY-MM-DDTHH:mm)
    const year = target.getFullYear();
    const month = String(target.getMonth() + 1).padStart(2, '0');
    const day = String(target.getDate()).padStart(2, '0');
    const hh = String(target.getHours()).padStart(2, '0');
    const mm = String(target.getMinutes()).padStart(2, '0');
    const formatted = `${year}-${month}-${day}T${hh}:${mm}`;

    const input = document.getElementById('service-edit-offer-ends-at');
    const toggle = document.getElementById('service-edit-timer-enabled');
    if (input) input.value = formatted;
    if (toggle) toggle.checked = true;
  },

  clearServiceTimer() {
    const input = document.getElementById('service-edit-offer-ends-at');
    const toggle = document.getElementById('service-edit-timer-enabled');
    if (input) input.value = '';
    if (toggle) toggle.checked = false;
  },

  openAddServiceModal() {
    document.getElementById('bot-service-modal-title').textContent = 'Add New Bot Service';
    document.getElementById('service-edit-id').value = '';
    document.getElementById('service-edit-name').value = '';
    document.getElementById('service-edit-key').value = '';
    document.getElementById('service-edit-price').value = '99';
    document.getElementById('service-edit-actual-price').value = '199';
    document.getElementById('service-edit-offer-ends-at').value = '';
    document.getElementById('service-edit-timer-enabled').checked = false;
    document.getElementById('service-edit-logo').value = '';
    document.getElementById('service-edit-icon').value = '🤖';
    document.getElementById('service-edit-badge').value = '';
    document.getElementById('service-edit-order').value = '0';
    document.getElementById('service-edit-description').value = '';
    document.getElementById('service-edit-features').value = 'Algorithmic signal execution\nSmart multi-timeframe analytics\n24/7 Auto Execution\nFull Risk Control Engine';
    document.getElementById('service-edit-highlighted').checked = false;
    document.getElementById('service-edit-active').checked = true;

    this.openModal('bot-service-edit-modal');
  },

  openEditServiceModal(serviceId) {
    const service = (this._cachedBotServices || []).find(s => s.id === serviceId);
    if (!service) return;

    document.getElementById('bot-service-modal-title').textContent = `Edit ${service.name}`;
    document.getElementById('service-edit-id').value = service.id;
    document.getElementById('service-edit-name').value = service.name || '';
    document.getElementById('service-edit-key').value = service.service_key || '';
    document.getElementById('service-edit-price').value = service.price || 0;
    document.getElementById('service-edit-actual-price').value = service.actual_price || service.price || 0;

    let endsAtVal = '';
    if (service.offer_ends_at) {
      try {
        const d = new Date(service.offer_ends_at);
        if (!isNaN(d.getTime())) {
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          endsAtVal = `${year}-${month}-${day}T${hh}:${mm}`;
        }
      } catch (e) {}
    }
    document.getElementById('service-edit-offer-ends-at').value = endsAtVal;
    document.getElementById('service-edit-timer-enabled').checked = !!service.offer_timer_enabled;

    document.getElementById('service-edit-logo').value = service.logo_url || '';
    document.getElementById('service-edit-icon').value = service.icon || '🤖';
    document.getElementById('service-edit-badge').value = service.badge || '';
    document.getElementById('service-edit-order').value = service.display_order || service.sort_order || 0;
    document.getElementById('service-edit-description').value = service.description || '';
    
    let featuresStr = '';
    if (Array.isArray(service.features)) {
      featuresStr = service.features.join('\n');
    } else if (typeof service.features === 'string') {
      try {
        const parsed = JSON.parse(service.features);
        featuresStr = Array.isArray(parsed) ? parsed.join('\n') : service.features;
      } catch (e) {
        featuresStr = service.features;
      }
    }
    document.getElementById('service-edit-features').value = featuresStr;
    document.getElementById('service-edit-highlighted').checked = !!service.is_highlighted;
    document.getElementById('service-edit-active').checked = !!service.is_active;

    this.openModal('bot-service-edit-modal');
  },

  async saveBotService() {
    const id = document.getElementById('service-edit-id').value;
    const name = document.getElementById('service-edit-name').value.trim();
    const service_key = document.getElementById('service-edit-key').value.trim();
    const price = parseFloat(document.getElementById('service-edit-price').value) || 0;
    const actual_price = parseFloat(document.getElementById('service-edit-actual-price').value) || price;
    const offerEndsInput = document.getElementById('service-edit-offer-ends-at').value;
    const offer_ends_at = offerEndsInput ? new Date(offerEndsInput).toISOString() : null;
    const offer_timer_enabled = document.getElementById('service-edit-timer-enabled').checked;

    const logo_url = document.getElementById('service-edit-logo') ? document.getElementById('service-edit-logo').value.trim() : '';
    const icon = document.getElementById('service-edit-icon').value.trim() || '🤖';
    const badge = document.getElementById('service-edit-badge').value.trim();
    const display_order = parseInt(document.getElementById('service-edit-order').value) || 0;
    const description = document.getElementById('service-edit-description').value.trim();
    const featuresRaw = document.getElementById('service-edit-features').value;
    const features = featuresRaw.split('\n').map(f => f.trim()).filter(Boolean);
    const is_highlighted = document.getElementById('service-edit-highlighted').checked;
    const is_active = document.getElementById('service-edit-active').checked;

    if (!name || !service_key) {
      this.toast('Service Name and Key are required.', 'error');
      return;
    }

    try {
      const endpoint = id ? '/api/admin/bot-services/update' : '/api/admin/bot-services/add';
      const body = {
        name,
        service_key,
        price,
        actual_price,
        offer_ends_at,
        offer_timer_enabled,
        logo_url,
        icon,
        badge,
        sort_order: display_order,
        description,
        features,
        is_highlighted,
        is_active
      };
      if (id) body.id = parseInt(id);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save service');
      }

      this.toast(id ? 'Service updated successfully!' : 'Service created successfully!', 'success');
      this.closeModal('bot-service-edit-modal');
      this.loadBotServices();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async toggleServiceHighlight(serviceId, is_highlighted) {
    try {
      const service = (this._cachedBotServices || []).find(s => s.id === serviceId);
      if (!service) return;

      const res = await fetch('/api/admin/bot-services/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: serviceId, is_highlighted }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update highlight status');
      }
      this.toast(`Highlight updated for ${service.name}!`, 'success');
      this.loadBotServices();
    } catch (err) {
      this.toast(err.message, 'error');
      this.loadBotServices();
    }
  },

  async toggleServiceActive(serviceId, is_active) {
    try {
      const service = (this._cachedBotServices || []).find(s => s.id === serviceId);
      if (!service) return;

      const res = await fetch('/api/admin/bot-services/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: serviceId, is_active }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update service status');
      }
      this.toast(`Status updated for ${service.name}!`, 'success');
      this.loadBotServices();
    } catch (err) {
      this.toast(err.message, 'error');
      this.loadBotServices();
    }
  },

  async deleteBotService(serviceId) {
    const service = (this._cachedBotServices || []).find(s => s.id === serviceId);
    const serviceName = service ? service.name : 'this service';
    if (!confirm(`Are you sure you want to delete ${serviceName}? It will no longer appear on the Services and Pricing pages.`)) {
      return;
    }
    try {
      const res = await fetch('/api/admin/bot-services/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: serviceId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete service');
      }
      this.toast('Service deleted successfully!', 'success');
      this.loadBotServices();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  // ==================== BOT PAYMENT METHODS MANAGER ====================
  async loadBotPaymentMethods() {
    try {
      const res = await fetch(`/api/admin/bot-payment-methods?t=${Date.now()}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load bot payment methods');
      }
      const data = await res.json();
      this._cachedBotPaymentMethods = data.methods || [];
      const tbody = document.getElementById('bot-payment-methods-table-body');
      if (!tbody) return;

      if (!this._cachedBotPaymentMethods.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
              No payment methods configured yet. Click "+ Add Payment Method" to add one.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = this._cachedBotPaymentMethods.map(m => {
        const isActive = !!m.is_active;
        const isCrypto = m.type === 'crypto';
        const typeBadge = isCrypto
          ? '<span class="badge" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3);">Crypto</span>'
          : '<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">E-Wallet / Bank</span>';

        return `
          <tr>
            <td>${typeBadge}</td>
            <td>
              <div style="font-weight: 700; color: var(--text);">${this.esc(m.name)}</div>
              ${m.instructions ? `<div style="font-size: 11px; color: var(--text-muted); max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this.esc(m.instructions)}</div>` : ''}
            </td>
            <td>
              <code style="font-size: 12px; color: #38bdf8; background: rgba(56,189,248,0.1); padding: 3px 6px; border-radius: 4px; word-break: break-all;">
                ${this.esc(m.address_or_number)}
              </code>
            </td>
            <td>
              <div style="font-size: 12px; color: var(--text);">${this.esc(m.network_or_bank || '--')}</div>
              ${m.account_holder ? `<div style="font-size: 11px; color: var(--text-muted);">Holder: ${this.esc(m.account_holder)}</div>` : ''}
            </td>
            <td>
              ${m.qr_code_url ? `<img src="${this.esc(m.qr_code_url)}" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; cursor: pointer; border: 1px solid var(--border);" onclick="panel.viewProofFullscreen(this.src)" title="Click to preview">` : '<span style="color: var(--text-muted); font-size: 12px;">--</span>'}
            </td>
            <td>
              <label class="toggle-switch" style="transform: scale(0.8); margin: 0;">
                <input type="checkbox" ${isActive ? 'checked' : ''} onchange="panel.toggleBotPaymentMethodActive(${m.id}, this.checked)">
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td style="text-align: right; padding-right: 16px;">
              <button class="btn-action btn-edit" onclick="panel.openEditBotPaymentModal(${m.id})" title="Edit Method" style="padding: 4px 8px; font-size: 11px; border-radius: 4px; margin-right: 4px;">
                Edit
              </button>
              <button class="btn-action btn-reject" onclick="panel.deleteBotPaymentMethod(${m.id})" title="Delete Method" style="padding: 4px 8px; font-size: 11px; border-radius: 4px;">
                Delete
              </button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load bot payment methods:', err);
    }
  },

  onBotPayTypeChange(type) {
    const isCrypto = type === 'crypto';
    const addrLabel = document.getElementById('bot-pay-address-label');
    const addrInput = document.getElementById('bot-pay-address');
    if (addrLabel) addrLabel.textContent = isCrypto ? 'Crypto Wallet Address *' : 'Account Number / IBAN *';
    if (addrInput) addrInput.placeholder = isCrypto ? 'e.g. TYbNqH2Z4vX8P4F9mQwE1k5L6t7R8s9A0b' : 'e.g. 03001234567 or PK86SADA...';
  },

  openAddBotPaymentModal() {
    document.getElementById('bot-payment-modal-title').textContent = 'Add Bot Payment Method';
    document.getElementById('bot-pay-id').value = '';
    document.getElementById('bot-pay-type').value = 'crypto';
    document.getElementById('bot-pay-name').value = '';
    document.getElementById('bot-pay-address').value = '';
    document.getElementById('bot-pay-holder').value = '';
    document.getElementById('bot-pay-network').value = 'TRC20';
    document.getElementById('bot-pay-instructions').value = 'Send exact amount. TXID and screenshot proof required.';
    document.getElementById('bot-pay-qr').value = '';
    document.getElementById('bot-pay-order').value = '0';
    document.getElementById('bot-pay-active').checked = true;

    this.onBotPayTypeChange('crypto');
    this.openModal('bot-payment-modal');
  },

  openEditBotPaymentModal(methodId) {
    const method = (this._cachedBotPaymentMethods || []).find(m => m.id === methodId);
    if (!method) return;

    document.getElementById('bot-payment-modal-title').textContent = `Edit ${method.name}`;
    document.getElementById('bot-pay-id').value = method.id;
    document.getElementById('bot-pay-type').value = method.type || 'crypto';
    document.getElementById('bot-pay-name').value = method.name || '';
    document.getElementById('bot-pay-address').value = method.address_or_number || '';
    document.getElementById('bot-pay-holder').value = method.account_holder || '';
    document.getElementById('bot-pay-network').value = method.network_or_bank || '';
    document.getElementById('bot-pay-instructions').value = method.instructions || '';
    document.getElementById('bot-pay-qr').value = method.qr_code_url || '';
    document.getElementById('bot-pay-order').value = method.sort_order || 0;
    document.getElementById('bot-pay-active').checked = method.is_active !== false;

    this.onBotPayTypeChange(method.type || 'crypto');
    this.openModal('bot-payment-modal');
  },

  async saveBotPaymentMethod() {
    const id = document.getElementById('bot-pay-id').value;
    const type = document.getElementById('bot-pay-type').value;
    const name = document.getElementById('bot-pay-name').value.trim();
    const address_or_number = document.getElementById('bot-pay-address').value.trim();
    const account_holder = document.getElementById('bot-pay-holder').value.trim();
    const network_or_bank = document.getElementById('bot-pay-network').value.trim();
    const instructions = document.getElementById('bot-pay-instructions').value.trim();
    const qr_code_url = document.getElementById('bot-pay-qr').value.trim();
    const sort_order = parseInt(document.getElementById('bot-pay-order').value) || 0;
    const is_active = document.getElementById('bot-pay-active').checked;

    if (!name || !address_or_number) {
      this.toast('Method Name and Wallet/Account number are required.', 'error');
      return;
    }

    try {
      const endpoint = id ? '/api/admin/bot-payment-methods/update' : '/api/admin/bot-payment-methods/add';
      const body = {
        name,
        type,
        address_or_number,
        account_holder,
        network_or_bank,
        instructions,
        qr_code_url,
        sort_order,
        is_active
      };
      if (id) body.id = parseInt(id);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save payment method');
      }

      this.toast(id ? 'Payment method updated successfully!' : 'Payment method added successfully!', 'success');
      this.closeModal('bot-payment-modal');
      this.loadBotPaymentMethods();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async toggleBotPaymentMethodActive(methodId, is_active) {
    try {
      const res = await fetch('/api/admin/bot-payment-methods/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: methodId, is_active }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update status');
      }
      this.toast('Payment method status updated!', 'success');
      this.loadBotPaymentMethods();
    } catch (err) {
      this.toast(err.message, 'error');
      this.loadBotPaymentMethods();
    }
  },

  async deleteBotPaymentMethod(methodId) {
    if (!confirm('Are you sure you want to delete this payment method?')) return;
    try {
      const res = await fetch('/api/admin/bot-payment-methods/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: methodId }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete method');
      }
      this.toast('Payment method deleted successfully!', 'success');
      this.loadBotPaymentMethods();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  // ==================== BOT ORDERS & PURCHASE REQUESTS ====================
  _botOrdersFilter: 'all',
  async loadBotOrders(filter = 'all') {
    this._botOrdersFilter = filter;
    try {
      const res = await fetch(`/api/admin/bot-orders?t=${Date.now()}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load bot orders');
      }
      const data = await res.json();
      this._cachedBotOrders = data.orders || [];
      const tbody = document.getElementById('bot-orders-table-body');
      if (!tbody) return;

      let filtered = this._cachedBotOrders;
      if (filter !== 'all') {
        filtered = filtered.filter(o => o.status === filter);
      }

      if (!filtered.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">
              No bot orders found matching "${filter}".
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = filtered.map(o => {
        let statusBadge = '<span class="badge badge-yellow">Pending</span>';
        if (o.status === 'approved') {
          statusBadge = '<span class="badge badge-green">Approved</span>';
        } else if (o.status === 'rejected') {
          statusBadge = '<span class="badge badge-red">Rejected</span>';
        }

        const createdAt = o.created_at ? new Date(o.created_at).toLocaleString() : '--';

        return `
          <tr>
            <td><strong style="color: var(--text);">#${o.id}</strong></td>
            <td>
              <div style="font-weight: 700; color: var(--primary);">${this.esc(o.user_email)}</div>
              <div style="font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px;">
                <span>📞</span> ${this.esc(o.user_phone || '--')}
              </div>
            </td>
            <td>
              <span class="badge" style="background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.25); font-weight: 700;">
                ${this.esc(o.service_name || o.service_key)}
              </span>
            </td>
            <td>
              <span style="font-weight: 800; color: #10b981; font-size: 14px;">$${parseFloat(o.amount || 0).toFixed(2)}</span>
            </td>
            <td>
              <div style="font-size: 12px; color: var(--text);">${this.esc(o.payment_method_name || 'Manual')}</div>
              <code style="font-size: 11px; color: #38bdf8; background: rgba(56,189,248,0.08); padding: 2px 4px; border-radius: 4px; max-width: 140px; display: inline-block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.esc(o.txid)}">
                ${this.esc(o.txid)}
              </code>
            </td>
            <td>
              ${o.proof_url ? `<img src="${this.esc(o.proof_url)}" style="width: 38px; height: 38px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 1px solid var(--border);" onclick="panel.viewProofFullscreen(this.src)" title="Click to view full screenshot">` : '<span style="color: var(--text-muted); font-size: 11px;">No Proof</span>'}
            </td>
            <td>
              ${statusBadge}
              ${o.assigned_key ? `<div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Key: <code style="color: var(--primary);">${this.esc(o.assigned_key)}</code></div>` : ''}
            </td>
            <td style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">${createdAt}</td>
            <td style="text-align: right; padding-right: 16px;">
              ${o.status === 'pending' ? `
                <button class="btn-action btn-approve" onclick="panel.openReviewOrderModal(${o.id})" style="padding: 5px 10px; font-size: 11px; border-radius: 4px; background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3);">
                  Review &amp; Approve
                </button>
              ` : `
                <button class="btn-action" onclick="panel.openReviewOrderModal(${o.id})" style="padding: 4px 8px; font-size: 11px; border-radius: 4px; background: var(--bg-deep); color: var(--text-muted);">
                  View Details
                </button>
              `}
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load bot orders:', err);
    }
  },

  filterBotOrders(filter) {
    document.querySelectorAll('#section-aibot-keys .filter-btn').forEach(btn => {
      if (btn.id.startsWith('bot-order-filter-')) btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`bot-order-filter-${filter}`);
    if (activeBtn) activeBtn.classList.add('active');
    this.loadBotOrders(filter);
  },

  openReviewOrderModal(orderId) {
    const order = (this._cachedBotOrders || []).find(o => o.id === orderId);
    if (!order) return;

    document.getElementById('review-order-id').value = order.id;
    document.getElementById('review-order-email').textContent = order.user_email || '—';
    document.getElementById('review-order-phone').textContent = order.user_phone || '—';
    document.getElementById('review-order-service').textContent = order.service_name || order.service_key || '—';
    document.getElementById('review-order-amount').textContent = `$${parseFloat(order.amount || 0).toFixed(2)} ${order.currency || 'USD'}`;
    document.getElementById('review-order-method').textContent = order.payment_method_name || 'Manual';
    document.getElementById('review-order-txid').textContent = order.txid || '—';
    document.getElementById('review-order-custom-key').value = order.assigned_key || '';
    document.getElementById('review-order-notes').value = order.admin_notes || '';

    const proofImg = document.getElementById('review-order-proof-img');
    const proofWrap = document.getElementById('review-proof-wrap');
    if (order.proof_url) {
      proofImg.src = order.proof_url;
      proofWrap.style.display = 'block';
    } else {
      proofWrap.style.display = 'none';
    }

    this.openModal('bot-order-review-modal');
  },

  async submitOrderReview(action) {
    const order_id = parseInt(document.getElementById('review-order-id').value);
    const key_code = document.getElementById('review-order-custom-key').value.trim();
    const admin_notes = document.getElementById('review-order-notes').value.trim();

    if (!order_id) return;

    try {
      const res = await fetch('/api/admin/bot-orders/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id, action, key_code, admin_notes }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to review order');
      }

      const data = await res.json();
      this.toast(data.message || (action === 'approve' ? 'Order approved!' : 'Order rejected!'), 'success');
      this.closeModal('bot-order-review-modal');
      this.loadBotOrders(this._botOrdersFilter || 'all');
      this.loadAiBotKeys();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  viewProofFullscreen(src) {
    if (!src) return;
    const modalImg = document.getElementById('fullscreen-proof-img');
    if (modalImg) modalImg.src = src;
    this.openModal('bot-proof-view-modal');
  },

  // ==================== BOT SUPPORT TICKETS & INQUIRIES ====================
  _botTicketsFilter: 'all',
  async loadBotTickets(filter = 'all') {
    this._botTicketsFilter = filter;
    try {
      const res = await fetch(`/api/admin/bot-tickets?t=${Date.now()}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to load support tickets');
      }
      const data = await res.json();
      this._cachedBotTickets = data.tickets || [];
      const tbody = document.getElementById('bot-tickets-table-body');
      if (!tbody) return;

      let filtered = this._cachedBotTickets;
      if (filter !== 'all') {
        filtered = filtered.filter(t => t.status === filter);
      }

      if (!filtered.length) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">
              No support tickets found matching "${filter}".
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = filtered.map(t => {
        let statusBadge = '<span class="badge badge-yellow">Pending</span>';
        if (t.status === 'resolved') {
          statusBadge = '<span class="badge badge-green">Resolved</span>';
        } else if (t.status === 'in_progress') {
          statusBadge = '<span class="badge badge-blue">In Progress</span>';
        }

        const createdAt = t.created_at ? new Date(t.created_at).toLocaleString() : '--';
        const msgPreview = (t.message || '').length > 60 ? (t.message.substring(0, 60) + '...') : (t.message || '--');

        return `
          <tr>
            <td><strong style="color: var(--text);">#${t.id}</strong></td>
            <td>
              <div style="font-weight: 700; color: var(--text);">${this.esc(t.name || 'Anonymous')}</div>
              <div style="font-size: 11px; color: var(--primary);">${this.esc(t.email)}</div>
              ${t.phone ? `<div style="font-size: 10.5px; color: var(--text-muted);">📞 ${this.esc(t.phone)}</div>` : ''}
            </td>
            <td>
              <span class="badge" style="background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3); font-weight: 600; font-size: 11px;">
                ${this.esc(t.category || 'General')}
              </span>
            </td>
            <td>
              <div style="font-weight: 600; color: var(--text); max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.esc(t.subject)}">
                ${this.esc(t.subject)}
              </div>
            </td>
            <td>
              <div style="font-size: 11.5px; color: var(--text-muted); max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${this.esc(t.message)}">
                ${this.esc(msgPreview)}
              </div>
            </td>
            <td>${statusBadge}</td>
            <td style="font-size: 11.5px; color: var(--text-sec); white-space: nowrap;">${createdAt}</td>
            <td style="text-align: right; padding-right: 16px; white-space: nowrap;">
              <button class="btn-action btn-edit" onclick="panel.openTicketViewModal(${t.id})" title="View Ticket Details" style="padding: 4px 8px; font-size: 11px; border-radius: 4px; margin-right: 4px;">
                View
              </button>
              ${t.status !== 'resolved' ? `<button class="btn-action btn-approve" onclick="panel.quickResolveTicket(${t.id})" title="Mark Resolved" style="padding: 4px 8px; font-size: 11px; border-radius: 4px;">Resolve</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.warn('Failed to load bot tickets:', err);
      const tbody = document.getElementById('bot-tickets-table-body');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger); padding: 20px;">Failed to load tickets: ${this.esc(err.message)}</td></tr>`;
      }
    }
  },

  filterBotTickets(filter) {
    document.querySelectorAll('[id^="bot-ticket-filter-"]').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`bot-ticket-filter-${filter}`);
    if (activeBtn) activeBtn.classList.add('active');
    this.loadBotTickets(filter);
  },

  openTicketViewModal(ticketId) {
    const ticket = (this._cachedBotTickets || []).find(t => t.id === ticketId);
    if (!ticket) return;

    document.getElementById('ticket-view-id').value = ticket.id;
    document.getElementById('ticket-view-name').textContent = ticket.name || '—';
    const emailEl = document.getElementById('ticket-view-email');
    if (emailEl) {
      emailEl.textContent = ticket.email || '—';
      emailEl.href = `mailto:${ticket.email}?subject=Re: ${encodeURIComponent(ticket.subject || 'Support Ticket Response')}`;
    }
    document.getElementById('ticket-view-phone').textContent = ticket.phone || '—';
    document.getElementById('ticket-view-category').textContent = (ticket.category || 'General').toUpperCase();
    document.getElementById('ticket-view-date').textContent = ticket.created_at ? new Date(ticket.created_at).toLocaleString() : '—';
    document.getElementById('ticket-view-subject').textContent = ticket.subject || '—';
    document.getElementById('ticket-view-message').textContent = ticket.message || '—';
    document.getElementById('ticket-view-status').value = ticket.status || 'pending';
    document.getElementById('ticket-view-notes').value = ticket.admin_notes || '';

    this.openModal('bot-ticket-view-modal');
  },

  async saveTicketStatus() {
    const id = parseInt(document.getElementById('ticket-view-id').value);
    const status = document.getElementById('ticket-view-status').value;
    const admin_notes = document.getElementById('ticket-view-notes').value.trim();

    if (!id) return;

    try {
      const res = await fetch('/api/admin/bot-tickets/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status, admin_notes }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update ticket status');
      }

      this.toast('Ticket status updated successfully!', 'success');
      this.closeModal('bot-ticket-view-modal');
      this.loadBotTickets(this._botTicketsFilter || 'all');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async quickResolveTicket(ticketId) {
    try {
      const res = await fetch('/api/admin/bot-tickets/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ticketId, status: 'resolved' }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to resolve ticket');
      }

      this.toast('Ticket marked as resolved!', 'success');
      this.loadBotTickets(this._botTicketsFilter || 'all');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async deleteCurrentTicket() {
    const id = parseInt(document.getElementById('ticket-view-id').value);
    if (!id) return;
    if (!confirm('Are you sure you want to delete this support ticket?')) return;

    try {
      const res = await fetch('/api/admin/bot-tickets/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        credentials: 'include'
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete ticket');
      }

      this.toast('Ticket deleted successfully!', 'success');
      this.closeModal('bot-ticket-view-modal');
      this.loadBotTickets(this._botTicketsFilter || 'all');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  copyCustomCode(code) {
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        this.toast('Invite code copied to clipboard!', 'success');
      }).catch(err => {
        this.toast('Failed to copy code.', 'error');
      });
    }
  },

  copyCustomLink(code) {
    if (code) {
      const link = `${window.location.origin}/?ref=${code}`;
      navigator.clipboard.writeText(link).then(() => {
        this.toast('Referral link copied to clipboard!', 'success');
      }).catch(err => {
        this.toast('Failed to copy link.', 'error');
      });
    }
  },

  applyPermissions() {
    const p = this.permissions;
    const isAdmin = this.user.role === 'admin';

    // Rename performance column and update subtitle for employees
    if (this.user.role === 'employee') {
      const th = document.getElementById('users-th-performance');
      if (th) th.textContent = 'Performance & Commission';
      const sub = document.getElementById('users-page-subtitle');
      if (sub) {
        const commPct = parseFloat(this.user.referral_commission_pct || 5.0);
        sub.textContent = `Your Loss Commission Rate: ${commPct.toFixed(2)}% (Commission earned from referred user trade losses)`;
      }
      const dashLabel = document.getElementById('stat-broker-profit-label');
      if (dashLabel) dashLabel.textContent = 'Your Earnings';
      const statsLabel = document.getElementById('stats-users-broker-profit-label');
      if (statsLabel) statsLabel.textContent = 'Your Earnings';
    } else {
      const dashLabel = document.getElementById('stat-broker-profit-label');
      if (dashLabel) dashLabel.textContent = 'Net Broker Profit';
      const statsLabel = document.getElementById('stats-users-broker-profit-label');
      if (statsLabel) statsLabel.textContent = 'Broker Net Revenue';
    }

    // Hide sections for employees with limited access
    const empOnly = !isAdmin && !p?.full_access;

    if (empOnly) {
      if (!p?.user_management) {
        document.getElementById('navlink-users')?.remove();
      }
      document.getElementById('navlink-kyc')?.remove();
      document.getElementById('navlink-visa-cards')?.remove();
      document.getElementById('navlink-bonus')?.remove();
      if (!p?.deposit_approval) {
        document.getElementById('navlink-deposits')?.remove();
      }
      if (!p?.withdrawal_approval) {
        document.getElementById('navlink-withdrawals')?.remove();
      }
      if (!p?.trade_monitoring) {
        document.getElementById('navlink-trades')?.remove();
      }
      if (!p?.live_support) {
        document.getElementById('navlink-live-support')?.remove();
      }
      
      // Dashboard sub-permissions checks
      if (!p?.dash_live_activity) {
        document.getElementById('dash-live-activity-panel')?.remove();
      }
      if (!p?.dash_global_settings) {
        document.getElementById('dash-global-settings-panel')?.remove();
      }
      if (!p?.dash_live_trades) {
        document.getElementById('dash-live-trades-panel')?.remove();
      }
      if (!p?.dash_kyc_list) {
        document.getElementById('dash-kyc-list-panel')?.remove();
      }
      if (!p?.see_all_users) {
        document.getElementById('stat-active-users-card')?.remove();
      }
      
      // If employee has no permissions in the entire User Management group, remove the header
      if (!p?.user_management && !p?.deposit_approval && !p?.withdrawal_approval && !p?.trade_monitoring) {
        document.getElementById('nav-section-users')?.remove();
      }
    }

    if (!isAdmin) {
      document.getElementById('navlink-employees')?.remove();
      document.getElementById('navlink-invite-codes')?.remove();
      document.getElementById('navlink-settings')?.remove();
      document.getElementById('navlink-trade-settings')?.remove();
      document.getElementById('nav-section-admin')?.remove();
      document.getElementById('navlink-otc-settings')?.remove();
      document.getElementById('navlink-email-events')?.remove();
      
      // Remove Active / Online cards from Dashboard & All Users page for non-admins (employees)
      document.getElementById('stat-active-users-card')?.remove();
      document.getElementById('stats-users-active-card')?.remove();

      // Remove Online option from session activity filter for employees
      const onlineOpt = document.querySelector('#user-filter-activity option[value="online"]');
      if (onlineOpt) onlineOpt.remove();

      // Remove checkboxes and bulk edit options in User Management for non-admins (employees)
      document.getElementById('users-th-checkbox')?.remove();
      document.getElementById('users-bulk-actions')?.remove();

      // Rename Net Broker Profit and Chart Title to show 'Your'/Personal context for employees
      const profitLabel = document.getElementById('stat-broker-profit-label');
      if (profitLabel) profitLabel.textContent = 'Your Profit';
      
      const chartTitle = document.getElementById('stat-chart-title');
      if (chartTitle) chartTitle.textContent = 'Your Trading Volume & Profit History';
    }
  },

  // ==================== LOGIN ====================
  async login(e) {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    // Clear previous error
    let errBox = document.getElementById('staff-login-error');
    if (!errBox) {
      errBox = document.createElement('div');
      errBox.id = 'staff-login-error';
      errBox.style.cssText = 'display:none; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.35); border-left:3px solid #ef4444; border-radius:8px; padding:11px 14px; margin-bottom:12px; font-size:13px; font-weight:500; color:#fca5a5; line-height:1.5; animation:errorShake 0.35s ease;';
      document.getElementById('login-form').insertBefore(errBox, btn);
    }
    errBox.style.display = 'none';

    // Remove previous input highlights
    document.getElementById('login-username').style.borderColor = '';
    document.getElementById('login-password').style.borderColor = '';

    if (!username) {
      errBox.textContent = '⚠ Please enter your username.';
      errBox.style.display = 'block';
      document.getElementById('login-username').style.borderColor = 'rgba(239,68,68,0.5)';
      document.getElementById('login-username').focus();
      return;
    }
    if (!password) {
      errBox.textContent = '⚠ Please enter your password.';
      errBox.style.display = 'block';
      document.getElementById('login-password').style.borderColor = 'rgba(239,68,68,0.5)';
      document.getElementById('login-password').focus();
      return;
    }

    btn.textContent = 'Signing in...';
    btn.disabled = true;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        if (data.user.role === 'user') {
          errBox.textContent = '⚠ Access denied. This panel is for authorized staff only.';
          errBox.style.display = 'block';
          document.getElementById('login-username').style.borderColor = 'rgba(239,68,68,0.5)';
        } else {
          if (data.token) {
            localStorage.setItem('staff_token', data.token);
          }
          this.user = data.user;
          this.permissions = data.permissions || { full_access: data.user.role === 'admin' ? 1 : 0 };
          // Check if 2FA is required before booting the panel
          const twoFaRequired = await this.staff2faCheck();
          if (!twoFaRequired) {
            this.bootPanel();
          }
        }
      } else {
        const errMsg = data.error || '';
        let msg = '⚠ Wrong username or password. Please try again.';
        if (errMsg.toLowerCase().includes('blocked')) {
          msg = '🚫 This account has been blocked. Contact the administrator.';
        } else if (errMsg.toLowerCase().includes('frozen')) {
          msg = '❄️ This account is frozen. Contact the administrator.';
        }
        errBox.textContent = msg;
        errBox.style.display = 'block';
        document.getElementById('login-username').style.borderColor = 'rgba(239,68,68,0.5)';
        document.getElementById('login-password').style.borderColor = 'rgba(239,68,68,0.5)';
        document.getElementById('login-password').value = '';
        document.getElementById('login-password').focus();
      }
    } catch (err) {
      errBox.textContent = '⚠ Cannot connect to server. Is the server running?';
      errBox.style.display = 'block';
    }

    btn.textContent = 'Sign In to Panel';
    btn.disabled = false;
  },


  async logout() {
    window.history.replaceState({}, '', '/staff/');
    // Stop background alarm check and clean up audio
    if (this.backgroundAlertInterval) {
      clearInterval(this.backgroundAlertInterval);
      this.backgroundAlertInterval = null;
    }
    this.stopAlarmSound();
    const container = document.getElementById('staff-alarm-container');
    if (container) container.innerHTML = '';
    this.activeAlarmsCount = 0;
    this.lastPendingDeposits = null;
    this.lastPendingWithdrawals = null;
    this.lastPendingKycs = null;

    try {
      localStorage.removeItem('staff_token');
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
      console.warn('Logout API failed:', e);
    }
    this.user = null;
    this.showLogin();
    this.toast('Logged out successfully.', 'success');
  },

  // ==================== NAVIGATION ====================
  show(section, pushState = true) {
    if (pushState) {
      window.history.pushState({}, '', `/staff/${section}`);
    }
    // Clear any running intervals
    if (this.tradesRefreshInterval) {
      clearInterval(this.tradesRefreshInterval);
      this.tradesRefreshInterval = null;
    }
    if (this.dashboardRefreshInterval) {
      clearInterval(this.dashboardRefreshInterval);
      this.dashboardRefreshInterval = null;
    }
    if (this.usersRefreshInterval) {
      clearInterval(this.usersRefreshInterval);
      this.usersRefreshInterval = null;
    }

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    const activeLink = document.querySelector(`.nav-link[data-section="${section}"]`);
    if (activeLink) activeLink.classList.add('active');

    // Show section
    document.querySelectorAll('.panel-section').forEach(s => s.classList.remove('active-section'));
    const sectionEl = document.getElementById(`section-${section}`);
    if (sectionEl) sectionEl.classList.add('active-section');

    this.currentSection = section;

    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');

    // Load data for section
    switch (section) {
      case 'dashboard': 
        this.loadDashboard(); 
        this.dashboardRefreshInterval = setInterval(() => this.loadDashboard(), 5000);
        break;
      case 'users': 
        this.loadUsers(); 
        this.usersRefreshInterval = setInterval(() => this.loadUsers(), 5000);
        break;
      case 'deposits': this.loadDeposits(this.depositFilter); break;
      case 'withdrawals': this.loadWithdrawals(this.withdrawalFilter); break;
      case 'trades':
        this.loadTrades(this.tradeFilter);
        this.fetchCombineSettings();
        // Auto-refresh trades every 5s
        this.tradesRefreshInterval = setInterval(() => this.loadTrades(this.tradeFilter), 5000);
        break;
      case 'employees': this.loadEmployees(); break;
      case 'invite-codes': this.loadInviteCodes(); break;
      case 'aibot-keys': 
        this.loadAiBotKeys(); 
        this.loadAiBotMinBalance(); 
        this.loadAiBotGlobalStatus(); 
        this.loadBotServices(); 
        this.loadBotPaymentMethods(); 
        this.loadBotOrders('all'); 
        break;
      case 'settings': this.loadSettings(); break;
      case 'trade-settings': this.loadTradeOptions(); break;
      case 'otc-settings': this.loadOtcSettings(); break;
      case 'kyc': this.loadKyc('pending'); break;
      case 'visa-cards': this.loadVisaCards(); break;
      case 'bonus': this.loadBonuses(); break;
      case 'email-events': this.loadEmailEvents(); break;
      case 'employee-withdrawals': this.loadEmployeeWithdrawalsSummary(); break;
      case 'leaderboard': this.loadLeaderboardCustomization(); break;
      case 'live-support': this.liveSupport.init(); break;
    }
  },

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
  },

  // ==================== TOAST ====================
  toast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      setTimeout(() => t.remove(), 300);
    }, 4000);
  },

  // ==================== MODAL ====================
  openModal(id) { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  viewDepositProof(imageUrl) {
    const body = document.getElementById('deposit-proof-modal-body');
    if (body) {
      body.innerHTML = `<img src="${imageUrl}" alt="Proof of Payment" style="max-width:100%; max-height: 480px; border-radius: 8px; border: 1px solid var(--border-color); box-shadow: 0 4px 12px rgba(0,0,0,0.15);">`;
    }
    this.openModal('deposit-proof-modal');
  },

  // ==================== DASHBOARD ====================
  // ==================== DASHBOARD ====================
  async loadDashboard() {
    try {
      const [statsRes, settingsRes] = await Promise.all([
        fetch('/api/admin/stats', { credentials: 'include' }),
        fetch('/api/admin/settings', { credentials: 'include' })
      ]);

      if (statsRes.ok) {
        const stats = await statsRes.json();
        
        // Stats cards values
        const totalUsersEl = document.getElementById('stat-total-users');
        if (totalUsersEl) totalUsersEl.textContent = stats.total_users ?? '--';

        const activeUsersEl = document.getElementById('stat-active-users');
        if (activeUsersEl) activeUsersEl.textContent = stats.active_users ?? '--';
        
        const vol = parseFloat(stats.total_volume || 0);
        const totalVolEl = document.getElementById('stat-total-volume');
        if (totalVolEl) totalVolEl.textContent = '$' + vol.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
        
        const rev = parseFloat(stats.net_broker_revenue || 0);
        const revEl = document.getElementById('stat-broker-profit');
        if (revEl) {
          revEl.textContent = (rev >= 0 ? '+' : '') + '$' + rev.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
          revEl.style.color = rev >= 0 ? 'var(--primary)' : 'var(--danger)';
        }

        const depEl = document.getElementById('stat-pending-deposits');
        if (depEl) depEl.textContent = stats.pending_deposits ?? '--';

        const withEl = document.getElementById('stat-pending-withdrawals');
        if (withEl) withEl.textContent = stats.pending_withdrawals ?? '--';

        // Render Enhanced Live Activity Monitor
        if (stats.live_activities && stats.live_activities.length > 0) {
          this.renderLiveActivity(stats.live_activities);
        } else if (stats.recent_activity) {
          // Fallback to parsing recent db activity if live activity log is empty
          const fallback = stats.recent_activity.map(act => {
            let username = 'System';
            let action = act.desc;
            
            if (act.type === 'signup') {
              username = act.desc.replace('New user signup:', '').trim();
              action = 'signed up to the platform';
            } else if (act.type === 'deposit') {
              const match = act.desc.match(/Deposit of \$([0-9\.]+) \((.+)\) by (.+)/);
              if (match) {
                username = match[3];
                action = `initiated a deposit of $${match[1]} (${match[2]})`;
              }
            } else if (act.type === 'withdrawal') {
              const match = act.desc.match(/Withdrawal of \$([0-9\.]+) \((.+)\) by (.+)/);
              if (match) {
                username = match[3];
                action = `requested a withdrawal of $${match[1]} (${match[2]})`;
              }
            } else if (act.type === 'trade') {
              const match = act.desc.match(/Placed \$([0-9\.]+) (UP|DOWN) trade on (\w+) \((.+)\) by (.+)/);
              if (match) {
                username = match[5];
                action = `placed a $${match[1]} ${match[2]} contract on ${match[3]} (${match[4]})`;
              }
            }
            
            return {
              username,
              action,
              type: act.type,
              time: act.time
            };
          });
          this.renderLiveActivity(fallback);
        }

        // Unified operations log
        const logEl = document.getElementById('dash-activity-log');
        if (logEl) {
          if (!stats.recent_activity || stats.recent_activity.length === 0) {
            logEl.innerHTML = '<div style="color:var(--text-sec); font-size:12px; text-align:center; padding:20px;">No platform activity recorded yet</div>';
          } else {
            logEl.innerHTML = stats.recent_activity.map(act => {
              let icon = 'ℹ️';
              let color = 'var(--info)';
              if (act.type === 'signup') { icon = '👤'; color = 'var(--info)'; }
              else if (act.type === 'deposit') { icon = '💵'; color = 'var(--primary)'; }
              else if (act.type === 'withdrawal') { icon = '💸'; color = 'var(--warning)'; }
              else if (act.type === 'trade') { icon = '📈'; color = 'var(--accent)'; }
              
              const timeStr = new Date(act.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
              
              return `
                <div class="mini-item" style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:rgba(255,255,255,0.03); border-radius:6px; border:1px solid var(--border); font-size:12.5px;">
                  <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1;">
                    <span style="font-size:14px; padding:4px; border-radius:4px; background:rgba(255,255,255,0.05); display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">${icon}</span>
                    <div style="min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.2;">
                      <div style="font-weight:700; color:var(--text);">${act.desc}</div>
                      <span style="font-size:10px; color:var(--text-muted);">${timeStr}</span>
                    </div>
                  </div>
                </div>
              `;
            }).join('');
          }
        }

        // Live trade watcher console
        const watcherEl = document.getElementById('dash-live-trades');
        if (watcherEl) {
          if (!stats.active_trades_list || stats.active_trades_list.length === 0) {
            watcherEl.innerHTML = '<tr><td colspan="7" class="loading-cell">No active trades currently pending.</td></tr>';
          } else {
            watcherEl.innerHTML = stats.active_trades_list.map(t => {
              const dirClass = t.direction === 'UP' ? 'badge-green' : 'badge-red';
              const expiresDate = new Date(t.expires_at);
              const diffSec = Math.max(0, Math.round((expiresDate.getTime() - Date.now()) / 1000));
              
              const ovr = t.admin_control || 'none';
              const ovrBadge = ovr === 'win' 
                ? '<span class="badge badge-green" style="font-size:9px; padding:2px 6px;">FORCE WIN</span>'
                : ovr === 'lose'
                ? '<span class="badge badge-red" style="font-size:9px; padding:2px 6px;">FORCE LOSE</span>'
                : '<span class="badge badge-gray" style="font-size:9px; padding:2px 6px;">Natural</span>';
                
              const tagHTML = t.is_bot
                ? '<br><span class="badge badge-purple" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-top: 2px; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3);">Bot</span>'
                : t.is_demo
                  ? '<br><span class="badge badge-yellow" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-top: 2px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);">Demo</span>'
                  : '<br><span class="badge badge-green" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-top: 2px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">Real</span>';
              return `
                <tr style="transition: all 0.2s ease;">
                  <td style="padding-left:14px; font-weight:700;">
                    #${t.id}
                    ${tagHTML}
                  </td>
                  <td><strong>${this.esc(t.username)}</strong></td>
                  <td>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <strong style="color:var(--accent); font-family:monospace;">${t.coin}</strong>
                      <span class="badge ${dirClass}" style="font-size:10px; font-weight:700;">${t.direction}</span>
                      ${ovrBadge}
                    </div>
                  </td>
                  <td><strong style="color:var(--text);">${this.fmtBal(t.amount, t.currency)}</strong></td>
                  <td><span style="font-family:monospace; color:var(--text-sec);">$${parseFloat(t.open_price).toFixed(5)}</span></td>
                  <td>
                    <div style="display:flex; align-items:center; gap:6px; font-weight:600; color:var(--warning);">
                      <span style="width:6px; height:6px; border-radius:50%; background:var(--warning); display:inline-block; animation:pulse 1s infinite;"></span>
                      <span>${diffSec}s remaining</span>
                    </div>
                  </td>
                  <td style="text-align:right; padding-right:14px;">
                    <div class="action-btns" style="justify-content: flex-end; gap:4px;">
                      <button class="btn-action btn-approve" onclick="panel.setDashTradeControl(${t.id}, 'win')" style="padding:3px 8px; font-size:10px; height:24px; border-radius:4px; background:rgba(16,185,129,0.08); color:var(--primary); border:1.5px solid rgba(16,185,129,0.15); font-weight:700;">Win</button>
                      <button class="btn-action btn-reject" onclick="panel.setDashTradeControl(${t.id}, 'lose')" style="padding:3px 8px; font-size:10px; height:24px; border-radius:4px; background:rgba(239,68,68,0.08); color:var(--danger); border:1.5px solid rgba(239,68,68,0.15); font-weight:700;">Lose</button>
                      <button class="btn-action btn-neutral" onclick="panel.setDashTradeControl(${t.id}, 'none')" style="padding:3px 8px; font-size:10px; height:24px; border-radius:4px; background:rgba(255,255,255,0.04); color:var(--text-sec); border:1.5px solid rgba(255,255,255,0.08); font-weight:700;">Natural</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join('');
          }
        }

        // KYC Verification Inbox list
        const kycEl = document.getElementById('dash-kyc-list');
        if (kycEl) {
          if (!stats.pending_kyc_list || stats.pending_kyc_list.length === 0) {
            kycEl.innerHTML = '<tr><td colspan="5" class="loading-cell">No KYC verifications currently pending.</td></tr>';
          } else {
            kycEl.innerHTML = stats.pending_kyc_list.map(k => `
              <tr>
                <td style="padding-left:14px;"><strong>${this.esc(k.username)}</strong></td>
                <td><span style="font-family:monospace; color:var(--text-sec);">${this.esc(k.email)}</span></td>
                <td><strong style="color:var(--accent);">${this.esc(k.kyc_country || 'Unknown')}</strong></td>
                <td><span style="font-size:11px; color:var(--text-muted);">${new Date(k.kyc_submitted_at).toLocaleString()}</span></td>
                <td style="text-align:right; padding-right:14px;">
                  <div class="action-btns" style="justify-content: flex-end; gap:6px;">
                    <button class="btn-action btn-approve" onclick="panel.approveDashKyc(${k.id})" style="padding:4px 8px; font-size:11px; height:26px; font-weight:700;">Approve</button>
                    <button class="btn-action btn-reject" onclick="panel.rejectDashKyc(${k.id})" style="padding:4px 8px; font-size:11px; height:26px; font-weight:700;">Reject</button>
                  </div>
                </td>
              </tr>
            `).join('');
          }
        }

        // Render line chart & doughnut chart if Chart is loaded
        if (typeof Chart !== 'undefined') {
          // Build a full 7-day label array (always show past 7 days even if no data)
          const dayLabels = [];
          const dayMap = {};
          for (let i = 6; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            const key = d.toISOString().substring(0, 10);
            const label = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
            dayLabels.push(label);
            dayMap[key] = { volume: 0, revenue: 0 };
          }
          (stats.volume_stats || []).forEach(s => {
            const key = s.date ? s.date.substring(0, 10) : '';
            if (dayMap[key]) {
              dayMap[key].volume = parseFloat(s.volume) || 0;
              dayMap[key].revenue = parseFloat(s.revenue) || 0;
            }
          });
          const volumeData = Object.values(dayMap).map(d => d.volume);
          const revenueData = Object.values(dayMap).map(d => d.revenue);

          // 1. Daily Volume & Revenue Chart — update if exists, create if not
          const pnlCtx = document.getElementById('pnl-chart')?.getContext('2d');
          if (pnlCtx) {
            if (window.myPnlChart) {
              // Update data in-place (no animation flash)
              window.myPnlChart.data.labels = dayLabels;
              window.myPnlChart.data.datasets[0].data = volumeData;
              window.myPnlChart.data.datasets[1].data = revenueData;
              window.myPnlChart.data.datasets[1].label = this.user.role === 'employee' ? 'Your Profit ($)' : 'Net Profit ($)';
              window.myPnlChart.update('none'); // 'none' = no animation
            } else {
              window.myPnlChart = new Chart(pnlCtx, {
                type: 'line',
                data: {
                  labels: dayLabels,
                  datasets: [
                    {
                      label: 'Volume ($)',
                      data: volumeData,
                      borderColor: '#3b82f6',
                      backgroundColor: 'rgba(59, 130, 246, 0.04)',
                      borderWidth: 2,
                      tension: 0.35,
                      fill: true,
                      yAxisID: 'y'
                    },
                    {
                      label: this.user.role === 'employee' ? 'Your Profit ($)' : 'Net Profit ($)',
                      data: revenueData,
                      borderColor: '#10b981',
                      backgroundColor: 'rgba(16, 185, 129, 0.04)',
                      borderWidth: 2.5,
                      tension: 0.35,
                      fill: true,
                      yAxisID: 'y1'
                    }
                  ]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      display: true,
                      labels: { color: '#6b7280', font: { family: 'Outfit', size: 10, weight: '600' } }
                    }
                  },
                  scales: {
                    x: {
                      grid: { display: false },
                      ticks: { color: '#9ca3af', font: { family: 'Outfit', size: 9 } }
                    },
                    y: {
                      type: 'linear',
                      display: true,
                      position: 'left',
                      grid: { color: 'rgba(0, 0, 0, 0.03)' },
                      ticks: { color: '#3b82f6', font: { family: 'Outfit', size: 9 } }
                    },
                    y1: {
                      type: 'linear',
                      display: true,
                      position: 'right',
                      grid: { drawOnChartArea: false },
                      ticks: { color: '#10b981', font: { family: 'Outfit', size: 9 } }
                    }
                  }
                }
              });
            }
          }

          // 2. Liquidity Distribution Doughnut Chart — update if exists, create if not
          const distCtx = document.getElementById('dist-chart')?.getContext('2d');
          if (distCtx) {
            const depSum = parseFloat(stats.total_deposits || 0);
            const witSum = parseFloat(stats.total_withdrawals || 0);
            const profitSum = Math.max(0, parseFloat(stats.net_broker_revenue || 0));

            if (window.myDistChart) {
              // Update data in-place — prevents the spinning reload animation
              window.myDistChart.data.datasets[0].data = [depSum, witSum, profitSum];
              window.myDistChart.update('none');
            } else {
              window.myDistChart = new Chart(distCtx, {
                type: 'doughnut',
                data: {
                  labels: ['Deposits', 'Withdrawals', 'Broker Profit'],
                  datasets: [{
                    data: [depSum, witSum, profitSum],
                    backgroundColor: ['#f59e0b', '#3b82f6', '#10b981'],
                    borderWidth: 0,
                    hoverOffset: 4
                  }]
                },
                options: {
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { display: false } },
                  cutout: '72%'
                }
              });
            }

            // Update HTML Legend (always refresh)
            const legendEl = document.getElementById('chart-legend');
            if (legendEl) {
              legendEl.innerHTML = [
                { label: 'Deposits', value: depSum, color: '#f59e0b' },
                { label: 'Withdrawals', value: witSum, color: '#3b82f6' },
                { label: 'Broker Profit', value: profitSum, color: '#10b981' }
              ].map(item => `
                <div style="display:flex; align-items:center; gap:6px;">
                  <span style="width:8px; height:8px; border-radius:50%; background:${item.color}; display:inline-block; flex-shrink:0;"></span>
                  <span style="font-weight:600; color:var(--text-sec);">${item.label}:</span>
                  <strong style="color:var(--text); font-variant-numeric: tabular-nums;">$${item.value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>
                </div>
              `).join('');
            }
          }
        }
      }

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        const settings = data.settings || {};
        this.settingsCache = settings;
        
        // Set Global Control values in inputs
        const overrideSel = document.getElementById('global-trade-override');
        if (overrideSel) overrideSel.value = settings.global_trade_override || 'none';
        
        const signupSel = document.getElementById('global-signup-toggle');
        if (signupSel) signupSel.value = settings.signup_enabled !== '0' ? '1' : '0';

        const maintenanceSel = document.getElementById('global-maintenance-toggle');
        if (maintenanceSel) maintenanceSel.value = settings.maintenance_mode === '1' ? '1' : '0';

        const editBtn = document.getElementById('btn-edit-maintenance-html');
        if (editBtn) {
          editBtn.style.display = settings.maintenance_mode === '1' ? 'block' : 'none';
        }
      }
    } catch (err) {
      console.error('Dashboard load error:', err);
    }

  // Refresh KYC pending badge in nav
    try {
      const kycRes = await fetch('/api/admin/kyc/list?kyc_status=pending', { credentials: 'include' });
      if (kycRes.ok) {
        const kycData = await kycRes.json();
        const count = (kycData.users || []).length;
        const badge = document.getElementById('kyc-pending-badge');
        if (badge) {
          badge.textContent = count;
          badge.style.display = count > 0 ? 'inline-block' : 'none';
        }
      }
    } catch (e) { /* silent */ }

    // Refresh Visa Card pending badge in nav
    try {
      const visaRes = await fetch('/api/admin/visa-cards', { credentials: 'include' });
      if (visaRes.ok) {
        const visaData = await visaRes.json();
        let pendingCount = 0;
        (visaData.visaCards || []).forEach(c => { if (c.status === 'pending') pendingCount++; });
        const badge = document.getElementById('visa-pending-badge');
        if (badge) {
          badge.textContent = pendingCount;
          badge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
        }
      }
    } catch (e) { /* silent */ }
  },

  currentActivityFilter: 'all',
  lastActivitiesList: [],

  filterLiveActivity(filter) {
    this.currentActivityFilter = filter;
    document.querySelectorAll('.activity-filter-btn').forEach(btn => {
      btn.style.background = 'rgba(255,255,255,0.03)';
      btn.style.color = 'var(--text-muted)';
      btn.style.borderColor = 'var(--border)';
    });
    // Highlight the clicked button
    const activeBtn = document.querySelector(`.activity-filter-btn[onclick*="'${filter}'"]`);
    if (activeBtn) {
      activeBtn.style.background = 'var(--primary)';
      activeBtn.style.color = '#fff';
      activeBtn.style.borderColor = 'var(--primary)';
    }
    this.renderLiveActivity();
  },

  renderLiveActivity(activities = null) {
    if (activities) {
      this.lastActivitiesList = activities;
    } else {
      activities = this.lastActivitiesList;
    }

    const listEl = document.getElementById('live-activity-monitor-list');
    if (!listEl) return;

    if (!activities || activities.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-sec); font-size:12px; text-align:center; padding:40px 20px;">No recent user activity recorded</div>';
      return;
    }

    // Filter activities
    let filtered = activities;
    const filter = this.currentActivityFilter || 'all';
    if (filter === 'navigation') {
      filtered = activities.filter(a => a.type === 'navigation');
    } else if (filter === 'trade') {
      filtered = activities.filter(a => a.type === 'trade');
    } else if (filter === 'finance') {
      filtered = activities.filter(a => ['deposit', 'withdrawal', 'bonus', 'kyc'].includes(a.type));
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="color:var(--text-sec); font-size:12px; text-align:center; padding:40px 20px;">No ${filter} activities found</div>`;
      return;
    }

    listEl.innerHTML = filtered.map(act => {
      let icon = '🧭';
      let bgColor = 'rgba(59, 130, 246, 0.1)';
      let textColor = '#3b82f6';
      
      if (act.type === 'trade') {
        icon = '📈';
        bgColor = 'rgba(168, 85, 247, 0.1)';
        textColor = '#a855f7';
      } else if (act.type === 'deposit') {
        icon = '💵';
        bgColor = 'rgba(16, 185, 129, 0.1)';
        textColor = '#10b981';
      } else if (act.type === 'withdrawal') {
        icon = '💸';
        bgColor = 'rgba(245, 158, 11, 0.1)';
        textColor = '#f59e0b';
      } else if (act.type === 'bonus') {
        icon = '🎁';
        bgColor = 'rgba(236, 72, 153, 0.1)';
        textColor = '#ec4899';
      } else if (act.type === 'kyc') {
        icon = '🪪';
        bgColor = 'rgba(14, 165, 233, 0.1)';
        textColor = '#0ea5e9';
      } else if (act.type === 'signup') {
        icon = '👤';
        bgColor = 'rgba(99, 102, 241, 0.1)';
        textColor = '#6366f1';
      }

      const timeStr = new Date(act.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return `
        <div class="mini-item" style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:rgba(255,255,255,0.02); border-radius:6px; border:1px solid var(--border); font-size:12px; transition: all 0.2s ease;">
          <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1;">
            <span style="font-size:14px; width:28px; height:28px; border-radius:50%; background:${bgColor}; color:${textColor}; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; font-weight:bold;">
              ${icon}
            </span>
            <div style="min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.2;">
              <div style="font-weight:700; color:var(--text); display:inline-block; margin-right:4px;">
                ${this.esc(act.username)}
              </div>
              <span style="color:var(--text-sec); font-weight:500;">
                ${this.esc(act.action)}
              </span>
              <div style="font-size:9px; color:var(--text-muted); margin-top:2px;">
                ${timeStr}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  async saveGlobalSettings() {
    const override = document.getElementById('global-trade-override').value;
    const signup = document.getElementById('global-signup-toggle').value;
    const maintenance = document.getElementById('global-maintenance-toggle').value;
    
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          global_trade_override: override,
          signup_enabled: signup,
          maintenance_mode: maintenance
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Platform configuration applied successfully.', 'success');
        this.loadDashboard();
      } else {
        this.toast(data.error || 'Failed to save settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  onMaintenanceToggleChange(sel) {
    if (sel.value === '1') {
      this.openMaintenanceHtmlModal();
    } else {
      const editBtn = document.getElementById('btn-edit-maintenance-html');
      if (editBtn) editBtn.style.display = 'none';
    }
  },

  openMaintenanceHtmlModal() {
    this.openModal('maintenance-modal');
    
    const textarea = document.getElementById('maintenance-html-textarea');
    if (!textarea) return;

    // Prefill with saved HTML or the gorgeous default template
    if (this.settingsCache && this.settingsCache.maintenance_html) {
      textarea.value = this.settingsCache.maintenance_html;
    } else {
      textarea.value = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>System Maintenance - Gain EX</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-main: #06090f;
      --bg-card: #0d111a;
      --primary: #00e676;
      --primary-glow: rgba(0, 230, 118, 0.15);
      --border: rgba(255, 255, 255, 0.05);
      --text-main: #ffffff;
      --text-muted: #8b9bb4;
    }

    body {
      background-color: var(--bg-main);
      color: var(--text-main);
      font-family: 'Outfit', sans-serif;
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }

    /* Radial ambient glow background */
    body::before {
      content: '';
      position: absolute;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(0, 230, 118, 0.05) 0%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 0;
      pointer-events: none;
    }

    .container {
      max-width: 550px;
      width: 100%;
      background: var(--bg-card);
      border: 1.5px solid var(--border);
      border-radius: 24px;
      padding: 50px 40px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(0, 230, 118, 0.02);
      text-align: center;
      z-index: 1;
      position: relative;
      animation: fadeIn 0.8s ease-out;
    }

    .brand-logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 35px;
    }

    .brand-logo img {
      height: 54px;
      width: auto;
    }

    .brand-logo span {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 1px;
      background: linear-gradient(135deg, #ffffff, #00e676);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .maint-icon-container {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .maint-icon-bg {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: rgba(0, 230, 118, 0.05);
      border: 1px dashed rgba(0, 230, 118, 0.2);
      animation: rotateDashed 20s linear infinite;
    }

    .maint-icon {
      font-size: 44px;
      animation: gearPulse 3s ease-in-out infinite;
      z-index: 1;
    }

    h1 {
      font-size: 28px;
      font-weight: 800;
      margin: 0 0 16px 0;
      letter-spacing: 0.5px;
      line-height: 1.3;
    }

    p {
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1.6;
      margin: 0 0 35px 0;
      font-weight: 400;
    }

    /* Live status indicator */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 100px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 10px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ffc107;
      box-shadow: 0 0 8px #ffc107;
      animation: pulseDot 1.5s infinite;
    }

    .progress-bar-container {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 25px;
    }

    .progress-bar-fill {
      height: 100%;
      width: 65%;
      background: linear-gradient(90deg, #00e676, #00b0ff);
      border-radius: 10px;
      animation: progressAnim 3s ease-in-out infinite alternate;
    }

    .footer-text {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.2);
      margin-top: 20px;
      font-weight: 500;
    }

    /* Animations */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes rotateDashed {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes gearPulse {
      0% { transform: scale(1) rotate(0deg); }
      50% { transform: scale(1.08) rotate(180deg); }
      100% { transform: scale(1) rotate(360deg); }
    }

    @keyframes pulseDot {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }

    @keyframes progressAnim {
      0% { width: 10%; }
      100% { width: 90%; }
    }
  </style>
</head>
<body>

  <div class="container">
    <div class="brand-logo">
      <img src="/logo.png" alt="Gain EX Logo">
    </div>

    <div class="maint-icon-container">
      <div class="maint-icon-bg"></div>
      <div class="maint-icon">⚙️</div>
    </div>

    <div class="status-badge">
      <span class="status-dot"></span>
      <span>System Update in Progress</span>
    </div>

    <h1>Scheduled Maintenance</h1>
    
    <p>We are currently upgrading our core infrastructure to deliver a faster, more secure, and extremely premium trading experience. We will be back online in just a few minutes. Thank you for your patience!</p>

    <div class="progress-bar-container">
      <div class="progress-bar-fill"></div>
    </div>

    <div class="footer-text">
      &copy; 2026 Gain EX. All rights reserved.
    </div>
  </div>

</body>
</html>`;
    }
  },

  previewMaintenanceHtml() {
    const textarea = document.getElementById('maintenance-html-textarea');
    if (!textarea) return;
    const html = textarea.value;
    const win = window.open();
    if (win) {
      win.document.write(html);
      win.document.close();
    } else {
      this.toast('Pop-up blocked. Please allow pop-ups to preview the page.', 'error');
    }
  },

  async saveMaintenanceConfig() {
    const textarea = document.getElementById('maintenance-html-textarea');
    if (!textarea) return;
    const customHtml = textarea.value;
    
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          maintenance_html: customHtml,
          maintenance_mode: '1'
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Maintenance mode enabled and HTML saved.', 'success');
        this.closeModal('maintenance-modal');
        
        // Update cache
        if (!this.settingsCache) this.settingsCache = {};
        this.settingsCache.maintenance_html = customHtml;
        this.settingsCache.maintenance_mode = '1';
        
        // Update UI
        const maintenanceSel = document.getElementById('global-maintenance-toggle');
        if (maintenanceSel) maintenanceSel.value = '1';
        const editBtn = document.getElementById('btn-edit-maintenance-html');
        if (editBtn) editBtn.style.display = 'block';
      } else {
        this.toast(data.error || 'Failed to save maintenance settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  cancelMaintenanceConfig() {
    this.closeModal('maintenance-modal');
    // Revert select back to saved state in settingsCache
    const savedState = this.settingsCache?.maintenance_mode === '1' ? '1' : '0';
    const maintenanceSel = document.getElementById('global-maintenance-toggle');
    if (maintenanceSel) {
      maintenanceSel.value = savedState;
    }
    const editBtn = document.getElementById('btn-edit-maintenance-html');
    if (editBtn) {
      editBtn.style.display = savedState === '1' ? 'block' : 'none';
    }
  },

  async setDashTradeControl(tradeId, control) {
    try {
      const res = await fetch(`/api/admin/trades/${tradeId}/control`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ admin_control: control })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Active contract #${tradeId} set to force ${control.toUpperCase()}`, 'success');
        this.loadDashboard();
      } else {
        this.toast(data.error || 'Failed to override contract.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async approveDashKyc(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/kyc/approve`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('KYC verified successfully.', 'success');
        this.loadDashboard();
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to verify KYC.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async rejectDashKyc(userId) {
    const reason = 'We need more details from you or the document photo is blurry. Please re-upload your ID.';
    try {
      const res = await fetch(`/api/admin/users/${userId}/kyc/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('KYC verification rejected.', 'success');
        this.loadDashboard();
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to reject KYC.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== USERS ====================
  async loadUsers() {
    const tbody = document.getElementById('users-table-body');
    if (!this.allUsersCache || this.allUsersCache.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Loading users...</td></tr>';
    }
    try {
      const res = await fetch('/api/admin/users', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      this.allUsersCache = data.users || [];
      
      // Calculate Stats Dashboard
      let onlineCount = 0;
      let totalBalances = 0;
      let totalBrokerProfit = 0;
      let totalTradersCount = 0;
      
      this.allUsersCache.forEach(u => {
        const isTestUser = (u.is_test === true || u.is_test === 1 || u.is_test === '1' || u.is_test === 'true');
        if (isTestUser) return;

        totalTradersCount++;
        let isOnline = false;
        if (u.last_seen_at) {
          let s = String(u.last_seen_at).trim();
          if (s.includes('T') && !s.endsWith('Z') && !s.includes('+') && s.split('T')[1] && !s.split('T')[1].includes('-')) {
            s += 'Z';
          } else if (!s.includes('T') && !s.includes('Z') && !s.includes('UTC')) {
            s += ' UTC';
          }
          const lastSeenDate = new Date(s);
          if (!isNaN(lastSeenDate.getTime())) {
            isOnline = (Date.now() - lastSeenDate.getTime() < 120000); // 2 minutes window
          }
        }
        if (isOnline) onlineCount++;

        const uCurrency = (u.currency || 'USD').toUpperCase().trim();
        const DEFAULT_CURRENCY_RATES = {
          USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
          EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
          IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
          THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
          PHP: 58.0, KRW: 1380.0
        };
        let rate = (this.currencyRates && this.currencyRates[uCurrency]) || DEFAULT_CURRENCY_RATES[uCurrency] || 1.0;
        totalBalances += parseFloat(u.balance || 0) / rate;
        totalBrokerProfit += parseFloat(u.net_broker_revenue || 0);
      });
      
      // Populate Stats DOM
      const totalEl = document.getElementById('stats-users-total');
      const activeEl = document.getElementById('stats-users-active');
      const balancesEl = document.getElementById('stats-users-balances');
      const profitEl = document.getElementById('stats-users-broker-profit');
      const profitLabelEl = document.getElementById('stats-users-broker-profit-label');
      const isEmp = this.user && this.user.role === 'employee';
      
      if (totalEl) totalEl.textContent = totalTradersCount;
      if (activeEl) activeEl.textContent = onlineCount;
      if (balancesEl) balancesEl.textContent = '$' + totalBalances.toLocaleString([], {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (profitEl) {
        if (isEmp) {
          if (profitLabelEl) profitLabelEl.textContent = 'Your Earnings';
          profitEl.textContent = (totalBrokerProfit >= 0 ? '+' : '') + '$' + totalBrokerProfit.toLocaleString([], {minimumFractionDigits: 2, maximumFractionDigits: 2});
          profitEl.style.color = 'var(--primary)';
        } else {
          if (profitLabelEl) profitLabelEl.textContent = 'Broker Net Revenue';
          profitEl.textContent = (totalBrokerProfit >= 0 ? '+' : '') + '$' + totalBrokerProfit.toLocaleString([], {minimumFractionDigits: 2, maximumFractionDigits: 2});
          profitEl.style.color = totalBrokerProfit >= 0 ? 'var(--primary)' : 'var(--danger)';
        }
      }
      
      // Apply current search and filter selections
      this.applyAllUserFilters();
    } catch (e) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Failed to load users.</td></tr>';
    }
  },

  renderUsersTable(users) {
    // Reset selection checkboxes and actions bar
    const selectAllChk = document.getElementById('users-select-all');
    if (selectAllChk) selectAllChk.checked = false;
    const bulkActionsDiv = document.getElementById('users-bulk-actions');
    if (bulkActionsDiv) bulkActionsDiv.style.display = 'none';

    const tbody = document.getElementById('users-table-body');
    if (!users || users.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="loading-cell">No users found.</td></tr>';
      return;
    }
    const isEmp = this.user && this.user.role === 'employee';
    tbody.innerHTML = users.map(u => {
      let lastSeenDate = null;
      let isOnline = false;
      if (u.last_seen_at) {
        if (u.last_seen_at instanceof Date) {
          lastSeenDate = u.last_seen_at;
        } else {
          let s = String(u.last_seen_at).trim();
          if (s.includes('T') && !s.endsWith('Z') && !s.includes('+') && s.split('T')[1] && !s.split('T')[1].includes('-')) {
            s += 'Z';
          } else if (!s.includes('T') && !s.includes('Z') && !s.includes('UTC')) {
            s += ' UTC';
          }
          lastSeenDate = new Date(s);
        }
        if (lastSeenDate && !isNaN(lastSeenDate.getTime())) {
          isOnline = (Date.now() - lastSeenDate.getTime() < 120000);
        }
      }
      
      const showOnlineIndicator = isOnline && !isEmp;

      const joinedDateStr = new Date(u.created_at).toLocaleDateString();
      let lastSeenStr = '<span style="color:var(--text-muted);">Offline</span>';
      if (lastSeenDate && !isNaN(lastSeenDate.getTime())) {
        const diffMin = Math.round((Date.now() - lastSeenDate.getTime()) / 60000);
        if (diffMin < 1) {
          lastSeenStr = isEmp ? '<span style="color:var(--text-sec);">Active just now</span>' : '<span style="color:#10b981; font-weight:700;">🟢 Online</span>';
        } else if (diffMin < 60) {
          lastSeenStr = `Active ${diffMin}m ago`;
        } else {
          lastSeenStr = lastSeenDate.toLocaleDateString() + ' ' + lastSeenDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        }
      }

      const balanceVal = parseFloat(u.balance || 0);
      const depositsVal = parseFloat(u.total_deposits || 0);
      const isVIP = balanceVal >= 2000 || depositsVal >= 5000;
      const vipTag = isVIP 
        ? '<span class="badge" style="background:#2563eb1e; color:#2563eb; border: 1px solid #2563eb30; font-weight:800; font-size:9px; padding:2px 6px; border-radius:4px; display:inline-block;">👑 VIP</span>'
        : '<span class="badge badge-gray" style="font-size:9px; padding:2px 6px; border-radius:4px; display:inline-block;">Standard</span>';
      
      const delayMs = parseInt(u.slippage_delay_ms || 0);
      const slippagePct = parseFloat(u.slippage_pct || 0);
      const hasLatency = delayMs > 0 || slippagePct > 0;
      const latencyTag = hasLatency
        ? `<span class="badge badge-yellow" style="font-size:9px; padding:2px 6px; display:inline-block;" title="Delay: ${delayMs}ms, Slip: ${slippagePct}%">⚙️ Override</span>`
        : '';

      const aiBotBadge = u.aibot_key
        ? `<span class="badge" style="background:rgba(0,200,150,0.1); color:#00c896; border:1px solid rgba(0,200,150,0.2); font-weight:700; font-size:9px; padding:2px 6px; border-radius:4px; display:inline-block;" title="Key: ${this.esc(u.aibot_key)}">🤖 Bot Active</span>`
        : `<span class="badge badge-gray" style="font-size:9px; padding:2px 6px; border-radius:4px; display:inline-block; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:var(--text-muted);">🤖 Bot Inactive</span>`;

      const totalTrades = parseInt(u.total_trades || 0);
      const wonTrades = parseInt(u.won_trades || 0);
      const winRate = totalTrades > 0 ? Math.round((wonTrades / totalTrades) * 100) : 0;
      
      let wrBadge = '';
      if (totalTrades > 0) {
        let wrBadgeColor = 'var(--text-sec)';
        let wrBgColor = 'rgba(74,122,101,0.06)';
        let wrBorderColor = 'rgba(74,122,101,0.15)';
        
        if (winRate >= 70) {
          wrBadgeColor = 'var(--danger)';
          wrBgColor = 'rgba(239,68,68,0.08)';
          wrBorderColor = 'rgba(239,68,68,0.2)';
        } else if (winRate <= 30) {
          wrBadgeColor = 'var(--primary)';
          wrBgColor = 'rgba(16,185,129,0.08)';
          wrBorderColor = 'rgba(16,185,129,0.2)';
        }
        wrBadge = `<span class="badge" style="color:${wrBadgeColor}; background:${wrBgColor}; border:1px solid ${wrBorderColor}; font-weight:700; font-size:10px; padding:2px 6px; display:inline-block; border-radius:4px;">WR: ${winRate}% (${wonTrades}/${totalTrades})</span>`;
      } else {
        wrBadge = `<span style="color:var(--text-muted); font-size:11px;">No trades yet</span>`;
      }
      
      let moodEmoji = '⚖️';
      let moodText = 'Calm';
      if (totalTrades >= 3) {
        if (winRate >= 70) { moodEmoji = '🤑'; moodText = 'Greedy'; }
        else if (winRate <= 30) { moodEmoji = '🔥'; moodText = 'Tilt'; }
      }

      const netRevenue = parseFloat(u.net_broker_revenue || 0);
      const isRevenuePositive = netRevenue >= 0;

      const kycStatus = u.kyc_status || 'unverified';
      const kycBadge = kycStatus === 'verified'
        ? '<span class="badge badge-green">Verified</span>'
        : kycStatus === 'pending'
        ? '<span class="badge badge-yellow">Pending</span>'
        : kycStatus === 'rejected'
        ? '<span class="badge badge-red">Rejected</span>'
        : '<span class="badge badge-gray">Unverified</span>';

      const statusBadge = u.status === 'active'
        ? '<span class="badge badge-green">Active</span>'
        : u.status === 'frozen'
        ? '<span class="badge badge-yellow">Frozen</span>'
        : '<span class="badge badge-red">Blocked</span>';

      const isTestUser = (u.is_test === true || u.is_test === 1 || u.is_test === '1' || u.is_test === 'true');
      const testBadge = isTestUser
        ? '<span class="badge" style="background:rgba(239,68,68,0.1); color:var(--danger); border:1px solid rgba(239,68,68,0.2); font-weight:700; font-size:9.5px;">🔬 Test</span>'
        : '';

      return `
      <tr style="transition: all 0.2s ease;">
        <!-- Column 0: Checkbox -->
        ${this.user.role === 'admin' ? `
        <td style="padding-left: 16px; width: 40px; vertical-align: middle;">
          <input type="checkbox" class="user-select-chk" value="${u.id}" onchange="panel.onUserSelectChange()" style="transform:scale(1.25); cursor:pointer;">
        </td>
        ` : ''}
        <!-- Column 1: Trader Details -->
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="user-avatar-circle" style="width:36px; height:36px; border-radius:50%; background:${showOnlineIndicator ? 'rgba(16,185,129,0.1)' : 'rgba(138,173,156,0.1)'}; color:${showOnlineIndicator ? 'var(--primary)' : 'var(--text-muted)'}; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; border: 1.5px solid ${showOnlineIndicator ? 'var(--primary)' : 'var(--border)'}; position:relative; flex-shrink:0;">
              ${(u.username || 'U').substring(0, 2).toUpperCase()}
              <span style="position:absolute; bottom:-1px; right:-1px; width:10px; height:10px; border-radius:50%; background:${showOnlineIndicator ? '#10b981' : '#8aad9c'}; border:2px solid #fff; box-shadow:${showOnlineIndicator ? '0 0 6px #10b981' : 'none'};"></span>
            </div>
            <div style="display:flex; flex-direction:column; line-height:1.35;">
              <span style="font-weight:700; color:var(--text); font-size:13.5px; display:inline-flex; align-items:center; gap:4px;">
                ${this.esc(u.username)}
                ${u.invite_code ? `<span style="font-size:9px; background:rgba(16,185,129,0.08); color:var(--accent); padding:1px 4px; border-radius:4px; font-family:monospace; font-weight:500;">code: ${this.esc(u.invite_code)}</span>` : ''}
              </span>
              ${u.email ? `<span style="font-size:11px; color:var(--text-sec); font-family:monospace; word-break:break-all;">${this.esc(u.email)}</span>` : ''}
              ${u.phone_number ? `<span style="font-size:10px; color:var(--text-muted); font-family:monospace;">${this.esc(u.phone_number)}</span>` : ''}
            </div>
          </div>
        </td>

        <!-- Column 2: Account Balances (Real / Demo) -->
        <td>
          <div style="display:flex; flex-direction:column; gap:2px; line-height:1.2; font-family:monospace;">
            <div style="font-size:13px; font-weight:700; color:var(--accent);">💎 ${this.fmtBal(u.balance, u.currency)}</div>
            <div style="font-size:11px; color:var(--text-muted);">🔬 $${parseFloat(u.demo_balance || 0).toFixed(2)}</div>
          </div>
        </td>

        <!-- Column 3: Status & Overrides -->
        <td>
          <div style="display:flex; flex-direction:column; gap:4px; line-height:1.3; align-items:flex-start;">
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              ${statusBadge}
              ${kycBadge}
              ${testBadge}
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
              ${vipTag}
              ${latencyTag}
              ${aiBotBadge}
            </div>
            <div style="font-size:10px; color:var(--text-sec); font-weight:500;">Live Trading: <span style="font-weight:700; color:${u.real_account_active ? 'var(--primary)' : 'var(--danger)'};">${u.real_account_active ? 'ENABLED' : 'DISABLED'}</span></div>
          </div>
        </td>

        <!-- Column 4: Performance & Revenue -->
        <td>
          <div style="display:flex; flex-direction:column; gap:4px; line-height:1.3;">
            <div>${wrBadge}</div>
            ${totalTrades > 0 ? `<div style="font-size:10px; font-weight:600; color:var(--text-sec);">${moodEmoji} Mood: ${moodText}</div>` : ''}
            ${this.user && this.user.role === 'employee' ? `
            <div style="font-size:11px; font-weight:600;">Commission: <span style="color:var(--primary); font-weight:700;">+$${netRevenue.toFixed(2)}</span></div>
            ` : `
            <div style="font-size:11px; font-weight:600;">Net PnL: <span style="color:${isRevenuePositive ? 'var(--primary)' : 'var(--danger)'};">${isRevenuePositive ? '+' : ''}$${netRevenue.toFixed(2)}</span></div>
            `}
          </div>
        </td>

        <!-- Column 5: Session & Activity -->
        <td>
          <div style="display:flex; flex-direction:column; gap:2px; line-height:1.2; font-size:11px;">
            <div style="font-weight:600; color:var(--text-sec);">${lastSeenStr}</div>
            <div style="color:var(--text-muted); font-size:10px;">Joined: ${joinedDateStr}</div>
            ${u.last_ip ? `<div style="color:var(--text-muted); font-size:10px; font-family:monospace; margin-top:2px; display:inline-flex; align-items:center; gap:3px;" title="IP: ${this.esc(u.last_ip)}${u.last_country ? ` - Country: ${this.esc(u.last_country)}` : ''}">📍 ${this.esc(u.last_ip)} ${u.last_country ? `(${this.esc(u.last_country)})` : ''}</div>` : ''}
          </div>
        </td>

        <!-- Column 6: Actions -->
        <td style="padding-right:16px; text-align:right;">
          <div class="action-btns" style="justify-content: flex-end; gap:6px;">
            <button class="btn-action btn-info" onclick="panel.viewUser(${u.id})" style="padding:4px 8px; font-size:11px; height:28px; border-radius:4px;">Details</button>
            ${this.user.role === 'admin' ? `
            <button class="btn-action btn-approve" onclick="panel.openManageModal(${u.id})" style="padding:4px 8px; font-size:11px; height:28px; border-radius:4px; background:rgba(16,185,129,0.08); color:var(--primary); border:1px solid rgba(16,185,129,0.15);" onmouseover="this.style.background='var(--primary)';this.style.color='#000';" onmouseout="this.style.background='rgba(16,185,129,0.08)';this.style.color='var(--primary)';">Adjust</button>
            ` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');
  },

  onUserSearchChange(val) {
    this.userSearchQuery = val;
    this.applyAllUserFilters();
  },

  onUserFilterChange() {
    this.applyAllUserFilters();
  },

  resetUserFilters() {
    document.getElementById('user-search').value = '';
    document.getElementById('user-filter-status').value = '';
    document.getElementById('user-filter-kyc').value = '';
    document.getElementById('user-filter-risk').value = '';
    document.getElementById('user-filter-online').value = '';
    document.getElementById('user-filter-balance').value = '';
    
    this.userSearchQuery = '';
    this.applyAllUserFilters();
  },

  applyAllUserFilters() {
    const searchVal = (this.userSearchQuery || '').toLowerCase().trim();
    const statusVal = document.getElementById('user-filter-status')?.value || '';
    const kycVal = document.getElementById('user-filter-kyc')?.value || '';
    const riskVal = document.getElementById('user-filter-risk')?.value || '';
    const onlineVal = document.getElementById('user-filter-online')?.value || '';
    const balanceFilterVal = document.getElementById('user-filter-balance')?.value || '';

    let filtered = this.allUsersCache || [];

    if (searchVal) {
      filtered = filtered.filter(u => 
        (u.username && u.username.toLowerCase().includes(searchVal)) ||
        (u.email && u.email.toLowerCase().includes(searchVal)) ||
        (u.phone_number && u.phone_number.toLowerCase().includes(searchVal)) ||
        String(u.id).includes(searchVal) ||
        (u.invite_code && u.invite_code.toLowerCase().includes(searchVal)) ||
        (u.last_ip && u.last_ip.toLowerCase().includes(searchVal))
      );
    }

    if (statusVal) {
      filtered = filtered.filter(u => u.status === statusVal);
    }

    if (kycVal) {
      filtered = filtered.filter(u => {
        const kStatus = u.kyc_status || 'unverified';
        return kStatus === kycVal;
      });
    }

    if (riskVal) {
      filtered = filtered.filter(u => {
        const balanceVal = parseFloat(u.balance || 0);
        const depositsVal = parseFloat(u.total_deposits || 0);
        const isVIP = balanceVal >= 2000 || depositsVal >= 5000;
        
        const totalTrades = parseInt(u.total_trades || 0);
        const wonTrades = parseInt(u.won_trades || 0);
        const winRate = totalTrades > 0 ? Math.round((wonTrades / totalTrades) * 100) : 0;
        
        if (riskVal === 'vip') {
          return isVIP;
        } else if (riskVal === 'profit') {
          return totalTrades >= 3 && winRate >= 70;
        } else if (riskVal === 'house') {
          return totalTrades >= 3 && winRate <= 30;
        } else if (riskVal === 'tilt') {
          return totalTrades >= 3 && winRate <= 30;
        }
        return true;
      });
    }

    if (onlineVal) {
      filtered = filtered.filter(u => {
        let isOnline = false;
        if (u.last_seen_at) {
          let lastSeenDate = null;
          if (u.last_seen_at instanceof Date) {
            lastSeenDate = u.last_seen_at;
          } else {
            let s = String(u.last_seen_at).trim();
            if (s.includes('T') && !s.endsWith('Z') && !s.includes('+') && s.split('T')[1] && !s.split('T')[1].includes('-')) {
              s += 'Z';
            } else if (!s.includes('T') && !s.includes('Z') && !s.includes('UTC')) {
              s += ' UTC';
            }
            lastSeenDate = new Date(s);
          }
          if (lastSeenDate && !isNaN(lastSeenDate.getTime())) {
            isOnline = (Date.now() - lastSeenDate.getTime() < 120000);
          }
        }
        return onlineVal === 'online' ? isOnline : !isOnline;
      });
    }

    if (balanceFilterVal) {
      filtered = filtered.filter(u => {
        const bal = parseFloat(u.balance || 0);
        if (balanceFilterVal === 'zero') return bal === 0;
        if (balanceFilterVal === 'positive') return bal > 0;
        if (balanceFilterVal === 'thousand') return bal >= 1000;
        if (balanceFilterVal === 'negative') return bal < 0;
        return true;
      });
    }

    const countEl = document.getElementById('user-count-display');
    if (countEl) countEl.textContent = `Showing ${filtered.length} of ${this.allUsersCache.length} users`;

    this.renderUsersTable(filtered);
  },

  openQuickBalanceAdjust(userId, username) {
    this.viewUser(userId);
    setTimeout(() => {
      const el = document.getElementById(`quick-bal-amount-${userId}`);
      if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 450);
  },

  filterUsers(query) {
    this.onUserSearchChange(query);
  },

  // Quick inline balance adjustment from user profile
  async quickBalanceAdjust(userId, action, target) {
    const amountEl = document.getElementById(`quick-bal-amount-${userId}`);
    const noteEl = document.getElementById(`quick-bal-note-${userId}`);
    const amount = parseFloat(amountEl?.value);
    const note = noteEl?.value?.trim() || '';
    if (!amount || amount <= 0) { this.toast('Enter a valid amount greater than 0.', 'error'); return; }
    try {
      const res = await fetch(`/api/admin/users/${userId}/balance`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, amount, note, target })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ ${action === 'add' ? 'Credited' : 'Debited'} $${amount.toFixed(2)} ${action === 'add' ? 'to' : 'from'} ${target} account.`, 'success');
        if (amountEl) amountEl.value = '';
        if (noteEl) noteEl.value = '';
        this.loadUsers();
        // Refresh the modal with updated data
        setTimeout(() => this.viewUser(userId), 300);
      } else {
        this.toast(data.error || 'Failed to adjust balance.', 'error');
      }
    } catch (e) { this.toast('Network error.', 'error'); }
  },

  // Quick inline toggle: real account, trading, withdrawals
  async quickToggle(userId, field, newVal, label) {
    try {
      const body = {};
      body[field] = newVal;
      const res = await fetch(`/api/admin/users/${userId}/manage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ ${label}`, 'success');
        this.loadUsers();
        setTimeout(() => this.viewUser(userId), 300);
      } else {
        this.toast(data.error || 'Failed to update.', 'error');
      }
    } catch (e) { this.toast('Network error.', 'error'); }
  },

  async viewUser(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/details`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error || 'Failed to load user.', 'error'); return; }
      const u = data.user;
      const ledger = (data.ledger || []).slice(0, 10);

      document.getElementById('user-modal-title').textContent = `👤 ${u.username}`;
      const scoreWidth = Math.min(100, Math.max(0, ((u.credit_score || 0) / 1000) * 100)).toFixed(1);
      document.getElementById('user-modal-body').innerHTML = `
        <!-- Info Grid -->
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-label">User ID</div><div class="detail-value">#${u.id}</div></div>
          <div class="detail-item"><div class="detail-label">Username</div><div class="detail-value"><strong>${this.esc(u.username)}</strong></div></div>
          <div class="detail-item"><div class="detail-label">Email</div><div class="detail-value" style="font-size:12px;">${this.esc(u.email || '—')}</div></div>
          <div class="detail-item"><div class="detail-label">Phone</div><div class="detail-value" style="font-size:12px;">${this.esc(u.phone_number || '—')}</div></div>
          <div class="detail-item"><div class="detail-label">Last IP Address</div><div class="detail-value" style="font-family:monospace;font-size:11.5px;">${this.esc(u.last_ip || '—')}</div></div>
          <div class="detail-item"><div class="detail-label">Last Country</div><div class="detail-value">${this.esc(u.last_country || '—')}</div></div>
          <div class="detail-item"><div class="detail-label">Balance</div><div class="detail-value" style="color:var(--accent);font-weight:700;">${this.fmtBal(u.balance, u.currency)} <span style="font-size:10px;color:var(--text-muted);">(${u.currency || 'USD'})</span></div></div>
          <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value"><span class="badge ${u.status==='active'?'badge-green':u.status==='frozen'?'badge-yellow':'badge-red'}">${u.status}</span></div></div>
          <div class="detail-item"><div class="detail-label">Withdrawal</div><div class="detail-value"><span class="badge ${u.withdraw_enabled?'badge-green':'badge-red'}">${u.withdraw_enabled?'Enabled':'Disabled'}</span></div></div>
          <div class="detail-item"><div class="detail-label">Withdraw Limit</div><div class="detail-value">${u.withdraw_limit > 0 ? this.fmtBal(u.withdraw_limit, u.currency) : '<span style="color:var(--text-muted)">No limit</span>'}</div></div>
          <div class="detail-item"><div class="detail-label">Real Account</div><div class="detail-value"><span class="badge ${u.real_account_active?'badge-green':'badge-red'}">${u.real_account_active?'Active':'Review/Inactive'}</span></div></div>
          <div class="detail-item"><div class="detail-label">Demo Balance</div><div class="detail-value" style="color:var(--warning);font-weight:700;">$${parseFloat(u.demo_balance||0).toFixed(2)}</div></div>
          <div class="detail-item"><div class="detail-label">KYC Status</div><div class="detail-value">${
            u.kyc_status === 'verified' ? '<span class="badge badge-green">✅ Verified</span>'
            : u.kyc_status === 'pending' ? '<span class="badge badge-yellow">⏳ Pending Review</span>'
            : u.kyc_status === 'rejected' ? '<span class="badge badge-red">❌ Rejected</span>'
            : '<span class="badge badge-gray">Unverified</span>'
          }</div></div>
          <div class="detail-item"><div class="detail-label">Trading Allowed</div><div class="detail-value"><span class="badge ${u.trading_enabled !== 0 ? 'badge-green' : 'badge-red'}">${u.trading_enabled !== 0 ? 'Allowed' : 'Blocked'}</span></div></div>
          ${this.user.role === 'admin' ? `
          <div class="detail-item"><div class="detail-label">Next Trade Force</div><div class="detail-value"><span class="badge ${u.force_next_trade && u.force_next_trade !== 'none' ? (u.force_next_trade === 'win' ? 'badge-green' : 'badge-red') : 'badge-gray'}">${u.force_next_trade && u.force_next_trade !== 'none' ? 'FORCE ' + u.force_next_trade.toUpperCase() : 'Market'}</span></div></div>
          <div class="detail-item"><div class="detail-label">Win Chance Override</div><div class="detail-value">${u.trade_win_chance !== null && u.trade_win_chance !== undefined ? `<strong style="color:#2ecc71;">${u.trade_win_chance}%</strong>` : '<span style="color:var(--text-muted)">Disabled (Natural)</span>'}</div></div>
          <div class="detail-item"><div class="detail-label">Sentiment Mood</div><div class="detail-value"><span class="mood-badge mood-${(data.mood || 'Calm').toLowerCase()}"><span class="pulse-indicator"></span>${data.mood || 'Calm'}</span></div></div>
          <div class="detail-item"><div class="detail-label">Entry Latency</div><div class="detail-value">${u.slippage_delay_ms > 0 ? u.slippage_delay_ms + 'ms' : '<span style="color:var(--text-muted)">0ms (Instant)</span>'}</div></div>
          <div class="detail-item"><div class="detail-label">Execution Slippage</div><div class="detail-value">${u.slippage_pct > 0 ? u.slippage_pct.toFixed(1) + '%' : '<span style="color:var(--text-muted)">0.0% (Perfect)</span>'}</div></div>
          <div class="detail-item"><div class="detail-label">Auto-Loss Balance</div><div class="detail-value">${u.auto_loss_balance > 0 ? '$' + parseFloat(u.auto_loss_balance).toFixed(2) : '<span style="color:var(--text-muted)">None</span>'}</div></div>
          <div class="detail-item"><div class="detail-label">Auto-Loss Profit %</div><div class="detail-value">${u.auto_loss_pct > 0 ? u.auto_loss_pct + '%' : '<span style="color:var(--text-muted)">None</span>'}</div></div>
          <div class="detail-item" style="grid-column: span 2;"><div class="detail-label">Custom Withdrawal Reject Message</div><div class="detail-value" style="font-size:12px;">${u.withdraw_error_message ? `<span style="color:#ef4444; font-weight:600;">${this.esc(u.withdraw_error_message)}</span>` : '<span style="color:var(--text-muted)">None (Standard Message)</span>'}</div></div>
          ` : ''}
        </div>

        ${ (u.kyc_status === 'pending' || u.kyc_status === 'verified' || u.kyc_status === 'rejected') && this.user.role === 'admin' ? `
        <!-- KYC Review -->
        <div style="margin-bottom:18px;">
          <div class="manage-section-title">🛡️ KYC Identity Documents</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;line-height:1.7;">
            <div><strong>Country:</strong> ${this.esc(u.kyc_country || '—')}</div>
            <div><strong>Address:</strong> ${this.esc(u.kyc_address || '—')}</div>
            <div><strong>Submitted:</strong> ${u.kyc_submitted_at ? new Date(u.kyc_submitted_at).toLocaleString() : '—'}</div>
            ${u.kyc_status === 'rejected' && u.kyc_rejected_reason ? `<div style="color:#ef4444;margin-top:4px;"><strong>Rejection Reason:</strong> ${this.esc(u.kyc_rejected_reason)}</div>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px;">
            ${u.kyc_document_front ? `<div><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">ID FRONT</div><a href="${u.kyc_document_front}" target="_blank"><img src="${u.kyc_document_front}" style="width:100%;border-radius:6px;border:1px solid rgba(16,185,129,0.25);cursor:pointer;" onerror="this.style.display='none'"></a></div>` : '<div style="color:var(--text-muted);font-size:11px;">No front doc</div>'}
            ${u.kyc_document_back ? `<div><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">ID BACK</div><a href="${u.kyc_document_back}" target="_blank"><img src="${u.kyc_document_back}" style="width:100%;border-radius:6px;border:1px solid rgba(16,185,129,0.25);cursor:pointer;" onerror="this.style.display='none'"></a></div>` : '<div style="color:var(--text-muted);font-size:11px;">No back doc</div>'}
            ${u.kyc_selfie ? `<div><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">SELFIE</div><a href="${u.kyc_selfie}" target="_blank"><img src="${u.kyc_selfie}" style="width:100%;border-radius:6px;border:1px solid rgba(16,185,129,0.25);cursor:pointer;" onerror="this.style.display='none'"></a></div>` : '<div style="color:var(--text-muted);font-size:11px;">No selfie</div>'}
          </div>
          ${(u.kyc_status === 'pending' && this.user.role === 'admin') ? `
          <div style="display:flex;gap:8px;">
            <button class="btn-action btn-approve" style="padding:8px 18px;flex:1;" onclick="panel.approveKyc(${u.id});panel.closeModal('user-modal');">✅ Approve KYC</button>
            <button class="btn-action btn-reject" style="padding:8px 18px;flex:1;" onclick="panel.openRejectKyc(${u.id});panel.closeModal('user-modal');">❌ Reject KYC</button>
          </div>` : ''}
          ${u.kyc_status === 'verified' ? '<div style="color:#10b981;font-size:12px;">✅ KYC has been verified and approved.</div>' : ''}
          ${(u.kyc_status === 'rejected' && this.user.role === 'admin') ? `<div style="display:flex;gap:8px;"><button class="btn-action btn-warn" style="padding:8px 18px;" onclick="panel.approveKyc(${u.id});panel.closeModal('user-modal');">↩ Re-approve KYC</button></div>` : ''}
        </div>` : '' }

        <!-- Credit Score -->
        <div style="margin-bottom:16px;">
          <div class="detail-label" style="margin-bottom:4px;">Credit Score: <strong style="color:var(--primary);">${u.credit_score || 0} / 1000</strong></div>
          <div class="credit-score-bar"><div class="credit-score-fill" style="width:${scoreWidth}%"></div></div>
        </div>

        <!-- ⚡ Quick Admin Adjustments -->
        ${(u.role !== 'admin' && this.user.role === 'admin') ? `
        <div class="quick-admin-actions" style="margin: 18px 0; padding: 14px; border-radius: 12px; border: 1px solid var(--border); background: rgba(16,185,129,0.02); box-shadow: inset 0 0 10px rgba(0,0,0,0.01);">
          <div style="margin-bottom:12px; font-weight:700; color:var(--primary); font-size:11px; letter-spacing:0.5px; text-transform:uppercase;">
            ⚡ Quick Control Panel
          </div>

          <!-- Toggles -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px;">
            <div style="padding:10px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5); display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:12px; font-weight:600;">Real Account</span>
                <span style="font-size:9px; color:var(--text-muted);">Live Trading Mode</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" ${u.real_account_active ? 'checked' : ''} onchange="panel.quickToggle(${u.id}, 'real_account_active', this.checked, this.checked ? 'Real Account Activated' : 'Real Account Deactivated')">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div style="padding:10px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5); display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:12px; font-weight:600;">Trading Access</span>
                <span style="font-size:9px; color:var(--text-muted);">Allow placing trades</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" ${u.trading_enabled !== 0 ? 'checked' : ''} onchange="panel.quickToggle(${u.id}, 'trading_enabled', this.checked ? 1 : 0, this.checked ? 'Trading Access Allowed' : 'Trading Access Blocked')">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div style="padding:10px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5); display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:12px; font-weight:600;">Withdrawal Access</span>
                <span style="font-size:9px; color:var(--text-muted);">Allow client withdrawals</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" ${u.withdraw_enabled ? 'checked' : ''} onchange="panel.quickToggle(${u.id}, 'withdraw_enabled', this.checked, this.checked ? 'Withdrawals Enabled' : 'Withdrawals Disabled')">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div style="padding:10px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5); display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:12px; font-weight:600;">Demo Trading</span>
                <span style="font-size:9px; color:var(--text-muted);">Allow demo balance trades</span>
              </div>
              <label class="toggle-switch">
                <input type="checkbox" ${u.demo_trading_enabled !== 0 ? 'checked' : ''} onchange="panel.quickToggle(${u.id}, 'demo_trading_enabled', this.checked ? 1 : 0, this.checked ? 'Demo Trading Allowed' : 'Demo Trading Blocked')">
                <span class="toggle-slider"></span>
              </label>
            </div>

            <div style="padding:10px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5); display:flex; align-items:center; justify-content:space-between;">
              <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:12px; font-weight:600;">KYC Status</span>
                <span style="font-size:9px; color:var(--text-muted);">Verification status</span>
              </div>
              <select class="form-control" style="width:110px; padding:2px 4px; font-size:11px; height:28px; background:#fff; border:1px solid var(--border);" onchange="panel.quickToggle(${u.id}, 'kyc_status', this.value, 'KYC status updated to ' + this.value.toUpperCase())">
                <option value="unverified" ${u.kyc_status === 'unverified' ? 'selected' : ''}>Unverified</option>
                <option value="pending" ${u.kyc_status === 'pending' ? 'selected' : ''}>⏳ Pending</option>
                <option value="verified" ${u.kyc_status === 'verified' ? 'selected' : ''}>✅ Verified</option>
                <option value="rejected" ${u.kyc_status === 'rejected' ? 'selected' : ''}>❌ Rejected</option>
              </select>
            </div>
          </div>

          <!-- Quick Balance Adjust -->
          <div style="padding:12px; border-radius:8px; border:1px solid var(--border); background:rgba(255,255,255,0.5);">
            <div style="font-size:11px; font-weight:700; margin-bottom:8px; color:var(--text-sec); display:flex; align-items:center; gap:4px;">
              <span>💰 Balance Adjuster</span>
            </div>
            <div style="display:flex; gap:6px; margin-bottom:8px;">
              <select id="quick-bal-target-${u.id}" class="form-control" style="width:105px; padding:4px 8px; font-size:12px; height:32px; background:#fff; border:1px solid var(--border);">
                <option value="real">💎 Real Bal</option>
                <option value="demo">🔬 Demo Bal</option>
              </select>
              <input type="number" id="quick-bal-amount-${u.id}" class="form-control" placeholder="Amt ($)" style="width:85px; padding:4px 8px; font-size:12px; height:32px; background:#fff; border:1px solid var(--border);" min="0.01" step="0.01">
              <input type="text" id="quick-bal-note-${u.id}" class="form-control" placeholder="Reason/Note" style="flex:1; padding:4px 8px; font-size:12px; height:32px; background:#fff; border:1px solid var(--border);">
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-primary" style="flex:1; font-size:11px; padding:6px; height:30px; display:flex; align-items:center; justify-content:center; gap:4px;" onclick="panel.quickBalanceAdjust(${u.id}, 'add', document.getElementById('quick-bal-target-${u.id}').value)">
                ➕ Credit Funds
              </button>
              <button class="btn btn-danger" style="flex:1; font-size:11px; padding:6px; height:30px; display:flex; align-items:center; justify-content:center; gap:4px; background:#ef4444;" onclick="panel.quickBalanceAdjust(${u.id}, 'subtract', document.getElementById('quick-bal-target-${u.id}').value)">
                ➖ Debit Funds
              </button>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Recent Ledger -->
        <div style="margin-bottom:18px;">
          <div class="manage-section-title">Recent Ledger (last 10)</div>
          ${ledger.length === 0 ? '<div style="color:var(--text-muted);font-size:12px;">No ledger entries.</div>' :
            ledger.map(l => `
              <div class="mini-item" style="margin-bottom:6px;">
                <span class="mini-item-user" style="font-size:12px;">${this.esc(l.description || l.type)}</span>
                <span class="badge ${l.type.includes('win')||l.type==='deposit'||l.type==='admin_add' ? 'badge-green' : 'badge-red'}">
                  ${l.type.includes('win')||l.type==='deposit'||l.type==='admin_add' ? '+' : '-'}$${Math.abs(l.amount).toFixed(2)}
                </span>
              </div>
            `).join('')
          }
        </div>

        <!-- Status Actions -->
        ${(u.role !== 'admin' && this.user.role === 'admin') ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
          ${u.status !== 'active' ? `<button class="btn-action btn-approve" style="padding:8px 16px;" onclick="panel.setUserStatus(${u.id},'active');panel.closeModal('user-modal');">Activate</button>` : ''}
          ${u.status === 'active' ? `<button class="btn-action btn-warn" style="padding:8px 16px;" onclick="panel.setUserStatus(${u.id},'frozen');panel.closeModal('user-modal');">Freeze</button>` : ''}
          ${u.status !== 'blocked' ? `<button class="btn-action btn-reject" style="padding:8px 16px;" onclick="panel.setUserStatus(${u.id},'blocked');panel.closeModal('user-modal');">Block</button>` : ''}
          <button class="btn-action btn-info" style="padding:8px 16px;" onclick="panel.closeModal('user-modal');panel.openManageModal(${u.id});">⚙ Manage Account</button>
        </div>` : ''}
      `;
      this.openModal('user-modal');
    } catch (e) {
      this.toast('Failed to load user details.', 'error');
    }
  },

  // ==================== KYC ====================
  async loadKyc(statusFilter = 'pending') {
    const tbody = document.getElementById('kyc-table-body');
    tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Loading...</td></tr>';
    try {
      const params = statusFilter ? `?kyc_status=${statusFilter}` : '';
      const res = await fetch(`/api/admin/kyc/list${params}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error || 'Failed to load KYC records.', 'error'); return; }
      this.renderKycTable(data.users || []);
      // Update pending badge
      if (statusFilter === 'pending') {
        const badge = document.getElementById('kyc-pending-badge');
        if (badge) {
          const count = (data.users || []).length;
          badge.textContent = count;
          badge.style.display = count > 0 ? 'inline-block' : 'none';
        }
      }
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Failed to load KYC records.</td></tr>';
    }
  },

  renderKycTable(users) {
    const tbody = document.getElementById('kyc-table-body');
    if (!users || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading-cell" style="color:var(--text-muted);">No KYC records found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(u => {
      const kycStatus = u.kyc_status || 'unverified';
      const statusBadge = kycStatus === 'verified'
        ? '<span class="badge badge-green">Verified</span>'
        : kycStatus === 'pending'
        ? '<span class="badge badge-yellow">Pending</span>'
        : kycStatus === 'rejected'
        ? '<span class="badge badge-red">Rejected</span>'
        : '<span class="badge badge-gray">Unverified</span>';
      return `
        <tr>
          <td><strong>${this.esc(u.username)}</strong><br><span style="color:var(--text-muted);font-size:11px;">#${u.id} · ${this.esc(u.email || '')}</span></td>
          <td style="font-size:12px;">${this.esc(u.kyc_country || '—')}</td>
          <td style="font-size:12px;color:var(--text-muted);">${u.kyc_submitted_at ? new Date(u.kyc_submitted_at).toLocaleDateString() : '—'}</td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn-action btn-info" onclick="panel.viewKycDocs(${u.id})" style="font-size:11px;">📄 View Docs</button>
          </td>
          <td>
            <div class="action-btns">
              ${kycStatus === 'pending' ? `
                <button class="btn-action btn-approve" onclick="panel.approveKyc(${u.id})">✅ Approve</button>
                <button class="btn-action btn-reject" onclick="panel.openRejectKyc(${u.id})">❌ Reject</button>
              ` : ''}
              ${kycStatus === 'verified' ? `<span style="color:#10b981;font-size:12px;">✅ Approved</span>` : ''}
              ${kycStatus === 'rejected' ? `
                <button class="btn-action btn-warn" onclick="panel.approveKyc(${u.id})" style="font-size:11px;">↩ Re-approve</button>
              ` : ''}
            </div>
          </td>
        </tr>`;
    }).join('');
  },

  async viewKycDocs(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/details`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok || !data.user) { this.toast('Failed to load user.', 'error'); return; }
      const u = data.user;
      document.getElementById('kyc-doc-modal-title').textContent = `KYC Documents — ${u.username}`;
      document.getElementById('kyc-doc-modal-body').innerHTML = `
        <div style="margin-bottom:12px;font-size:13px;line-height:1.8;">
          <div><strong>Country:</strong> ${this.esc(u.kyc_country || '—')}</div>
          <div><strong>Address:</strong> ${this.esc(u.kyc_address || '—')}</div>
          <div><strong>Submitted:</strong> ${u.kyc_submitted_at ? new Date(u.kyc_submitted_at).toLocaleString() : '—'}</div>
          ${u.kyc_status === 'rejected' && u.kyc_rejected_reason ? `<div style="color:#ef4444;"><strong>Rejection Reason:</strong> ${this.esc(u.kyc_rejected_reason)}</div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600;">ID FRONT</div>
            ${u.kyc_document_front ? `<a href="${u.kyc_document_front}" target="_blank"><img src="${u.kyc_document_front}" style="width:100%;border-radius:8px;border:1px solid rgba(16,185,129,0.3);cursor:zoom-in;" onerror="this.parentElement.innerHTML='<span style=\'color:var(--text-muted);font-size:11px;\'>Image unavailable</span>'"></a>` : '<span style="color:var(--text-muted);font-size:11px;">Not uploaded</span>'}
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600;">ID BACK</div>
            ${u.kyc_document_back ? `<a href="${u.kyc_document_back}" target="_blank"><img src="${u.kyc_document_back}" style="width:100%;border-radius:8px;border:1px solid rgba(16,185,129,0.3);cursor:zoom-in;" onerror="this.parentElement.innerHTML='<span style=\'color:var(--text-muted);font-size:11px;\'>Image unavailable</span>'"></a>` : '<span style="color:var(--text-muted);font-size:11px;">Not uploaded</span>'}
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-weight:600;">SELFIE</div>
            ${u.kyc_selfie ? `<a href="${u.kyc_selfie}" target="_blank"><img src="${u.kyc_selfie}" style="width:100%;border-radius:8px;border:1px solid rgba(16,185,129,0.3);cursor:zoom-in;" onerror="this.parentElement.innerHTML='<span style=\'color:var(--text-muted);font-size:11px;\'>Image unavailable</span>'"></a>` : '<span style="color:var(--text-muted);font-size:11px;">Not uploaded</span>'}
          </div>
        </div>
        ${u.kyc_status === 'pending' ? `
        <div style="display:flex;gap:10px;">
          <button class="btn-action btn-approve" style="flex:1;padding:10px;" onclick="panel.approveKyc(${u.id});panel.closeModal('kyc-doc-modal');">✅ Approve KYC</button>
          <button class="btn-action btn-reject" style="flex:1;padding:10px;" onclick="panel.openRejectKyc(${u.id});panel.closeModal('kyc-doc-modal');">❌ Reject KYC</button>
        </div>` : ''}
        ${u.kyc_status === 'verified' ? '<div style="color:#10b981;font-weight:600;text-align:center;padding:10px;">✅ KYC Verified & Approved</div>' : ''}
        ${u.kyc_status === 'rejected' ? `<div style="display:flex;gap:10px;"><button class="btn-action btn-warn" style="flex:1;padding:10px;" onclick="panel.approveKyc(${u.id});panel.closeModal('kyc-doc-modal');">↩ Re-approve KYC</button></div>` : ''}
      `;
      this.openModal('kyc-doc-modal');
    } catch (e) {
      this.toast('Failed to load KYC documents.', 'error');
    }
  },

  async approveKyc(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/kyc/approve`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('KYC approved — user can now trade on Real account.', 'success');
        // Reload KYC list with current filter
        const filter = document.getElementById('kyc-filter');
        this.loadKyc(filter ? filter.value : 'pending');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to approve KYC.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  openRejectKyc(userId) {
    document.getElementById('kyc-reject-user-id').value = userId;
    document.getElementById('kyc-reject-reason').value = '';
    this.openModal('kyc-reject-modal');
  },

  async confirmRejectKyc() {
    const userId = document.getElementById('kyc-reject-user-id').value;
    const reason = document.getElementById('kyc-reject-reason').value.trim();
    if (!reason) { this.toast('Please enter a rejection reason.', 'error'); return; }
    try {
      const res = await fetch(`/api/admin/users/${userId}/kyc/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('KYC rejected — user has been notified.', 'success');
        this.closeModal('kyc-reject-modal');
        const filter = document.getElementById('kyc-filter');
        this.loadKyc(filter ? filter.value : 'pending');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to reject KYC.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async loadVisaCards() {
    const tbody = document.getElementById('visa-table-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Loading Visa Card claims...</td></tr>';
    }
    
    try {
      const res = await fetch('/api/admin/visa-cards', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        this.toast(data.error || 'Failed to load Visa Cards.', 'error');
        return;
      }
      
      const cards = data.visaCards || [];
      
      let pendingCount = 0;
      cards.forEach(c => { if (c.status === 'pending') pendingCount++; });
      const badge = document.getElementById('visa-pending-badge');
      if (badge) {
        badge.textContent = pendingCount;
        badge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
      }
      
      if (!tbody) return;
      if (cards.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">No Visa Card claims found.</td></tr>';
        return;
      }
      
      tbody.innerHTML = cards.map(c => {
        let statusBadge = '';
        if (c.status === 'pending') {
          statusBadge = '<span class="badge badge-pending">Pending</span>';
        } else if (c.status === 'delivered') {
          statusBadge = '<span class="badge badge-blue" style="background:rgba(59,130,246,0.1); color:#3b82f6; border:1px solid rgba(59,130,246,0.2);">Delivered</span>';
        } else if (c.status === 'active') {
          statusBadge = '<span class="badge badge-green">Active</span>';
        }
        
        const detailsAssigned = c.card_number 
          ? `<span style="font-family:monospace; font-size:11px;">Num: ${c.card_number.replace(/(\d{4})/g, '$1 ')}<br>Exp: ${c.card_expiry} | CVV: ${c.card_cvv}</span>`
          : '<span style="color:var(--text-muted); font-style:italic;">None Assigned</span>';
          
        let actions = '';
        if (c.status === 'pending') {
          actions = `<button class="btn-action btn-approve" style="padding:4px 8px; font-size:11px; font-weight:700;" onclick="panel.openVisaDeliverModal(${c.id}, '${this.esc(c.first_name)}', '${this.esc(c.last_name)}', '${this.esc(c.address)}')">Ship / Deliver</button>`;
        } else {
          actions = '<span style="color:var(--text-muted); font-size:11px;">No Action Needed</span>';
        }
        
        return `
          <tr>
            <td style="padding-left:14px;"><strong>${this.esc(c.username)}</strong> (ID: ${c.user_id})</td>
            <td>${this.esc(c.first_name)} ${this.esc(c.last_name)}</td>
            <td><strong>${this.esc(c.nickname)}</strong></td>
            <td style="font-size:11px; max-width:180px; white-space:normal; line-height:1.3;">${this.esc(c.address)}</td>
            <td>
              <button class="btn-action btn-neutral" style="padding:3px 6px; font-size:10px; font-weight:600; border:1px solid var(--border-strong);" onclick="window.open('${c.bank_statement_path}', '_blank')">
                View Statement ↗
              </button>
            </td>
            <td>${statusBadge}</td>
            <td>${detailsAssigned}</td>
            <td style="text-align:right; padding-right:14px;">${actions}</td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      console.error('Error loading Visa Cards:', err);
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell">Failed to load Visa Cards.</td></tr>';
      }
    }
  },

  openVisaDeliverModal(cardId, firstName, lastName, address) {
    document.getElementById('visa-deliver-card-id').value = cardId;
    document.getElementById('visa-deliver-first-name').value = firstName;
    document.getElementById('visa-deliver-last-name').value = lastName;
    document.getElementById('visa-deliver-address').value = address;
    
    document.getElementById('visa-deliver-number').value = '';
    document.getElementById('visa-deliver-cvv').value = '';
    document.getElementById('visa-deliver-expiry').value = '';
    
    this.openModal('visa-deliver-modal');
  },

  async submitVisaDeliver(event) {
    event.preventDefault();
    const cardId = document.getElementById('visa-deliver-card-id').value;
    const cardNumber = document.getElementById('visa-deliver-number').value.trim();
    const cardCvv = document.getElementById('visa-deliver-cvv').value.trim();
    const cardExpiry = document.getElementById('visa-deliver-expiry').value.trim();

    if (!cardNumber || !cardCvv || !cardExpiry) {
      this.toast('Card number, CVV, and expiry date are required.', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/admin/visa-card/${cardId}/deliver`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          card_number: cardNumber,
          card_cvv: cardCvv,
          card_expiry: cardExpiry
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.toast('Visa Card successfully marked as delivered.', 'success');
        this.closeModal('visa-deliver-modal');
        this.loadVisaCards();
      } else {
        this.toast(data.error || 'Failed to deliver card.', 'error');
      }
    } catch (err) {
      console.error('Error delivering Visa Card:', err);
      this.toast('Network error.', 'error');
    }
  },

  openManageModal(userId) {
    // Reset fields
    document.getElementById('manage-user-id').value = userId;
    document.getElementById('manage-username').value = '';
    document.getElementById('manage-fullname').value = '';
    document.getElementById('manage-email').value = '';
    document.getElementById('manage-phone').value = '';
    document.getElementById('manage-credit-score').value = '';
    document.getElementById('manage-withdraw-limit').value = '';
    document.getElementById('manage-withdraw-enabled').checked = true;
    document.getElementById('manage-real-account-active').checked = false;
    document.getElementById('manage-new-password').value = '';
    document.getElementById('manage-bal-target').value = 'real';
    document.getElementById('manage-bal-action').value = 'add';
    document.getElementById('manage-bal-amount').value = '';
    document.getElementById('manage-bal-note').value = '';

    // Reset ultra & futuristic features
    document.getElementById('manage-trading-enabled').checked = true;
    document.getElementById('manage-force-next-trade').value = 'none';
    document.getElementById('manage-win-chance-override').checked = false;
    document.getElementById('manage-trade-win-chance').value = 50;
    
    document.getElementById('manage-slippage-delay-ms').value = 0;
    document.getElementById('latency-val-label').textContent = '0ms';
    
    document.getElementById('manage-slippage-pct').value = 0;
    document.getElementById('slippage-val-label').textContent = '0.0%';
    
    document.getElementById('manage-auto-loss-balance').value = '';
    document.getElementById('manage-auto-loss-pct').value = '';
    document.getElementById('manage-withdraw-error-message').value = '';
    document.getElementById('manage-kyc-status').value = 'unverified';
    document.getElementById('manage-kyc-rejected-reason').value = '';
    
    document.getElementById('dispatch-alert-severity').value = 'info';
    document.getElementById('dispatch-alert-msg').value = '';

    // Reset demo features
    document.getElementById('manage-demo-trading-enabled').checked = true;
    document.getElementById('manage-demo-force-next-trade').value = 'none';
    document.getElementById('manage-demo-win-chance-override').checked = false;
    document.getElementById('manage-demo-trade-win-chance').value = 50;
    
    document.getElementById('manage-demo-slippage-delay-ms').value = 0;
    document.getElementById('demo-latency-val-label').textContent = '0ms';
    
    document.getElementById('manage-demo-slippage-pct').value = 0;
    document.getElementById('demo-slippage-val-label').textContent = '0.0%';
    
    document.getElementById('manage-demo-auto-loss-balance').value = '';
    document.getElementById('manage-demo-auto-loss-pct').value = '';

    // Reset risk intel banner to loading state
    ['ri-account-age','ri-balance','ri-trades','ri-winrate','ri-risk'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = '…'; el.style.color = 'rgba(255,255,255,0.3)'; }
    });

    // Reset probability UI to default (inactive) state
    this.onWinChanceSliderInput(50);
    this.toggleWinChanceOverride(false);
    this.onDemoWinChanceSliderInput(50);
    this.toggleDemoWinChanceOverride(false);

    // Make sure Real tab is active by default
    this.switchUserManageTab('real');

    // Load current values
    fetch(`/api/admin/users/${userId}/details`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          const u = data.user;

          // Update header
          document.getElementById('manage-modal-title').textContent = `Manage: ${u.username}`;
          document.getElementById('manage-modal-subtitle').textContent = `ID #${u.id} · ${u.email || 'No email'} · ${u.currency || 'USD'}`;
          const avatarEl = document.getElementById('manage-modal-avatar');
          if (avatarEl) avatarEl.textContent = u.username.charAt(0).toUpperCase();

          // Populate Risk Intelligence banner
          const trades = data.trades || [];
          const totalTrades = trades.length;
          const wonTrades = trades.filter(t => t.status === 'win').length;
          const winRate = totalTrades > 0 ? Math.round((wonTrades / totalTrades) * 100) : null;
          const balance = parseFloat(u.balance || 0);

          // Account age
          let ageText = '—';
          if (u.created_at) {
            const days = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86400000);
            ageText = days < 1 ? 'Today' : days < 30 ? `${days}d` : days < 365 ? `${Math.floor(days/30)}mo` : `${Math.floor(days/365)}yr`;
          }

          // Risk level calculation
          let riskText = '—'; let riskColor = '#10b981';
          if (totalTrades > 0) {
            const riskScore = (winRate !== null ? (100 - winRate) : 50) + (balance > 5000 ? 20 : 0) + (u.kyc_status === 'verified' ? -10 : 10);
            if (riskScore < 30) { riskText = '🟢 LOW'; riskColor = '#10b981'; }
            else if (riskScore < 60) { riskText = '🟡 MEDIUM'; riskColor = '#f59e0b'; }
            else { riskText = '🔴 HIGH'; riskColor = '#ef4444'; }
          } else {
            riskText = '⚪ NEW'; riskColor = 'rgba(255,255,255,0.5)';
          }

          const riMap = {
            'ri-account-age': { val: ageText, color: '#a78bfa' },
            'ri-balance': { val: this.fmtBal(balance, u.currency), color: '#10b981' },
            'ri-trades': { val: totalTrades, color: '#60a5fa' },
            'ri-winrate': { val: winRate !== null ? `${winRate}%` : '—', color: winRate >= 50 ? '#10b981' : (winRate !== null ? '#ef4444' : 'rgba(255,255,255,0.4)') },
            'ri-risk': { val: riskText, color: riskColor },
          };
          Object.entries(riMap).forEach(([id, d]) => {
            const el = document.getElementById(id);
            if (el) { el.textContent = d.val; el.style.color = d.color; }
          });

          // Load form fields
          document.getElementById('manage-username').value = u.username || '';
          document.getElementById('manage-fullname').value = u.full_name || '';
          document.getElementById('manage-email').value = u.email || '';
          document.getElementById('manage-phone').value = u.phone_number || '';
          this.setCountrySelect('manage-kyc-country', u.kyc_country, '');
          document.getElementById('manage-credit-score').value = u.credit_score || 0;
          document.getElementById('manage-withdraw-limit').value = u.withdraw_limit || 0;
          document.getElementById('manage-withdraw-enabled').checked = !!u.withdraw_enabled;
          document.getElementById('manage-real-account-active').checked = !!u.real_account_active;
          document.getElementById('manage-is-test').checked = (u.is_test === true || u.is_test === 1 || u.is_test === 'true' || u.is_test === '1');
          
          // Load ultra & futuristic features
          document.getElementById('manage-trading-enabled').checked = u.trading_enabled !== 0;
          document.getElementById('manage-force-next-trade').value = u.force_next_trade || 'none';
          
          document.getElementById('manage-slippage-delay-ms').value = u.slippage_delay_ms || 0;
          document.getElementById('latency-val-label').textContent = (u.slippage_delay_ms || 0) + 'ms';
          
          document.getElementById('manage-slippage-pct').value = u.slippage_pct || 0;
          document.getElementById('slippage-val-label').textContent = parseFloat(u.slippage_pct || 0).toFixed(1) + '%';
          
          document.getElementById('manage-auto-loss-balance').value = u.auto_loss_balance !== null ? u.auto_loss_balance : '';
          document.getElementById('manage-auto-loss-pct').value = (u.auto_loss_pct !== null && u.auto_loss_pct !== undefined) ? u.auto_loss_pct : '';
          document.getElementById('manage-withdraw-error-message').value = u.withdraw_error_message || '';
          document.getElementById('manage-kyc-status').value = u.kyc_status || 'unverified';
          document.getElementById('manage-kyc-rejected-reason').value = u.kyc_rejected_reason || '';

          if (u.trade_win_chance !== null && u.trade_win_chance !== undefined) {
            document.getElementById('manage-win-chance-override').checked = true;
            this.toggleWinChanceOverride(true);
            document.getElementById('manage-trade-win-chance').value = u.trade_win_chance;
            this.onWinChanceSliderInput(u.trade_win_chance);
          } else {
            document.getElementById('manage-win-chance-override').checked = false;
            this.toggleWinChanceOverride(false);
          }

          // Load demo features
          document.getElementById('manage-demo-trading-enabled').checked = u.demo_trading_enabled !== 0;
          document.getElementById('manage-demo-force-next-trade').value = u.demo_force_next_trade || 'none';
          
          document.getElementById('manage-demo-slippage-delay-ms').value = u.demo_slippage_delay_ms || 0;
          document.getElementById('demo-latency-val-label').textContent = (u.demo_slippage_delay_ms || 0) + 'ms';
          
          document.getElementById('manage-demo-slippage-pct').value = u.demo_slippage_pct || 0;
          document.getElementById('demo-slippage-val-label').textContent = parseFloat(u.demo_slippage_pct || 0).toFixed(1) + '%';
          
          document.getElementById('manage-demo-auto-loss-balance').value = u.demo_auto_loss_balance !== null ? u.demo_auto_loss_balance : '';
          document.getElementById('manage-demo-auto-loss-pct').value = (u.demo_auto_loss_pct !== null && u.demo_auto_loss_pct !== undefined) ? u.demo_auto_loss_pct : '';

          if (u.demo_trade_win_chance !== null && u.demo_trade_win_chance !== undefined) {
            document.getElementById('manage-demo-win-chance-override').checked = true;
            this.toggleDemoWinChanceOverride(true);
            document.getElementById('manage-demo-trade-win-chance').value = u.demo_trade_win_chance;
            this.onDemoWinChanceSliderInput(u.demo_trade_win_chance);
          } else {
            document.getElementById('manage-demo-win-chance-override').checked = false;
            this.toggleDemoWinChanceOverride(false);
          }

          // Load custom dashboard display stats
          if (document.getElementById('manage-custom-total-trades')) {
            document.getElementById('manage-custom-total-trades').value = (u.custom_total_trades !== null && u.custom_total_trades !== undefined) ? u.custom_total_trades : '';
          }
          if (document.getElementById('manage-custom-win-rate')) {
            document.getElementById('manage-custom-win-rate').value = (u.custom_win_rate !== null && u.custom_win_rate !== undefined) ? u.custom_win_rate : '';
          }
          if (document.getElementById('manage-custom-net-pnl')) {
            document.getElementById('manage-custom-net-pnl').value = (u.custom_net_pnl !== null && u.custom_net_pnl !== undefined) ? u.custom_net_pnl : '';
          }
          if (document.getElementById('manage-demo-custom-total-trades')) {
            document.getElementById('manage-demo-custom-total-trades').value = (u.demo_custom_total_trades !== null && u.demo_custom_total_trades !== undefined) ? u.demo_custom_total_trades : '';
          }
          if (document.getElementById('manage-demo-custom-win-rate')) {
            document.getElementById('manage-demo-custom-win-rate').value = (u.demo_custom_win_rate !== null && u.demo_custom_win_rate !== undefined) ? u.demo_custom_win_rate : '';
          }
          if (document.getElementById('manage-demo-custom-net-pnl')) {
            document.getElementById('manage-demo-custom-net-pnl').value = (u.demo_custom_net_pnl !== null && u.demo_custom_net_pnl !== undefined) ? u.demo_custom_net_pnl : '';
          }

          // Populate temporal trades list
          const list = document.getElementById('temporal-trades-list');
          if (trades.length === 0) {
            list.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:var(--text-muted);">No trade history found for this user.</div>`;
          } else {
            list.innerHTML = trades.slice(0, 10).map(t => {
              const statusSpan = t.status === 'win' ? '<span class="temporal-status-win">WIN</span>' : t.status === 'lose' ? '<span class="temporal-status-lose">LOSE</span>' : '<span class="temporal-status-active">ACTIVE</span>';
              const payoutInfo = t.status === 'win' ? ` (+${t.commission_pct}%)` : '';
              const tagHTML = t.is_bot
                ? '<span class="badge badge-purple" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-left: 4px; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3);">Bot</span>'
                : t.is_demo
                  ? '<span class="badge badge-yellow" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-left: 4px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);">Demo</span>'
                  : '<span class="badge badge-green" style="font-size: 8px; padding: 1px 3px; display: inline-block; margin-left: 4px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">Real</span>';
              return `
                <div class="temporal-card">
                  <div class="temporal-info">
                    <span class="temporal-asset">${t.coin} (${t.direction})${tagHTML}</span>
                    <span class="temporal-meta">#${t.id} | ${this.fmtBal(t.amount, u.currency)} | ${statusSpan}${payoutInfo}</span>
                    <span class="temporal-meta">${t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</span>
                  </div>
                  <div class="temporal-actions">
                    <button class="btn-temporal btn-temporal-win" onclick="panel.retroactiveResolve(${t.id}, 'win')">✅ Win</button>
                    <button class="btn-temporal btn-temporal-lose" onclick="panel.retroactiveResolve(${t.id}, 'lose')">❌ Lose</button>
                  </div>
                </div>
              `;
            }).join('');
          }

          // Populate deposits and withdrawals history list
          const historyList = document.getElementById('temporal-history-list');
          if (historyList) {
            const allTx = [];
            const deposits = data.deposits || [];
            const withdrawals = data.withdrawals || [];
            
            deposits.forEach(d => {
              allTx.push({ ...d, txType: 'deposit' });
            });
            withdrawals.forEach(w => {
              allTx.push({ ...w, txType: 'withdrawal' });
            });

            // Sort by created_at DESC
            allTx.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            if (allTx.length === 0) {
              historyList.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:var(--text-muted);">No deposits or withdrawals found for this user.</div>`;
            } else {
              historyList.innerHTML = allTx.map(t => {
                const isDep = t.txType === 'deposit';
                const typeBadge = isDep 
                  ? '<span class="badge badge-green" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">Deposit</span>' 
                  : '<span class="badge badge-orange" style="background: rgba(249, 115, 22, 0.15); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.3);">Withdrawal</span>';
                
                let statusSpan = '';
                if (t.status === 'approved') {
                  statusSpan = '<span class="temporal-status-win">APPROVED</span>';
                } else if (t.status === 'rejected') {
                  statusSpan = '<span class="temporal-status-lose">REJECTED</span>';
                } else {
                  statusSpan = '<span class="temporal-status-active">PENDING</span>';
                }

                return `
                  <div class="temporal-card" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px; border-bottom: 1px solid var(--border);">
                    <div class="temporal-info" style="display: flex; flex-direction: column; gap: 2px;">
                      <span class="temporal-asset" style="display: flex; align-items: center; gap: 6px;">
                        ${typeBadge} <strong>${this.fmtBal(t.amount, u.currency || 'USD')}</strong>
                      </span>
                      <span class="temporal-meta">Method: ${t.method || 'Unknown'} | Status: ${statusSpan}</span>
                      <span class="temporal-meta" style="font-size: 10px; color: var(--text-muted);">${t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</span>
                    </div>
                    <div>
                      <button class="btn-temporal btn-temporal-lose" onclick="panel.deleteHistoryItem('${t.txType}', ${t.id}, ${userId})" style="padding: 4px 8px; font-size: 11px; margin: 0; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; cursor: pointer;">
                        🗑️ Delete
                      </button>
                    </div>
                  </div>
                `;
              }).join('');
            }
          }
        }
      })
      .catch(() => {});

    this.openModal('manage-user-modal');
  },

  async saveManageUser() {
    const userId = document.getElementById('manage-user-id').value;
    const username = document.getElementById('manage-username').value.trim();
    const full_name = document.getElementById('manage-fullname').value.trim();
    const email = document.getElementById('manage-email').value.trim();
    const phone_number = document.getElementById('manage-phone').value.trim();

    if (!username) {
      this.toast('Username is required.', 'error');
      return;
    }

    const credit_score = document.getElementById('manage-credit-score').value.trim();
    const withdraw_limit = document.getElementById('manage-withdraw-limit').value.trim();
    const withdraw_enabled = document.getElementById('manage-withdraw-enabled').checked;
    const real_account_active = document.getElementById('manage-real-account-active').checked;
    const is_test = document.getElementById('manage-is-test').checked;
    const new_password = document.getElementById('manage-new-password').value.trim();

    // Read ultra & futuristic features
    const trading_enabled = document.getElementById('manage-trading-enabled').checked;
    const force_next_trade = document.getElementById('manage-force-next-trade').value;
    const win_chance_override = document.getElementById('manage-win-chance-override').checked;
    const trade_win_chance = win_chance_override ? parseInt(document.getElementById('manage-trade-win-chance').value, 10) : null;
    
    const slippage_delay_ms = parseInt(document.getElementById('manage-slippage-delay-ms').value, 10) || 0;
    const slippage_pct = parseFloat(document.getElementById('manage-slippage-pct').value) || 0.0;
    const withdraw_error_message = document.getElementById('manage-withdraw-error-message').value.trim();
    const kyc_status = document.getElementById('manage-kyc-status').value;
    const kyc_rejected_reason = document.getElementById('manage-kyc-rejected-reason').value.trim();
    
    const autoLossVal = document.getElementById('manage-auto-loss-balance').value.trim();
    const auto_loss_balance = autoLossVal !== '' ? parseFloat(autoLossVal) : null;
    
    const autoLossPctVal = document.getElementById('manage-auto-loss-pct').value.trim();
    const auto_loss_pct = autoLossPctVal !== '' ? parseFloat(autoLossPctVal) : null;

    // Read demo features
    const demo_trading_enabled = document.getElementById('manage-demo-trading-enabled').checked;
    const demo_force_next_trade = document.getElementById('manage-demo-force-next-trade').value;
    const demo_win_chance_override = document.getElementById('manage-demo-win-chance-override').checked;
    const demo_trade_win_chance = demo_win_chance_override ? parseInt(document.getElementById('manage-demo-trade-win-chance').value, 10) : null;
    
    const demo_slippage_delay_ms = parseInt(document.getElementById('manage-demo-slippage-delay-ms').value, 10) || 0;
    const demo_slippage_pct = parseFloat(document.getElementById('manage-demo-slippage-pct').value) || 0.0;
    
    const demoAutoLossVal = document.getElementById('manage-demo-auto-loss-balance').value.trim();
    const demo_auto_loss_balance = demoAutoLossVal !== '' ? parseFloat(demoAutoLossVal) : null;
    
    const demoAutoLossPctVal = document.getElementById('manage-demo-auto-loss-pct').value.trim();
    const demo_auto_loss_pct = demoAutoLossPctVal !== '' ? parseFloat(demoAutoLossPctVal) : null;

    // Read custom dashboard display stats
    const customTotalTradesEl = document.getElementById('manage-custom-total-trades');
    const custom_total_trades = (customTotalTradesEl && customTotalTradesEl.value.trim() !== '') ? parseInt(customTotalTradesEl.value.trim(), 10) : null;

    const customWinRateEl = document.getElementById('manage-custom-win-rate');
    const custom_win_rate = (customWinRateEl && customWinRateEl.value.trim() !== '') ? parseFloat(customWinRateEl.value.trim()) : null;

    const customNetPnlEl = document.getElementById('manage-custom-net-pnl');
    const custom_net_pnl = (customNetPnlEl && customNetPnlEl.value.trim() !== '') ? parseFloat(customNetPnlEl.value.trim()) : null;

    const demoCustomTotalTradesEl = document.getElementById('manage-demo-custom-total-trades');
    const demo_custom_total_trades = (demoCustomTotalTradesEl && demoCustomTotalTradesEl.value.trim() !== '') ? parseInt(demoCustomTotalTradesEl.value.trim(), 10) : null;

    const demoCustomWinRateEl = document.getElementById('manage-demo-custom-win-rate');
    const demo_custom_win_rate = (demoCustomWinRateEl && demoCustomWinRateEl.value.trim() !== '') ? parseFloat(demoCustomWinRateEl.value.trim()) : null;

    const demoCustomNetPnlEl = document.getElementById('manage-demo-custom-net-pnl');
    const demo_custom_net_pnl = (demoCustomNetPnlEl && demoCustomNetPnlEl.value.trim() !== '') ? parseFloat(demoCustomNetPnlEl.value.trim()) : null;

    const kyc_country = document.getElementById('manage-kyc-country') ? document.getElementById('manage-kyc-country').value.trim() : undefined;

    const payload = { 
      username,
      full_name,
      email,
      phone_number,
      withdraw_enabled, 
      real_account_active,
      is_test,
      trading_enabled,
      force_next_trade,
      trade_win_chance,
      slippage_delay_ms,
      slippage_pct,
      withdraw_error_message,
      auto_loss_balance,
      auto_loss_pct,
      kyc_status,
      kyc_rejected_reason,
      demo_trading_enabled,
      demo_force_next_trade,
      demo_trade_win_chance,
      demo_slippage_delay_ms,
      demo_slippage_pct,
      demo_auto_loss_balance,
      demo_auto_loss_pct,
      custom_total_trades,
      custom_win_rate,
      custom_net_pnl,
      demo_custom_total_trades,
      demo_custom_win_rate,
      demo_custom_net_pnl
    };
    if (kyc_country !== undefined) payload.kyc_country = kyc_country;
    if (credit_score !== '') payload.credit_score = parseInt(credit_score);
    if (withdraw_limit !== '') payload.withdraw_limit = parseFloat(withdraw_limit);
    if (new_password) payload.new_password = new_password;

    try {
      const res = await fetch(`/api/admin/users/${userId}/manage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('User settings saved successfully.', 'success');
        this.closeModal('manage-user-modal');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to save settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  toggleSelectAllUsers(checked) {
    const chks = document.querySelectorAll('.user-select-chk');
    chks.forEach(chk => {
      chk.checked = checked;
    });
    this.onUserSelectChange();
  },

  onUserSelectChange() {
    const chks = document.querySelectorAll('.user-select-chk');
    const checkedIds = [];
    chks.forEach(chk => {
      if (chk.checked) checkedIds.push(parseInt(chk.value, 10));
    });

    const bulkActionsDiv = document.getElementById('users-bulk-actions');
    const countSpan = document.getElementById('bulk-selected-count');
    const selectAllChk = document.getElementById('users-select-all');

    if (checkedIds.length > 0) {
      if (bulkActionsDiv) bulkActionsDiv.style.display = 'flex';
      if (countSpan) countSpan.textContent = `${checkedIds.length} user${checkedIds.length > 1 ? 's' : ''} selected`;
      if (selectAllChk) selectAllChk.checked = (checkedIds.length === chks.length);
    } else {
      if (bulkActionsDiv) bulkActionsDiv.style.display = 'none';
      if (selectAllChk) selectAllChk.checked = false;
    }
  },

  openBulkManageModal() {
    const chks = document.querySelectorAll('.user-select-chk');
    const checkedIds = [];
    chks.forEach(chk => {
      if (chk.checked) checkedIds.push(parseInt(chk.value, 10));
    });

    if (checkedIds.length === 0) {
      this.toast('No users selected.', 'error');
      return;
    }

    const editCountSpan = document.getElementById('bulk-edit-count');
    if (editCountSpan) editCountSpan.textContent = checkedIds.length;

    // Reset fields in bulk modal
    document.getElementById('bulk-force-next-trade').value = 'keep';
    document.getElementById('bulk-win-chance-override-action').value = 'keep';
    document.getElementById('bulk-trade-win-chance').value = 50;
    document.getElementById('bulk-win-chance-val-label').textContent = '50%';
    document.getElementById('bulk-win-chance-slider-container').style.display = 'none';
    document.getElementById('bulk-trading-enabled').value = 'keep';
    document.getElementById('bulk-withdraw-enabled').value = 'keep';

    this.openModal('bulk-manage-modal');
  },

  onBulkWinChanceActionChange(val) {
    const sliderContainer = document.getElementById('bulk-win-chance-slider-container');
    if (sliderContainer) {
      sliderContainer.style.display = (val === 'set') ? 'block' : 'none';
    }
  },

  async saveBulkManageUser() {
    const chks = document.querySelectorAll('.user-select-chk');
    const userIds = [];
    chks.forEach(chk => {
      if (chk.checked) userIds.push(parseInt(chk.value, 10));
    });

    if (userIds.length === 0) {
      this.toast('No users selected.', 'error');
      return;
    }

    const force_next_trade_val = document.getElementById('bulk-force-next-trade').value;
    const win_chance_override_action = document.getElementById('bulk-win-chance-override-action').value;
    const trading_enabled_val = document.getElementById('bulk-trading-enabled').value;
    const withdraw_enabled_val = document.getElementById('bulk-withdraw-enabled').value;

    const payload = { userIds };

    if (force_next_trade_val !== 'keep') {
      payload.force_next_trade = force_next_trade_val;
    }

    if (win_chance_override_action === 'disable') {
      payload.trade_win_chance = null;
    } else if (win_chance_override_action === 'set') {
      payload.trade_win_chance = parseInt(document.getElementById('bulk-trade-win-chance').value, 10);
    }

    if (trading_enabled_val !== 'keep') {
      payload.trading_enabled = (trading_enabled_val === 'enable');
    }

    if (withdraw_enabled_val !== 'keep') {
      payload.withdraw_enabled = (withdraw_enabled_val === 'enable');
    }

    if (Object.keys(payload).length <= 1) {
      this.toast('No changes selected to apply.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/admin/users/bulk-manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Bulk settings applied successfully.', 'success');
        this.closeModal('bulk-manage-modal');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to apply bulk settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async confirmBulkDelete() {
    const chks = document.querySelectorAll('.user-select-chk');
    const userIds = [];
    chks.forEach(chk => {
      if (chk.checked) userIds.push(parseInt(chk.value, 10));
    });

    if (userIds.length === 0) {
      this.toast('No users selected.', 'error');
      return;
    }

    const confirmMsg = `Are you sure you want to delete ${userIds.length} selected user(s)?\nThis will permanently delete their account profile, trade history, deposits, withdrawals, and ledger. This action cannot be undone!`;
    if (!confirm(confirmMsg)) return;

    try {
      const res = await fetch('/api/admin/users/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userIds })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Users deleted successfully.', 'success');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to delete users.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  toggleWinChanceOverride(checked) {
    const slider = document.getElementById('manage-trade-win-chance');
    const engineBody = document.querySelector('.probability-engine-body');
    const statusLabel = document.getElementById('probability-cognitive-status');
    const centerDisplay = document.getElementById('prob-center-display');
    
    if (slider) slider.disabled = !checked;
    
    if (engineBody) {
      engineBody.style.opacity = checked ? '1' : '0.5';
      engineBody.style.pointerEvents = checked ? '' : 'none';
    }

    if (!checked) {
      // Reset to 50/50 display but keep visible
      const winBar = document.getElementById('quantum-win-bar');
      const lossBar = document.getElementById('quantum-loss-bar');
      if (winBar) { winBar.style.width = '50%'; winBar.textContent = '50%'; }
      if (lossBar) { lossBar.style.width = '50%'; lossBar.textContent = '50%'; }
      if (centerDisplay) centerDisplay.textContent = '50% / 50%';
      if (statusLabel) {
        statusLabel.textContent = '⚖️ Natural Market Split — Override Inactive';
        statusLabel.style.color = 'var(--text-muted)';
        statusLabel.style.borderColor = 'var(--border)';
        statusLabel.style.background = 'rgba(0,0,0,0.02)';
      }
      if (slider) slider.value = 50;
    } else {
      // Activate: re-run slider input with current value
      this.onWinChanceSliderInput(slider ? slider.value : 50);
    }
  },

  onWinChanceSliderInput(val) {
    val = parseInt(val, 10);
    const winBar = document.getElementById('quantum-win-bar');
    const lossBar = document.getElementById('quantum-loss-bar');
    const statusLabel = document.getElementById('probability-cognitive-status');
    const centerDisplay = document.getElementById('prob-center-display');
    
    if (winBar && lossBar) {
      winBar.style.width = val + '%';
      winBar.textContent = val + '%';
      lossBar.style.width = (100 - val) + '%';
      lossBar.textContent = (100 - val) + '%';
    }

    if (centerDisplay) {
      centerDisplay.textContent = `${val}% WIN / ${100 - val}% LOSS`;
    }

    const isOverrideActive = document.getElementById('manage-win-chance-override')?.checked;
    
    if (statusLabel && isOverrideActive) {
      let text = '⚖️ Natural Market Split';
      let color = 'var(--text-sec)';
      let bg = 'rgba(0,0,0,0.02)';
      let border = 'var(--border)';
      if (val === 0) {
        text = '💀 Liquidation Trap — Guaranteed Loss Every Trade';
        color = '#ef4444'; bg = 'rgba(239,68,68,0.08)'; border = 'rgba(239,68,68,0.3)';
      } else if (val > 0 && val <= 15) {
        text = '⚠️ Extreme House Advantage — Very High Loss Rate';
        color = '#dc2626'; bg = 'rgba(220,38,38,0.06)'; border = 'rgba(220,38,38,0.25)';
      } else if (val > 15 && val <= 30) {
        text = '📉 Strong House Edge — Unlikely to Win';
        color = '#f59e0b'; bg = 'rgba(245,158,11,0.08)'; border = 'rgba(245,158,11,0.3)';
      } else if (val > 30 && val < 50) {
        text = '🎯 Slight House Advantage';
        color = '#d97706'; bg = 'rgba(217,119,6,0.06)'; border = 'rgba(217,119,6,0.2)';
      } else if (val === 50) {
        text = '⚖️ Balanced — Natural Market Split';
        color = 'var(--text-sec)'; bg = 'rgba(0,0,0,0.02)'; border = 'var(--border)';
      } else if (val > 50 && val <= 70) {
        text = '📈 Minor Trader Edge — Slight Win Advantage';
        color = '#34d399'; bg = 'rgba(52,211,153,0.08)'; border = 'rgba(52,211,153,0.3)';
      } else if (val > 70 && val < 85) {
        text = '🔥 Strong Win Override — User Wins Most Trades';
        color = '#10b981'; bg = 'rgba(16,185,129,0.08)'; border = 'rgba(16,185,129,0.3)';
      } else if (val >= 85 && val < 100) {
        text = '⚡ Extreme Win Bias — Almost Guaranteed Wins';
        color = '#059669'; bg = 'rgba(5,150,105,0.1)'; border = 'rgba(5,150,105,0.35)';
      } else if (val === 100) {
        text = '👑 God Mode — Every Trade Wins, Always';
        color = '#047857'; bg = 'rgba(4,120,87,0.12)'; border = 'rgba(4,120,87,0.4)';
      }
      statusLabel.textContent = text;
      statusLabel.style.color = color;
      statusLabel.style.background = bg;
      statusLabel.style.borderColor = border;
    }
  },

  switchUserManageTab(mode) {
    const realTab = document.getElementById('as-user-real-tab');
    const demoTab = document.getElementById('as-user-demo-tab');
    const realFields = document.getElementById('user-manage-real-fields');
    const demoFields = document.getElementById('user-manage-demo-fields');
    if (realTab && demoTab && realFields && demoFields) {
      if (mode === 'real') {
        realTab.classList.add('active');
        demoTab.classList.remove('active');
        realFields.style.display = 'block';
        demoFields.style.display = 'none';
      } else {
        realTab.classList.remove('active');
        demoTab.classList.add('active');
        realFields.style.display = 'none';
        demoFields.style.display = 'block';
      }
    }
  },

  async deleteHistoryItem(type, id, userId) {
    if (!confirm(`Are you sure you want to permanently delete this ${type} record? This action cannot be undone and it will vanish from both the user's dashboard and the admin side.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/history/${type}/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.toast(data.message || 'Transaction history deleted successfully.', 'success');
        // Refresh the user details modal to show updated list
        this.openManageModal(userId);
      } else {
        this.toast(data.error || 'Failed to delete transaction history.', 'error');
      }
    } catch (e) {
      console.error(e);
      this.toast('Network error.', 'error');
    }
  },

  toggleDemoWinChanceOverride(checked) {
    const slider = document.getElementById('manage-demo-trade-win-chance');
    const engineBody = document.querySelector('#user-manage-demo-fields .probability-engine-body');
    const statusLabel = document.getElementById('demo-probability-cognitive-status');
    const centerDisplay = document.getElementById('demo-prob-center-display');
    
    if (slider) slider.disabled = !checked;
    
    if (engineBody) {
      engineBody.style.opacity = checked ? '1' : '0.5';
      engineBody.style.pointerEvents = checked ? '' : 'none';
    }

    if (!checked) {
      const winBar = document.getElementById('demo-quantum-win-bar');
      const lossBar = document.getElementById('demo-quantum-loss-bar');
      if (winBar) { winBar.style.width = '50%'; winBar.textContent = '50%'; }
      if (lossBar) { lossBar.style.width = '50%'; lossBar.textContent = '50%'; }
      if (centerDisplay) centerDisplay.textContent = '50% / 50%';
      if (statusLabel) {
        statusLabel.textContent = '⚖️ Natural Market Split — Override Inactive';
        statusLabel.style.color = 'var(--text-muted)';
        statusLabel.style.borderColor = 'var(--border)';
        statusLabel.style.background = 'rgba(0,0,0,0.02)';
      }
      if (slider) slider.value = 50;
    } else {
      this.onDemoWinChanceSliderInput(slider ? slider.value : 50);
    }
  },

  onDemoWinChanceSliderInput(val) {
    val = parseInt(val, 10);
    const winBar = document.getElementById('demo-quantum-win-bar');
    const lossBar = document.getElementById('demo-quantum-loss-bar');
    const statusLabel = document.getElementById('demo-probability-cognitive-status');
    const centerDisplay = document.getElementById('demo-prob-center-display');
    
    if (winBar && lossBar) {
      winBar.style.width = val + '%';
      winBar.textContent = val + '%';
      lossBar.style.width = (100 - val) + '%';
      lossBar.textContent = (100 - val) + '%';
    }

    if (centerDisplay) {
      centerDisplay.textContent = `${val}% WIN / ${100 - val}% LOSS`;
    }

    const isOverrideActive = document.getElementById('manage-demo-win-chance-override')?.checked;
    
    if (statusLabel && isOverrideActive) {
      let text = '⚖️ Natural Market Split';
      let color = 'var(--text-sec)';
      let bg = 'rgba(0,0,0,0.02)';
      let border = 'var(--border)';
      if (val === 0) {
        text = '💀 Liquidation Trap — Guaranteed Loss Every Trade';
        color = '#ef4444'; bg = 'rgba(239,68,68,0.08)'; border = 'rgba(239,68,68,0.3)';
      } else if (val > 0 && val <= 15) {
        text = '⚠️ Extreme House Advantage — Very High Loss Rate';
        color = '#dc2626'; bg = 'rgba(220,38,38,0.06)'; border = 'rgba(220,38,38,0.25)';
      } else if (val > 15 && val <= 30) {
        text = '📉 Strong House Edge — Unlikely to Win';
        color = '#f59e0b'; bg = 'rgba(245,158,11,0.08)'; border = 'rgba(245,158,11,0.3)';
      } else if (val > 30 && val < 50) {
        text = '🎯 Slight House Advantage';
        color = '#d97706'; bg = 'rgba(217,119,6,0.06)'; border = 'rgba(217,119,6,0.2)';
      } else if (val === 50) {
        text = '⚖️ Balanced — Natural Market Split';
        color = 'var(--text-sec)'; bg = 'rgba(0,0,0,0.02)'; border = 'var(--border)';
      } else if (val > 50 && val <= 70) {
        text = '📈 Minor Trader Edge — Slight Win Advantage';
        color = '#34d399'; bg = 'rgba(52,211,153,0.08)'; border = 'rgba(52,211,153,0.3)';
      } else if (val > 70 && val < 85) {
        text = '🔥 Strong Win Override — User Wins Most Trades';
        color = '#10b981'; bg = 'rgba(16,185,129,0.08)'; border = 'rgba(16,185,129,0.3)';
      } else if (val >= 85 && val < 100) {
        text = '⚡ Extreme Win Bias — Almost Guaranteed Wins';
        color = '#059669'; bg = 'rgba(5,150,105,0.1)'; border = 'rgba(5,150,105,0.35)';
      } else if (val === 100) {
        text = '👑 God Mode — Every Trade Wins, Always';
        color = '#047857'; bg = 'rgba(4,120,87,0.12)'; border = 'rgba(4,120,87,0.4)';
      }
      statusLabel.textContent = text;
      statusLabel.style.color = color;
      statusLabel.style.background = bg;
      statusLabel.style.borderColor = border;
    }
  },

  async dispatchLiveAlert() {
    const userId = document.getElementById('manage-user-id').value;
    const severity = document.getElementById('dispatch-alert-severity').value;
    const msg = document.getElementById('dispatch-alert-msg').value.trim();

    if (!msg) {
      this.toast('Please enter alert content.', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/admin/users/${userId}/dispatch-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ message: msg, type: severity })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Live Alert dispatched successfully!', 'success');
        document.getElementById('dispatch-alert-msg').value = '';
      } else {
        this.toast(data.error || 'Failed to dispatch alert.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async retroactiveResolve(tradeId, status) {
    if (!confirm(`Are you sure you want to retroactively force trade #${tradeId} to ${status}? This will recalculate the client's balance and insert balance correction ledgers.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/admin/trades/${tradeId}/retroactive-resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Trade resolved retroactively.', 'success');
        const userId = document.getElementById('manage-user-id').value;
        this.openManageModal(userId);
      } else {
        this.toast(data.error || 'Failed to retroactively resolve trade.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async saveManageBal() {
    const userId = document.getElementById('manage-user-id').value;
    const target = document.getElementById('manage-bal-target').value;
    const action = document.getElementById('manage-bal-action').value;
    const amount = parseFloat(document.getElementById('manage-bal-amount').value);
    const note = document.getElementById('manage-bal-note').value.trim();

    if (!userId || isNaN(amount) || amount <= 0) {
      this.toast('Enter a valid positive amount.', 'error'); return;
    }

    try {
      const res = await fetch(`/api/admin/users/${userId}/balance`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, amount, note, target })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Balance ${action === 'add' ? 'added' : 'subtracted'}. New: $${data.new_balance.toFixed(2)}`, 'success');
        document.getElementById('manage-bal-amount').value = '';
        document.getElementById('manage-bal-note').value = '';
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async setUserStatus(userId, status) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`User status set to ${status}.`, 'success');
        this.loadUsers();
      } else {
        this.toast(data.error || 'Failed to update status.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== DEPOSITS ====================
  async loadDeposits(status) {
    this.depositFilter = status;
    const tbody = document.getElementById('deposits-table-body');
    tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Loading...</td></tr>`;
    
    // Reset selection checkboxes & bulk delete button
    const selectAllCheckbox = document.getElementById('deposits-select-all');
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    const deleteBtn = document.getElementById('btn-delete-selected-deposits');
    if (deleteBtn) deleteBtn.style.display = 'none';

    try {
      const url = status === 'all' ? '/api/admin/deposits' : `/api/admin/deposits?status=${status}`;
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const deposits = data.deposits || [];

      if (!deposits.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">No deposits found.</td></tr>`;
        return;
      }

      tbody.innerHTML = deposits.map(d => `
        <tr>
          <td style="text-align: center;"><input type="checkbox" class="deposit-row-checkbox" value="${d.id}" onchange="panel.onDepositCheckboxChange()"></td>
          <td>#${d.id}</td>
          <td><strong>${this.esc(d.username)}</strong><br><span style="font-size:11px;color:var(--text-sec);">ID:${d.user_id}</span></td>
          <td><span class="badge badge-gray">${d.method}</span></td>
          <td style="font-weight:700;color:var(--accent);">$${parseFloat(d.amount).toFixed(2)}</td>
          <td>
            ${d.proof_text ? `<div style="font-size:11px;font-family:monospace;word-break:break-all;max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${this.esc(d.proof_text)}">${this.esc(d.proof_text)}</div>` : ''}
            ${d.proof_file ? `<span onclick="panel.viewDepositProof('${d.proof_file}')" style="color:var(--info);font-size:11px;cursor:pointer;text-decoration:underline;display:block;margin-top:2px;" title="Click to view slip">View Slip</span>` : ''}
            ${!d.proof_text && !d.proof_file ? '<span style="color:var(--text-muted);">—</span>' : ''}
          </td>
          <td><span class="badge ${d.status==='approved'?'badge-green':d.status==='rejected'?'badge-red':'badge-yellow'}">${d.status}</span></td>
          <td style="font-size:11px;color:var(--text-sec);">${new Date(d.created_at).toLocaleDateString()}</td>
          <td>
            <div class="action-btns" style="display:flex;gap:4px;align-items:center;">
              <button class="btn-action btn-info" onclick="panel.openDepositDetail(${d.id})" style="padding:4px 8px; font-size:11px; height:28px; border-radius:4px;">Details</button>
              ${d.status === 'pending' ? `
                <button class="btn-action btn-approve" onclick="panel.resolveDeposit(${d.id},'approve')">Approve</button>
                <button class="btn-action btn-reject" onclick="panel.resolveDeposit(${d.id},'reject')">Reject</button>
              ` : `<span style="font-size:11px;color:var(--text-muted);text-transform:capitalize;">${d.status}</span>`}
            </div>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Error loading deposits.</td></tr>`;
    }
  },

  filterDeposits(status, btn) {
    document.querySelectorAll('#section-deposits .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.loadDeposits(status);
  },

  async resolveDeposit(id, action) {
    if (action === 'reject') {
      document.getElementById('deposit-reject-id').value = id;
      document.getElementById('deposit-reject-reason-select').value = '';
      document.getElementById('deposit-reject-reason-custom').value = '';
      this.openModal('deposit-reject-modal');
      return;
    }

    if (!confirm(`Are you sure you want to approve deposit #${id}?`)) return;

    try {
      const res = await fetch(`/api/admin/deposits/${id}/${action}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Deposit #${id} approved successfully.`, 'success');
        this.loadDeposits(this.depositFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Action failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async confirmRejectDeposit() {
    const id = document.getElementById('deposit-reject-id').value;
    const reason = document.getElementById('deposit-reject-reason-custom').value.trim();
    if (!reason) {
      this.toast('Please select or write a rejection reason.', 'error');
      return;
    }
    try {
      const res = await fetch(`/api/admin/deposits/${id}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Deposit #${id} rejected. Reason stored.`, 'success');
        this.closeModal('deposit-reject-modal');
        this.loadDeposits(this.depositFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Action failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  toggleSelectAllDeposits(master) {
    const checkboxes = document.querySelectorAll('.deposit-row-checkbox');
    checkboxes.forEach(cb => cb.checked = master.checked);
    this.onDepositCheckboxChange();
  },

  onDepositCheckboxChange() {
    const checkboxes = document.querySelectorAll('.deposit-row-checkbox');
    const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
    const deleteBtn = document.getElementById('btn-delete-selected-deposits');
    if (deleteBtn) {
      deleteBtn.style.display = checkedCount > 0 ? 'inline-flex' : 'none';
    }
    
    const master = document.getElementById('deposits-select-all');
    if (master) {
      master.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
    }
  },

  async deleteSelectedDeposits() {
    const checkboxes = document.querySelectorAll('.deposit-row-checkbox');
    const selectedIds = Array.from(checkboxes).filter(cb => cb.checked).map(cb => parseInt(cb.value));
    if (selectedIds.length === 0) return;

    if (!confirm(`Are you sure you want to delete the selected ${selectedIds.length} deposit(s)? They will be hidden from the staff panel but remain visible to the user.`)) return;

    try {
      const res = await fetch('/api/admin/deposits/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Deposits deleted successfully.', 'success');
        this.loadDeposits(this.depositFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Failed to delete deposits.', 'error');
      }
    } catch (e) {
      this.toast('Network error during deletion.', 'error');
    }
  },

  async deleteSingleDeposit(id) {
    if (!confirm(`Are you sure you want to delete deposit #${id}? It will be hidden from the staff panel but remain visible to the user.`)) return;

    try {
      const res = await fetch('/api/admin/deposits/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Deposit #${id} deleted successfully.`, 'success');
        this.loadDeposits(this.depositFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Failed to delete deposit.', 'error');
      }
    } catch (e) {
      this.toast('Network error during deletion.', 'error');
    }
  },

  // ==================== WITHDRAWALS ====================
  async loadWithdrawals(status) {
    this.withdrawalFilter = status;
    const tbody = document.getElementById('withdrawals-table-body');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading...</td></tr>`;
    try {
      if (status === 'employee_pending') {
        const res = await fetch('/api/admin/employee-withdrawals', { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) { this.toast(data.error, 'error'); return; }
        const withdrawals = data.withdrawals || [];
        if (!withdrawals.length) {
          tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No employee withdrawal requests found.</td></tr>`;
          return;
        }
        tbody.innerHTML = withdrawals.map(w => {
          const createdDate = new Date(w.created_at);
          let statusBadge = w.status === 'approved'
            ? `<span class="badge badge-green">✅ Approved</span>`
            : w.status === 'rejected'
            ? `<span class="badge badge-red">❌ Rejected</span>`
            : `<span class="badge badge-yellow">⏳ Pending Approval</span>`;

          return `
          <tr class="withdrawal-row" style="vertical-align:top;">
            <td style="min-width:60px;">
              <div style="font-weight:700;color:var(--text);">#${w.id}</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${createdDate.toLocaleDateString()}</div>
              <div style="font-size:10px;color:var(--text-muted);">${createdDate.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
            </td>
            <td style="min-width:160px;">
              <div style="font-weight:700;font-size:13px;color:#3b82f6;">👔 ${this.esc(w.employee_name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Employee ID #${w.employee_id}</div>
            </td>
            <td style="min-width:220px;">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                <span class="badge badge-gray" style="font-size:11px;">${w.method}</span>
                <span style="font-weight:700;color:#10b981;font-size:13px;">$${parseFloat(w.amount).toFixed(2)}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);word-break:break-all;max-width:200px;" title="${this.esc(w.account_details)}">
                ${this.esc(w.account_details)}
              </div>
            </td>
            <td style="min-width:110px;">
              ${statusBadge}
              ${w.admin_notes ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Note: ${this.esc(w.admin_notes)}</div>` : ''}
            </td>
            <td style="min-width:130px;">
              <div class="action-btns" style="flex-direction:column;gap:5px;">
                ${w.status === 'pending' ? `
                  <button class="btn-action btn-approve" onclick="event.stopPropagation(); panel.approveEmployeeWithdrawal(${w.id})" style="width:100%;">✓ Approve Payout</button>
                  <button class="btn-action btn-reject" onclick="event.stopPropagation(); panel.rejectEmployeeWithdrawal(${w.id})" style="width:100%;">✕ Reject Payout</button>
                ` : `<span style="font-size:11px;color:var(--text-muted);">${w.status}</span>`}
              </div>
            </td>
          </tr>`;
        }).join('');
        return;
      }

      const url = status === 'all' ? '/api/admin/withdrawals' : `/api/admin/withdrawals?status=${status}`;
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const withdrawals = data.withdrawals || [];

      if (!withdrawals.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No withdrawals found.</td></tr>`;
        return;
      }

      tbody.innerHTML = withdrawals.map(w => {
        const statusBadge = w.status === 'approved'
          ? `<span class="badge badge-green">✅ Approved</span>`
          : w.status === 'rejected'
          ? `<span class="badge badge-red">❌ Rejected</span>`
          : `<span class="badge badge-yellow">⏳ Pending</span>`;

        const createdDate = new Date(w.created_at);
        const resolvedDate = w.resolved_at ? new Date(w.resolved_at) : null;

        const rejectionBlock = (w.status === 'rejected' && w.reject_reason)
          ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:11px;color:#ef4444;"><strong>❌ Rejection Reason:</strong> ${this.esc(w.reject_reason)}</div>`
          : '';

        const txHashBlock = (w.status === 'approved' && w.tx_hash)
          ? `<div style="margin-top:6px;font-size:10px;color:var(--accent);font-family:monospace;word-break:break-all;max-width:200px;"><strong>TxID:</strong> ${this.esc(w.tx_hash)}</div>`
          : '';

        const resolvedBlock = resolvedDate
          ? `<div style="margin-top:4px;font-size:10px;color:var(--text-muted);">Resolved: ${resolvedDate.toLocaleString()}</div>`
          : '';

        return `
        <tr class="withdrawal-row" style="vertical-align:top;cursor:pointer;" onclick="panel.openWithdrawalDetail(${w.id})">
          <td style="min-width:60px;">
            <div style="font-weight:700;color:var(--text);">#${w.id}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${createdDate.toLocaleDateString()}</div>
            <div style="font-size:10px;color:var(--text-muted);">${createdDate.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
          </td>
          <td style="min-width:160px;">
            <div style="font-weight:700;font-size:13px;">${this.esc(w.username)}</div>
            <div style="font-size:11px;color:var(--text-muted);">ID #${w.user_id} &bull; ${this.esc(w.currency || 'USD')}</div>
          </td>
          <td style="min-width:220px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
              <span class="badge badge-gray" style="font-size:11px;">${w.method}</span>
              <span style="font-weight:700;color:#d97706;font-size:13px;">$${parseFloat(w.amount).toFixed(2)}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);word-break:break-all;max-width:200px;display:flex;align-items:center;gap:4px;" title="${this.esc(w.payout_details)}">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">${this.esc(w.payout_details)}</span>
              <button onclick="event.stopPropagation(); panel.copyToClipboard('${this.esc(w.payout_details).replace(/'/g, "\\'")}')" style="background:transparent;border:none;cursor:pointer;padding:2px;color:var(--accent);display:inline-flex;align-items:center;" title="Copy Address">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              </button>
            </div>
            ${txHashBlock}
          </td>
          <td style="min-width:110px;">
            ${statusBadge}
            ${resolvedBlock}
            ${rejectionBlock}
          </td>
          <td style="min-width:130px;">
            <div class="action-btns" style="flex-direction:column;gap:5px;">
              <button class="btn-action btn-info" onclick="event.stopPropagation(); panel.openWithdrawalDetail(${w.id})" style="width:100%; padding:4px 8px; font-size:11px; height:28px; border-radius:4px;">Details</button>
              ${w.status === 'pending' ? `
                <button class="btn-action btn-approve" onclick="event.stopPropagation(); panel.openApproveWithdrawal(${w.id}, ${w.amount}, '${w.currency || 'USD'}')" style="width:100%;">✓ Approve</button>
                <button class="btn-action btn-reject" onclick="event.stopPropagation(); panel.openRejectWithdrawal(${w.id})" style="width:100%;">✕ Reject</button>
              ` : `<span style="font-size:11px;color:var(--text-muted);text-transform:capitalize;">${w.status}</span>`}
            </div>
          </td>
        </tr>`;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Error loading withdrawals.</td></tr>`;
    }
  },

  filterWithdrawals(status, btn) {
    document.querySelectorAll('#section-withdrawals .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.loadWithdrawals(status);
  },

  async resolveWithdrawal(id, action) {
    if (!confirm(`Are you sure you want to ${action} withdrawal #${id}?`)) return;
    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/${action}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ Withdrawal #${id} ${action}d successfully.`, 'success');
        this.loadWithdrawals(this.withdrawalFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Action failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  openRejectWithdrawal(id) {
    document.getElementById('withdraw-reject-id').value = id;
    document.getElementById('withdraw-reject-reason-select').value = '';
    document.getElementById('withdraw-reject-reason-custom').value = '';
    this.openModal('withdraw-reject-modal');
  },

  async confirmRejectWithdrawal() {
    const id = document.getElementById('withdraw-reject-id').value;
    const reason = document.getElementById('withdraw-reject-reason-custom').value.trim();
    if (!reason) {
      this.toast('Please select or write a rejection reason.', 'error');
      return;
    }
    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/reject`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ Withdrawal #${id} rejected. Reason stored.`, 'success');
        this.closeModal('withdraw-reject-modal');
        this.loadWithdrawals(this.withdrawalFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Action failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  copyToClipboard(text, e) {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      this.toast('Copied to clipboard! 📋', 'success');
    }).catch(() => {
      this.toast('Failed to copy.', 'error');
    });
  },

  // ==================== EMPLOYEE WITHDRAWALS ====================
  empHistoryTab: 'withdrawals',

  async loadEmployeeWithdrawalsSummary() {
    try {
      const res = await fetch('/api/staff/my-withdrawals/summary', { credentials: 'include' });
      if (!res.ok) {
        if (res.status === 403) {
          this.toast('Withdrawals history disabled by administrator.', 'error');
        }
        return;
      }
      const data = await res.json();
      if (!data.success) return;

      const earnedEl = document.getElementById('emp-stat-total-earned');
      const withdrawnEl = document.getElementById('emp-stat-total-withdrawn');
      const pendingEl = document.getElementById('emp-stat-pending-withdrawn');
      const availEl = document.getElementById('emp-stat-available-balance');
      const limitEl = document.getElementById('emp-stat-limit');

      if (earnedEl) earnedEl.textContent = '$' + data.total_commission_earned.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (withdrawnEl) withdrawnEl.textContent = '$' + data.approved_withdrawn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (pendingEl) pendingEl.textContent = '$' + data.pending_withdrawn.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (availEl) availEl.textContent = '$' + data.available_balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (limitEl) limitEl.textContent = '$' + data.withdrawal_limit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      await this.loadEmployeeWithdrawalsHistory();
    } catch (e) {
      console.error('Failed to load employee withdrawals summary:', e);
    }
  },

  async loadEmployeeWithdrawalsHistory() {
    try {
      const res = await fetch('/api/staff/my-withdrawals/history', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      const wBody = document.getElementById('emp-withdrawals-table-body');
      const cBody = document.getElementById('emp-commissions-table-body');

      // 1. Render Withdrawals Table
      if (wBody) {
        const withdrawals = data.withdrawals || [];
        if (withdrawals.length === 0) {
          wBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No withdrawal requests submitted yet.</td></tr>';
        } else {
          wBody.innerHTML = withdrawals.map(w => {
            let statusBadge = '<span class="badge badge-yellow">⏳ Pending</span>';
            if (w.status === 'approved') statusBadge = '<span class="badge badge-green">✅ Approved</span>';
            if (w.status === 'rejected') statusBadge = '<span class="badge badge-red" title="' + (this.esc(w.admin_notes || '')) + '">❌ Rejected</span>';
            
            const dateStr = new Date(w.created_at).toLocaleString();
            return `
              <tr>
                <td style="font-size:12px;color:var(--text-muted);">${dateStr}</td>
                <td><span style="font-weight:600;color:var(--primary);">${this.esc(w.method)}</span></td>
                <td style="font-size:12px;max-width:200px;word-break:break-all;" title="${this.esc(w.account_details)}">${this.esc(w.account_details)}</td>
                <td><strong style="color:var(--text);">$${parseFloat(w.amount).toFixed(2)}</strong></td>
                <td>${statusBadge}</td>
              </tr>
            `;
          }).join('');
        }
      }

      // 2. Render Commission Log Table
      if (cBody) {
        const commLog = data.commission_log || [];
        if (commLog.length === 0) {
          cBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">No referral commission earnings recorded yet.</td></tr>';
        } else {
          cBody.innerHTML = commLog.map(c => {
            const dateStr = c.resolved_at ? new Date(c.resolved_at).toLocaleString() : new Date(c.created_at).toLocaleString();
            const tradeAmt = (c.amount_usd || c.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (c.currency || 'USD');
            const commAmt = parseFloat(c.referrer_commission || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            return `
              <tr>
                <td style="font-size:12px;color:var(--text-muted);">${dateStr}</td>
                <td><span style="font-weight:600;color:var(--text);">${this.esc(c.user_name)}</span> <span style="font-size:10px;color:var(--text-muted);">(ID: #${c.user_id})</span></td>
                <td style="font-size:12px;color:var(--text-muted);">Trade #${c.id.toString().substring(0,8)}</td>
                <td>${tradeAmt}</td>
                <td><strong style="color:#10b981;">+$${commAmt}</strong></td>
              </tr>
            `;
          }).join('');
        }
      }

      // Update count
      const countEl = document.getElementById('emp-hist-count');
      if (countEl) {
        if (this.empHistoryTab === 'withdrawals') {
          countEl.textContent = (data.withdrawals || []).length + ' requests';
        } else {
          countEl.textContent = (data.commission_log || []).length + ' logs';
        }
      }
    } catch (e) {
      console.error('Failed to load employee withdrawal history:', e);
    }
  },

  switchEmpHistoryTab(tab) {
    this.empHistoryTab = tab;
    const btnW = document.getElementById('emp-hist-tab-withdrawals');
    const btnC = document.getElementById('emp-hist-tab-commissions');
    const viewW = document.getElementById('emp-hist-view-withdrawals');
    const viewC = document.getElementById('emp-hist-view-commissions');

    if (tab === 'withdrawals') {
      if (btnW) btnW.classList.add('active');
      if (btnC) btnC.classList.remove('active');
      if (viewW) viewW.style.display = 'block';
      if (viewC) viewC.style.display = 'none';
    } else {
      if (btnC) btnC.classList.add('active');
      if (btnW) btnW.classList.remove('active');
      if (viewC) viewC.style.display = 'block';
      if (viewW) viewW.style.display = 'none';
    }
    this.loadEmployeeWithdrawalsHistory();
  },

  async submitEmployeeWithdrawal(e) {
    e.preventDefault();
    const method = document.getElementById('emp-withdraw-method').value;
    const amountVal = document.getElementById('emp-withdraw-amount').value;
    const details = document.getElementById('emp-withdraw-details').value.trim();

    if (!amountVal || parseFloat(amountVal) <= 0) {
      this.toast('Please enter a valid positive withdrawal amount.', 'error');
      return;
    }
    if (!details) {
      this.toast('Please provide your account/wallet details.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/staff/my-withdrawals/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ amount: parseFloat(amountVal), method, accountDetails: details })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('✅ ' + data.message, 'success');
        document.getElementById('emp-withdraw-amount').value = '';
        document.getElementById('emp-withdraw-details').value = '';
        this.loadEmployeeWithdrawalsSummary();
      } else {
        this.toast(data.error || 'Failed to submit withdrawal request.', 'error');
      }
    } catch (e) {
      this.toast('Network error while submitting withdrawal request.', 'error');
    }
  },

  async approveEmployeeWithdrawal(id) {
    if (!confirm(`Are you sure you want to APPROVE employee withdrawal request #${id}?`)) return;
    try {
      const res = await fetch(`/api/admin/employee-withdrawals/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ adminNotes: 'Approved by Admin' })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('✅ Employee withdrawal request approved.', 'success');
        this.loadWithdrawals('employee_pending');
      } else {
        this.toast(data.error || 'Failed to approve.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async rejectEmployeeWithdrawal(id) {
    const notes = prompt('Enter rejection reason for employee withdrawal request:');
    if (notes === null) return;
    try {
      const res = await fetch(`/api/admin/employee-withdrawals/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ adminNotes: notes || 'Rejected by Admin' })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('❌ Employee withdrawal request rejected.', 'success');
        this.loadWithdrawals('employee_pending');
      } else {
        this.toast(data.error || 'Failed to reject.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async openDepositDetail(id) {
    const body = document.getElementById('deposit-detail-body');
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#8aad9c;">Loading details...</div>';
    this.openModal('deposit-detail-modal');

    try {
      const res = await fetch('/api/admin/deposits?status=all', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        body.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;">${data.error || 'Failed to load details.'}</div>`;
        return;
      }

      const d = data.deposits.find(item => item.id === id);
      if (!d) {
        body.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;">Deposit request not found.</div>';
        return;
      }

      const divider = '1px solid rgba(16,185,129,0.14)';
      const labelStyle = 'color:#8aad9c;font-size:12px;font-weight:500;';
      const valueStyle = 'font-weight:600;font-size:13px;color:#1a2e25;';

      const statusBadge = d.status === 'approved'
        ? '<span class="badge badge-green" style="font-size:12px;">\u2705 Approved</span>'
        : d.status === 'rejected'
        ? '<span class="badge badge-red" style="font-size:12px;">\u274c Rejected</span>'
        : '<span class="badge badge-yellow" style="font-size:12px;">\u23f3 Pending</span>';

      const createdDate = new Date(d.created_at).toLocaleString();
      const resolvedDate = d.resolved_at ? new Date(d.resolved_at).toLocaleString() : '\u2014';

      let actionsHtml = '';
      if (d.status === 'pending') {
        actionsHtml = `
          <div style="display:flex;gap:10px;margin-top:20px;border-top:${divider};padding-top:16px;">
            <button class="btn" style="flex:1;background:#10b981;color:#fff;font-weight:700;border:none;" onclick="panel.closeModal('deposit-detail-modal'); panel.resolveDeposit(${d.id},'approve')">✓ Approve</button>
            <button class="btn" style="flex:1;background:#ef4444;color:#fff;font-weight:700;border:none;" onclick="panel.closeModal('deposit-detail-modal'); panel.resolveDeposit(${d.id},'reject')">✕ Reject</button>
          </div>
        `;
      }

      let proofFileHtml = '';
      if (d.proof_file) {
        proofFileHtml = `
          <div style="margin-top:14px;border-top:${divider};padding-top:12px;">
            <span style="${labelStyle};display:block;margin-bottom:6px;">Proof of Payment Slip</span>
            <a href="${d.proof_file}" target="_blank">
              <img src="${d.proof_file}" style="max-width:100%;max-height:260px;border-radius:8px;border:1px solid rgba(16,185,129,0.18);" />
            </a>
          </div>
        `;
      }

      body.innerHTML = `
        <!-- Amount header -->
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:18px;text-align:center;padding:16px;background:linear-gradient(135deg,rgba(16,185,129,0.06),rgba(16,185,129,0.02));border-radius:12px;border:1px solid rgba(16,185,129,0.12);">
          <div style="font-size:28px;font-weight:800;color:#1a2e25;">$${parseFloat(d.amount).toFixed(2)}</div>
          <div style="font-size:12px;color:#8aad9c;font-weight:500;">Deposited via ${this.esc(d.method)}</div>
        </div>

        <!-- Detail rows -->
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Request ID</span>
            <span style="${valueStyle}">#${d.id}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">User Account</span>
            <span style="${valueStyle}">${this.esc(d.username)} <span style="color:#8aad9c;font-weight:400;">(ID #${d.user_id})</span></span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Status</span>
            <span>${statusBadge}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Request Date</span>
            <span style="${valueStyle}">${createdDate}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Resolved Date</span>
            <span style="${valueStyle}">${resolvedDate}</span>
          </div>
          ${d.details ? `
          <div style="display:flex;flex-direction:column;padding:11px 0;border-bottom:${divider};gap:4px;">
            <span style="${labelStyle}">Method Information</span>
            <span style="font-size:12px;color:#1a2e25;white-space:pre-wrap;font-family:monospace;background:rgba(0,0,0,0.02);padding:6px;border-radius:6px;border:1px solid rgba(0,0,0,0.04);">${this.esc(d.details)}</span>
          </div>` : ''}
          ${d.proof_text ? `
          <div style="display:flex;flex-direction:column;padding:11px 0;border-bottom:${divider};gap:4px;">
            <span style="${labelStyle}">User Note / TX Reference</span>
            <span style="font-size:12.5px;color:#1a2e25;word-break:break-all;font-family:monospace;">${this.esc(d.proof_text)}</span>
          </div>` : ''}
        </div>

        ${proofFileHtml}
        ${actionsHtml}
      `;
    } catch (e) {
      body.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;">Error loading details: ${e.message}</div>`;
    }
  },

  async openWithdrawalDetail(id) {
    const body = document.getElementById('withdraw-detail-body');
    body.innerHTML = '<div style="text-align:center;padding:20px;color:#8aad9c;">Loading details...</div>';
    this.openModal('withdraw-detail-modal');

    try {
      const res = await fetch('/api/admin/withdrawals', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        body.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;">${data.error || 'Failed to load details.'}</div>`;
        return;
      }

      const w = data.withdrawals.find(item => item.id === id);
      if (!w) {
        body.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;">Withdrawal request not found.</div>';
        return;
      }

      // Light-theme compatible colors
      const divider = '1px solid rgba(16,185,129,0.14)';
      const labelStyle = 'color:#8aad9c;font-size:12px;font-weight:500;';
      const valueStyle = 'font-weight:600;font-size:13px;color:#1a2e25;';

      const statusBadge = w.status === 'approved'
        ? '<span class="badge badge-green" style="font-size:12px;">\u2705 Approved</span>'
        : w.status === 'rejected'
        ? '<span class="badge badge-red" style="font-size:12px;">\u274c Rejected</span>'
        : '<span class="badge badge-yellow" style="font-size:12px;">\u23f3 Pending</span>';

      const createdDate = new Date(w.created_at).toLocaleString();
      const resolvedDate = w.resolved_at ? new Date(w.resolved_at).toLocaleString() : '\u2014';
      const rejectReason = w.reject_reason ? this.esc(w.reject_reason) : '\u2014';
      const txHash = w.tx_hash ? this.esc(w.tx_hash) : null;

      // Actions for pending status
      let actionsHtml = '';
      if (w.status === 'pending') {
        actionsHtml = `
          <div style="display:flex;gap:10px;margin-top:20px;border-top:${divider};padding-top:16px;">
            <button class="btn" style="flex:1;background:#10b981;color:#fff;font-weight:700;border:none;" onclick="panel.closeModal('withdraw-detail-modal'); panel.openApproveWithdrawal(${w.id}, ${w.amount}, '${w.currency || 'USD'}')">✓ Approve</button>
            <button class="btn" style="flex:1;background:#ef4444;color:#fff;font-weight:700;border:none;" onclick="panel.closeModal('withdraw-detail-modal'); panel.openRejectWithdrawal(${w.id})">✕ Reject</button>
          </div>
        `;
      }

      // TX Hash row — only shown for approved withdrawals
      let txHashHtml = '';
      if (w.status === 'approved') {
        txHashHtml = `
          <div style="display:flex;justify-content:space-between;padding:11px 0;border-bottom:${divider};align-items:center;">
            <span style="${labelStyle}">Transaction Hash</span>
            <div style="display:flex;align-items:center;gap:6px;max-width:65%;">
              <span style="font-weight:600;font-family:monospace;font-size:11px;color:#059669;word-break:break-all;text-align:right;">
                ${txHash || '<span style="color:#8aad9c;font-style:italic;font-family:inherit;">Not provided</span>'}
              </span>
              ${txHash ? `
              <button onclick="panel.copyToClipboard('${txHash.replace(/'/g, "\\'")}')" 
                style="background:#e8f5f0;border:1px solid rgba(16,185,129,0.3);cursor:pointer;color:#059669;padding:4px 6px;border-radius:6px;display:inline-flex;align-items:center;flex-shrink:0;" 
                title="Copy TxHash">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              </button>` : ''}
            </div>
          </div>
        `;
      }

      body.innerHTML = `
        <!-- Amount header -->
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:18px;text-align:center;padding:16px;background:linear-gradient(135deg,rgba(16,185,129,0.06),rgba(16,185,129,0.02));border-radius:12px;border:1px solid rgba(16,185,129,0.12);">
          <div style="font-size:28px;font-weight:800;color:#1a2e25;">$${parseFloat(w.amount).toFixed(2)}</div>
          <div style="font-size:12px;color:#8aad9c;font-weight:500;">Requested via ${this.esc(w.method)}</div>
        </div>

        <!-- Detail rows -->
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Request ID</span>
            <span style="${valueStyle}">#${w.id}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">User Account</span>
            <span style="${valueStyle}">${this.esc(w.username)} <span style="color:#8aad9c;font-weight:400;">(ID #${w.user_id})</span></span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Payout Address</span>
            <div style="display:flex;align-items:center;gap:6px;max-width:65%;">
              <span style="font-weight:600;font-family:monospace;font-size:11px;color:#1a2e25;word-break:break-all;text-align:right;">${this.esc(w.payout_details)}</span>
              <button onclick="panel.copyToClipboard('${this.esc(w.payout_details).replace(/'/g, "\\'")}')" 
                style="background:#e8f5f0;border:1px solid rgba(16,185,129,0.3);cursor:pointer;color:#059669;padding:4px 6px;border-radius:6px;display:inline-flex;align-items:center;flex-shrink:0;" 
                title="Copy Address">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:currentColor;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              </button>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Status</span>
            <span>${statusBadge}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Request Date</span>
            <span style="${valueStyle}">${createdDate}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:${divider};">
            <span style="${labelStyle}">Resolved Date</span>
            <span style="${valueStyle}">${resolvedDate}</span>
          </div>
          ${txHashHtml}
          ${w.status === 'rejected' ? `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:11px 0;">
            <span style="${labelStyle}">Rejection Reason</span>
            <span style="font-weight:600;color:#ef4444;font-size:12px;text-align:right;max-width:220px;word-break:break-word;">${rejectReason}</span>
          </div>` : ''}
        </div>

        <!-- Status banners -->
        ${w.status === 'approved' ? `
        <div style="margin-top:16px;padding:14px 16px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px;">
          <div style="font-size:12px;color:#059669;font-weight:600;line-height:1.6;">\u2705 This withdrawal has been approved and processed successfully.</div>
        </div>` : ''}
        ${w.status === 'pending' ? `
        <div style="margin-top:16px;padding:14px 16px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.25);border-radius:10px;">
          <div style="font-size:12px;color:#d97706;font-weight:600;line-height:1.6;">\u23f3 This withdrawal is awaiting review. Please approve or reject it below.</div>
        </div>` : ''}
        ${w.status === 'rejected' ? `
        <div style="margin-top:16px;padding:14px 16px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;">
          <div style="font-size:12px;color:#ef4444;font-weight:600;line-height:1.6;">\u274c This withdrawal was rejected. The rejection reason has been sent to the user.</div>
        </div>` : ''}

        ${actionsHtml}
      `;

    } catch (e) {
      body.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;">Network error. Failed to load details.</div>`;
    }
  },

  openApproveWithdrawal(id, amount, currency) {
    document.getElementById('withdraw-approve-id').value = id;
    document.getElementById('withdraw-approve-amount').value = parseFloat(amount).toFixed(2);
    document.getElementById('withdraw-approve-currency-label').textContent = currency || 'USD';
    document.getElementById('withdraw-approve-hash').value = '';
    this.openModal('withdraw-approve-modal');
  },

  async confirmApproveWithdrawal() {
    const id = document.getElementById('withdraw-approve-id').value;
    const amountVal = document.getElementById('withdraw-approve-amount').value.trim();
    const hash = document.getElementById('withdraw-approve-hash').value.trim();

    if (!hash) {
      this.toast('Please enter the transaction hash / TXID.', 'error');
      return;
    }

    const payload = {
      tx_hash: hash
    };

    if (amountVal !== '') {
      const parsedAmount = parseFloat(amountVal);
      if (!isNaN(parsedAmount) && parsedAmount > 0) {
        payload.amount = parsedAmount;
      }
    }

    try {
      const res = await fetch(`/api/admin/withdrawals/${id}/approve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('✅ Withdrawal approved and transaction hash stored.', 'success');
        this.closeModal('withdraw-approve-modal');
        this.loadWithdrawals(this.withdrawalFilter);
        this.updateStatsBadge();
      } else {
        this.toast(data.error || 'Approval failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },


  tradeSearchQuery: '',

  onTradeSearchChange(val) {
    this.tradeSearchQuery = val;
    this.loadTrades(this.tradeFilter);
  },

  // ==================== TRADES ====================
  async loadTrades(filter) {
    this.tradeFilter = filter || this.tradeFilter || 'active';
    const tbody = document.getElementById('trades-table-body');
    try {
      let url = `/api/admin/trades?status=${this.tradeFilter}`;
      if (this.tradeSearchQuery) {
        url += `&search=${encodeURIComponent(this.tradeSearchQuery)}`;
      }
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const trades = data.trades || [];

      if (!trades.length) {
        tbody.innerHTML = `<tr><td colspan="10" class="loading-cell">No trades found.</td></tr>`;
        return;
      }

      const now = Date.now();
      tbody.innerHTML = trades.map(t => {
        const expires = new Date(t.expires_at).getTime();
        const remaining = Math.max(0, Math.round((expires - now) / 1000));
        const isActive = t.status === 'active';
        const tagHTML = t.is_bot
          ? '<br><span class="badge badge-purple" style="font-size: 8.5px; padding: 2px 4px; margin-top: 4px; display: inline-block; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3);">Bot</span>'
          : t.is_demo
            ? '<br><span class="badge badge-yellow" style="font-size: 8.5px; padding: 2px 4px; margin-top: 4px; display: inline-block; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);">Demo</span>'
            : '<br><span class="badge badge-green" style="font-size: 8.5px; padding: 2px 4px; margin-top: 4px; display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3);">Real</span>';
        return `
        <tr id="trade-row-${t.id}">
          <td>
            #${t.id}
            ${tagHTML}
          </td>
          <td>
            <strong>${this.esc(t.username)}</strong>
            <br>
            <span style="font-size:10.5px;color:var(--text-sec);">ID: ${t.user_id}</span>
            ${t.email ? `<br><span style="font-size:10px;color:var(--text-muted);font-family:monospace;">${this.esc(t.email)}</span>` : ''}
            ${t.phone_number ? `<br><span style="font-size:10px;color:var(--text-muted);font-family:monospace;">${this.esc(t.phone_number)}</span>` : ''}
          </td>
          <td style="font-weight:600;">${t.coin}</td>
          <td><span class="badge ${t.direction==='UP'?'badge-up':'badge-down'}">${t.direction==='UP'?'▲ UP':'▼ DOWN'}</span></td>
          <td style="font-weight:700;color:var(--accent);">${this.fmtBal(t.amount, t.currency)}</td>
          <td style="color:var(--text-sec);">${t.commission_pct}%</td>
          <td><span class="badge ${t.status==='active'?'badge-yellow':t.status==='win'?'badge-green':t.status==='lose'?'badge-red':'badge-gray'}">${t.status}</span></td>
          <td>
            <span class="badge ${t.admin_control==='win'?'badge-green':t.admin_control==='lose'?'badge-red':'badge-gray'}">
              ${t.admin_control==='win'?'WIN FORCED':t.admin_control==='lose'?'LOSE FORCED':'NATURAL'}
            </span>
          </td>
          <td style="font-size:11px;">
            ${isActive
              ? `<span id="timer-${t.id}" style="color:${remaining<10?'var(--danger)':'var(--warning)'};">${remaining}s</span>`
              : `<span style="color:var(--text-muted);">${t.status}</span>`
            }
          </td>
          <td>
            <div class="action-btns">
              ${isActive ? `
                <button class="btn-action btn-approve" onclick="panel.setTradeControl(${t.id},'win')">Force WIN</button>
                <button class="btn-action btn-reject" onclick="panel.setTradeControl(${t.id},'lose')">Force LOSE</button>
                <button class="btn-action btn-neutral" onclick="panel.setTradeControl(${t.id},'none')">Natural</button>
              ` : `<span style="font-size:11px;color:var(--text-muted);">Resolved</span>`}
            </div>
          </td>
        </tr>
        `;
      }).join('');

      // Live countdown timers for active trades
      trades.filter(t => t.status === 'active').forEach(t => {
        this.startTradeTimer(t.id, new Date(t.expires_at).getTime());
      });

    } catch (e) {
      console.error('Trades load error:', e);
    }
  },

  startTradeTimer(tradeId, expiresAt) {
    const el = document.getElementById(`timer-${tradeId}`);
    if (!el) return;
    const tick = () => {
      const rem = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (el) {
        el.textContent = `${rem}s`;
        el.style.color = rem < 10 ? 'var(--danger)' : 'var(--warning)';
      }
      if (rem <= 0 && el) {
        el.textContent = 'Expired';
        el.style.color = 'var(--text-muted)';
      }
    };
    tick();
    const interval = setInterval(() => {
      tick();
      const rem = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (rem <= 0) clearInterval(interval);
    }, 1000);
  },

  filterTrades(filter, btn) {
    document.querySelectorAll('#section-trades .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.loadTrades(filter);
  },

  async setTradeControl(tradeId, control) {
    try {
      const res = await fetch(`/api/admin/trades/${tradeId}/control`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ admin_control: control })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Trade #${tradeId} set to ${control === 'none' ? 'Natural' : control.toUpperCase()}.`, 'success');
        this.loadTrades(this.tradeFilter);
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async fetchCombineSettings() {
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'include' });
      const data = await res.json();
      if (res.ok && data.settings) {
        this.loadCombineSettings(data.settings);
      }
    } catch (e) {
      console.error('Failed to fetch combine settings:', e);
    }
  },

  loadCombineSettings(settings) {
    const combineToggle = document.getElementById('combine-toggle');
    const outcomeRow = document.getElementById('combine-outcome-row');
    if (!combineToggle || !outcomeRow) return;

    const controlVal = settings.combine_trades_control === 'true';
    combineToggle.checked = controlVal;

    const outcomeVal = settings.combine_trades_outcome || 'none';
    const radios = document.getElementsByName('combine-outcome');
    radios.forEach(r => {
      r.checked = r.value === outcomeVal;
    });
  },

  async onCombineToggle(checked) {
    try {
      const res = await fetch('/api/admin/trades/combine-control', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ combine_trades_control: checked })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Combine trades control turned ${checked ? 'ON' : 'OFF'}.`, 'success');
        this.loadTrades(this.tradeFilter);
      } else {
        this.toast(data.error || 'Failed to update combine control.', 'error');
        document.getElementById('combine-toggle').checked = !checked;
      }
    } catch (e) {
      this.toast('Network error.', 'error');
      document.getElementById('combine-toggle').checked = !checked;
    }
  },

  async setCombineOutcome(outcome) {
    try {
      const res = await fetch('/api/admin/trades/combine-control', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ combine_trades_outcome: outcome })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Global outcome set to ${outcome.toUpperCase()}.`, 'success');
        this.loadTrades(this.tradeFilter);
      } else {
        this.toast(data.error || 'Failed to update global outcome.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== EMPLOYEES ====================
  async loadEmployees() {
    const tbody = document.getElementById('employees-table-body');
    tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Loading...</td></tr>`;
    try {
      const res = await fetch('/api/admin/employees', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const emps = data.employees || [];

      if (!emps.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">No employees found.</td></tr>`;
        return;
      }

      // Cache employee data so onclick handlers can reference it safely
      // without embedding JSON inside HTML attribute strings
      this._empCache = {};

      tbody.innerHTML = emps.map(e => {
        const p = e.permissions || {};
        // Store in cache for onclick retrieval
        this._empCache[e.id] = {
          perms: p,
          inviteCode: e.invite_code || '',
          commissionPct: (e.commission_pct !== null && e.commission_pct !== undefined) ? e.commission_pct : ''
        };

        const permTags = [];
        if (p.full_access) permTags.push('<span class="badge badge-green">Full</span>');
        else {
          if (p.user_management)     permTags.push('<span class="badge badge-gray">Users</span>');
          if (p.deposit_approval)    permTags.push('<span class="badge badge-gray">Deposits</span>');
          if (p.withdrawal_approval) permTags.push('<span class="badge badge-gray">Withdrawals</span>');
          if (p.trade_monitoring)    permTags.push('<span class="badge badge-gray">Trades</span>');
          if (p.live_support)        permTags.push('<span class="badge badge-gray">💬 Support</span>');
          if (p.see_all_users)       permTags.push('<span class="badge badge-gray">👁 All Users</span>');
          if (p.dash_live_activity)   permTags.push('<span class="badge badge-gray" style="font-size:10px;">⚡ Activity</span>');
          if (p.dash_global_settings) permTags.push('<span class="badge badge-gray" style="font-size:10px;">🛡️ Settings</span>');
          if (p.dash_live_trades)     permTags.push('<span class="badge badge-gray" style="font-size:10px;">🛸 Watcher</span>');
          if (p.dash_kyc_list)        permTags.push('<span class="badge badge-gray" style="font-size:10px;">📄 KYC Inbox</span>');
        }

        const commDisplay = (e.commission_pct !== null && e.commission_pct !== undefined)
          ? `<span style="color:var(--accent);font-weight:700;">${parseFloat(e.commission_pct).toFixed(1)}%</span>`
          : `<span style="color:var(--text-muted);font-size:11px;">Global</span>`;

        const statusBadge = e.status === 'active'
          ? 'badge-green' : e.status === 'frozen' ? 'badge-yellow' : 'badge-red';

        const joined = e.created_at ? new Date(e.created_at).toLocaleDateString() : '—';
        const eid = e.id;
        const uname = this.esc(e.username);

        return `
        <tr>
          <td>#${eid}</td>
          <td><strong>${uname}</strong></td>
          <td>
            ${e.invite_code ? `
              <div style="display:inline-flex; align-items:center; gap:6px;">
                <span style="font-family:monospace;font-size:12px;color:var(--accent);">${this.esc(e.invite_code)}</span>
                <button onclick="panel.copyCustomCode('${this.esc(e.invite_code)}')" style="background:none; border:none; padding:2px; cursor:pointer; color:var(--primary); display:flex; align-items:center; justify-content:center;" title="Copy Code">
                  <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:currentColor;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
                </button>
                <button onclick="panel.copyCustomLink('${this.esc(e.invite_code)}')" style="background:none; border:none; padding:2px; cursor:pointer; color:var(--primary); display:flex; align-items:center; justify-content:center;" title="Copy Referral Link">
                  <svg viewBox="0 0 24 24" style="width:12px; height:12px; fill:currentColor;"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
                </button>
              </div>
            ` : '—'}
          </td>
          <td>${commDisplay}</td>
          <td>
            <button class="btn-action btn-info" style="font-size:11px;padding:3px 8px;" onclick="panel.showEmployeeStats(${eid}, '${uname}')">
              ${e.users_invited ?? 0} Users
            </button>
          </td>
          <td><span class="badge ${statusBadge}">${e.status}</span></td>
          <td><div style="display:flex;gap:4px;flex-wrap:wrap;">${permTags.join('') || '<span style="color:var(--text-muted);font-size:11px;">None</span>'}</div></td>
          <td style="font-size:11px;color:var(--text-muted);">${joined}</td>
          <td>
            <div class="action-btns" style="gap:4px;">
              <button class="btn-action btn-info" onclick="panel.showEditPermissions(${eid}, '${uname}')">Edit</button>
              <button class="btn-action btn-warn" onclick="panel.showResetPasswordModal(${eid}, '${uname}')">Reset PW</button>
              ${e.status === 'active'
                ? `<button class="btn-action btn-warn" onclick="panel.setUserStatus(${eid},'frozen')">Freeze</button>`
                : `<button class="btn-action btn-approve" onclick="panel.setUserStatus(${eid},'active')">Activate</button>`}
              <button class="btn-action btn-reject" onclick="panel.deleteEmployee(${eid}, '${uname}')">Delete</button>
            </div>
          </td>
        </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">Error loading employees.</td></tr>`;
    }
  },


  showCreateUser() {
    document.getElementById('create-user-username').value = '';
    document.getElementById('create-user-fullname').value = '';
    document.getElementById('create-user-email').value = '';
    document.getElementById('create-user-phone').value = '';
    document.getElementById('create-user-password').value = '';
    document.getElementById('create-user-balance').value = '0.00';
    document.getElementById('create-user-demo-balance').value = '10000.00';

    const isEmp = this.user.role === 'employee';
    const balanceFormGroup = document.getElementById('create-user-balance')?.closest('.form-group');
    const demoBalanceFormGroup = document.getElementById('create-user-demo-balance')?.closest('.form-group');
    if (balanceFormGroup) {
      balanceFormGroup.style.display = isEmp ? 'none' : 'block';
    }
    if (demoBalanceFormGroup) {
      demoBalanceFormGroup.style.display = isEmp ? 'none' : 'block';
    }

    const errBox = document.getElementById('create-user-error');
    if (errBox) {
      errBox.style.display = 'none';
      errBox.textContent = '';
    }
    this.openModal('create-user-modal');
  },

  async handleCreateUser(e) {
    e.preventDefault();
    const username = document.getElementById('create-user-username').value.trim();
    const full_name = document.getElementById('create-user-fullname').value.trim();
    const email = document.getElementById('create-user-email').value.trim();
    const phone_number = document.getElementById('create-user-phone').value.trim();
    const password = document.getElementById('create-user-password').value;
    const balance = parseFloat(document.getElementById('create-user-balance').value) || 0.0;
    const demo_balance = parseFloat(document.getElementById('create-user-demo-balance').value) || 0.0;

    const errorEl = document.getElementById('create-user-error');
    if (errorEl) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
    }

    if (password.length < 6) {
      if (errorEl) {
        errorEl.textContent = 'Password must be at least 6 characters.';
        errorEl.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch('/api/admin/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username,
          full_name,
          email,
          phone_number,
          password,
          balance,
          demo_balance
        })
      });

      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ User "${username}" created successfully!`, 'success');
        this.closeModal('create-user-modal');
        this.loadUsers();
      } else {
        if (errorEl) {
          errorEl.textContent = data.error || 'Failed to create user.';
          errorEl.style.display = 'block';
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = 'Network error. Please try again.';
        errorEl.style.display = 'block';
      }
    }
  },

  showCreateEmployee() {
    document.getElementById('emp-username').value = '';
    document.getElementById('emp-password').value = '';
    document.getElementById('emp-invite-code').value = '';
    document.getElementById('emp-commission-pct').value = '';
    // Reset all permission checkboxes
    ['perm-full-access','perm-user-mgmt','perm-deposits','perm-withdrawals','perm-trades','perm-live-support','perm-see-all-users',
     'perm-dash-live-activity','perm-dash-global-settings','perm-dash-live-trades','perm-dash-kyc-list'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.checked = false; el.disabled = false; }
    });
    this.openModal('create-employee-modal');
  },

  handleFullAccessToggle(checkbox) {
    const perms = ['perm-user-mgmt', 'perm-deposits', 'perm-withdrawals', 'perm-trades', 'perm-live-support', 'perm-see-all-users',
                   'perm-dash-live-activity', 'perm-dash-global-settings', 'perm-dash-live-trades', 'perm-dash-kyc-list'];
    perms.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.checked = checkbox.checked; el.disabled = checkbox.checked; }
    });
  },

  handleEditFullAccessToggle(checkbox) {
    const perms = ['edit-perm-user-mgmt', 'edit-perm-deposits', 'edit-perm-withdrawals', 'edit-perm-trades', 'edit-perm-live-support', 'edit-perm-see-all-users',
                   'edit-perm-dash-live-activity', 'edit-perm-dash-global-settings', 'edit-perm-dash-live-trades', 'edit-perm-dash-kyc-list'];
    perms.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.checked = checkbox.checked; el.disabled = checkbox.checked; }
    });
  },

  async createEmployee(e) {
    e.preventDefault();
    const username = document.getElementById('emp-username').value.trim();
    const password = document.getElementById('emp-password').value;
    const invite_code = document.getElementById('emp-invite-code').value.trim().toUpperCase();
    const commRaw = document.getElementById('emp-commission-pct').value.trim();
    const commission_pct = commRaw !== '' ? parseFloat(commRaw) : null;

    const permissions = {
      full_access:          document.getElementById('perm-full-access').checked   ? 1 : 0,
      user_management:      document.getElementById('perm-user-mgmt').checked     ? 1 : 0,
      deposit_approval:     document.getElementById('perm-deposits').checked      ? 1 : 0,
      withdrawal_approval:  document.getElementById('perm-withdrawals').checked   ? 1 : 0,
      trade_monitoring:     document.getElementById('perm-trades').checked        ? 1 : 0,
      live_support:         document.getElementById('perm-live-support').checked  ? 1 : 0,
      see_all_users:        document.getElementById('perm-see-all-users').checked ? 1 : 0,
      dash_live_activity:   document.getElementById('perm-dash-live-activity').checked   ? 1 : 0,
      dash_global_settings: document.getElementById('perm-dash-global-settings').checked ? 1 : 0,
      dash_live_trades:     document.getElementById('perm-dash-live-trades').checked     ? 1 : 0,
      dash_kyc_list:        document.getElementById('perm-dash-kyc-list').checked        ? 1 : 0,
    };

    if (!invite_code) { this.toast('Invite code is required.', 'error'); return; }

    try {
      const res = await fetch('/api/admin/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, invite_code, commission_pct, permissions })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`✅ Employee "${username}" created — Invite Code: ${data.invite_code || invite_code}`, 'success');
        this.closeModal('create-employee-modal');
        this.loadEmployees();
      } else {
        this.toast(data.error || 'Failed to create employee.', 'error');
      }
    } catch (ex) {
      this.toast('Network error.', 'error');
    }
  },

  showEditPermissions(userId, username, perms, inviteCode, commissionPct) {
    // If called from loadEmployees (new cache-based path), read from cache
    if (perms === undefined && this._empCache && this._empCache[userId]) {
      const cached = this._empCache[userId];
      perms = cached.perms;
      inviteCode = cached.inviteCode;
      commissionPct = cached.commissionPct;
    }
    perms = perms || {};

    document.getElementById('edit-perms-user-id').value = userId;
    document.getElementById('edit-perms-title').textContent = `Edit: ${username}`;

    // Invite code & commission
    document.getElementById('edit-invite-code').value = inviteCode || '';
    document.getElementById('edit-commission-pct').value =
      (commissionPct !== undefined && commissionPct !== null && commissionPct !== '') ? commissionPct : '';

    // Re-enable all individual perms first (clear sticky disabled state)
    ['edit-perm-user-mgmt','edit-perm-deposits','edit-perm-withdrawals',
     'edit-perm-trades','edit-perm-live-support','edit-perm-see-all-users',
     'edit-perm-dash-live-activity','edit-perm-dash-global-settings','edit-perm-dash-live-trades','edit-perm-dash-kyc-list'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    document.getElementById('edit-perm-full-access').checked  = !!perms.full_access;
    document.getElementById('edit-perm-user-mgmt').checked    = !!perms.user_management;
    document.getElementById('edit-perm-deposits').checked     = !!perms.deposit_approval;
    document.getElementById('edit-perm-withdrawals').checked  = !!perms.withdrawal_approval;
    document.getElementById('edit-perm-trades').checked       = !!perms.trade_monitoring;
    document.getElementById('edit-perm-live-support').checked = !!perms.live_support;
    const ehEl = document.getElementById('edit-perm-earnings-history');
    if (ehEl) ehEl.checked = perms.earnings_history !== 0;
    const wlEl = document.getElementById('edit-perm-withdrawal-limit');
    if (wlEl) wlEl.value = perms.withdrawal_limit !== undefined && perms.withdrawal_limit !== null ? perms.withdrawal_limit : 1000;
    document.getElementById('edit-perm-see-all-users').checked= !!perms.see_all_users;
    document.getElementById('edit-perm-dash-live-activity').checked   = !!perms.dash_live_activity;
    document.getElementById('edit-perm-dash-global-settings').checked = !!perms.dash_global_settings;
    document.getElementById('edit-perm-dash-live-trades').checked     = !!perms.dash_live_trades;
    document.getElementById('edit-perm-dash-kyc-list').checked        = !!perms.dash_kyc_list;

    // If full_access set, disable individual perms
    if (perms.full_access) {
      ['edit-perm-user-mgmt','edit-perm-deposits','edit-perm-withdrawals',
       'edit-perm-trades','edit-perm-live-support','edit-perm-earnings-history','edit-perm-see-all-users',
       'edit-perm-dash-live-activity','edit-perm-dash-global-settings','edit-perm-dash-live-trades','edit-perm-dash-kyc-list'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
    }

    this.openModal('edit-perms-modal');
  },

  async savePermissions() {
    const userId = document.getElementById('edit-perms-user-id').value;
    const commRaw = document.getElementById('edit-commission-pct').value.trim();
    const commission_pct = commRaw !== '' ? parseFloat(commRaw) : null;
    const new_invite_code = document.getElementById('edit-invite-code').value.trim().toUpperCase() || null;

    const ehEl = document.getElementById('edit-perm-earnings-history');
    const wlEl = document.getElementById('edit-perm-withdrawal-limit');

    const payload = {
      full_access:          document.getElementById('edit-perm-full-access').checked   ? 1 : 0,
      user_management:      document.getElementById('edit-perm-user-mgmt').checked     ? 1 : 0,
      deposit_approval:     document.getElementById('edit-perm-deposits').checked      ? 1 : 0,
      withdrawal_approval:  document.getElementById('edit-perm-withdrawals').checked   ? 1 : 0,
      trade_monitoring:     document.getElementById('edit-perm-trades').checked        ? 1 : 0,
      live_support:         document.getElementById('edit-perm-live-support').checked  ? 1 : 0,
      earnings_history:     ehEl ? (ehEl.checked ? 1 : 0) : 1,
      withdrawal_limit:     wlEl && wlEl.value.trim() !== '' ? parseFloat(wlEl.value.trim()) : 1000.00,
      see_all_users:        document.getElementById('edit-perm-see-all-users').checked ? 1 : 0,
      dash_live_activity:   document.getElementById('edit-perm-dash-live-activity').checked   ? 1 : 0,
      dash_global_settings: document.getElementById('edit-perm-dash-global-settings').checked ? 1 : 0,
      dash_live_trades:     document.getElementById('edit-perm-dash-live-trades').checked     ? 1 : 0,
      dash_kyc_list:        document.getElementById('edit-perm-dash-kyc-list').checked        ? 1 : 0,
      commission_pct,
      new_invite_code,
    };

    try {
      const res = await fetch(`/api/admin/employees/${userId}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('✅ Employee updated successfully.', 'success');
        this.closeModal('edit-perms-modal');
        this.loadEmployees();
      } else {
        this.toast(data.error || 'Failed to update.', 'error');
      }
    } catch (ex) {
      this.toast('Network error.', 'error');
    }
  },

  async deleteEmployee(userId, username) {
    if (!confirm(`Delete employee "${username}"? Their account will be blocked and they will lose access.`)) return;
    try {
      const res = await fetch(`/api/admin/employees/${userId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Employee "${username}" deleted/blocked.`, 'success');
        this.loadEmployees();
      } else {
        this.toast(data.error || 'Failed to delete employee.', 'error');
      }
    } catch (ex) {
      this.toast('Network error.', 'error');
    }
  },

  showResetPasswordModal(userId, username) {
    document.getElementById('reset-emp-id').value = userId;
    document.getElementById('reset-emp-password-title').textContent = `Reset Password: ${username}`;
    document.getElementById('reset-emp-new-password').value = '';
    document.getElementById('reset-emp-confirm-password').value = '';
    const errEl = document.getElementById('reset-emp-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    this.openModal('reset-emp-password-modal');
  },

  async resetEmployeePassword() {
    const userId = document.getElementById('reset-emp-id').value;
    const new_password = document.getElementById('reset-emp-new-password').value;
    const confirm_password = document.getElementById('reset-emp-confirm-password').value;
    const errEl = document.getElementById('reset-emp-error');

    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

    if (new_password.length < 6) {
      if (errEl) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; }
      return;
    }
    if (new_password !== confirm_password) {
      if (errEl) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; }
      return;
    }

    try {
      const res = await fetch(`/api/admin/employees/${userId}/reset-password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ new_password })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('✅ Password reset successfully.', 'success');
        this.closeModal('reset-emp-password-modal');
      } else {
        if (errEl) { errEl.textContent = data.error || 'Failed.'; errEl.style.display = 'block'; }
      }
    } catch (ex) {
      if (errEl) { errEl.textContent = 'Network error.'; errEl.style.display = 'block'; }
    }
  },

  async showEmployeeStats(userId, username) {
    document.getElementById('emp-stats-title').textContent = `Stats: ${username}`;
    document.getElementById('stats-users-count').textContent = '…';
    document.getElementById('stats-deposits-total').textContent = '…';
    document.getElementById('stats-commission-total').textContent = '…';
    document.getElementById('emp-stats-users-tbody').innerHTML = `<tr><td colspan="4" class="loading-cell">Loading...</td></tr>`;
    this.openModal('employee-stats-modal');

    try {
      const res = await fetch(`/api/admin/employees/${userId}/stats`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error || 'Failed to load stats.', 'error'); return; }

      document.getElementById('stats-users-count').textContent = data.users_invited.length;
      document.getElementById('stats-deposits-total').textContent = '$' + (data.total_deposits || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById('stats-commission-total').textContent = '$' + (data.total_commissions || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const tbody = document.getElementById('emp-stats-users-tbody');
      if (!data.users_invited.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">No users invited yet.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.users_invited.map(u => `
        <tr>
          <td>#${u.id}</td>
          <td><strong>${this.esc(u.username)}</strong></td>
          <td><span class="badge ${u.status === 'active' ? 'badge-green' : u.status === 'frozen' ? 'badge-yellow' : 'badge-red'}">${u.status}</span></td>
          <td style="font-size:11px;color:var(--text-muted);">${new Date(u.created_at).toLocaleDateString()}</td>
        </tr>
      `).join('');
    } catch (ex) {
      document.getElementById('emp-stats-users-tbody').innerHTML = `<tr><td colspan="4" class="loading-cell">Error loading stats.</td></tr>`;
    }
  },

  // ==================== INVITE CODES ====================
  async loadInviteCodes() {
    const tbody = document.getElementById('codes-table-body');
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading...</td></tr>`;
    try {
      const res = await fetch('/api/admin/invite-codes', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const codes = data.codes || [];

      if (!codes.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No invite codes found.</td></tr>`;
        return;
      }

      tbody.innerHTML = codes.map(c => `
        <tr>
          <td><span style="font-family:monospace;font-size:14px;font-weight:700;color:var(--accent);">${this.esc(c.code)}</span></td>
          <td>${this.esc(c.creator_username || '—')}</td>
          <td><span class="badge badge-gray">${c.used_count}</span></td>
          <td style="font-size:11px;color:var(--text-sec);">${new Date(c.created_at).toLocaleDateString()}</td>
          <td>
            <button class="btn-action btn-reject" onclick="panel.deleteInviteCode(${c.id}, '${this.esc(c.code)}')">Delete</button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Error.</td></tr>`;
    }
  },

  showCreateCode() {
    document.getElementById('new-code-input').value = '';
    this.openModal('create-code-modal');
  },

  async createInviteCode(e) {
    e.preventDefault();
    const code = document.getElementById('new-code-input').value.trim().toUpperCase();
    if (!code) { this.toast('Code cannot be empty.', 'error'); return; }

    try {
      const res = await fetch('/api/admin/invite-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Invite code "${code}" created.`, 'success');
        this.closeModal('create-code-modal');
        this.loadInviteCodes();
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async deleteInviteCode(id, code) {
    if (!confirm(`Delete invite code "${code}"?`)) return;
    try {
      const res = await fetch(`/api/admin/invite-codes/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Code "${code}" deleted.`, 'success');
        this.loadInviteCodes();
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== PAYMENT SETTINGS ====================
  async loadSettings() {
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const s = data.settings;

      document.getElementById('setting-usdt-address').value = s.usdt_deposit_address || '';
      document.getElementById('setting-usdt-trc20-address').value = s.usdt_trc20_deposit_address || '';
      document.getElementById('setting-usdt-erc20-address').value = s.usdt_erc20_deposit_address || '';
      document.getElementById('setting-usdt-bep20-address').value = s.usdt_bep20_deposit_address || '';
      document.getElementById('setting-usdt-ltc-address').value = s.usdt_ltc_deposit_address || '';
      document.getElementById('setting-usdt-aptos-address').value = s.usdt_aptos_deposit_address || '';
      document.getElementById('setting-usdc-address').value = s.usdc_deposit_address || '';
      document.getElementById('setting-bank-details').value = s.bank_deposit_details || '';
      document.getElementById('setting-deposit-usdt').checked = s.deposit_usdt_enabled === 'true';
      document.getElementById('setting-deposit-usdc').checked = s.deposit_usdc_enabled === 'true';
      document.getElementById('setting-deposit-bank').checked = s.deposit_bank_enabled === 'true';
      
      document.getElementById('setting-deposit-binance-auto').checked = s.binance_auto_enabled === 'true';
      document.getElementById('setting-deposit-binance-manual').checked = s.binance_manual_enabled === 'true';
      document.getElementById('setting-binance-api-key').value = s.binance_api_key || '';
      document.getElementById('setting-binance-secret-key').value = s.binance_secret_key || '';
      document.getElementById('setting-binance-deposit-address').value = s.binance_deposit_address || '';
      document.getElementById('setting-binance-qr-url').value = s.binance_qr_url || '';
      
      const qrUrl = s.binance_qr_url || '';
      const qrPrev = document.getElementById('binance-qr-preview');
      const qrWrap = document.getElementById('binance-qr-preview-wrap');
      if (qrUrl) {
        if (qrPrev) qrPrev.src = qrUrl;
        if (qrWrap) qrWrap.style.display = 'block';
      } else {
        if (qrWrap) qrWrap.style.display = 'none';
      }

      document.getElementById('setting-withdraw-usdt').checked = s.withdrawal_usdt_enabled === 'true';
      document.getElementById('setting-withdraw-usdc').checked = s.withdrawal_usdc_enabled === 'true';
      document.getElementById('setting-withdraw-bank').checked = s.withdrawal_bank_enabled === 'true';

      if (document.getElementById('setting-terms-description')) {
        document.getElementById('setting-terms-description').value = s.terms_description || '';
      }
      if (document.getElementById('setting-policy-description')) {
        document.getElementById('setting-policy-description').value = s.policy_description || '';
      }
      if (document.getElementById('setting-faq-description')) {
        document.getElementById('setting-faq-description').value = s.faq_description || '';
      }
      if (document.getElementById('setting-auth-description')) {
        document.getElementById('setting-auth-description').value = s.auth_description || '';
      }
      if (document.getElementById('setting-risk-description')) {
        document.getElementById('setting-risk-description').value = s.risk_description || '';
      }
      if (document.getElementById('setting-aml-description')) {
        document.getElementById('setting-aml-description').value = s.aml_description || '';
      }
      if (document.getElementById('setting-contact-description')) {
        document.getElementById('setting-contact-description').value = s.contact_description || '';
      }
      if (document.getElementById('setting-kyc-description')) {
        document.getElementById('setting-kyc-description').value = s.kyc_description || '';
      }
      if (document.getElementById('setting-refund-policy-description')) {
        document.getElementById('setting-refund-policy-description').value = s.refund_policy_description || '';
      }
      if (document.getElementById('setting-shipping-policy-description')) {
        document.getElementById('setting-shipping-policy-description').value = s.shipping_policy_description || '';
      }
      if (document.getElementById('setting-office-address')) {
        document.getElementById('setting-office-address').value = s.office_address || '';
      }
      if (document.getElementById('setting-office-number')) {
        document.getElementById('setting-office-number').value = s.office_number || '';
      }

      // Load balance card background image settings (mobile + desktop)
      const bgMobileEl = document.getElementById('setting-balance-card-bg-mobile');
      const bgDesktopEl = document.getElementById('setting-balance-card-bg-desktop');
      if (bgMobileEl) {
        bgMobileEl.value = s.balance_card_bg_mobile || '';
        if (s.balance_card_bg_mobile) {
          const prev = document.getElementById('balance-bg-preview-mobile');
          const wrap = document.getElementById('balance-bg-preview-wrap-mobile');
          if (prev) prev.src = s.balance_card_bg_mobile;
          if (wrap) wrap.style.display = 'block';
        }
      }
      if (bgDesktopEl) {
        bgDesktopEl.value = s.balance_card_bg_desktop || '';
        if (s.balance_card_bg_desktop) {
          const prev = document.getElementById('balance-bg-preview-desktop');
          const wrap = document.getElementById('balance-bg-preview-wrap-desktop');
          if (prev) prev.src = s.balance_card_bg_desktop;
          if (wrap) wrap.style.display = 'block';
        }
      }

      if (document.getElementById('setting-referral-pct')) {
        document.getElementById('setting-referral-pct').value = s.referral_commission_pct || '5.0';
      }

      if (document.getElementById('risk-setting-streak-limit')) {
        document.getElementById('risk-setting-streak-limit').value = s.risk_auto_streak_limit || '0';
      }
      if (document.getElementById('risk-setting-profit-limit')) {
        document.getElementById('risk-setting-profit-limit').value = s.risk_auto_profit_limit || '0.0';
      }
      if (document.getElementById('risk-setting-latency-ms')) {
        document.getElementById('risk-setting-latency-ms').value = s.risk_auto_latency_ms || '1500';
      }
      if (document.getElementById('risk-setting-slippage-pct')) {
        document.getElementById('risk-setting-slippage-pct').value = s.risk_auto_slippage_pct || '2.0';
      }

      // Load combine trades settings
      this.loadCombineSettings(s);

      // Load Support & Community Links
      const waEl = document.getElementById('setting-whatsapp-number');
      if (waEl) waEl.value = s.whatsapp_support_number || '';
      const tgEl = document.getElementById('setting-telegram-link');
      if (tgEl) tgEl.value = s.telegram_community_link || '';

      // Render coin visibility checkboxes
      const allCoins = ['BTC','ETH','SOL','BNB','DOGE','XRP','ADA','AVAX','MATIC','LINK','LTC','DOT','TRX','UNI','ATOM'];
      let visible = [];
      try { visible = JSON.parse(s.crypto_visible_coins || '[]'); } catch(e) {}
      const grid = document.getElementById('coin-visibility-grid');
      if (grid) {
        grid.innerHTML = allCoins.map(coin => `
          <label style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px 14px; cursor:pointer; font-size:13px; font-weight:600; user-select:none;">
            <input type="checkbox" class="coin-vis-chk" value="${coin}" ${visible.includes(coin) ? 'checked' : ''} style="width:16px; height:16px; accent-color:var(--accent);">
            ${coin}/USDT
          </label>
        `).join('');
      }

      // Populate onboarding slides editors
      let slides = [];
      try { slides = JSON.parse(s.onboarding_slides || '[]'); } catch(e) {}
      const slidesContainer = document.getElementById('onboarding-slides-list');
      if (slidesContainer) {
        while (slides.length < 5) {
          slides.push({ title: '', description: '', image: '' });
        }
        slides = slides.slice(0, 5);
        slidesContainer.innerHTML = slides.map((sl, i) => `
          <div class="onboarding-slide-editor" style="border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px; margin-bottom:12px; background: rgba(255,255,255,0.01);">
            <p style="font-weight:700; margin-bottom:10px; color:var(--accent);">Slide ${i+1}</p>
            <div class="form-group">
              <label class="form-label">Slide Image</label>
              <div style="display: flex; gap: 10px; align-items: center;">
                <input type="text" class="form-control slide-image" value="${this.esc(sl.image || '')}" readonly style="flex: 1; background: rgba(255,255,255,0.02);">
                <button type="button" class="btn btn-secondary" onclick="panel.triggerSlideUpload(${i})" style="padding: 10px 16px; font-size: 13px; width: auto; white-space: nowrap;">Upload Image</button>
                <input type="file" id="slide-file-${i}" onchange="panel.handleSlideUpload(${i})" accept="image/*" style="display: none;">
              </div>
              <div style="margin-top: 10px; display: ${sl.image ? 'block' : 'none'};" id="slide-preview-container-${i}">
                <img id="slide-preview-${i}" src="${sl.image || ''}" style="max-height: 80px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); display: block;">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Title</label>
              <input type="text" class="form-control slide-title" value="${this.esc(sl.title || '')}">
            </div>
            <div class="form-group">
              <label class="form-label">Description</label>
              <textarea class="form-control slide-desc" rows="2">${this.esc(sl.description || '')}</textarea>
            </div>
          </div>
        `).join('');
      }

      this.currencyRates = {};
      Object.keys(s).forEach(key => {
        if (key.startsWith('currency_rate_')) {
          const code = key.replace('currency_rate_', '').toUpperCase();
          this.currencyRates[code] = parseFloat(s[key] || 0);
        }
      });
      if (this.currencyRates.USD === undefined) {
        this.currencyRates.USD = 1.0;
      }
      this.renderCurrencyRatesTable();
      await this.loadEWallets();
    } catch (e) {
      console.error(e);
      this.toast('Failed to load settings.', 'error');
    }
  },

  async saveSupportLinks() {
    const waNum  = (document.getElementById('setting-whatsapp-number')?.value || '').trim();
    const tgLink = (document.getElementById('setting-telegram-link')?.value || '').trim();
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          whatsapp_support_number: waNum,
          telegram_community_link: tgLink
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Support links saved successfully!', 'success');
      } else {
        this.toast(data.error || 'Failed to save.', 'error');
      }
    } catch (e) {
      this.toast('Network error. Please try again.', 'error');
    }
  },

  async saveCoinVisibility() {
    const checked = [];
    document.querySelectorAll('.coin-vis-chk:checked').forEach(chk => checked.push(chk.value));
    if (checked.length === 0) {
      this.toast('Please enable at least one coin.', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ crypto_visible_coins: checked })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Coin visibility updated: ${checked.join(', ')}`, 'success');
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async saveReferralSettings() {
    const pctVal = document.getElementById('setting-referral-pct').value;
    if (pctVal === '') {
      this.toast('Referral commission percentage is required.', 'error');
      return;
    }
    const pct = parseFloat(pctVal);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      this.toast('Invalid percentage value. Must be between 0 and 100.', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ referral_commission_pct: String(pct) })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Referral settings saved successfully.', 'success');
      } else {
        this.toast(data.error || 'Failed to save settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async saveRiskSettings() {
    const streakLimit = parseInt(document.getElementById('risk-setting-streak-limit').value || '0');
    const profitLimit = parseFloat(document.getElementById('risk-setting-profit-limit').value || '0.0');
    const latencyMs = parseInt(document.getElementById('risk-setting-latency-ms').value || '1500');
    const slippagePct = parseFloat(document.getElementById('risk-setting-slippage-pct').value || '2.0');

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          risk_auto_streak_limit: String(streakLimit),
          risk_auto_profit_limit: String(profitLimit),
          risk_auto_latency_ms: String(latencyMs),
          risk_auto_slippage_pct: String(slippagePct)
        })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Smart Risk mitigation rules applied successfully.', 'success');
      } else {
        this.toast(data.error || 'Failed to save risk settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error saving risk settings.', 'error');
    }
  },

  async savePaymentSettings(e) {
    e.preventDefault();
    const bgMobileEl = document.getElementById('setting-balance-card-bg-mobile');
    const bgDesktopEl = document.getElementById('setting-balance-card-bg-desktop');
    const settings = {
      usdt_deposit_address: document.getElementById('setting-usdt-trc20-address').value.trim() || document.getElementById('setting-usdt-address').value.trim(),
      usdt_trc20_deposit_address: document.getElementById('setting-usdt-trc20-address').value.trim(),
      usdt_erc20_deposit_address: document.getElementById('setting-usdt-erc20-address').value.trim(),
      usdt_bep20_deposit_address: document.getElementById('setting-usdt-bep20-address').value.trim(),
      usdt_ltc_deposit_address: document.getElementById('setting-usdt-ltc-address').value.trim(),
      usdt_aptos_deposit_address: document.getElementById('setting-usdt-aptos-address').value.trim(),
      usdc_deposit_address: document.getElementById('setting-usdc-address').value.trim(),
      bank_deposit_details: document.getElementById('setting-bank-details').value.trim(),
      deposit_usdt_enabled: document.getElementById('setting-deposit-usdt').checked ? 'true' : 'false',
      deposit_usdc_enabled: document.getElementById('setting-deposit-usdc').checked ? 'true' : 'false',
      deposit_bank_enabled: document.getElementById('setting-deposit-bank').checked ? 'true' : 'false',
      binance_auto_enabled: document.getElementById('setting-deposit-binance-auto').checked ? 'true' : 'false',
      binance_manual_enabled: document.getElementById('setting-deposit-binance-manual').checked ? 'true' : 'false',
      binance_api_key: document.getElementById('setting-binance-api-key').value.trim(),
      binance_secret_key: document.getElementById('setting-binance-secret-key').value.trim(),
      binance_deposit_address: document.getElementById('setting-binance-deposit-address').value.trim(),
      binance_qr_url: document.getElementById('setting-binance-qr-url').value.trim(),
      withdrawal_usdt_enabled: document.getElementById('setting-withdraw-usdt').checked ? 'true' : 'false',
      withdrawal_usdc_enabled: document.getElementById('setting-withdraw-usdc').checked ? 'true' : 'false',
      withdrawal_bank_enabled: document.getElementById('setting-withdraw-bank').checked ? 'true' : 'false',
      balance_card_bg_mobile: bgMobileEl ? bgMobileEl.value.trim() : '',
      balance_card_bg_desktop: bgDesktopEl ? bgDesktopEl.value.trim() : '',
    };

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Payment settings saved successfully.', 'success');
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async loadEWallets() {
    try {
      const res = await fetch('/api/admin/e-wallets', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        this.toast(data.error || 'Failed to load e-wallets', 'error');
        return;
      }
      
      const list = document.getElementById('ewallet-methods-list');
      if (!list) return;
      
      const methods = data.methods || [];
      if (methods.length === 0) {
        list.innerHTML = `<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:10px;">No Banks / E-Wallets configured.</div>`;
        return;
      }
      
      list.innerHTML = methods.map(ew => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); padding:10px 14px; border-radius:8px;">
          <div style="display:flex; align-items:center; gap:10px;">
            ${ew.logo_url ? `<img src="${ew.logo_url}" style="width:30px; height:30px; border-radius:50%; object-fit:cover; border:1px solid rgba(255,255,255,0.1);">` : `<div style="width:30px; height:30px; border-radius:50%; background:var(--accent); display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:11px; color:#000;">${ew.name.slice(0,2).toUpperCase()}</div>`}
            <div>
              <span style="font-weight:700; color:var(--text-primary);">${this.esc(ew.name)}</span>
              <span class="badge" style="font-size:9px; padding:2px 6px; margin-left:6px; background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3);">🌍 ${this.esc(ew.country || 'Pakistan')}</span>
              ${ew.enabled === 1 ? `<span class="badge badge-green" style="font-size:9px; padding:2px 6px; margin-left:4px;">Active</span>` : `<span class="badge badge-red" style="font-size:9px; padding:2px 6px; margin-left:4px;">Disabled</span>`}
              <div style="font-size:11px; color:var(--text-sec); margin-top:2px;">
                Holder: ${this.esc(ew.account_name)} | Number: ${this.esc(ew.account_number)}
                ${ew.iban ? ` | IBAN: ${this.esc(ew.iban)}` : ''} | Rate: 1 USD = ${ew.pkr_rate || 283} Local
                <br>
                Dep Limits: $${ew.min_deposit !== undefined && ew.min_deposit !== null ? ew.min_deposit : 10} - $${ew.max_deposit !== undefined && ew.max_deposit !== null ? ew.max_deposit : 10000} | Wd Limits: $${ew.min_withdrawal !== undefined && ew.min_withdrawal !== null ? ew.min_withdrawal : 10} - $${ew.max_withdrawal !== undefined && ew.max_withdrawal !== null ? ew.max_withdrawal : 10000}
              </div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="btn btn-secondary" onclick="panel.startEWalletEdit(${JSON.stringify(ew).replace(/"/g, '&quot;')})" style="padding:6px 10px; font-size:11px; width:auto; height:auto;">Edit</button>
            <button type="button" class="btn btn-red" onclick="panel.deleteEWallet(${ew.id})" style="padding:6px 10px; font-size:11px; width:auto; height:auto; background:#ef4444; color:#fff; border:none; border-radius:4px;">Delete</button>
          </div>
        </div>
      `).join('');
      
    } catch (err) {
      console.error(err);
      this.toast('Network error loading e-wallets.', 'error');
    }
  },

  triggerEWalletLogoUpload() {
    const fileInput = document.getElementById('ewallet-logo-file');
    if (fileInput) fileInput.click();
  },

  async handleEWalletLogoUpload() {
    const fileInput = document.getElementById('ewallet-logo-file');
    if (!fileInput || !fileInput.files[0]) return;
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.filePath) {
        document.getElementById('ewallet-logo-url').value = data.filePath;
        
        const preview = document.getElementById('ewallet-logo-preview');
        const previewWrap = document.getElementById('ewallet-logo-preview-wrap');
        if (preview && previewWrap) {
          preview.src = data.filePath;
          previewWrap.style.display = 'flex';
        }
        
        this.toast('Logo image uploaded successfully!', 'success');
      } else {
        this.toast(data.error || 'Upload failed.', 'error');
      }
    } catch (err) {
      this.toast('Upload error: ' + err.message, 'error');
    }
  },

  startEWalletEdit(ew) {
    document.getElementById('ewallet-edit-id').value = ew.id;
    document.getElementById('ewallet-name').value = ew.name;
    this.setCountrySelect('ewallet-country', ew.country, 'Pakistan');
    document.getElementById('ewallet-holder').value = ew.account_name;
    document.getElementById('ewallet-number').value = ew.account_number;
    document.getElementById('ewallet-iban').value = ew.iban || '';
    document.getElementById('ewallet-logo-url').value = ew.logo_url || '';
    document.getElementById('ewallet-enabled').checked = ew.enabled === 1;
    document.getElementById('ewallet-rate').value = ew.pkr_rate || 283;
    document.getElementById('ewallet-min-deposit').value = ew.min_deposit !== undefined && ew.min_deposit !== null ? ew.min_deposit : 10;
    document.getElementById('ewallet-max-deposit').value = ew.max_deposit !== undefined && ew.max_deposit !== null ? ew.max_deposit : 10000;
    document.getElementById('ewallet-min-withdrawal').value = ew.min_withdrawal !== undefined && ew.min_withdrawal !== null ? ew.min_withdrawal : 10;
    document.getElementById('ewallet-max-withdrawal').value = ew.max_withdrawal !== undefined && ew.max_withdrawal !== null ? ew.max_withdrawal : 10000;
    
    const preview = document.getElementById('ewallet-logo-preview');
    const previewWrap = document.getElementById('ewallet-logo-preview-wrap');
    if (preview && previewWrap) {
      if (ew.logo_url) {
        preview.src = ew.logo_url;
        previewWrap.style.display = 'flex';
      } else {
        previewWrap.style.display = 'none';
      }
    }
    
    document.getElementById('ewallet-form-title').textContent = 'Edit Bank / E-Wallet';
    document.getElementById('ewallet-cancel-btn').style.display = 'inline-block';
  },

  cancelEWalletEdit() {
    document.getElementById('ewallet-edit-id').value = '';
    document.getElementById('ewallet-name').value = '';
    this.setCountrySelect('ewallet-country', 'Pakistan');
    document.getElementById('ewallet-holder').value = '';
    document.getElementById('ewallet-number').value = '';
    document.getElementById('ewallet-iban').value = '';
    document.getElementById('ewallet-logo-url').value = '';
    document.getElementById('ewallet-enabled').checked = true;
    document.getElementById('ewallet-rate').value = 283;
    document.getElementById('ewallet-min-deposit').value = '10';
    document.getElementById('ewallet-max-deposit').value = '10000';
    document.getElementById('ewallet-min-withdrawal').value = '10';
    document.getElementById('ewallet-max-withdrawal').value = '10000';
    document.getElementById('ewallet-logo-preview-wrap').style.display = 'none';
    
    document.getElementById('ewallet-form-title').textContent = 'Add Bank / E-Wallet';
    document.getElementById('ewallet-cancel-btn').style.display = 'none';
  },

  async saveEWalletMethod() {
    const editId = document.getElementById('ewallet-edit-id').value;
    const name = document.getElementById('ewallet-name').value.trim();
    const country = (document.getElementById('ewallet-country')?.value || '').trim() || 'Pakistan';
    const holder = document.getElementById('ewallet-holder').value.trim();
    const number = document.getElementById('ewallet-number').value.trim();
    const iban = document.getElementById('ewallet-iban').value.trim();
    const logo_url = document.getElementById('ewallet-logo-url').value.trim();
    const enabled = document.getElementById('ewallet-enabled').checked ? 1 : 0;
    const pkr_rate = parseInt(document.getElementById('ewallet-rate').value.trim()) || 283;
    const min_deposit = parseFloat(document.getElementById('ewallet-min-deposit').value.trim()) || 0;
    const max_deposit = parseFloat(document.getElementById('ewallet-max-deposit').value.trim()) || 0;
    const min_withdrawal = parseFloat(document.getElementById('ewallet-min-withdrawal').value.trim()) || 0;
    const max_withdrawal = parseFloat(document.getElementById('ewallet-max-withdrawal').value.trim()) || 0;
    
    if (!name || !holder || !number) {
      this.toast('Wallet Name, Account Holder Name, and Account Number are required.', 'error');
      return;
    }
    
    const payload = { 
      name, 
      country,
      account_name: holder, 
      account_number: number, 
      iban, 
      logo_url, 
      enabled, 
      pkr_rate,
      min_deposit,
      max_deposit,
      min_withdrawal,
      max_withdrawal
    };
    
    try {
      const url = editId ? `/api/admin/e-wallets/${editId}` : '/api/admin/e-wallets';
      const method = editId ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`E-Wallet ${editId ? 'updated' : 'added'} successfully.`, 'success');
        this.cancelEWalletEdit();
        this.loadEWallets();
      } else {
        this.toast(data.error || 'Failed to save e-wallet method.', 'error');
      }
    } catch (err) {
      this.toast('Network error saving e-wallet.', 'error');
    }
  },

  async deleteEWallet(id) {
    if (!confirm('Are you sure you want to delete this e-wallet method?')) return;
    try {
      const res = await fetch(`/api/admin/e-wallets/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('E-Wallet method deleted.', 'success');
        this.loadEWallets();
      } else {
        this.toast(data.error || 'Failed to delete.', 'error');
      }
    } catch (err) {
      this.toast('Network error deleting e-wallet.', 'error');
    }
  },

  async saveDocumentDescriptions(e) {
    e.preventDefault();
    const settings = {
      terms_description: document.getElementById('setting-terms-description').value,
      policy_description: document.getElementById('setting-policy-description').value,
      faq_description: document.getElementById('setting-faq-description').value,
      auth_description: document.getElementById('setting-auth-description').value,
      risk_description: document.getElementById('setting-risk-description').value,
      aml_description: document.getElementById('setting-aml-description').value,
      contact_description: document.getElementById('setting-contact-description').value,
      kyc_description: document.getElementById('setting-kyc-description').value,
      refund_policy_description: document.getElementById('setting-refund-policy-description').value,
      shipping_policy_description: document.getElementById('setting-shipping-policy-description').value,
      office_address: document.getElementById('setting-office-address').value,
      office_number: document.getElementById('setting-office-number').value
    };
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Document descriptions updated successfully.', 'success');
      } else {
        this.toast(data.error || 'Failed to save descriptions.', 'error');
      }
    } catch(err) {
      this.toast('Network error.', 'error');
    }
  },

  triggerBalanceBgUpload(type) {
    const fileInput = document.getElementById(`balance-bg-file-${type}`);
    if (fileInput) fileInput.click();
  },

  async handleBalanceBgUpload(type) {
    const fileInput = document.getElementById(`balance-bg-file-${type}`);
    if (!fileInput || !fileInput.files[0]) return;
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.filePath) {
        const inputEl = document.getElementById(`setting-balance-card-bg-${type}`);
        const prevEl = document.getElementById(`balance-bg-preview-${type}`);
        const wrapEl = document.getElementById(`balance-bg-preview-wrap-${type}`);
        if (inputEl) inputEl.value = data.filePath;
        if (prevEl) prevEl.src = data.filePath;
        if (wrapEl) wrapEl.style.display = 'block';
        this.toast(`${type === 'mobile' ? 'Mobile' : 'Desktop'} image uploaded! Click Save Settings to apply.`, 'success');
      } else {
        this.toast(data.error || 'Upload failed.', 'error');
      }
    } catch (err) {
      this.toast('Upload error: ' + err.message, 'error');
    }
  },

  async handleBinanceQRUpload() {
    const fileInput = document.getElementById('binance-qr-file');
    if (!fileInput || !fileInput.files[0]) return;
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.filePath) {
        document.getElementById('setting-binance-qr-url').value = data.filePath;
        const prevEl = document.getElementById('binance-qr-preview');
        const wrapEl = document.getElementById('binance-qr-preview-wrap');
        if (prevEl) prevEl.src = data.filePath;
        if (wrapEl) wrapEl.style.display = 'block';
        this.toast('Binance QR code uploaded! Click Save Settings to apply.', 'success');
      } else {
        this.toast(data.error || 'Upload failed.', 'error');
      }
    } catch (err) {
      this.toast('Upload error: ' + err.message, 'error');
    }
  },

  async saveOnboardingSlides() {
    const slides = [];
    document.querySelectorAll('.onboarding-slide-editor').forEach((el, i) => {
      slides.push({
        title: el.querySelector('.slide-title').value.trim(),
        description: el.querySelector('.slide-desc').value.trim(),
        image: el.querySelector('.slide-image').value.trim()
      });
    });
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarding_slides: JSON.stringify(slides) })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Onboarding slides saved successfully!', 'success');
      } else {
        this.toast(data.error || 'Failed to save onboarding slides.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  triggerSlideUpload(index) {
    const input = document.getElementById(`slide-file-${index}`);
    if (input) input.click();
  },

  async handleSlideUpload(index) {
    const input = document.getElementById(`slide-file-${index}`);
    if (!input || !input.files[0]) return;
    
    const file = input.files[0];
    
    // Validate file type and size
    if (!file.type.startsWith('image/')) {
      this.toast('Please select a valid image file.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.toast('Image must be under 5MB.', 'error');
      return;
    }

    // Show loading state on the Upload button
    const editors = document.querySelectorAll('.onboarding-slide-editor');
    const editor = editors[index];
    const btn = editor ? editor.querySelector('button') : null;
    if (btn) {
      btn.textContent = 'Uploading...';
      btn.disabled = true;
    }

    try {
      const formData = new FormData();
      formData.append('image', file);

      const res = await fetch('/api/admin/upload-onboarding-image', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.filePath) {
        // Update the hidden URL field
        const urlInput = editor ? editor.querySelector('.slide-image') : null;
        if (urlInput) urlInput.value = data.filePath;

        // Show preview
        const preview = document.getElementById(`slide-preview-${index}`);
        const previewContainer = document.getElementById(`slide-preview-container-${index}`);
        if (preview) {
          preview.src = data.filePath;
        }
        if (previewContainer) {
          previewContainer.style.display = 'block';
        }

        this.toast(`Slide ${index + 1} image uploaded!`, 'success');
      } else {
        this.toast(data.error || 'Upload failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error during upload.', 'error');
    } finally {
      if (btn) {
        btn.textContent = 'Upload Image';
        btn.disabled = false;
      }
      // Reset file input so same file can be re-selected if needed
      if (input) input.value = '';
    }
  },

  async adjustBalance() {
    const userId = document.getElementById('bal-user-id').value.trim();
    const target = document.getElementById('bal-target').value;
    const action = document.getElementById('bal-action').value;
    const amount = parseFloat(document.getElementById('bal-amount').value);
    const note = document.getElementById('bal-note').value.trim();

    if (!userId || isNaN(amount) || amount <= 0) {
      this.toast('Please fill in all balance adjustment fields.', 'error');
      return;
    }

    try {
      const res = await fetch(`/api/admin/users/${userId}/balance`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, amount, note, target })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Balance ${action === 'add' ? 'added' : 'subtracted'} successfully. New balance: $${data.new_balance.toFixed(2)}`, 'success');
        document.getElementById('bal-user-id').value = '';
        document.getElementById('bal-amount').value = '';
        document.getElementById('bal-note').value = '';
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== TRADE OPTIONS ====================
  async loadTradeOptions() {
    const tbody = document.getElementById('trade-options-body');
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading...</td></tr>`;
    try {
      const res = await fetch('/api/admin/trade-options', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error, 'error'); return; }
      const opts = data.trade_options || [];

      if (!opts.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">No trade options.</td></tr>`;
        return;
      }

      tbody.innerHTML = opts.map(o => {
        const dur = o.duration;
        let display = dur >= 60 ? `${dur/60} min` : `${dur}s`;
        if (dur === 300) display = '5 min';
        if (dur === 120) display = '2 min';
        return `
        <tr>
          <td>#${o.id}</td>
          <td style="font-weight:600;">${dur}s</td>
          <td style="color:var(--text-sec);">${display}</td>
          <td>
            <div class="action-btns">
              <button class="btn-action btn-info" onclick="panel.editTradeOption(${o.id}, ${dur}, ${o.commission_pct})">Edit</button>
              <button class="btn-action btn-reject" onclick="panel.deleteTradeOption(${o.id})">Delete</button>
            </div>
          </td>
        </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">Error.</td></tr>`;
    }
    this.loadPayoutSettings();
  },

  async loadPayoutSettings() {
    const tbody = document.getElementById('payout-settings-body');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading...</td></tr>`;
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) return;
      const s = data.settings || {};

      // Load interval
      const intervalInput = document.getElementById('setting-payout-interval');
      if (intervalInput) {
        intervalInput.value = s.payout_randomize_interval || '10';
      }

      // Load asset payouts
      let payoutSettings = {};
      try { payoutSettings = JSON.parse(s.asset_payout_settings || '{}'); } catch(e) {}

      // Get all coins from settings or fallback
      let visibleCoins = [];
      try { visibleCoins = JSON.parse(s.crypto_visible_coins || '[]'); } catch(e) {}
      if (!visibleCoins.length) visibleCoins = ['BTC','ETH','SOL','BNB','DOGE','XRP','ADA','AVAX','MATIC','LINK','LTC','DOT','TRX','UNI','ATOM'];
      
      let forexVisible = [];
      try { forexVisible = JSON.parse(s.forex_visible_pairs || '[]'); } catch(e) {}
      if (!forexVisible.length) forexVisible = ['EUR/USD', 'USD/CAD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];

      const allAssets = [...visibleCoins.map(c => `${c}/USDT`), ...forexVisible];

      tbody.innerHTML = allAssets.map(asset => {
        const item = payoutSettings[asset] || { min: 75, max: 95, current: 85 };
        // Save back if not set so inputs are clean
        if (!payoutSettings[asset]) payoutSettings[asset] = item;
        const idSafe = asset.replace('/', '_');
        
        return `
          <tr>
            <td style="font-weight:700; color:var(--accent);">${asset}</td>
            <td>
              <input type="number" id="min-payout-${idSafe}" class="form-control" style="width:90px; display:inline-block;" value="${item.min}" min="0" max="100">
            </td>
            <td>
              <input type="number" id="max-payout-${idSafe}" class="form-control" style="width:90px; display:inline-block;" value="${item.max}" min="0" max="100">
            </td>
            <td>
              <strong style="color:var(--green); font-size:1.1rem;">${item.current}%</strong>
            </td>
            <td>
              <button class="btn btn-primary btn-sm" onclick="panel.saveAssetPayout('${asset}')" style="padding:6px 12px; font-size:12px;">Save</button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Error loading payout settings.</td></tr>`;
    }
  },

  async savePayoutInterval() {
    const val = parseInt(document.getElementById('setting-payout-interval').value);
    if (isNaN(val) || val < 1) {
      this.toast('Interval must be at least 1 minute.', 'error');
      return;
    }
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ payout_randomize_interval: String(val) })
      });
      if (res.ok) {
        this.toast('Randomize interval saved successfully.', 'success');
      } else {
        this.toast('Failed to save interval.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async saveAssetPayout(asset) {
    const idSafe = asset.replace('/', '_');
    const minVal = parseInt(document.getElementById(`min-payout-${idSafe}`).value);
    const maxVal = parseInt(document.getElementById(`max-payout-${idSafe}`).value);

    if (isNaN(minVal) || isNaN(maxVal) || minVal < 0 || maxVal > 100 || minVal > maxVal) {
      this.toast('Invalid range. Min must be >= 0, Max must be <= 100, and Min <= Max.', 'error');
      return;
    }

    try {
      const getRes = await fetch('/api/admin/settings', { credentials: 'include' });
      const getData = await getRes.json();
      let payoutSettings = {};
      if (getRes.ok && getData.settings && getData.settings.asset_payout_settings) {
        try { payoutSettings = JSON.parse(getData.settings.asset_payout_settings); } catch(e) {}
      }

      const currentVal = payoutSettings[asset] ? (payoutSettings[asset].current || 85) : 85;
      payoutSettings[asset] = {
        min: minVal,
        max: maxVal,
        current: Math.max(minVal, Math.min(maxVal, currentVal))
      };

      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ asset_payout_settings: JSON.stringify(payoutSettings) })
      });
      if (res.ok) {
        this.toast(`Payout range for ${asset} saved successfully.`, 'success');
        this.loadPayoutSettings();
      } else {
        this.toast('Failed to save payout settings.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  showAddTradeOption() {
    document.getElementById('trade-option-modal-title').textContent = 'Add Trade Option';
    document.getElementById('trade-option-id').value = '';
    document.getElementById('trade-option-duration').value = '';
    document.getElementById('trade-option-commission').value = '0';
    document.getElementById('trade-option-duration').disabled = false;
    this.openModal('trade-option-modal');
  },

  editTradeOption(id, duration, commission) {
    document.getElementById('trade-option-modal-title').textContent = 'Edit Trade Option';
    document.getElementById('trade-option-id').value = id;
    document.getElementById('trade-option-duration').value = duration;
    document.getElementById('trade-option-duration').disabled = true; // Duration is unique key, can't change
    document.getElementById('trade-option-commission').value = commission !== undefined ? commission : '0';
    this.openModal('trade-option-modal');
  },

  async saveTradeOption() {
    const id = document.getElementById('trade-option-id').value;
    const duration = parseInt(document.getElementById('trade-option-duration').value);
    const commission_pct = parseFloat(document.getElementById('trade-option-commission').value) || 0;

    if (isNaN(duration) || isNaN(commission_pct)) {
      this.toast('Please fill in all fields.', 'error');
      return;
    }

    try {
      let res;
      if (id) {
        // Update
        res = await fetch(`/api/admin/trade-options/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ commission_pct })
        });
      } else {
        // Create
        res = await fetch('/api/admin/trade-options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ duration, commission_pct })
        });
      }
      const data = await res.json();
      if (res.ok) {
        this.toast(id ? 'Trade option updated.' : 'Trade option created.', 'success');
        this.closeModal('trade-option-modal');
        this.loadTradeOptions();
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  async deleteTradeOption(id) {
    if (!confirm('Delete this trade option?')) return;
    try {
      const res = await fetch(`/api/admin/trade-options/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Trade option deleted.', 'success');
        this.loadTradeOptions();
      } else {
        this.toast(data.error || 'Failed.', 'error');
      }
    } catch (e) {
      this.toast('Network error.', 'error');
    }
  },

  // ==================== HELPERS ====================
  esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  // Format a balance with the user's real currency symbol
  fmtBal(amount, currency) {
    const SYMBOLS = {
      USD: '$', EUR: '€', GBP: '£', JPY: '¥', PKR: '₨', INR: '₹',
      AED: 'AED ', SAR: 'SAR ', NGN: '₦', TRY: '₺', CAD: 'C$',
      AUD: 'A$', CHF: 'CHF ', CNY: '¥', BRL: 'R$', MXN: 'MX$',
      MYR: 'RM', SGD: 'S$', HKD: 'HK$', KWD: 'KD ', BHD: 'BD ',
      QAR: 'QR ', OMR: 'OMR ', EGP: 'E£', ZAR: 'R ', IDR: 'Rp ',
      THB: '฿', VND: '₫', PHP: '₱', BDT: '৳', KZT: '₸', UAH: '₴',
      KRW: '₩'
    };
    const code = (currency || 'USD').toUpperCase();
    const sym = SYMBOLS[code] || (code + ' ');
    const num = parseFloat(amount || 0);
    return sym + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  async updateStatsBadge() {
    // Silently refresh dashboard stats
    try {
      const res = await fetch('/api/admin/stats', { credentials: 'include' });
      if (res.ok) {
        const stats = await res.json();
        document.getElementById('stat-pending-deposits').textContent = stats.pending_deposits ?? '--';
        document.getElementById('stat-pending-withdrawals').textContent = stats.pending_withdrawals ?? '--';
      }
    } catch (e) {}
  },

  currencyRates: {},

  renderCurrencyRatesTable() {
    const tbody = document.getElementById('currency-rates-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    const sortedCodes = Object.keys(this.currencyRates).sort();

    sortedCodes.forEach(code => {
      const rate = this.currencyRates[code];
      const isUsd = code === 'USD';
      
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      
      tr.innerHTML = `
        <td style="padding: 10px 12px; font-weight: 700; color: var(--text);">${code}</td>
        <td style="padding: 10px 12px;">
          <input type="number" step="any" class="form-control currency-rate-input" data-code="${code}" value="${rate}" ${isUsd ? 'disabled' : ''} style="width: 150px; height: 32px; font-size: 13px; background: #ffffff; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px;">
        </td>
        <td style="padding: 10px 12px; text-align: center;">
          <button type="button" class="btn btn-secondary" onclick="panel.deleteCurrencyRate('${code}')" ${isUsd ? 'disabled' : ''} style="padding: 4px 8px; font-size: 11px; width: auto; background: var(--danger); border-color: var(--danger); color: #fff; border-radius: 4px;">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  },

  addNewCurrencyRow(e) {
    e.preventDefault();
    const codeEl = document.getElementById('new-currency-code');
    const rateEl = document.getElementById('new-currency-rate');
    if (!codeEl || !rateEl) return;

    const code = codeEl.value.trim().toUpperCase();
    const rate = parseFloat(rateEl.value);

    if (!code || isNaN(rate) || rate <= 0) {
      this.toast('Please enter a valid currency code and positive exchange rate.', 'error');
      return;
    }

    this.currencyRates[code] = rate;
    codeEl.value = '';
    rateEl.value = '';
    this.renderCurrencyRatesTable();
    this.toast(`Added ${code} rate locally. Click Save Currency Rates to apply.`, 'success');
  },

  async deleteCurrencyRate(code) {
    if (code === 'USD') {
      this.toast('USD rate is protected and cannot be deleted.', 'error');
      return;
    }
    if (confirm(`Are you sure you want to delete the exchange rate for ${code}? This will remove it from the platform.`)) {
      try {
        const res = await fetch(`/api/admin/settings/currency_rate_${code}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        const data = await res.json();
        if (res.ok) {
          delete this.currencyRates[code];
          this.renderCurrencyRatesTable();
          this.toast(`Deleted ${code} exchange rate successfully.`, 'success');
          this.loadSettings();
        } else {
          this.toast(data.error || 'Failed to delete currency rate.', 'error');
        }
      } catch (e) {
        this.toast('Network error deleting currency rate.', 'error');
      }
    }
  },

  async saveCurrencyRates() {
    const inputs = document.querySelectorAll('.currency-rate-input');
    const settingsPayload = {};
    
    inputs.forEach(input => {
      const code = input.getAttribute('data-code');
      const val = parseFloat(input.value);
      if (code && !isNaN(val) && val > 0) {
        settingsPayload[`currency_rate_${code}`] = val;
      }
    });

    settingsPayload['currency_rate_USD'] = 1.0;

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(settingsPayload)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Currency exchange rates saved successfully.', 'success');
        this.loadSettings();
      } else {
        this.toast(data.error || 'Failed to save exchange rates.', 'error');
      }
    } catch (e) {
      this.toast('Network error saving currency rates.', 'error');
    }
  },

  addMilestoneField(data = { milestone: '', days: '', min_volume: '', bonus: '' }) {
    const container = document.getElementById('bonus-milestones-container');
    if (!container) return;

    const card = document.createElement('div');
    card.className = 'milestone-config-card';
    card.style = 'background: rgba(16, 185, 129, 0.03); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)) auto; gap: 15px; align-items: flex-end; margin-bottom: 10px;';

    card.innerHTML = `
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label" style="font-size: 11px;">Milestone Tier (#)</label>
        <input type="number" class="form-control milestone-tier-input" value="${data.milestone}" min="1" placeholder="e.g. 1" required style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label" style="font-size: 11px;">Consecutive Days</label>
        <input type="number" class="form-control milestone-days-input" value="${data.days}" min="1" placeholder="e.g. 14" required style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label" style="font-size: 11px;">Min Daily Volume (USD)</label>
        <input type="number" class="form-control milestone-vol-input" value="${data.min_volume}" min="0.01" step="0.01" placeholder="e.g. 5.00" required style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label" style="font-size: 11px;">Bonus Reward (USD)</label>
        <input type="number" class="form-control milestone-reward-input" value="${data.bonus}" min="0.01" step="0.01" placeholder="e.g. 10.00" required style="height:34px;">
      </div>
      <div style="text-align: right; flex-shrink: 0; padding-bottom: 2px;">
        <button type="button" class="btn" onclick="this.closest('.milestone-config-card').remove()" style="height: 34px; padding: 0 12px; background: rgba(239,68,68,0.1); color: var(--danger); border: 1px solid rgba(239,68,68,0.2); border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='var(--danger)';this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.1)';this.style.color='var(--danger)';">
          🗑️ Delete
        </button>
      </div>
    `;
    container.appendChild(card);
  },

  addBadgeConfigRow(data = { key: '', name: '', icon: '', volume_threshold: '', bonus_amount: '' }) {
    const container = document.getElementById('badge-config-container');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'badge-config-row';
    row.style = 'display: grid; grid-template-columns: 80px 1fr 60px 1fr 1fr auto; gap: 10px; align-items: flex-end; background: rgba(16,185,129,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 12px;';
    row.innerHTML = `
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="font-size:11px;">Key (unique)</label>
        <input type="text" class="form-control badge-key-input" value="${this.esc(data.key)}" placeholder="e.g. trader" style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="font-size:11px;">Badge Name</label>
        <input type="text" class="form-control badge-name-input" value="${this.esc(data.name)}" placeholder="e.g. Trader Badge" style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="font-size:11px;">Icon</label>
        <input type="text" class="form-control badge-icon-input" value="${this.esc(data.icon)}" placeholder="🏅" style="height:34px; font-size:18px; text-align:center;">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="font-size:11px;">Vol. Threshold ($)</label>
        <input type="number" class="form-control badge-vol-input" value="${data.volume_threshold}" min="0.01" step="0.01" placeholder="e.g. 100" style="height:34px;">
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label class="form-label" style="font-size:11px;">Bonus Reward ($)</label>
        <input type="number" class="form-control badge-bonus-input" value="${data.bonus_amount}" min="0.01" step="0.01" placeholder="e.g. 5.00" style="height:34px;">
      </div>
      <div style="padding-bottom: 2px; flex-shrink:0;">
        <button type="button" class="btn" onclick="this.closest('.badge-config-row').remove()" style="height:34px; padding:0 12px; background:rgba(239,68,68,0.1); color:var(--danger); border:1px solid rgba(239,68,68,0.2); border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;" onmouseover="this.style.background='var(--danger)';this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.1)';this.style.color='var(--danger)';">
          🗑️
        </button>
      </div>
    `;
    container.appendChild(row);
  },

  async saveBadgeConfig() {
    const container = document.getElementById('badge-config-container');
    if (!container) return;
    const rows = container.querySelectorAll('.badge-config-row');
    const payload = [];
    for (const row of rows) {
      const key = row.querySelector('.badge-key-input').value.trim().toLowerCase().replace(/\s+/g, '_');
      const name = row.querySelector('.badge-name-input').value.trim();
      const icon = row.querySelector('.badge-icon-input').value.trim();
      const volume_threshold = parseFloat(row.querySelector('.badge-vol-input').value);
      const bonus_amount = parseFloat(row.querySelector('.badge-bonus-input').value);
      if (!key || !name || isNaN(volume_threshold) || isNaN(bonus_amount)) {
        this.toast('All badge fields are required and must be valid.', 'error'); return;
      }
      payload.push({ key, name, icon, volume_threshold, bonus_amount });
    }
    try {
      const res = await fetch('/api/admin/badge-bonuses/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ badges: payload })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Badge configuration saved successfully!', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to save badge config.', 'error');
      }
    } catch(e) {
      this.toast('Network error saving badge config.', 'error');
    }
  },

  async loadBadgeBonuses() {
    try {
      const res = await fetch('/api/admin/badge-bonuses', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error || 'Failed to load badge data', 'error'); return; }

      // Populate badge config editor
      const container = document.getElementById('badge-config-container');
      if (container) {
        container.innerHTML = '';
        const badges = data.badges || [];
        if (badges.length > 0) {
          for (const b of badges) this.addBadgeConfigRow(b);
        } else {
          this.addBadgeConfigRow();
        }
      }

      // Pending badge claims
      const pendingTbody = document.getElementById('badge-pending-body');
      if (pendingTbody) {
        if (!data.pendingClaims || data.pendingClaims.length === 0) {
          pendingTbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No pending badge bonus claims.</td></tr>`;
        } else {
          pendingTbody.innerHTML = data.pendingClaims.map(claim => {
            const dateStr = new Date(claim.created_at).toLocaleString();
            return `
              <tr>
                <td style="padding-left:16px; padding-top:12px; padding-bottom:12px;">
                  <div style="font-weight:700; color:#fff;">${this.esc(claim.username)}</div>
                  <div style="font-size:11px; color:var(--text-sec);">${this.esc(claim.email)}</div>
                </td>
                <td>
                  <div style="font-weight:700; color:#fff;">${this.esc(claim.badge_name)}</div>
                  <div style="font-size:11px; color:var(--text-sec);">Vol: $${Number(claim.volume_threshold).toLocaleString()}</div>
                </td>
                <td style="font-weight:700; color:var(--primary);">$${Number(claim.bonus_amount).toFixed(2)}</td>
                <td style="font-size:12px; color:var(--text-sec);">${dateStr}</td>
                <td style="text-align:right; padding-right:16px;">
                  <button class="btn btn-primary" onclick="panel.approveBadgeClaim(${claim.id})" style="padding:4px 10px; font-size:12px; width:auto; border-radius:4px; margin-right:4px;">Approve</button>
                  <button class="btn" onclick="panel.rejectBadgeClaim(${claim.id})" style="padding:4px 10px; font-size:12px; width:auto; border-radius:4px; background:rgba(239,68,68,0.1); color:var(--danger); border:1px solid rgba(239,68,68,0.2);" onmouseover="this.style.background='var(--danger)';this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.1)';this.style.color='var(--danger)';">Reject</button>
                </td>
              </tr>`;
          }).join('');
        }
      }

      // Resolved badge claims history
      const historyTbody = document.getElementById('badge-history-body');
      if (historyTbody) {
        if (!data.resolvedClaims || data.resolvedClaims.length === 0) {
          historyTbody.innerHTML = `<tr><td colspan="6" class="loading-cell">No badge claim history.</td></tr>`;
        } else {
          historyTbody.innerHTML = data.resolvedClaims.map(claim => {
            const dateStr = new Date(claim.resolved_at || claim.created_at).toLocaleString();
            const statusColor = claim.status === 'approved' ? 'var(--primary)' : 'var(--danger)';
            const statusBg = claim.status === 'approved' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
            return `
              <tr>
                <td style="padding-left:16px; padding-top:10px; padding-bottom:10px;">
                  <div style="font-weight:700; color:#fff;">${this.esc(claim.username)}</div>
                  <div style="font-size:11px; color:var(--text-sec);">${this.esc(claim.email)}</div>
                </td>
                <td>${this.esc(claim.badge_name)}</td>
                <td style="font-weight:700; color:${claim.status === 'approved' ? 'var(--primary)' : 'var(--text-sec)'};">$${Number(claim.bonus_amount).toFixed(2)}</td>
                <td>
                  <span class="badge" style="background:${statusBg}; color:${statusColor}; font-weight:700; border:1px solid currentColor; padding:2px 8px; border-radius:4px; font-size:11px;">${claim.status.toUpperCase()}</span>
                </td>
                <td style="font-size:12px; color:var(--text-sec);">${dateStr}</td>
                <td style="padding-right:16px;">${this.esc(claim.resolved_by_username || 'System')}</td>
              </tr>`;
          }).join('');
        }
      }
    } catch(e) {
      console.error('Error loading badge bonuses:', e);
      this.toast('Network error loading badge bonuses.', 'error');
    }
  },

  async approveBadgeClaim(claimId) {
    if (!confirm('Approve this badge bonus claim and credit the reward to the user?')) return;
    try {
      const res = await fetch(`/api/admin/badge-bonuses/claims/${claimId}/approve`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Badge bonus approved!', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to approve badge claim.', 'error');
      }
    } catch(e) { this.toast('Network error.', 'error'); }
  },

  async rejectBadgeClaim(claimId) {
    if (!confirm('Reject this badge bonus claim?')) return;
    try {
      const res = await fetch(`/api/admin/badge-bonuses/claims/${claimId}/reject`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Badge claim rejected.', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to reject badge claim.', 'error');
      }
    } catch(e) { this.toast('Network error.', 'error'); }
  },

  async loadBonuses() {
    // Load badge bonuses (config + pending + resolved)
    await this.loadBadgeBonuses();

    try {
      const res = await fetch('/api/admin/bonuses', { credentials: 'include' });
      const data = await res.json();

      if (!res.ok) {
        this.toast(data.error || 'Failed to load bonus data', 'error');
        return;
      }

      const container = document.getElementById('bonus-milestones-container');
      if (container) {
        container.innerHTML = '';
        if (data.criteria && data.criteria.length > 0) {
          const sortedCriteria = [...data.criteria].sort((a, b) => a.milestone - b.milestone);
          for (const item of sortedCriteria) {
            this.addMilestoneField(item);
          }
        } else {
          this.addMilestoneField();
        }
      }

      const pendingTbody = document.getElementById('bonus-pending-body');
      if (pendingTbody) {
        if (!data.pendingClaims || data.pendingClaims.length === 0) {
          pendingTbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No pending bonus claims found.</td></tr>`;
        } else {
          pendingTbody.innerHTML = data.pendingClaims.map(claim => {
            const dateStr = new Date(claim.created_at).toLocaleString();
            return `
              <tr>
                <td style="padding-left:16px; padding-top: 12px; padding-bottom: 12px;">
                  <div style="font-weight: 700; color: #fff;">${this.esc(claim.username)}</div>
                  <div style="font-size: 11px; color: var(--text-sec);">${this.esc(claim.email)}</div>
                </td>
                <td>
                  <span class="badge" style="background: ${claim.milestone === 1 ? 'rgba(16,185,129,0.1)' : claim.milestone === 2 ? 'rgba(59,130,246,0.1)' : 'rgba(167,139,250,0.1)'}; color: ${claim.milestone === 1 ? 'var(--primary)' : claim.milestone === 2 ? '#60a5fa' : '#a78bfa'}; font-weight:700; border: 1px solid currentColor; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
                    Milestone ${claim.milestone}
                  </span>
                </td>
                <td>
                  <div style="font-size:13px; font-weight:600; color: #fff;">Streak: ${claim.days} Days</div>
                  <div style="font-size:11px; color:var(--text-sec);">Min Vol: $${claim.min_volume}/day | Bonus: $${claim.bonus}</div>
                </td>
                <td style="font-size:12px; color:var(--text-sec);">${dateStr}</td>
                <td style="text-align:right; padding-right:16px;">
                  <button class="btn btn-primary" onclick="panel.approveBonusClaim(${claim.id})" style="padding:4px 10px; font-size:12px; width:auto; border-radius:4px; margin-right:4px;">Approve</button>
                  <button class="btn" onclick="panel.rejectBonusClaim(${claim.id})" style="padding:4px 10px; font-size:12px; width:auto; border-radius:4px; background:rgba(239,68,68,0.1); color:var(--danger); border:1px solid rgba(239,68,68,0.2);" onmouseover="this.style.background='var(--danger)';this.style.color='#fff';" onmouseout="this.style.background='rgba(239,68,68,0.1)';this.style.color='var(--danger)';">Reject</button>
                </td>
              </tr>
            `;
          }).join('');
        }
      }

      const historyTbody = document.getElementById('bonus-history-body');
      if (historyTbody) {
        if (!data.resolvedClaims || data.resolvedClaims.length === 0) {
          historyTbody.innerHTML = `<tr><td colspan="6" class="loading-cell">No history records found.</td></tr>`;
        } else {
          historyTbody.innerHTML = data.resolvedClaims.map(claim => {
            const dateStr = new Date(claim.resolved_at || claim.created_at).toLocaleString();
            const statusColor = claim.status === 'approved' ? 'var(--primary)' : 'var(--danger)';
            const statusBg = claim.status === 'approved' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
            return `
              <tr>
                <td style="padding-left:16px; padding-top: 10px; padding-bottom: 10px;">
                  <div style="font-weight: 700; color: #fff;">${this.esc(claim.username)}</div>
                  <div style="font-size: 11px; color: var(--text-sec);">${this.esc(claim.email)}</div>
                </td>
                <td>Milestone ${claim.milestone} (${claim.days} Days)</td>
                <td style="font-weight:700; color: ${claim.status === 'approved' ? 'var(--primary)' : 'var(--text-sec)'}">$${claim.bonus}</td>
                <td>
                  <span class="badge" style="background: ${statusBg}; color: ${statusColor}; font-weight:700; border: 1px solid currentColor; padding: 2px 8px; border-radius: 4px; font-size: 11px;">
                    ${claim.status.toUpperCase()}
                  </span>
                </td>
                <td style="font-size:12px; color:var(--text-sec);">${dateStr}</td>
                <td style="padding-right:16px;">${this.esc(claim.resolved_by_username || 'System')}</td>
              </tr>
            `;
          }).join('');
        }
      }

    } catch (e) {
      console.error('Error loading bonuses:', e);
      this.toast('Network error loading daily bonuses.', 'error');
    }
  },

  async saveBonusCriteria(e) {
    if (e) e.preventDefault();
    const container = document.getElementById('bonus-milestones-container');
    if (!container) return;

    const cards = container.querySelectorAll('.milestone-config-card');
    const payload = [];

    for (const card of cards) {
      const milestone = parseInt(card.querySelector('.milestone-tier-input').value);
      const days = parseInt(card.querySelector('.milestone-days-input').value);
      const min_volume = parseFloat(card.querySelector('.milestone-vol-input').value);
      const bonus = parseFloat(card.querySelector('.milestone-reward-input').value);

      if (isNaN(milestone) || isNaN(days) || isNaN(min_volume) || isNaN(bonus)) {
        this.toast('All milestone fields are required and must be valid numbers.', 'error');
        return;
      }

      payload.push({ milestone, days, min_volume, bonus });
    }

    payload.sort((a, b) => a.milestone - b.milestone);

    try {
      const res = await fetch('/api/admin/bonuses/criteria', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ criteria: payload })
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('Milestone requirements saved successfully.', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to save milestone requirements.', 'error');
      }
    } catch (err) {
      this.toast('Network error saving milestone rules.', 'error');
    }
  },

  async approveBonusClaim(claimId) {
    if (!confirm('Are you sure you want to approve this daily bonus claim and credit the reward?')) return;
    try {
      const res = await fetch(`/api/admin/bonuses/claims/${claimId}/approve`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Daily bonus approved successfully.', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to approve bonus claim.', 'error');
      }
    } catch (err) {
      this.toast('Network error approving bonus claim.', 'error');
    }
  },

  async rejectBonusClaim(claimId) {
    if (!confirm('Are you sure you want to reject this daily bonus claim?')) return;
    try {
      const res = await fetch(`/api/admin/bonuses/claims/${claimId}/reject`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(data.message || 'Daily bonus claim rejected.', 'success');
        this.loadBonuses();
      } else {
        this.toast(data.error || 'Failed to reject bonus claim.', 'error');
      }
    } catch (err) {
      this.toast('Network error rejecting bonus claim.', 'error');
    }
  },

  // ==================== EMAIL EVENTS ====================
  _emailPreviewTimer: null,
  _emailAllUsers: [],
  _emailSelectedIds: new Set(),

  loadEmailEvents() {
    const editor = document.getElementById('email-html-editor');
    if (!editor._listenerAttached) {
      editor.addEventListener('input', () => this.updateEmailPreview());
      editor._listenerAttached = true;
    }
    this.updateEmailPreview();
    this.loadScheduledEmails();
  },

  updateEmailPreview() {
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
  },

  _validateEmailForm() {
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
  },

  async sendEmailToAll() {
    const formData = this._validateEmailForm();
    if (!formData) return;

    let userCount = '?';
    try {
      const countRes = await fetch('/api/admin/users', { credentials: 'include' });
      const countData = await countRes.json();
      userCount = (countData.users || countData).filter(u => u.status === 'active' && u.email).length;
    } catch(e) {}

    if (!confirm(`⚠️ BROADCAST EMAIL\n\nThis will send the email to ALL ${userCount} active users.\n\nSubject: "${formData.subject}"\n\nAre you absolutely sure?`)) {
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
        this.toast(`✅ Broadcast complete! Sent: ${data.sent}, Failed: ${data.failed}`, 'success');
      } else {
        this.toast(data.error || 'Failed to send emails.', 'error');
      }
    } catch (err) {
      this.toast('Network error sending emails.', 'error');
    } finally {
      progress.style.display = 'none';
    }
  },

  async openEmailUserSelector() {
    const formData = this._validateEmailForm();
    if (!formData) return;

    this.isScheduling = false;
    this._emailSelectedIds.clear();
    this.openModal('email-select-users-modal');
    document.getElementById('email-user-search').value = '';
    document.getElementById('email-send-selected-btn').setAttribute('onclick', 'panel.sendEmailToSelected()');
    this._updateEmailSelectionUI();

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
  },

  _renderEmailUserList(users) {
    const listEl = document.getElementById('email-user-list');
    if (!users.length) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:30px;">No users found.</div>';
      return;
    }
    listEl.innerHTML = users.map(u => {
      const checked = this._emailSelectedIds.has(u.id) ? 'checked' : '';
      const selectedClass = this._emailSelectedIds.has(u.id) ? ' selected' : '';
      const displayName = u.full_name || u.username || 'Unknown';
      const emailTrunc = (u.email || '').length > 30 ? u.email.substring(0, 27) + '...' : u.email;
      return `<div class="email-user-item${selectedClass}" onclick="panel.toggleEmailUser(${u.id}, this)">
        <input type="checkbox" ${checked} onclick="event.stopPropagation(); panel.toggleEmailUser(${u.id}, this.parentElement)">
        <div class="user-info">
          <div class="username">${displayName}</div>
          <div class="user-email">${emailTrunc}</div>
        </div>
      </div>`;
    }).join('');
  },

  searchEmailUsers(query) {
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
  },

  toggleEmailUser(id, rowEl) {
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
  },

  clearEmailSelection() {
    this._emailSelectedIds.clear();
    document.querySelectorAll('.email-user-item').forEach(el => {
      el.classList.remove('selected');
      const cb = el.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = false;
    });
    this._updateEmailSelectionUI();
  },

  _updateEmailSelectionUI() {
    const count = this._emailSelectedIds.size;
    document.getElementById('email-selected-count').textContent = count;
    const btn = document.getElementById('email-send-selected-btn');
    if (this.isScheduling) {
      btn.textContent = `Confirm Selection (${count} User${count !== 1 ? 's' : ''})`;
    } else {
      btn.textContent = `Send to ${count} User${count !== 1 ? 's' : ''}`;
    }
    btn.disabled = count === 0;
  },

  async sendEmailToSelected() {
    if (this._emailSelectedIds.size === 0) return;

    const formData = this._validateEmailForm();
    if (!formData) return;

    const count = this._emailSelectedIds.size;
    if (!confirm(`Send this email to ${count} selected user${count !== 1 ? 's' : ''}?`)) return;

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
        this.toast(`✅ Sent: ${data.sent}, Failed: ${data.failed}`, 'success');
      } else {
        this.toast(data.error || 'Failed to send emails.', 'error');
      }
    } catch (err) {
      this.toast('Network error sending emails.', 'error');
    } finally {
      progress.style.display = 'none';
    }
  },

  _editingScheduleId: null,
  _scheduledEmailsList: [],

  openEmailScheduler() {
    const formData = this._validateEmailForm();
    if (!formData) return;

    this._editingScheduleId = null;
    const titleEl = document.getElementById('email-scheduler-modal-title');
    if (titleEl) titleEl.textContent = '🕒 Schedule Email';

    this.scheduledUserIds = [];
    document.getElementById('schedule-recipient-type').value = 'all';
    document.getElementById('schedule-specific-users-wrap').style.display = 'none';
    document.getElementById('schedule-selected-users-count').textContent = '0';
    document.getElementById('schedule-times-input').value = '';
    
    // Uncheck all days checkboxes
    document.querySelectorAll('input[name="schedule-days"]').forEach(cb => cb.checked = false);

    this.openModal('email-scheduler-modal');
  },

  editScheduledEmail(id) {
    const item = (this._scheduledEmailsList || []).find(x => String(x.id) === String(id));
    if (!item) return;

    this._editingScheduleId = id;
    const titleEl = document.getElementById('email-scheduler-modal-title');
    if (titleEl) titleEl.textContent = '✏️ Edit Scheduled Email';

    // Load subject and HTML into the composer
    document.getElementById('email-subject').value = item.subject || '';
    document.getElementById('email-html-editor').value = item.html_content || '';
    this.updateEmailPreview();

    // Populate recipient type
    const recType = item.recipient_type || 'all';
    document.getElementById('schedule-recipient-type').value = recType;
    
    const wrap = document.getElementById('schedule-specific-users-wrap');
    if (recType === 'specific') {
      wrap.style.display = 'block';
      try {
        this.scheduledUserIds = JSON.parse(item.recipient_ids || '[]');
      } catch (e) {
        this.scheduledUserIds = (item.recipient_ids || '').split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
      }
      document.getElementById('schedule-selected-users-count').textContent = this.scheduledUserIds.length;
    } else {
      wrap.style.display = 'none';
      this.scheduledUserIds = [];
      document.getElementById('schedule-selected-users-count').textContent = '0';
    }

    // Populate days checkboxes
    const activeDays = (item.schedule_days || '').split(',').map(d => d.trim().toLowerCase());
    document.querySelectorAll('input[name="schedule-days"]').forEach(cb => {
      cb.checked = activeDays.includes(cb.value.toLowerCase());
    });

    // Populate times
    document.getElementById('schedule-times-input').value = item.schedule_times || '';

    this.openModal('email-scheduler-modal');
  },

  onScheduleRecipientTypeChange() {
    const type = document.getElementById('schedule-recipient-type').value;
    const wrap = document.getElementById('schedule-specific-users-wrap');
    if (type === 'specific') {
      wrap.style.display = 'block';
    } else {
      wrap.style.display = 'none';
    }
  },

  async openScheduleUserSelector() {
    this.isScheduling = true;
    this.closeModal('email-scheduler-modal');
    this._emailSelectedIds.clear();
    if (this.scheduledUserIds) {
      this.scheduledUserIds.forEach(id => this._emailSelectedIds.add(id));
    }
    this.openModal('email-select-users-modal');
    document.getElementById('email-user-search').value = '';
    document.getElementById('email-send-selected-btn').setAttribute('onclick', 'panel.confirmScheduleUserSelection()');

    const listEl = document.getElementById('email-user-list');
    listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">Loading users...</div>';

    try {
      const res = await fetch('/api/admin/users', { credentials: 'include' });
      const data = await res.json();
      this._emailAllUsers = (data.users || data).filter(u => u.email);
      this._renderEmailUserList(this._emailAllUsers);
      this._updateEmailSelectionUI();
    } catch (e) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--danger);padding:40px;">Failed to load users.</div>';
    }
  },

  closeEmailUserSelectorModal() {
    this.closeModal('email-select-users-modal');
    if (this.isScheduling) {
      this.openModal('email-scheduler-modal');
    }
  },

  confirmScheduleUserSelection() {
    this.scheduledUserIds = Array.from(this._emailSelectedIds);
    document.getElementById('schedule-selected-users-count').textContent = this.scheduledUserIds.length;
    this.closeModal('email-select-users-modal');
    this.openModal('email-scheduler-modal');
  },

  async saveScheduledEmail() {
    const formData = this._validateEmailForm();
    if (!formData) return;

    const recipientType = document.getElementById('schedule-recipient-type').value;
    let recipientIds = null;
    if (recipientType === 'specific') {
      if (!this.scheduledUserIds || this.scheduledUserIds.length === 0) {
        this.toast('Please select at least one recipient user.', 'error');
        return;
      }
      recipientIds = JSON.stringify(this.scheduledUserIds);
    }

    // Get selected days
    const checkedDays = Array.from(document.querySelectorAll('input[name="schedule-days"]:checked')).map(cb => cb.value);
    if (checkedDays.length === 0) {
      this.toast('Please select at least one day of the week.', 'error');
      return;
    }

    // Get times
    const timesRaw = document.getElementById('schedule-times-input').value.trim();
    if (!timesRaw) {
      this.toast('Please enter at least one schedule time.', 'error');
      return;
    }

    // Validate times (HH:MM)
    const times = timesRaw.split(',').map(t => t.trim());
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    for (const time of times) {
      if (!timeRegex.test(time)) {
        this.toast(`Invalid time format: "${time}". Please use HH:MM (24-hour format).`, 'error');
        return;
      }
    }

    const payload = {
      subject: formData.subject,
      html_content: formData.html_content,
      recipient_type: recipientType,
      recipient_ids: recipientIds,
      schedule_times: times.join(','),
      schedule_days: checkedDays.join(',')
    };

    const url = this._editingScheduleId ? `/api/admin/email/scheduled/${this._editingScheduleId}` : '/api/admin/email/schedule';
    const method = this._editingScheduleId ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.toast(this._editingScheduleId ? '✅ Scheduled email updated successfully!' : '✅ Email scheduled successfully!', 'success');
        this.closeModal('email-scheduler-modal');
        this._editingScheduleId = null;
        this.loadScheduledEmails();
      } else {
        this.toast(data.error || 'Failed to save email schedule.', 'error');
      }
    } catch (err) {
      this.toast('Network error saving email schedule.', 'error');
    }
  },

  async loadScheduledEmails() {
    const listBody = document.getElementById('scheduled-emails-list-body');
    if (!listBody) return;

    try {
      const res = await fetch('/api/admin/email/scheduled', { credentials: 'include' });
      const data = await res.json();
      if (res.ok && data.success) {
        const list = data.list || [];
        this._scheduledEmailsList = list;
        if (list.length === 0) {
          listBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--text-muted);">No scheduled emails found.</td></tr>`;
          return;
        }

        listBody.innerHTML = list.map(item => {
          let recs = 'All Users';
          if (item.recipient_type === 'specific') {
            try {
              const ids = JSON.parse(item.recipient_ids || '[]');
              recs = `${ids.length} Specific User${ids.length !== 1 ? 's' : ''}`;
            } catch (e) {
              recs = 'Specific Users';
            }
          }
          const lastSentStr = item.last_sent || '—';
          const subjectTrunc = item.subject.length > 40 ? item.subject.substring(0, 37) + '...' : item.subject;
          
          return `
            <tr style="border-bottom: 1px solid var(--border);">
              <td style="padding: 12px 10px; font-weight: 500;" title="${item.subject.replace(/"/g, '&quot;')}">${subjectTrunc}</td>
              <td style="padding: 12px 10px; font-size: 13px; color: var(--text-sec);">${item.schedule_days}</td>
              <td style="padding: 12px 10px; font-size: 13px; font-family: monospace; color: var(--text-sec);">${item.schedule_times}</td>
              <td style="padding: 12px 10px; font-size: 13px;">${recs}</td>
              <td style="padding: 12px 10px; font-size: 13px; color: var(--text-muted);">${lastSentStr}</td>
              <td style="padding: 12px 10px; text-align: right; white-space: nowrap;">
                <button class="btn" style="padding: 6px 12px; font-size: 12px; background: rgba(59, 130, 246, 0.1); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.2); margin-right: 6px;" onclick="panel.editScheduledEmail(${item.id})">
                  Edit
                </button>
                <button class="btn btn-danger" style="padding: 6px 12px; font-size: 12px; background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2);" onclick="panel.deleteScheduledEmail(${item.id})">
                  Delete
                </button>
              </td>
            </tr>
          `;
        }).join('');
      }
    } catch (err) {
      listBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 20px; color: var(--danger);">Failed to load active schedules.</td></tr>`;
    }
  },

  async deleteScheduledEmail(id) {
    if (!confirm('Are you sure you want to delete this scheduled email?')) return;

    try {
      const res = await fetch(`/api/admin/email/scheduled/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.toast('✅ Scheduled email deleted successfully!', 'success');
        this.loadScheduledEmails();
      } else {
        this.toast(data.error || 'Failed to delete scheduled email.', 'error');
      }
    } catch (err) {
      this.toast('Network error deleting scheduled email.', 'error');
    }
  },


  // =========================================================================
  // 🎧 LIVE SUPPORT CONTROLLER — Staff-Side Chat Center
  // =========================================================================
  liveSupport: {
    ably: null,
    queueChannel: null,
    convChannel: null,
    queue: 'unassigned', // 'unassigned' | 'mine' | 'all'
    searchQuery: '',
    categoryFilter: '',
    priorityFilter: '',
    conversations: [],
    activeConversation: null,
    messages: [],
    isLoadingMessages: false,
    hasMore: false,
    oldestTs: null,
    userTypingTimeout: null,
    soundEnabled: true,
    _userId: null,
    rightTab: 'notes', // 'notes' | 'audit' | 'media'
    queueAgeInterval: null,
    statsInterval: null,
    mobileView: 'list', // 'list' | 'chat' | 'details' (Telegram-style mobile flow)
    quickChats: [],
    qcEditingId: null,

    playSound(type) {
      if (!this.soundEnabled) return;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        if (type === 'new_request') {
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.2);
        } else {
          osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        }
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch(e) {}
    },

    async init() {
      this._userId = panel.user.id;
      if (typeof Ably !== 'undefined') {
        try {
          if (!this.ably) {
            this.ably = new Ably.Realtime({ authUrl: '/api/chat/token', authMethod: 'GET' });
          }
          if (this.queueChannel) { try { this.queueChannel.detach(); } catch(e){} }
          this.queueChannel = this.ably.channels.get('support:queue');
          
          this.queueChannel.subscribe('new_conversation', (msg) => {
            window.panel.triggerStaffAlarm('chat', 'New live support chat request initiated by customer.');
            this.refresh();
          });

          this.queueChannel.subscribe('message_update', (msg) => {
            const data = msg.data;
            const existing = this.conversations.find(c => c.id === data.conversationId);
            if (existing) {
              existing.last_message_text = data.lastMessage;
              existing.updated_at = data.updatedAt;
              if (data.status) existing.status = data.status;
              if (data.priority) existing.priority = data.priority;
              if (data.category) existing.category = data.category;
              
              if (this.activeConversation && this.activeConversation.id === data.conversationId) {
                // Read receipts handled in sub channel
              } else {
                existing.unread_count = (existing.unread_count || 0) + 1;
                this.playSound('message');
              }
              this.renderQueue();
            } else {
              this.refresh();
            }
          });

          this.queueChannel.subscribe('conversation_updated', (msg) => {
            const data = msg.data;
            if (data && data.transferredFromBot) {
              window.panel.triggerStaffAlarm('chat', 'A customer has been transferred from AI Assistant to human support.');
            }
            this.refresh();
          });
        } catch(e) { console.warn('Ably staff queue init failed:', e); }
      }

      // Initialize wait age timer
      clearInterval(this.queueAgeInterval);
      this.queueAgeInterval = setInterval(() => this.updateQueueWaitTimes(), 30000);

      // Periodically refresh stats
      clearInterval(this.statsInterval);
      this.statsInterval = setInterval(() => this.loadStats(), 15000);

      this.setMobileView(this.mobileView || 'list');
      this.refresh();
    },

    async refresh() {
      await this.loadQueue();
      await this.loadStats();
      await this.updateGlobalSupportBadge();
    },

    async updateGlobalSupportBadge() {
      try {
        const res = await fetch('/api/staff/support/conversations?queue=unassigned', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const count = data.conversations ? data.conversations.length : 0;
        
        const badge = document.getElementById('live-support-badge');
        if (badge) {
          badge.textContent = count;
          badge.style.display = count > 0 ? 'inline-block' : 'none';
        }
        const countSpan = document.getElementById('ls-count-unassigned');
        if (countSpan) {
          countSpan.textContent = count;
        }
      } catch(e) {}
    },

    async loadStats() {
      try {
        const res = await fetch('/api/staff/support/stats', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        
        document.getElementById('ls-stat-waiting').textContent = data.waiting_chats;
        document.getElementById('ls-stat-active').textContent = data.active_chats;
        document.getElementById('ls-stat-resolved').textContent = data.resolved_today;
        document.getElementById('ls-stat-agents').textContent = data.online_agents;

        const pulse = document.getElementById('ls-waiting-pulse');
        if (pulse) {
          pulse.style.display = data.waiting_chats > 0 ? 'inline-block' : 'none';
        }
      } catch(e) {}
    },

    setQueue(q) {
      this.queue = q;
      ['unassigned','mine','all','bot'].forEach(id => {
        const el = document.getElementById('ls-tab-' + id);
        if (!el) return;
        if (id === q) {
          el.style.background = 'var(--primary)';
          el.style.color = '#000';
        } else {
          el.style.background = 'transparent';
          el.style.color = 'var(--text-sec)';
        }
      });
      this.loadQueue();
    },

    // ── Telegram-style mobile master/detail navigation ──────────────
    // The ls-view-* classes only take effect under the 900px media query;
    // on desktop the three-column layout is unaffected.
    setMobileView(view) {
      this.mobileView = view;
      const section = document.getElementById('section-live-support');
      if (!section) return;
      section.classList.remove('ls-view-list', 'ls-view-chat', 'ls-view-details');
      section.classList.add('ls-view-' + view);
    },

    openDetails() {
      if (!this.activeConversation) return;
      const tRow = document.getElementById('ls-details-transfer-row');
      if (tRow) tRow.classList.toggle('ls-hidden', !(panel.user && panel.user.role === 'admin'));
      this.setMobileView('details');
    },

    goBackToChat() {
      this.setMobileView('chat');
    },

    goBackToList() {
      this.setMobileView('list');
    },

    setCategoryFilter(c) {
      this.categoryFilter = c;
      this.loadQueue();
    },

    setPriorityFilter(p) {
      this.priorityFilter = p;
      this.loadQueue();
    },

    search(q) {
      this.searchQuery = q.trim();
      this.loadQueue();
    },

    async loadQueue() {
      try {
        let url = '/api/staff/support/conversations?queue=' + this.queue;
        if (this.searchQuery) url += '&search=' + encodeURIComponent(this.searchQuery);
        if (this.categoryFilter) url += '&category=' + encodeURIComponent(this.categoryFilter);
        if (this.priorityFilter) url += '&priority=' + encodeURIComponent(this.priorityFilter);
        
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        this.conversations = data.conversations || [];
        this.renderQueue();
      } catch(e) {}
    },

    updateQueueWaitTimes() {
      document.querySelectorAll('.ls-wait-time').forEach(el => {
        const ts = el.getAttribute('data-ts');
        if (ts) {
          el.textContent = this.formatQueueAge(ts);
        }
      });
    },

    formatQueueAge(dateStr) {
      if (!dateStr) return '';
      const diffMs = Date.now() - new Date(dateStr).getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return '⏱️ Just now';
      if (diffMins < 60) return `⏱️ ${diffMins}m`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `⏱️ ${diffHours}h`;
      return `⏱️ ${Math.floor(diffHours / 24)}d`;
    },

    renderQueue() {
      const list = document.getElementById('ls-conv-list');
      const empty = document.getElementById('ls-conv-empty');
      if (!list) return;
      list.innerHTML = '';
      if (this.conversations.length === 0) {
        if (empty) empty.style.display = 'block';
        list.appendChild(empty);
        return;
      }
      if (empty) empty.style.display = 'none';

      this.conversations.forEach(c => {
        const item = document.createElement('div');
        const isActive = this.activeConversation && this.activeConversation.id === c.id;
        
        item.style.cssText = 'padding:12px 14px; cursor:pointer; border-bottom:1px solid var(--border); display:flex; flex-direction:column; gap:4px; transition:background 0.2s; ' + 
          (isActive ? 'background:rgba(16,255,136,0.04); border-left:3px solid var(--primary);' : '');
        item.onmouseover = () => { if (!isActive) item.style.background = 'var(--card-hover)'; };
        item.onmouseout = () => { if (!isActive) item.style.background = ''; };
        item.onclick = () => this.openChat(c.id, true);

        // Row 1: Username & Priority/Category Badges
        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
        
        const nameGroup = document.createElement('div');
        nameGroup.style.cssText = 'display:flex; align-items:center; gap:6px;';
        
        const name = document.createElement('span');
        name.style.cssText = 'font-weight:700; font-size:12.5px; color:var(--text);';
        name.textContent = c.user_name || 'User ' + c.user_id;
        nameGroup.appendChild(name);
        
        // Prio dot/badge
        const prioColor = c.priority === 'high' ? '#ef4444' : (c.priority === 'medium' ? '#fbbf24' : '#10b981');
        const prioText = c.priority ? c.priority.toUpperCase() : 'LOW';
        const prioBadge = document.createElement('span');
        prioBadge.style.cssText = `font-size:9px; font-weight:700; border-radius:4px; padding:1px 4px; background:${prioColor}20; color:${prioColor}; border:1px solid ${prioColor}40;`;
        prioBadge.textContent = prioText;
        nameGroup.appendChild(prioBadge);
        row1.appendChild(nameGroup);

        if (c.unread_count > 0) {
          const badge = document.createElement('span');
          badge.style.cssText = 'background:#ef4444; color:#fff; font-size:10px; font-weight:700; border-radius:50%; width:16px; height:16px; display:flex; align-items:center; justify-content:center;';
          badge.textContent = c.unread_count;
          row1.appendChild(badge);
        }
        item.appendChild(row1);

        // Row 2: Message preview
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:11.5px; color:var(--text-sec);';
        const msg = document.createElement('span');
        msg.style.cssText = 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;';
        msg.textContent = c.last_message_text || '(No messages)';
        row2.appendChild(msg);

        const time = document.createElement('span');
        if (c.last_message_at || c.updated_at) {
          const date = new Date(c.last_message_at || c.updated_at);
          time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        row2.appendChild(time);
        item.appendChild(row2);

        // Row 3: Category and Queue Wait Age
        const row3 = document.createElement('div');
        row3.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:10px; margin-top:2px;';
        
        const catBadge = document.createElement('span');
        catBadge.style.cssText = 'color:var(--primary); font-weight:600;';
        catBadge.textContent = '📁 ' + (c.category || 'General');
        row3.appendChild(catBadge);
        
        if (c.status === 'waiting') {
          if (c.assigned_to === this._userId) {
            const transferredEl = document.createElement('span');
            transferredEl.style.cssText = 'color:#3b82f6; font-weight:700; background:rgba(59,130,246,0.1); padding:1px 5px; border-radius:4px; font-size:9.5px;';
            transferredEl.textContent = '📩 Transferred to you';
            row3.appendChild(transferredEl);
          } else {
            const waitEl = document.createElement('span');
            waitEl.className = 'ls-wait-time';
            waitEl.setAttribute('data-ts', c.updated_at);
            waitEl.style.cssText = 'color:var(--warning); font-weight:600;';
            waitEl.textContent = this.formatQueueAge(c.updated_at);
            row3.appendChild(waitEl);
          }
        } else if (c.assigned_agent_name) {
          const agentEl = document.createElement('span');
          agentEl.style.cssText = 'color:var(--text-muted); font-style:italic;';
          agentEl.textContent = '👤 ' + c.assigned_agent_name;
          row3.appendChild(agentEl);
        }
        
        item.appendChild(row3);
        list.appendChild(item);
      });
    },

    async openChat(convId, navigate) {
      try {
        const res = await fetch('/api/staff/support/conversations/' + convId, { credentials: 'include' });
        if (!res.ok) return;
        const { conversation } = await res.json();
        this.activeConversation = conversation;
        
        // Hide details empty state
        document.getElementById('ls-details-empty').style.display = 'none';
        document.getElementById('ls-details-active').style.display = 'flex';
        document.getElementById('ls-chat-empty').style.display = 'none';
        document.getElementById('ls-chat-active').style.display = 'flex';
        
        // Populate chat panel metadata
        document.getElementById('ls-user-avatar').textContent = conversation.user_name.charAt(0).toUpperCase();
        document.getElementById('ls-user-name').textContent = conversation.user_name;
        document.getElementById('ls-user-subtitle').textContent = 'User ID: ' + conversation.user_id + ' | Ticket Status: ' + conversation.status.toUpperCase();
        document.getElementById('ls-chat-category').value = conversation.category || 'General';
        document.getElementById('ls-chat-priority').value = conversation.priority || 'low';

        // Mobile details sub-window mirrors
        const dStatus = document.getElementById('ls-details-status');
        if (dStatus) dStatus.textContent = (conversation.status || 'waiting').toUpperCase();
        const dCat = document.getElementById('ls-details-category');
        if (dCat) dCat.value = conversation.category || 'General';
        const dPrio = document.getElementById('ls-details-priority');
        if (dPrio) dPrio.value = conversation.priority || 'low';

        // Additional Metadata items
        const joinedEl = document.getElementById('ls-meta-joined');
        if (joinedEl) joinedEl.textContent = new Date(conversation.user_created_at).toLocaleDateString();

        const lastSeenEl = document.getElementById('ls-meta-last-seen');
        if (lastSeenEl) {
          if (conversation.last_seen_at) {
            const lsDate = new Date(conversation.last_seen_at);
            lastSeenEl.textContent = lsDate.toLocaleDateString() + ' ' + lsDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          } else {
            lastSeenEl.textContent = 'Never';
          }
        }

        // Check user online status
        const presence = document.getElementById('ls-user-presence');
        if (presence) {
          const twoMinsAgo = Date.now() - 120000;
          const isOnline = new Date(conversation.last_seen_at).getTime() >= twoMinsAgo;
          presence.style.background = isOnline ? '#10b981' : '#ccc';
          presence.title = isOnline ? 'Online' : 'Offline';
        }

        // Details Panel
        document.getElementById('ls-details-avatar').textContent = conversation.user_name.charAt(0).toUpperCase();
        document.getElementById('ls-details-name').textContent = conversation.user_name;
        document.getElementById('ls-details-email').textContent = conversation.email || 'No email';
        document.getElementById('ls-meta-id').textContent = conversation.user_id;
        document.getElementById('ls-meta-messages-count').textContent = conversation.total_messages || 0;

        const acctStatus = conversation.user_account_status ? conversation.user_account_status.toUpperCase() : 'ACTIVE';
        document.getElementById('ls-meta-status').textContent = acctStatus;
        document.getElementById('ls-meta-status').style.color = acctStatus === 'ACTIVE' ? 'var(--primary)' : 'var(--danger)';

        const ratingVal = conversation.rating;
        const ratingLabels = [
          "😠 Poor (1/5)",
          "🙁 Fair (2/5)",
          "😐 Average (3/5)",
          "🙂 Good (4/5)",
          "😄 Excellent (5/5)"
        ];
        const ratingEl = document.getElementById('ls-meta-rating');
        if (ratingEl) {
          ratingEl.textContent = ratingVal ? ratingLabels[ratingVal - 1] : 'Not rated yet';
          ratingEl.style.color = ratingVal ? '#10b981' : '';
          ratingEl.style.fontWeight = ratingVal ? '700' : '';
        }

        // Set ownership warning banner and inputs
        const isMine = conversation.assigned_to === this._userId;
        const isAdmin = panel.user.role === 'admin';
        
        const acceptBtn = document.getElementById('ls-accept-btn');
        const handoverBtn = document.getElementById('ls-handover-bot-btn');
        const closeBtn = document.getElementById('ls-close-btn');
        const inputArea = document.getElementById('ls-input-area');
        const banner = document.getElementById('ls-ownership-banner');
        
        // Reset defaults
        banner.style.display = 'none';
        acceptBtn.style.display = 'none';
        if (handoverBtn) handoverBtn.style.display = 'none';
        closeBtn.style.display = 'inline-block';
        inputArea.style.display = 'block';

        if (conversation.status === 'waiting') {
          if (!conversation.assigned_to || conversation.assigned_to === this._userId) {
            acceptBtn.style.display = 'inline-block';
          } else {
            acceptBtn.style.display = 'none';
            banner.style.display = 'flex';
            banner.querySelector('span').textContent = `🔒 Transferred to ${conversation.assigned_agent_name || 'another agent'}. Waiting for acceptance.`;
          }
          inputArea.style.display = 'none';
          closeBtn.style.display = 'none';
        } else {
          // If assigned and not closed, show handover to bot option
          if (handoverBtn && conversation.status !== 'closed' && conversation.assigned_to) {
            handoverBtn.style.display = 'inline-block';
          }
          if (!isMine && !isAdmin) {
            // Assigned to someone else, and current user is not Admin -> Block replies!
            banner.style.display = 'flex';
            banner.querySelector('span').textContent = `🔒 Assigned to ${conversation.assigned_agent_name || 'another agent'}. Only the owner or admins can reply.`;
            inputArea.style.display = 'none';
          }
        }

        if (conversation.status === 'closed') {
          inputArea.style.display = 'none';
          closeBtn.style.display = 'none';
        }

        // Setup reassign select for Admins
        const transferContainer = document.getElementById('ls-transfer-container');
        const detailsTransferRow = document.getElementById('ls-details-transfer-row');
        if (isAdmin) {
          transferContainer.style.display = 'flex';
          await this.loadAgents();
          document.getElementById('ls-chat-agent-select').value = conversation.assigned_to || '';
          const dSel = document.getElementById('ls-details-agent-select');
          if (dSel) dSel.value = conversation.assigned_to || '';
        } else {
          transferContainer.style.display = 'none';
        }
        // Transfer Agent row shows in the mobile details sheet for admins only
        if (detailsTransferRow) detailsTransferRow.classList.toggle('ls-hidden', !isAdmin);

        // Real-Time Channels
        if (typeof Ably !== 'undefined') {
          if (this.convChannel) {
            try {
              this.convChannel.unsubscribe();
              this.convChannel.detach();
            } catch(e){}
          }
          this.convChannel = this.ably.channels.get('support:conversation:' + convId);
          try { this.convChannel.unsubscribe(); } catch(e){}
          
          this.convChannel.subscribe('message', (msg) => {
            const m = msg.data;
            const currentUserId = Number(this._userId || panel.user?.id || 0);
            const msgSenderId = Number(m.sender_id || 0);
            if (currentUserId > 0 && msgSenderId === currentUserId) return;

            const exists = this.messages.some(existing => String(existing.id) === String(m.id));
            if (!exists) {
              this.messages.push(m);
              this._appendMessage(m);
              const totalCountEl = document.getElementById('ls-meta-messages-count');
              if (totalCountEl) totalCountEl.textContent = parseInt(totalCountEl.textContent || 0) + 1;
              this.renderSharedMedia();
            }
          });

          this.convChannel.subscribe('typing', (msg) => {
            const currentUserId = Number(this._userId || panel.user?.id || 0);
            if (Number(msg.data.userId) === currentUserId) return;
            const ind = document.getElementById('ls-typing-ind');
            if (ind) {
              const txt = document.getElementById('ls-typing-text');
              if (txt) {
                txt.textContent = msg.data.isBot ? "AI Assistant is typing" : "Customer is typing";
              }
              ind.style.display = 'flex';
            }
            clearTimeout(this.userTypingTimeout);
            this.userTypingTimeout = setTimeout(() => { if (ind) ind.style.display = 'none'; }, 3000);
          });

          this.convChannel.subscribe('status_update', (msg) => {
            this.activeConversation.status = msg.data.status;
            this.openChat(convId);
            this.refresh();
          });

          this.convChannel.subscribe('priority_update', (msg) => {
            this.activeConversation.priority = msg.data.priority;
            document.getElementById('ls-chat-priority').value = msg.data.priority;
            const dP = document.getElementById('ls-details-priority');
            if (dP) dP.value = msg.data.priority;
            this.refresh();
          });

          this.convChannel.subscribe('category_update', (msg) => {
            this.activeConversation.category = msg.data.category;
            this.activeConversation.priority = msg.data.priority;
            document.getElementById('ls-chat-category').value = msg.data.category;
            document.getElementById('ls-chat-priority').value = msg.data.priority;
            const dC = document.getElementById('ls-details-category');
            if (dC) dC.value = msg.data.category;
            const dP2 = document.getElementById('ls-details-priority');
            if (dP2) dP2.value = msg.data.priority;
            this.refresh();
          });
        }

        this.messages = [];
        this.oldestTs = null;
        
        await this.loadMessages(true);
        this.setRightTab(this.rightTab);
        this.initEmojiPicker();
        this.initDragAndDrop();
        this.renderQueue();
        if (navigate) this.setMobileView('chat');
      } catch(e) {}
    },

    async loadMessages(initial) {
      if (this.isLoadingMessages || !this.activeConversation) return;
      this.isLoadingMessages = true;
      try {
        let url = '/api/staff/support/conversations/' + this.activeConversation.id + '/messages';
        if (!initial && this.oldestTs) url += '?before=' + encodeURIComponent(this.oldestTs);
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        if (initial) {
          this.messages = data.messages || [];
          this.renderMessages();
        } else {
          const older = data.messages || [];
          this.messages = [...older, ...this.messages];
          this._prependMessages(older);
        }
        this.hasMore = !!data.hasMore;
        if (this.messages.length > 0) this.oldestTs = this.messages[0].created_at;
        const btn = document.getElementById('ls-load-more');
        if (btn) btn.style.display = this.hasMore ? 'block' : 'none';
        
        // Handle pinned message display
        const pinnedMsg = this.messages.find(m => m.is_pinned === 1 || m.is_pinned === true);
        const pinnedBar = document.getElementById('ls-pinned-bar');
        const pinnedText = document.getElementById('ls-pinned-text');
        
        if (pinnedMsg && pinnedBar && pinnedText) {
          pinnedBar.style.display = 'flex';
          pinnedText.textContent = pinnedMsg.text || '📎 Attachment';
        } else if (pinnedBar) {
          pinnedBar.style.display = 'none';
        }

        if (initial) this._scrollToBottom();
      } catch(e) {} finally { this.isLoadingMessages = false; }
    },

    loadMoreMessages() { this.loadMessages(false); },

    renderMessages() {
      const list = document.getElementById('ls-messages-list');
      if (!list) return;
      list.innerHTML = '';
      
      const uniqueMessages = [];
      const seenIds = new Set();
      (this.messages || []).forEach(m => {
        const key = m.id ? String(m.id) : (m.text + '_' + m.created_at);
        if (!seenIds.has(key)) {
          seenIds.add(key);
          uniqueMessages.push(m);
        }
      });
      this.messages = uniqueMessages;
      this.messages.forEach(m => list.appendChild(this._buildBubble(m)));
    },

    _prependMessages(msgs) {
      const list = document.getElementById('ls-messages-list');
      const area = document.getElementById('ls-messages-area');
      if (!list || !area) return;
      const prev = area.scrollHeight;
      const frag = document.createDocumentFragment();
      msgs.forEach(m => frag.appendChild(this._buildBubble(m)));
      list.insertBefore(frag, list.firstChild);
      area.scrollTop = area.scrollHeight - prev;
    },

    _appendMessage(msg) {
      const list = document.getElementById('ls-messages-list');
      if (!list) return;
      
      if (msg.id && list.querySelector(`[data-msg-id="${String(msg.id)}"]`)) {
        return;
      }
      
      list.appendChild(this._buildBubble(msg));
      this._scrollToBottom();
    },

    _buildBubble(msg) {
      const currentUserId = Number(this._userId || panel.user?.id || 0);
      const msgSenderId = Number(msg.sender_id || 0);
      const isMine = (currentUserId > 0 && msgSenderId === currentUserId) || (msg.is_staff && msgSenderId === currentUserId);
      const isBot = msg.sender_name === "GainEX AI Bot" || msg.username === "GainEX AI Bot";
      const isSupportReply = isMine || msg.is_staff || isBot;

      const wrap = document.createElement('div');
      if (msg.id) wrap.setAttribute('data-msg-id', String(msg.id));
      wrap.style.cssText = 'display:flex; flex-direction:column; align-items:' + (isSupportReply ? 'flex-end' : 'flex-start') + '; margin-bottom:6px;';
      
      if (!isMine && (isBot || msg.is_staff)) {
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:10px; color:var(--text-sec); margin-bottom:3px; padding-right:4px; align-self:flex-end;';
        if (isBot) {
          lbl.textContent = 'AI Assistant';
        } else {
          lbl.textContent = '🛡 Support Agent (' + (msg.sender_name || 'Staff') + ')';
        }
        wrap.appendChild(lbl);
      }

      const bubble = document.createElement('div');
      let bubbleStyle = 'max-width:75%; padding:10px 14px; border-radius:12px; font-size:13px; line-height:1.5; word-break:break-word; position:relative; ';
      if (isMine) {
        bubbleStyle += 'background:var(--primary); color:#000; border-bottom-right-radius:4px; align-self:flex-end;';
      } else if (isSupportReply) {
        bubbleStyle += 'background:rgba(16, 255, 136, 0.08); color:var(--text); border:1.5px solid rgba(16, 255, 136, 0.25); border-bottom-right-radius:4px; align-self:flex-end;';
      } else {
        bubbleStyle += 'background:var(--bg); color:var(--text); border:1.5px solid var(--border); border-bottom-left-radius:4px; align-self:flex-start;';
      }
      bubble.style.cssText = bubbleStyle;

      // Pin overlay or indicator
      if (msg.is_pinned === 1 || msg.is_pinned === true) {
        const pinIcon = document.createElement('span');
        pinIcon.style.cssText = 'position:absolute; top:-6px; right:-6px; background:var(--bg3); border:1px solid var(--border); border-radius:50%; width:16px; height:16px; display:flex; align-items:center; justify-content:center; font-size:9px;';
        pinIcon.textContent = '📌';
        bubble.appendChild(pinIcon);
      }

      if (msg.text) {
        const textEl = document.createElement('div');
        const escapeHTML = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        let formatted = escapeHTML(msg.text);
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        formatted = formatted.replace(/\*(.*?)\*/g, "<strong>$1</strong>");
        formatted = formatted.replace(/\n/g, "<br>");
        textEl.innerHTML = formatted;
        bubble.appendChild(textEl);
      }

      if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
          if (!att) return;
          const d = document.createElement('div');
          d.style.marginTop = '6px';
          if (att.file_type && att.file_type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = att.file_url;
            img.style.cssText = 'max-width:200px; max-height:180px; border-radius:8px; cursor:pointer; display:block;';
            img.onclick = () => window.open(att.file_url, '_blank');
            d.appendChild(img);
          } else if (att.file_type && att.file_type.startsWith('audio/')) {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = att.file_url;
            audio.style.cssText = 'max-width:200px; display:block;';
            d.appendChild(audio);
          } else {
            const a = document.createElement('a');
            a.href = att.file_url;
            a.target = '_blank';
            a.style.cssText = 'font-size:12px; color:' + (isMine ? '#000' : 'var(--primary)') + '; text-decoration:underline;';
            a.textContent = '📄 ' + att.file_name;
            d.appendChild(a);
          }
          bubble.appendChild(d);
        });
      }

      // Time + Pin/Unpin action menu trigger
      const footerRow = document.createElement('div');
      footerRow.style.cssText = 'display:flex; gap:8px; align-items:center; font-size:10px; opacity:0.6; margin-top:4px; justify-content:' + (isSupportReply ? 'flex-end' : 'flex-start') + ';';
      
      const timeEl = document.createElement('span');
      timeEl.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      footerRow.appendChild(timeEl);

      const pinBtn = document.createElement('span');
      pinBtn.style.cssText = 'cursor:pointer; text-decoration:underline; font-size:9.5px;';
      pinBtn.textContent = (msg.is_pinned === 1 || msg.is_pinned === true) ? 'Unpin' : 'Pin';
      pinBtn.onclick = () => this.togglePinMessage(msg.id, !(msg.is_pinned === 1 || msg.is_pinned === true));
      footerRow.appendChild(pinBtn);

      bubble.appendChild(footerRow);
      wrap.appendChild(bubble);
      return wrap;
    },

    _scrollToBottom() {
      const area = document.getElementById('ls-messages-area');
      if (area) setTimeout(() => { area.scrollTop = area.scrollHeight; }, 50);
    },

    async sendReply() {
      if (!this.activeConversation) return;
      this.hideSlashMenu();
      this.hideQuickChatSelect();
      const input = document.getElementById('ls-reply-input');
      const text = input ? input.value.trim() : '';
      if (!text) return;

      const tempId = 'tmp_' + Date.now();
      const tempMsg = { id: tempId, sender_id: this._userId, text, created_at: new Date().toISOString(), attachments: null };
      this.messages.push(tempMsg);
      this._appendMessage(tempMsg);
      if (input) { input.value = ''; input.style.height = 'auto'; }

      try {
        const res = await fetch('/api/staff/support/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ conversationId: this.activeConversation.id, text })
        });
        const data = await res.json();
        if (res.ok && data.message) {
          this.messages = this.messages.filter(m => m.id !== tempId);
          if (data.message) this.messages.push(data.message);
          this.renderMessages();
          this.loadQueue();
        } else {
          panel.toast(data.error || 'Failed to send reply', 'error');
        }
      } catch(e) {
        panel.toast('Failed to send reply', 'error');
      }
    },

    async acceptChat() {
      if (!this.activeConversation) return;
      try {
        const res = await fetch('/api/staff/support/conversations/' + this.activeConversation.id + '/accept', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          panel.toast('Conversation accepted', 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        } else {
          const err = await res.json();
          panel.toast(err.error || 'Failed to accept', 'error');
        }
      } catch(e) {}
    },

    async handoverToBot() {
      if (!this.activeConversation) return;
      if (!confirm("Are you sure you want to hand over this conversation back to the AI Support Bot? The bot will start answering customer queries immediately.")) return;
      try {
        const res = await fetch('/api/staff/support/conversations/' + this.activeConversation.id + '/handover-to-bot', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          panel.toast('Conversation handed over to AI Bot', 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        } else {
          const err = await res.json();
          panel.toast(err.error || 'Failed to hand over', 'error');
        }
      } catch(e) {
        panel.toast('Error handing over conversation', 'error');
      }
    },

    async openAiBotSupportModal() {
      try {
        const res = await fetch('/api/admin/support/aibot-settings', { credentials: 'include' });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to load AI settings');
        }
        const data = await res.json();
        
        const toggle = document.getElementById('ls-aibot-enabled-toggle');
        const label = document.getElementById('ls-aibot-enabled-label');
        const keyInput = document.getElementById('ls-aibot-gemini-key');
        const instructionsInput = document.getElementById('ls-aibot-instructions');
        
        if (toggle) toggle.checked = data.enabled === 'true' || data.enabled === true;
        if (label) {
          label.textContent = (data.enabled === 'true' || data.enabled === true) ? 'Active (Replying to user first)' : 'Inactive (Disabled)';
          label.style.color = (data.enabled === 'true' || data.enabled === true) ? '#10b981' : '#ef4444';
        }
        if (keyInput) keyInput.value = data.gemini_key || '';
        if (instructionsInput) instructionsInput.value = data.instructions || '';
        
        // Add toggle change listener to update labels in real-time
        if (toggle) {
          toggle.onchange = function() {
            if (label) {
              label.textContent = this.checked ? 'Active (Replying to user first)' : 'Inactive (Disabled)';
              label.style.color = this.checked ? '#10b981' : '#ef4444';
            }
          };
        }

        panel.openModal('ls-aibot-settings-modal');
      } catch (err) {
        panel.toast(err.message, 'error');
      }
    },

    async saveAiBotSettings() {
      try {
        const toggle = document.getElementById('ls-aibot-enabled-toggle');
        const keyInput = document.getElementById('ls-aibot-gemini-key');
        const instructionsInput = document.getElementById('ls-aibot-instructions');
        
        const enabled = toggle ? toggle.checked : false;
        const gemini_key = keyInput ? keyInput.value : '';
        const instructions = instructionsInput ? instructionsInput.value : '';
        
        const res = await fetch('/api/admin/support/aibot-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, gemini_key, instructions }),
          credentials: 'include'
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to save AI settings');
        }
        panel.toast('AI Support Bot settings saved successfully!', 'success');
        panel.closeModal('ls-aibot-settings-modal');
      } catch (err) {
        panel.toast(err.message, 'error');
      }
    },

    closeTicketPrompt() {
      if (!confirm("Are you sure you want to close this conversation? The customer will no longer be able to reply until a new support ticket is created.")) return;
      this.changeStatus('closed');
    },

    async changeStatus(status) {
      if (!this.activeConversation) return;
      try {
        const res = await fetch('/api/staff/support/conversations/' + this.activeConversation.id + '/status', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status })
        });
        if (res.ok) {
          panel.toast('Status changed to ' + status.toUpperCase(), 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        }
      } catch(e) {}
    },

    async updateCategory(category) {
      if (!this.activeConversation) return;
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/category`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ category })
        });
        if (res.ok) {
          panel.toast('Category updated to ' + category, 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        }
      } catch(e) {}
    },

    async updatePriority(priority) {
      if (!this.activeConversation) return;
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/priority`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ priority })
        });
        if (res.ok) {
          panel.toast('Priority updated to ' + priority.toUpperCase(), 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        }
      } catch(e) {}
    },

    async loadAgents() {
      const selects = [
        document.getElementById('ls-chat-agent-select'),
        document.getElementById('ls-details-agent-select')
      ].filter(Boolean);
      if (!selects.length) return;
      try {
        const res = await fetch('/api/staff/support/agents', { credentials: 'include' });
        const data = await res.json();
        const agents = data.agents || [];
        
        const html = '<option value="">👤 Transfer Agent...</option>' + 
          agents.map(a => `<option value="${a.id}">${a.username} (${a.role.toUpperCase()}) - ${a.active_chats_count} chats</option>`).join('');
        selects.forEach(s => { s.innerHTML = html; });
      } catch (e) {}
    },

    async transferChat(agentId) {
      if (!agentId || !this.activeConversation) return;
      if (!confirm(`Are you sure you want to transfer this chat to the selected agent?`)) {
        document.getElementById('ls-chat-agent-select').value = this.activeConversation.assigned_to || '';
        const dSel = document.getElementById('ls-details-agent-select');
        if (dSel) dSel.value = this.activeConversation.assigned_to || '';
        return;
      }
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/reassign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ agentId })
        });
        if (res.ok) {
          panel.toast('Conversation transferred successfully', 'success');
          this.openChat(this.activeConversation.id);
          this.refresh();
        } else {
          const data = await res.json();
          panel.toast(data.error || 'Failed to transfer chat', 'error');
          document.getElementById('ls-chat-agent-select').value = this.activeConversation.assigned_to || '';
          const dSel2 = document.getElementById('ls-details-agent-select');
          if (dSel2) dSel2.value = this.activeConversation.assigned_to || '';
        }
      } catch(e) {}
    },

    async togglePinMessage(msgId, shouldPin) {
      try {
        const url = `/api/staff/support/messages/${msgId}/${shouldPin ? 'pin' : 'unpin'}`;
        const res = await fetch(url, { method: 'POST', credentials: 'include' });
        if (res.ok) {
          panel.toast(shouldPin ? 'Message pinned' : 'Message unpinned', 'success');
          this.loadMessages(true);
        }
      } catch(e) {}
    },

    async unpinMessage() {
      const pinnedMsg = this.messages.find(m => m.is_pinned === 1 || m.is_pinned === true);
      if (pinnedMsg) {
        await this.togglePinMessage(pinnedMsg.id, false);
      }
    },

    // ── ⚡ QUICK CHATS (slash command) ────────────────────────────
    onReplyInput(el) {
      if (el.value === '/') {
        const m = document.getElementById('ls-slash-menu');
        if (m) m.style.display = 'flex';
        this.hideQuickChatSelect();
      } else {
        this.hideSlashMenu();
      }
    },

    hideSlashMenu() {
      const m = document.getElementById('ls-slash-menu');
      if (m) m.style.display = 'none';
    },

    hideQuickChatSelect() {
      const p = document.getElementById('ls-qc-select-panel');
      if (p) p.style.display = 'none';
    },

    async loadQuickChats() {
      try {
        const res = await fetch('/api/staff/support/quick-chats', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        this.quickChats = data.quickChats || [];
      } catch (e) {}
    },

    async openQuickChatAdd() {
      this.hideSlashMenu();
      this.hideQuickChatSelect();
      this.qcEditingId = null;
      document.getElementById('ls-qc-sheet-title').textContent = 'Add Quick Chat';
      document.getElementById('ls-qc-title-input').value = '';
      document.getElementById('ls-qc-content-input').value = '';
      await this.loadQuickChats();
      this.renderQuickChatManageList();
      document.getElementById('ls-qc-backdrop').style.display = 'block';
      requestAnimationFrame(() => document.getElementById('ls-qc-sheet').classList.add('open'));
    },

    closeQuickChatSheet() {
      const sheet = document.getElementById('ls-qc-sheet');
      if (sheet) sheet.classList.remove('open');
      setTimeout(() => { const b = document.getElementById('ls-qc-backdrop'); if (b) b.style.display = 'none'; }, 260);
      this.qcEditingId = null;
    },

    renderQuickChatManageList() {
      const list = document.getElementById('ls-qc-manage-list');
      if (!list) return;
      list.innerHTML = '';
      if (this.quickChats.length === 0) {
        list.innerHTML = '<div style="text-align:center; font-size:11px; color:var(--text-muted); padding:16px;">No quick chats saved yet.</div>';
        return;
      }
      this.quickChats.forEach(qc => {
        const row = document.createElement('div');
        row.className = 'ls-qc-manage-row';

        const info = document.createElement('div');
        info.className = 'ls-qc-manage-info';
        const t = document.createElement('div');
        t.className = 'ls-qc-manage-title';
        t.textContent = qc.title;
        const p = document.createElement('div');
        p.className = 'ls-qc-manage-preview';
        p.textContent = qc.content;
        info.appendChild(t);
        info.appendChild(p);
        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'ls-qc-manage-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = '✏️ Edit';
        editBtn.onclick = () => this.startEditQuickChat(qc);
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ls-qc-del';
        delBtn.textContent = '🗑 Delete';
        delBtn.onclick = () => this.deleteQuickChat(qc.id);
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);
        list.appendChild(row);
      });
    },

    startEditQuickChat(qc) {
      this.qcEditingId = qc.id;
      document.getElementById('ls-qc-sheet-title').textContent = 'Edit Quick Chat';
      document.getElementById('ls-qc-title-input').value = qc.title;
      document.getElementById('ls-qc-content-input').value = qc.content;
      document.getElementById('ls-qc-sheet').scrollTop = 0;
    },

    async deleteQuickChat(id) {
      if (!confirm('Delete this quick chat? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/staff/support/quick-chats/' + id, { method: 'DELETE', credentials: 'include' });
        if (res.ok) {
          panel.toast('Quick chat deleted', 'success');
          if (this.qcEditingId === id) {
            this.qcEditingId = null;
            document.getElementById('ls-qc-sheet-title').textContent = 'Add Quick Chat';
            document.getElementById('ls-qc-title-input').value = '';
            document.getElementById('ls-qc-content-input').value = '';
          }
          await this.loadQuickChats();
          this.renderQuickChatManageList();
        }
      } catch (e) {}
    },

    async saveQuickChat() {
      const title = document.getElementById('ls-qc-title-input').value.trim();
      const content = document.getElementById('ls-qc-content-input').value.trim();
      if (!title || !content) {
        panel.toast('Title and message are both required', 'error');
        return;
      }
      try {
        const url = this.qcEditingId ? '/api/staff/support/quick-chats/' + this.qcEditingId : '/api/staff/support/quick-chats';
        const method = this.qcEditingId ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ title, content })
        });
        const data = await res.json();
        if (res.ok) {
          panel.toast(this.qcEditingId ? 'Quick chat updated' : 'Quick chat saved', 'success');
          this.qcEditingId = null;
          document.getElementById('ls-qc-sheet-title').textContent = 'Add Quick Chat';
          document.getElementById('ls-qc-title-input').value = '';
          document.getElementById('ls-qc-content-input').value = '';
          await this.loadQuickChats();
          this.renderQuickChatManageList();
        } else {
          panel.toast(data.error || 'Failed to save quick chat', 'error');
        }
      } catch (e) {
        panel.toast('Failed to save quick chat', 'error');
      }
    },

    async openQuickChatSelect() {
      this.hideSlashMenu();
      await this.loadQuickChats();
      const list = document.getElementById('ls-qc-select-list');
      if (list) {
        list.innerHTML = '';
        if (this.quickChats.length === 0) {
          list.innerHTML = '<div style="text-align:center; font-size:11px; color:var(--text-muted); padding:16px;">No quick chats yet. Use “Add Quick Chat” to create one.</div>';
        } else {
          this.quickChats.forEach(qc => {
            const item = document.createElement('div');
            item.className = 'ls-qc-select-item';
            const t = document.createElement('div');
            t.className = 'ls-qc-select-item-title';
            t.textContent = qc.title;
            const p = document.createElement('div');
            p.className = 'ls-qc-select-item-preview';
            p.textContent = qc.content;
            item.appendChild(t);
            item.appendChild(p);
            item.onclick = () => this.useQuickChat(qc.id);
            list.appendChild(item);
          });
        }
      }
      const panelEl = document.getElementById('ls-qc-select-panel');
      if (panelEl) panelEl.style.display = 'flex';
    },

    useQuickChat(id) {
      const qc = this.quickChats.find(q => String(q.id) === String(id));
      if (!qc) return;
      const input = document.getElementById('ls-reply-input');
      if (input) {
        // Only the message body goes into the input — never the title.
        // The agent can tweak it, then press the normal Send button.
        input.value = qc.content;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        input.focus();
      }
      this.hideQuickChatSelect();
      this.hideSlashMenu();
    },

    // Notes, Audit & Media Sidebar Controls
    setRightTab(tab) {
      this.rightTab = tab;
      ['notes', 'audit', 'media'].forEach(id => {
        const btn = document.getElementById('ls-right-tab-' + id);
        const body = document.getElementById('ls-tab-body-' + id);
        if (id === tab) {
          if (btn) { btn.style.background = 'var(--primary)'; btn.style.color = '#000'; }
          if (body) body.style.display = 'flex';
        } else {
          if (btn) { btn.style.background = 'transparent'; btn.style.color = 'var(--text-sec)'; }
          if (body) body.style.display = 'none';
        }
      });
      this.loadRightTabContent();
    },

    async loadRightTabContent() {
      if (!this.activeConversation) return;
      if (this.rightTab === 'notes') {
        await this.loadNotes();
      } else if (this.rightTab === 'audit') {
        await this.loadAuditLogs();
      } else if (this.rightTab === 'media') {
        this.renderSharedMedia();
      }
    },

    async loadNotes() {
      const list = document.getElementById('ls-notes-list');
      if (!list) return;
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/notes`, { credentials: 'include' });
        const data = await res.json();
        const notes = data.notes || [];
        if (notes.length === 0) {
          list.innerHTML = '<div style="text-align:center;font-size:11px;color:var(--text-muted);padding:20px;">No private notes available.</div>';
          return;
        }
        list.innerHTML = notes.map(n => `
          <div style="background:rgba(16,185,129,0.04); border:1px solid var(--border); padding:8px 10px; border-radius:8px; font-size:11.5px; line-height:1.4;">
            <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:10px; color:var(--text-sec);">
              <strong>✍️ ${n.author_name}</strong>
              <span>${new Date(n.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
            </div>
            <div style="color:var(--text); word-break:break-word;">${n.text}</div>
          </div>
        `).join('');
      } catch (e) {}
    },

    async addStaffNote() {
      const input = document.getElementById('ls-note-input');
      const text = input ? input.value.trim() : '';
      if (!text) return;
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ text })
        });
        if (res.ok) {
          if (input) input.value = '';
          this.loadNotes();
        }
      } catch (e) {}
    },

    async loadAuditLogs() {
      const list = document.getElementById('ls-audit-list');
      if (!list) return;
      try {
        const res = await fetch(`/api/staff/support/conversations/${this.activeConversation.id}/audit`, { credentials: 'include' });
        const data = await res.json();
        const logs = data.logs || [];
        if (logs.length === 0) {
          list.innerHTML = '<div style="text-align:center;font-size:11px;color:var(--text-muted);padding:20px;">No history recorded yet.</div>';
          return;
        }
        list.innerHTML = logs.map(l => {
          const date = new Date(l.created_at).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
          return `
            <div style="border-left:2px solid var(--border); padding-left:8px; font-size:11px; line-height:1.4; margin-bottom:8px;">
              <span style="color:var(--text-sec); font-size:9.5px;">${date}</span>
              <div style="color:var(--text); font-weight:600;">${l.details}</div>
            </div>
          `;
        }).join('');
      } catch (e) {}
    },

    renderSharedMedia() {
      const fileList = document.getElementById('ls-media-files-list');
      const imgGrid = document.getElementById('ls-media-images-grid');
      if (!fileList || !imgGrid) return;
      fileList.innerHTML = '';
      imgGrid.innerHTML = '';
      
      let imageCount = 0;
      let fileCount = 0;
      
      this.messages.forEach(m => {
        if (m.attachments && m.attachments.length > 0) {
          m.attachments.forEach(att => {
            if (!att) return;
            if (att.file_type && att.file_type.startsWith('image/')) {
              imageCount++;
              const img = document.createElement('img');
              img.src = att.file_url;
              img.style.cssText = 'width:100%; height:60px; object-fit:cover; border-radius:6px; border:1px solid var(--border); cursor:pointer;';
              img.onclick = () => window.open(att.file_url, '_blank');
              imgGrid.appendChild(img);
            } else {
              fileCount++;
              const div = document.createElement('div');
              div.style.cssText = 'font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:4px;';
              const a = document.createElement('a');
              a.href = att.file_url;
              a.target = '_blank';
              a.style.cssText = 'color:var(--primary); text-decoration:underline;';
              a.textContent = '📄 ' + att.file_name;
              div.appendChild(a);
              fileList.appendChild(div);
            }
          });
        }
      });
      
      if (imageCount === 0) {
        imgGrid.innerHTML = '<div style="font-size:11px; color:var(--text-muted); grid-column:span 3; padding:10px 0;">No shared images</div>';
      }
      if (fileCount === 0) {
        fileList.innerHTML = '<div style="font-size:11px; color:var(--text-muted); padding:10px 0;">No shared documents</div>';
      }
    },

    // Emoji Picker Trigger
    _picmoPicker: null,
    initEmojiPicker() {
      const btn = document.getElementById('ls-emoji-btn');
      if (!btn) return;
      
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      
      newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleEmojiDrawer(newBtn);
      });
    },
    
    toggleEmojiDrawer(btn) {
      let container = document.getElementById('ls-emoji-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'ls-emoji-container';
        container.style.cssText = 'position:absolute; bottom:60px; left:16px; z-index:1000; box-shadow:0 10px 30px rgba(0,0,0,0.25); border-radius:12px; background:var(--card);';
        document.getElementById('ls-input-area').appendChild(container);
      }
      
      if (container.style.display === 'none' || !container.style.display) {
        container.style.display = 'block';
        if (!this._picmoPicker && typeof picmo !== 'undefined') {
          this._picmoPicker = picmo.createPicker({
            rootElement: container,
            theme: 'dark'
          });
          this._picmoPicker.addEventListener('emoji', (selection) => {
            const input = document.getElementById('ls-reply-input');
            if (input) input.value += selection.emoji;
            container.style.display = 'none';
          });
        }
        
        const closeHandler = () => {
          container.style.display = 'none';
          document.removeEventListener('click', closeHandler);
        };
        setTimeout(() => document.addEventListener('click', closeHandler), 10);
      } else {
        container.style.display = 'none';
      }
    },

    // Voice Recording Support
    mediaRecorder: null,
    audioChunks: [],
    isRecording: false,
    recordingTimer: null,
    recordingSeconds: 0,
    
    async toggleVoiceRecording() {
      if (this.isRecording) {
        this.stopRecording(true);
      } else {
        await this.startRecording();
      }
    },
    
    async startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(stream);
        this.audioChunks = [];
        this.mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) this.audioChunks.push(e.data);
        };
        this.mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          const file = new File([audioBlob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
          await this.uploadAudioFile(file);
        };
        this.mediaRecorder.start();
        this.isRecording = true;
        this.recordingSeconds = 0;
        document.getElementById('ls-voice-timer').style.display = 'inline';
        document.getElementById('ls-voice-cancel').style.display = 'inline';
        document.getElementById('ls-voice-btn').style.color = 'var(--danger)';
        this.recordingTimer = setInterval(() => {
          this.recordingSeconds++;
          const min = Math.floor(this.recordingSeconds / 60);
          const sec = String(this.recordingSeconds % 60).padStart(2, '0');
          document.getElementById('ls-voice-timer').textContent = `⏱️ ${min}:${sec}`;
        }, 1000);
      } catch (e) {
        panel.toast('Microphone access denied or unavailable', 'error');
      }
    },
    
    stopRecording(shouldUpload = true) {
      if (!this.isRecording) return;
      clearInterval(this.recordingTimer);
      this.isRecording = false;
      document.getElementById('ls-voice-timer').style.display = 'none';
      document.getElementById('ls-voice-cancel').style.display = 'none';
      document.getElementById('ls-voice-btn').style.color = '';
      
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        if (!shouldUpload) {
          this.mediaRecorder.onstop = null;
        }
        this.mediaRecorder.stop();
        this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
      }
    },
    
    cancelVoiceRecording() {
      this.stopRecording(false);
    },
    
    async uploadAudioFile(file) {
      panel.toast('Uploading voice note...', 'info');
      try {
        const resMsg = await fetch('/api/staff/support/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ conversationId: this.activeConversation.id, text: '' })
        });
        const dataMsg = await resMsg.json();
        if (!resMsg.ok) throw new Error(dataMsg.error);
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('messageId', dataMsg.message.id);
        
        const resAtt = await fetch('/api/support/attachments', {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
        if (resAtt.ok) {
          panel.toast('Voice note sent!', 'success');
          this.loadMessages(true);
          this.loadQueue();
        }
      } catch (e) {
        panel.toast('Failed to upload voice note', 'error');
        this.loadMessages(true);
      }
    },

    // Drag & Drop File Uploads
    initDragAndDrop() {
      const area = document.getElementById('ls-chat-panel');
      const overlay = document.getElementById('ls-drag-overlay');
      if (!area || !overlay) return;
      
      area.addEventListener('dragenter', (e) => {
        e.preventDefault();
        overlay.style.display = 'flex';
      });
      
      overlay.addEventListener('dragleave', (e) => {
        e.preventDefault();
        overlay.style.display = 'none';
      });
      
      overlay.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      
      overlay.addEventListener('drop', async (e) => {
        e.preventDefault();
        overlay.style.display = 'none';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          await this.uploadDroppedFile(e.dataTransfer.files[0]);
        }
      });
    },
    
    async uploadDroppedFile(file) {
      panel.toast('Uploading file...', 'info');
      try {
        const resMsg = await fetch('/api/staff/support/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ conversationId: this.activeConversation.id, text: '' })
        });
        const dataMsg = await resMsg.json();
        if (!resMsg.ok) throw new Error(dataMsg.error);
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('messageId', dataMsg.message.id);
        
        const resAtt = await fetch('/api/support/attachments', {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
        if (resAtt.ok) {
          panel.toast('Attachment uploaded successfully!', 'success');
          this.loadMessages(true);
          this.loadQueue();
        }
      } catch (e) {
        panel.toast('Upload failed', 'error');
        this.loadMessages(true);
      }
    },

    async handleFileUpload(e) {
      if (e.target.files && e.target.files[0]) {
        await this.uploadDroppedFile(e.target.files[0]);
      }
    }
  },

  // ==================== OTC MANAGEMENT ====================
  otcPaused: false,

  async loadOtcSettings() {
    const container = document.getElementById('otc-pairs-container');
    if (!container) return;
    container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:50px; color:var(--text-sec);">Loading OTC pair settings...</div>';
    
    try {
      const res = await fetch('/api/admin/otc/settings', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { this.toast(data.error || 'Failed to load OTC settings', 'error'); return; }
      
      const pairs = data.pairs || [];
      this.otcPaused = data.emergency_paused === true;
      
      // Update global pause button styling and text
      const pauseBtn = document.getElementById('otc-global-pause-btn');
      if (pauseBtn) {
        if (this.otcPaused) {
          pauseBtn.innerText = '▶ Resume Engine';
          pauseBtn.className = 'btn btn-success';
        } else {
          pauseBtn.innerText = '🚨 Emergency Pause';
          pauseBtn.className = 'btn btn-danger';
        }
      }

      if (pairs.length === 0) {
        container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:50px; color:var(--text-sec);">No OTC pairs configured in the database.</div>';
        return;
      }

      container.innerHTML = pairs.map(pair => {
        const symbol = pair.symbol;
        const safeSym = encodeURIComponent(symbol);
        const enabled = pair.enabled === 1;
        const visible = pair.visible === 1;
        const auto_mode = pair.auto_mode === 1;

        return `
          <div class="otc-card" id="otc-card-${safeSym}">
            <div class="otc-card-header">
              <span class="otc-pair-title">
                <span style="font-size:20px;">💱</span>
                ${symbol}
              </span>
              <span class="otc-status-badge ${pair.status === 'healthy' ? 'healthy' : 'paused'}">
                ${pair.status.toUpperCase()}
              </span>
            </div>

            <div class="otc-switch-row">
              <span class="otc-switch-label">Enabled / Active</span>
              <input type="checkbox" id="otc-enabled-${safeSym}" ${enabled ? 'checked' : ''} style="width:20px; height:20px;">
            </div>

            <div class="otc-switch-row">
              <span class="otc-switch-label">Visible to Users</span>
              <input type="checkbox" id="otc-visible-${safeSym}" ${visible ? 'checked' : ''} style="width:20px; height:20px;">
            </div>

            <div class="otc-form-grid">
              <div class="otc-form-group">
                <label class="otc-label">Engine Mode</label>
                <select id="otc-mode-${safeSym}" class="otc-select" onchange="panel.toggleOtcCardFields('${safeSym}')">
                  <option value="auto" ${auto_mode ? 'selected' : ''}>Auto (AI Mode)</option>
                  <option value="manual" ${!auto_mode ? 'selected' : ''}>Manual</option>
                </select>
              </div>

              <div class="otc-form-group otc-manual-field-${safeSym}" style="${auto_mode ? 'display:none;' : ''}">
                <label class="otc-label">Direction Bias</label>
                <select id="otc-bias-${safeSym}" class="otc-select">
                  <option value="neutral" ${pair.direction_bias === 'neutral' ? 'selected' : ''}>Neutral</option>
                  <option value="bullish" ${pair.direction_bias === 'bullish' ? 'selected' : ''}>Bullish</option>
                  <option value="bearish" ${pair.direction_bias === 'bearish' ? 'selected' : ''}>Bearish</option>
                </select>
              </div>

              <div class="otc-form-group otc-manual-field-${safeSym}" style="${auto_mode ? 'display:none;' : ''}">
                <label class="otc-label">Trend Strength</label>
                <input type="number" id="otc-strength-${safeSym}" class="otc-input" value="${pair.trend_strength}" step="0.01" min="0" max="1">
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Volatility Scale</label>
                <select id="otc-volatility-${safeSym}" class="otc-select">
                  <option value="very_low" ${pair.volatility === 'very_low' ? 'selected' : ''}>Very Low</option>
                  <option value="low" ${pair.volatility === 'low' ? 'selected' : ''}>Low</option>
                  <option value="medium" ${pair.volatility === 'medium' ? 'selected' : ''}>Medium</option>
                  <option value="high" ${pair.volatility === 'high' ? 'selected' : ''}>High</option>
                  <option value="very_high" ${pair.volatility === 'very_high' ? 'selected' : ''}>Very High</option>
                </select>
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Movement Speed</label>
                <select id="otc-speed-${safeSym}" class="otc-select">
                  <option value="slow" ${pair.speed === 'slow' ? 'selected' : ''}>Slow</option>
                  <option value="normal" ${pair.speed === 'normal' ? 'selected' : ''}>Normal</option>
                  <option value="fast" ${pair.speed === 'fast' ? 'selected' : ''}>Fast</option>
                </select>
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Price Offset</label>
                <input type="number" id="otc-offset-${safeSym}" class="otc-input" value="${pair.price_offset}" step="0.0001">
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Visual Spread</label>
                <input type="number" id="otc-spread-${safeSym}" class="otc-input" value="${pair.spread}" step="0.0001">
              </div>

              <div class="otc-form-group otc-manual-field-${safeSym}" style="${auto_mode ? 'display:none;' : ''}">
                <label class="otc-label">Noise Jitter</label>
                <input type="number" id="otc-noise-${safeSym}" class="otc-input" value="${pair.noise}" step="0.0001">
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Base Starting Price</label>
                <input type="number" id="otc-base-${safeSym}" class="otc-input" value="${pair.base_price}" step="0.01">
              </div>

              <div class="otc-form-group">
                <label class="otc-label">Schedule Hours</label>
                <select id="otc-schedule-${safeSym}" class="otc-select" onchange="panel.toggleOtcScheduleField('${safeSym}')">
                  <option value="always" ${pair.schedule_type === 'always' ? 'selected' : ''}>Always Available</option>
                  <option value="weekends" ${pair.schedule_type === 'weekends' ? 'selected' : ''}>Weekends Only</option>
                  <option value="custom" ${pair.schedule_type === 'custom' ? 'selected' : ''}>Custom Config</option>
                </select>
              </div>

              <div class="otc-form-group full-width otc-custom-sched-field-${safeSym}" style="${pair.schedule_type !== 'custom' ? 'display:none;' : ''}">
                <label class="otc-label">Custom Hours (JSON)</label>
                <input type="text" id="otc-sched-custom-${safeSym}" class="otc-input" value='${pair.schedule_custom || '{"days":[0,6],"startHour":0,"endHour":24}'}'>
              </div>
            </div>

            <div class="otc-card-actions">
              <button class="btn btn-secondary" onclick="panel.resetOtcPair('${safeSym}')" style="width:48% !important; height:34px; padding:0; font-size:12px;">Reset History</button>
              <button class="btn btn-primary" onclick="panel.saveOtcPairSettings('${safeSym}')" style="width:48% !important; height:34px; padding:0; font-size:12px;">Save Settings</button>
            </div>
          </div>
        `;
      }).join('');

    } catch (e) {
      container.innerHTML = '<div style="grid-column: 1/-1; text-align:center; padding:50px; color:var(--text-sec);">Error loading OTC settings from API.</div>';
    }
  },

  toggleOtcCardFields(safeSym) {
    const mode = document.getElementById(`otc-mode-${safeSym}`).value;
    const manualFields = document.querySelectorAll(`.otc-manual-field-${safeSym}`);
    manualFields.forEach(el => {
      el.style.display = (mode === 'manual') ? 'flex' : 'none';
    });
  },

  toggleOtcScheduleField(safeSym) {
    const sched = document.getElementById(`otc-schedule-${safeSym}`).value;
    const customField = document.querySelector(`.otc-custom-sched-field-${safeSym}`);
    if (customField) {
      customField.style.display = (sched === 'custom') ? 'flex' : 'none';
    }
  },

  async saveOtcPairSettings(safeSym) {
    const symbol = decodeURIComponent(safeSym);
    const body = {
      enabled: document.getElementById(`otc-enabled-${safeSym}`).checked,
      visible: document.getElementById(`otc-visible-${safeSym}`).checked,
      status: 'healthy',
      auto_mode: document.getElementById(`otc-mode-${safeSym}`).value === 'auto',
      direction_bias: document.getElementById(`otc-bias-${safeSym}`).value,
      trend_strength: parseFloat(document.getElementById(`otc-strength-${safeSym}`).value || 0),
      volatility: document.getElementById(`otc-volatility-${safeSym}`).value,
      speed: document.getElementById(`otc-speed-${safeSym}`).value,
      price_offset: parseFloat(document.getElementById(`otc-offset-${safeSym}`).value || 0),
      spread: parseFloat(document.getElementById(`otc-spread-${safeSym}`).value || 0.0001),
      noise: parseFloat(document.getElementById(`otc-noise-${safeSym}`).value || 0.0002),
      base_price: parseFloat(document.getElementById(`otc-base-${safeSym}`).value || 1.0),
      schedule_type: document.getElementById(`otc-schedule-${safeSym}`).value,
      schedule_custom: document.getElementById(`otc-sched-custom-${safeSym}`).value
    };

    try {
      const res = await fetch(`/api/admin/otc/settings/${safeSym}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Settings for ${symbol} saved successfully!`, 'success');
        this.loadOtcSettings();
      } else {
        this.toast(data.error || 'Failed to save settings', 'error');
      }
    } catch (e) {
      this.toast('Save request failed', 'error');
    }
  },

  async resetOtcPair(safeSym) {
    const symbol = decodeURIComponent(safeSym);
    if (!confirm(`Are you sure you want to reset the price and history of ${symbol}? This will wipe current charts for this pair.`)) return;
    
    try {
      const res = await fetch(`/api/admin/otc/reset/${safeSym}`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast(`Pair ${symbol} reset successfully!`, 'success');
      } else {
        this.toast(data.error || 'Failed to reset pair', 'error');
      }
    } catch (e) {
      this.toast('Reset request failed', 'error');
    }
  },

  async restartOtcEngine() {
    if (!confirm('Are you sure you want to restart the OTC Market Engine? This will reload all pairs from the database.')) return;
    
    try {
      const res = await fetch('/api/admin/otc/restart', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        this.toast('OTC Engine restarted successfully!', 'success');
        this.loadOtcSettings();
      } else {
        this.toast(data.error || 'Failed to restart engine', 'error');
      }
    } catch (e) {
      this.toast('Restart request failed', 'error');
    }
  },

  async toggleOtcPause() {
    const newPausedState = !this.otcPaused;
    
    try {
      const res = await fetch('/api/admin/otc/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paused: newPausedState })
      });
      const data = await res.json();
      if (res.ok) {
        this.otcPaused = data.paused;
        this.toast(newPausedState ? 'OTC Engine paused!' : 'OTC Engine resumed!', 'success');
        this.loadOtcSettings();
      } else {
        this.toast(data.error || 'Failed to toggle pause', 'error');
      }
    } catch (e) {
      this.toast('Pause request failed', 'error');
    }
  },

  // ==================== LEADERBOARD CUSTOMIZATION ====================
  async safeFetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('Server returned HTML. Please refresh your browser (Ctrl+F5) to clear cached scripts.');
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Server error occurred.');
    }
    return data;
  },

  async loadLeaderboardCustomization() {
    try {
      const data = await this.safeFetchJson('/api/admin/leaderboard-customization', { credentials: 'include' });
      
      this._currentLbEntries = data.entries || [];
      this._registeredUsers = data.registeredUsers || [];

      // Fill global settings
      if (data.settings) {
        const modeEl = document.getElementById('lb-setting-mode');
        const minEl = document.getElementById('lb-setting-min');
        const maxEl = document.getElementById('lb-setting-max');
        const autoEl = document.getElementById('lb-setting-auto-fluctuate');

        if (modeEl) modeEl.value = data.settings.mode || 'hybrid';
        if (minEl) minEl.value = data.settings.min_profit !== undefined ? data.settings.min_profit : 500;
        if (maxEl) maxEl.value = data.settings.max_profit !== undefined ? data.settings.max_profit : 25000;
        if (autoEl) autoEl.checked = data.settings.auto_fluctuate !== false;
      }

      // Fill user select dropdown in modal
      const userSelect = document.getElementById('lb-entry-user-select');
      if (userSelect) {
        userSelect.innerHTML = `<option value="">-- Create Custom Virtual Profile --</option>` +
          this._registeredUsers.map(u => `<option value="${u.id}">${this.esc(u.username)} (ID: ${u.id}${u.full_name ? ` - ${this.esc(u.full_name)}` : ''})</option>`).join('');
      }

      // Update count badge
      const badge = document.getElementById('lb-entries-count-badge');
      if (badge) badge.textContent = `${this._currentLbEntries.length} Entries`;

      // Render table rows
      const tbody = document.getElementById('leaderboard-entries-tbody');
      if (!tbody) return;

      if (this._currentLbEntries.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No custom leaderboard entries configured yet. Click "Add Custom Entry" above to add your first entry!</td></tr>`;
        return;
      }

      tbody.innerHTML = this._currentLbEntries.map((e, idx) => {
        const posText = e.position ? `<span class="badge badge-blue">#${e.position} Pinned</span>` : `<span class="badge badge-gray">Auto Sort</span>`;
        const profileType = e.user_id ? `<span class="badge badge-blue">Registered</span>` : `<span class="badge badge-green">Virtual</span>`;
        const isActive = (e.is_active === 1 || e.is_active === true);
        const statusBadge = isActive ? `<span class="badge badge-green">Active</span>` : `<span class="badge badge-gray">Disabled</span>`;
        const profitFormatted = `+$${parseFloat(e.net_profit || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        const avatarImg = e.avatar_url ? `<img src="${this.esc(e.avatar_url)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:8px;">` : `<div style="width:28px;height:28px;border-radius:50%;background:var(--primary);color:#000;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-right:8px;font-size:12px;">${e.username.charAt(0).toUpperCase()}</div>`;

        return `
          <tr>
            <td>${posText}</td>
            <td style="display:flex; align-items:center; font-weight:600;">
              ${avatarImg}
              <div>
                <div>${this.esc(e.username)}</div>
                ${e.full_name ? `<div style="font-size:11px; color:var(--text-muted);">${this.esc(e.full_name)}</div>` : ''}
              </div>
            </td>
            <td>${profileType}</td>
            <td style="font-weight:700;">${this.esc(e.country || 'US')}</td>
            <td style="font-weight:700; color:var(--primary);">${profitFormatted}</td>
            <td style="font-size:12px; font-weight:600;"><span style="color:var(--primary);">${e.won_trades}W</span> / <span style="color:var(--danger);">${e.lost_trades}L</span></td>
            <td>${statusBadge}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button class="btn-action btn-secondary" onclick="panel.editLeaderboardEntry(${e.id})" style="padding:4px 8px; font-size:11px;">Edit</button>
                <button class="btn-action ${isActive ? 'btn-danger' : 'btn-primary'}" onclick="panel.toggleLeaderboardEntry(${e.id}, ${isActive})" style="padding:4px 8px; font-size:11px;">${isActive ? 'Disable' : 'Enable'}</button>
                <button class="btn-action btn-danger" onclick="panel.deleteLeaderboardEntry(${e.id})" style="padding:4px 8px; font-size:11px;">Delete</button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async saveLeaderboardSettings(event) {
    event.preventDefault();
    try {
      const mode = document.getElementById('lb-setting-mode').value;
      const min_profit = document.getElementById('lb-setting-min').value;
      const max_profit = document.getElementById('lb-setting-max').value;
      const auto_fluctuate = document.getElementById('lb-setting-auto-fluctuate').checked;

      const data = await this.safeFetchJson('/api/admin/leaderboard-customization/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode, min_profit, max_profit, auto_fluctuate })
      });

      this.toast(data.message || 'Leaderboard settings saved successfully!', 'success');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  openAddLeaderboardModal() {
    document.getElementById('lb-modal-title').textContent = 'Add Custom Leaderboard Entry';
    document.getElementById('lb-entry-id').value = '';
    document.getElementById('lb-entry-user-select').value = '';
    document.getElementById('lb-entry-username').value = '';
    document.getElementById('lb-entry-fullname').value = '';
    document.getElementById('lb-entry-country').value = 'US';
    document.getElementById('lb-entry-position').value = '';
    document.getElementById('lb-entry-profit').value = '';
    document.getElementById('lb-entry-wins').value = '15';
    document.getElementById('lb-entry-losses').value = '2';
    document.getElementById('lb-entry-avatar').value = '';
    document.getElementById('lb-entry-active').checked = true;

    document.getElementById('modal-leaderboard-entry').classList.remove('hidden');
  },

  onLeaderboardUserSelect(userId) {
    if (!userId) return;
    const u = (this._registeredUsers || []).find(r => String(r.id) === String(userId));
    if (u) {
      document.getElementById('lb-entry-username').value = u.username;
      document.getElementById('lb-entry-fullname').value = u.full_name || '';
      document.getElementById('lb-entry-country').value = u.kyc_country || 'US';
    }
  },

  editLeaderboardEntry(id) {
    const entry = (this._currentLbEntries || []).find(e => Number(e.id) === Number(id));
    if (!entry) return;

    document.getElementById('lb-modal-title').textContent = 'Edit Leaderboard Entry';
    document.getElementById('lb-entry-id').value = entry.id;
    document.getElementById('lb-entry-user-select').value = entry.user_id || '';
    document.getElementById('lb-entry-username').value = entry.username;
    document.getElementById('lb-entry-fullname').value = entry.full_name || '';
    document.getElementById('lb-entry-country').value = entry.country || 'US';
    document.getElementById('lb-entry-position').value = entry.position || '';
    document.getElementById('lb-entry-profit').value = entry.net_profit;
    document.getElementById('lb-entry-wins').value = entry.won_trades;
    document.getElementById('lb-entry-losses').value = entry.lost_trades;
    document.getElementById('lb-entry-avatar').value = entry.avatar_url || '';
    document.getElementById('lb-entry-active').checked = (entry.is_active === 1 || entry.is_active === true);

    document.getElementById('modal-leaderboard-entry').classList.remove('hidden');
  },

  closeLeaderboardModal() {
    document.getElementById('modal-leaderboard-entry').classList.add('hidden');
  },

  async saveLeaderboardEntry(event) {
    event.preventDefault();
    try {
      const payload = {
        id: document.getElementById('lb-entry-id').value || null,
        user_id: document.getElementById('lb-entry-user-select').value || null,
        username: document.getElementById('lb-entry-username').value,
        full_name: document.getElementById('lb-entry-fullname').value,
        country: document.getElementById('lb-entry-country').value,
        position: document.getElementById('lb-entry-position').value || null,
        net_profit: document.getElementById('lb-entry-profit').value,
        won_trades: document.getElementById('lb-entry-wins').value,
        lost_trades: document.getElementById('lb-entry-losses').value,
        avatar_url: document.getElementById('lb-entry-avatar').value,
        is_active: document.getElementById('lb-entry-active').checked
      };

      const data = await this.safeFetchJson('/api/admin/leaderboard-customization/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      this.toast(data.message || 'Leaderboard entry saved successfully!', 'success');
      this.closeLeaderboardModal();
      this.loadLeaderboardCustomization();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async toggleLeaderboardEntry(id, currentActive) {
    const entry = (this._currentLbEntries || []).find(e => Number(e.id) === Number(id));
    if (!entry) return;

    try {
      const payload = {
        ...entry,
        is_active: !currentActive
      };

      const data = await this.safeFetchJson('/api/admin/leaderboard-customization/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      this.toast(currentActive ? 'Entry disabled' : 'Entry enabled', 'success');
      this.loadLeaderboardCustomization();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async deleteLeaderboardEntry(id) {
    if (!confirm('Are you sure you want to delete this custom leaderboard entry?')) return;
    try {
      const data = await this.safeFetchJson(`/api/admin/leaderboard-customization/entry/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      this.toast(data.message || 'Leaderboard entry deleted', 'success');
      this.loadLeaderboardCustomization();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  startBackgroundAlertPolling() {
    if (this.backgroundAlertInterval) clearInterval(this.backgroundAlertInterval);
    
    const checkStats = async () => {
      // Only poll if the user is authenticated and is admin/employee
      if (!this.user || (this.user.role !== 'admin' && this.user.role !== 'employee')) return;
      try {
        const res = await fetch('/api/admin/stats', { credentials: 'include' });
        if (!res.ok) return;
        const stats = await res.json();
        
        // Check for updates compared to previous tick
        if (this.lastPendingDeposits === null) {
          if (stats.pending_deposits > 0) {
            this.triggerStaffAlarm('deposit', `You have ${stats.pending_deposits} pending deposit request${stats.pending_deposits > 1 ? 's' : ''}.`);
          }
        } else if (stats.pending_deposits > this.lastPendingDeposits) {
          const diff = stats.pending_deposits - this.lastPendingDeposits;
          this.triggerStaffAlarm('deposit', `Received ${diff} new pending deposit request${diff > 1 ? 's' : ''}.`);
        }

        if (this.lastPendingWithdrawals === null) {
          if (stats.pending_withdrawals > 0) {
            this.triggerStaffAlarm('withdrawal', `You have ${stats.pending_withdrawals} pending withdrawal request${stats.pending_withdrawals > 1 ? 's' : ''}.`);
          }
        } else if (stats.pending_withdrawals > this.lastPendingWithdrawals) {
          const diff = stats.pending_withdrawals - this.lastPendingWithdrawals;
          this.triggerStaffAlarm('withdrawal', `Received ${diff} new pending withdrawal request${diff > 1 ? 's' : ''}.`);
        }

        const kycCount = stats.pending_kyc_list ? stats.pending_kyc_list.length : 0;
        if (this.lastPendingKycs === null) {
          if (kycCount > 0) {
            this.triggerStaffAlarm('kyc', `You have ${kycCount} pending KYC submission${kycCount > 1 ? 's' : ''}.`);
          }
        } else if (kycCount > this.lastPendingKycs) {
          const diff = kycCount - this.lastPendingKycs;
          this.triggerStaffAlarm('kyc', `Received ${diff} new pending KYC submission${diff > 1 ? 's' : ''}.`);
        }

        // Check for duplicate IP alerts
        const ipAlertsList = stats.ip_alerts || [];
        this.shownIpAlertIds = this.shownIpAlertIds || new Set();
        ipAlertsList.forEach(alert => {
          if (!this.shownIpAlertIds.has(alert.id)) {
            this.shownIpAlertIds.add(alert.id);
            this.triggerIpConflictAlarm(alert);
          }
        });

        // Update stored counts
        this.lastPendingDeposits = stats.pending_deposits;
        this.lastPendingWithdrawals = stats.pending_withdrawals;
        this.lastPendingKycs = kycCount;
      } catch (e) {
        console.error('Background alarm check failed:', e);
      }
    };

    // Run first check after a brief delay
    setTimeout(() => checkStats(), 2000);
    this.backgroundAlertInterval = setInterval(checkStats, 5000);
  },

  triggerStaffAlarm(type, message) {
    this.activeAlarmsCount++;
    this.startAlarmSound();

    const container = document.getElementById('staff-alarm-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `staff-alarm-toast type-${type}`;
    
    let icon = '🔔';
    let title = 'New Notification';
    let targetSection = 'dashboard';
    
    if (type === 'deposit') {
      icon = '💰';
      title = 'New Deposit Received';
      targetSection = 'deposits';
    } else if (type === 'withdrawal') {
      icon = '💸';
      title = 'New Withdrawal Request';
      targetSection = 'withdrawals';
    } else if (type === 'kyc') {
      icon = '📄';
      title = 'New KYC Submitted';
      targetSection = 'kyc';
    } else if (type === 'chat') {
      icon = '💬';
      title = 'New Live Support Chat';
      targetSection = 'live-support';
    }

    toast.innerHTML = `
      <div class="staff-alarm-header">
        <span class="staff-alarm-icon">${icon}</span>
        <span class="staff-alarm-title">${title}</span>
      </div>
      <div class="staff-alarm-body">${message}</div>
      <div class="staff-alarm-actions">
        <button class="staff-alarm-btn staff-alarm-btn-dismiss">Dismiss</button>
        <button class="staff-alarm-btn staff-alarm-btn-goto">Go To...</button>
      </div>
    `;

    container.appendChild(toast);

    const cleanup = () => {
      toast.style.opacity = '0';
      toast.style.transform = 'scale(0.9) translateX(20px)';
      setTimeout(() => {
        toast.remove();
      }, 300);
      
      this.activeAlarmsCount--;
      if (this.activeAlarmsCount <= 0) {
        this.activeAlarmsCount = 0;
        this.stopAlarmSound();
      }
    };

    // Bind action listeners
    toast.querySelector('.staff-alarm-btn-dismiss').addEventListener('click', () => {
      cleanup();
    });

    toast.querySelector('.staff-alarm-btn-goto').addEventListener('click', () => {
      cleanup();
      this.show(targetSection);
    });
  },

  triggerIpConflictAlarm(alert) {
    this.playShortIpAlertSound();

    const container = document.getElementById('staff-alarm-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'staff-alarm-toast type-kyc'; // Styled yellow/orange for warning warning
    toast.style.borderLeft = '4px solid #ef4444'; // Red highlight for high priority conflict
    
    toast.innerHTML = `
      <div class="staff-alarm-header" style="display:flex; justify-content:space-between; align-items:center;">
        <span class="staff-alarm-title" style="color:#ef4444; font-weight:700; display:inline-flex; align-items:center; gap:5px;">⚠️ IP Address Conflict</span>
      </div>
      <div class="staff-alarm-body" style="margin: 8px 0; font-size:12px; line-height:1.4;">
        New registration <strong>${this.esc(alert.username)}</strong> has matching IP address (<strong>${this.esc(alert.ip_address)}</strong>) with previous account <strong>${this.esc(alert.conflict_username)}</strong>.
      </div>
      <div class="staff-alarm-actions" style="margin-top: 8px; display:flex; gap:8px;">
        <button class="staff-alarm-btn staff-alarm-btn-dismiss" style="background:#ef4444; color:#fff; border:none; padding:4px 10px; border-radius:4px; font-weight:700; cursor:pointer;">Dismiss</button>
      </div>
    `;

    container.appendChild(toast);

    const dismissAlert = async () => {
      toast.style.opacity = '0';
      toast.style.transform = 'scale(0.9) translateX(20px)';
      setTimeout(() => {
        toast.remove();
      }, 300);

      try {
        await fetch(`/api/admin/ip-alerts/${alert.id}/dismiss`, { method: 'POST', credentials: 'include' });
      } catch (err) {
        console.error('Failed to dismiss IP alert:', err);
      }
    };

    toast.querySelector('.staff-alarm-btn-dismiss').addEventListener('click', () => {
      dismissAlert();
    });
  },

  playShortIpAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch(e) {}
  },

  startAlarmSound() {
    if (this.alarmInterval) return; // Sound is already running
    try {
      const initAudio = () => {
        if (!this.alarmInterval) return; // Stopped in the meantime
        if (!this.alarmAudioContext) {
          this.alarmAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        const playBeep = () => {
          if (!this.alarmAudioContext) return;
          try {
            if (this.alarmAudioContext.state === 'suspended') {
              this.alarmAudioContext.resume();
            }
            const osc = this.alarmAudioContext.createOscillator();
            const gain = this.alarmAudioContext.createGain();
            osc.connect(gain);
            gain.connect(this.alarmAudioContext.destination);
            
            osc.type = 'sawtooth';
            const now = this.alarmAudioContext.currentTime;
            
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.linearRampToValueAtTime(1300, now + 0.15);
            
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
            
            osc.start();
            osc.stop(now + 0.2);
          } catch(e) {}
        };
        
        playBeep();
        clearInterval(this.alarmInterval);
        this.alarmInterval = setInterval(playBeep, 200);
      };

      this.alarmInterval = true;
      initAudio();

      const resumeOnInteraction = () => {
        if (this.alarmAudioContext && this.alarmAudioContext.state === 'suspended') {
          this.alarmAudioContext.resume().then(() => {
            removeListeners();
          });
        } else {
          removeListeners();
        }
      };

      const removeListeners = () => {
        window.removeEventListener('click', resumeOnInteraction);
        window.removeEventListener('keydown', resumeOnInteraction);
      };

      window.addEventListener('click', resumeOnInteraction);
      window.addEventListener('keydown', resumeOnInteraction);

    } catch(e) {
      console.error('Failed to start alarm sound:', e);
    }
  },


  // ============================================================
  // ADMIN ACCOUNT SECURITY SETTINGS
  // ============================================================

  openAdminSettings() {
    const overlay = document.getElementById('as-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    // Reset to password tab
    this.asTab('pwd');
    // Load current profile
    this.asLoadProfile();
  },

  closeAdminSettings() {
    const overlay = document.getElementById('as-overlay');
    if (overlay) overlay.classList.remove('open');
    // Clear all form fields and messages
    ['as-cur-pwd','as-new-pwd','as-conf-pwd','as-new-email','as-email-otp','as-2fa-email-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    ['as-pwd-msg','as-email-req-msg','as-email-verify-msg','as-2fa-msg'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.className = 'as-msg'; el.textContent = ''; }
    });
    // Reset email tab to step 1
    const s1 = document.getElementById('as-email-step1');
    const s2 = document.getElementById('as-email-step2');
    if (s1) s1.style.display = '';
    if (s2) s2.style.display = 'none';
  },

  asTab(tab) {
    ['pwd','email','2fa'].forEach(t => {
      const btn = document.getElementById('as-tab-' + t);
      const panel = document.getElementById('as-panel-' + t);
      if (btn)   btn.classList.toggle('active',   t === tab);
      if (panel) panel.classList.toggle('active', t === tab);
    });
  },

  async asLoadProfile() {
    try {
      const res = await fetch('/api/admin-settings/profile', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const emailEl = document.getElementById('as-current-email');
      if (emailEl) emailEl.textContent = data.email ? 'Logged in as: ' + data.email : 'No email configured';
      // Set 2FA toggle state
      const toggle = document.getElementById('as-2fa-toggle');
      if (toggle) toggle.checked = !!data.two_fa_enabled;
      const emailInput = document.getElementById('as-2fa-email-input');
      if (emailInput) emailInput.value = data.two_fa_email || '';
    } catch (e) {
      console.warn('[AdminSettings] Profile load failed:', e);
    }
  },

  async asChangePwd() {
    const cur     = document.getElementById('as-cur-pwd')?.value || '';
    const newPwd  = document.getElementById('as-new-pwd')?.value || '';
    const confPwd = document.getElementById('as-conf-pwd')?.value || '';
    const msgEl   = document.getElementById('as-pwd-msg');
    const btn     = document.getElementById('as-pwd-btn');

    const setMsg = (txt, type) => {
      if (!msgEl) return;
      msgEl.textContent = txt;
      msgEl.className = 'as-msg show ' + type;
    };

    if (!cur || !newPwd || !confPwd) return setMsg('All fields are required.', 'error');
    if (newPwd !== confPwd)          return setMsg('New passwords do not match.', 'error');
    if (newPwd.length < 8)           return setMsg('Password must be at least 8 characters.', 'error');

    btn.disabled = true;
    btn.textContent = 'Updating...';
    if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }

    try {
      const res = await fetch('/api/admin-settings/change-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: newPwd, confirm_password: confPwd })
      });
      const data = await res.json();
      if (res.ok) {
        setMsg('✅ ' + data.message, 'success');
        document.getElementById('as-cur-pwd').value  = '';
        document.getElementById('as-new-pwd').value  = '';
        document.getElementById('as-conf-pwd').value = '';
      } else {
        setMsg('⚠ ' + (data.error || 'Failed to update password.'), 'error');
      }
    } catch (e) {
      setMsg('⚠ Network error. Please try again.', 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Update Password';
  },

  async asEmailRequest() {
    const email = document.getElementById('as-new-email')?.value?.trim() || '';
    const msgEl = document.getElementById('as-email-req-msg');
    const btn   = document.getElementById('as-email-req-btn');

    const setMsg = (txt, type) => {
      if (!msgEl) return;
      msgEl.textContent = txt;
      msgEl.className = 'as-msg show ' + type;
    };

    if (!email || !email.includes('@')) return setMsg('Enter a valid email address.', 'error');

    btn.disabled = true;
    btn.textContent = 'Sending...';
    if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }

    try {
      const res = await fetch('/api/admin-settings/change-email/request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_email: email })
      });
      const data = await res.json();
      if (res.ok) {
        // Move to step 2
        document.getElementById('as-email-step1').style.display = 'none';
        document.getElementById('as-email-step2').style.display = '';
        const m2 = document.getElementById('as-email-verify-msg');
        if (m2) { m2.textContent = '✅ ' + data.message; m2.className = 'as-msg show success'; }
      } else {
        setMsg('⚠ ' + (data.error || 'Failed to send code.'), 'error');
      }
    } catch (e) {
      setMsg('⚠ Network error.', 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Send Verification Code';
  },

  async asEmailVerify() {
    const otp   = document.getElementById('as-email-otp')?.value?.trim() || '';
    const msgEl = document.getElementById('as-email-verify-msg');
    const btn   = document.getElementById('as-email-verify-btn');

    const setMsg = (txt, type) => {
      if (!msgEl) return;
      msgEl.textContent = txt;
      msgEl.className = 'as-msg show ' + type;
    };

    if (!otp || otp.length < 6) return setMsg('Enter the 6-digit code from your email.', 'error');

    btn.disabled = true;
    btn.textContent = 'Verifying...';
    if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }

    try {
      const res = await fetch('/api/admin-settings/change-email/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      const data = await res.json();
      if (res.ok) {
        setMsg('✅ ' + data.message, 'success');
        // Update the subtitle
        const emailEl = document.getElementById('as-current-email');
        if (emailEl) emailEl.textContent = 'Logged in as: ' + data.new_email;
        // Reset back to step 1 after 2 seconds
        setTimeout(() => {
          document.getElementById('as-email-step1').style.display = '';
          document.getElementById('as-email-step2').style.display = 'none';
          document.getElementById('as-new-email').value = '';
          if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }
        }, 2500);
      } else {
        setMsg('⚠ ' + (data.error || 'Verification failed.'), 'error');
      }
    } catch (e) {
      setMsg('⚠ Network error.', 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Confirm Email Change';
  },

  asEmailBack() {
    document.getElementById('as-email-step1').style.display = '';
    document.getElementById('as-email-step2').style.display = 'none';
    const m = document.getElementById('as-email-verify-msg');
    if (m) { m.className = 'as-msg'; m.textContent = ''; }
  },

  as2faToggle(enabled) {
    // Just visual — actual save happens on "Save 2FA Settings" button
    const msgEl = document.getElementById('as-2fa-msg');
    if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }
  },

  async as2faSave() {
    const toggle   = document.getElementById('as-2fa-toggle');
    const emailEl  = document.getElementById('as-2fa-email-input');
    const msgEl    = document.getElementById('as-2fa-msg');
    const btn      = document.getElementById('as-2fa-save-btn');
    const enable   = toggle ? toggle.checked : false;
    const twoFaEmail = emailEl ? emailEl.value.trim() : '';

    const setMsg = (txt, type) => {
      if (!msgEl) return;
      msgEl.textContent = txt;
      msgEl.className = 'as-msg show ' + type;
    };

    btn.disabled = true;
    btn.textContent = 'Saving...';
    if (msgEl) { msgEl.className = 'as-msg'; msgEl.textContent = ''; }

    try {
      const res = await fetch('/api/admin-settings/2fa/toggle', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable, two_fa_email: twoFaEmail || undefined })
      });
      const data = await res.json();
      if (res.ok) {
        setMsg('✅ ' + data.message, 'success');
      } else {
        setMsg('⚠ ' + (data.error || 'Failed to save 2FA settings.'), 'error');
        if (toggle) toggle.checked = !enable; // revert toggle
      }
    } catch (e) {
      setMsg('⚠ Network error.', 'error');
      if (toggle) toggle.checked = !enable;
    }

    btn.disabled = false;
    btn.textContent = 'Save 2FA Settings';
  },

  // ---- 2FA Login Flow (triggered after password login if 2FA is enabled) ----

  async staff2faCheck() {
    // Called after successful password login — checks if this account has 2FA
    try {
      const res = await fetch('/api/admin-settings/profile', { credentials: 'include' });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.two_fa_enabled) {
        // Show 2FA screen and request OTP
        await this.staff2faShow(data.email_hint || '');
        return true; // 2FA required
      }
      return false; // No 2FA, proceed normally
    } catch (e) {
      console.warn('[2FA Check] Failed:', e);
      return false;
    }
  },

  async staff2faShow(emailHint) {
    const overlay = document.getElementById('staff-2fa-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const hintEl = document.getElementById('staff-2fa-hint-text');
    if (hintEl && emailHint) {
      hintEl.textContent = 'A 6-digit security code has been sent to ' + emailHint + '. Enter it below to continue.';
    }
    // Request OTP from server
    try {
      const res = await fetch('/api/admin-settings/2fa/request-otp', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.email_hint && hintEl) {
        hintEl.textContent = 'A 6-digit security code has been sent to ' + data.email_hint + '. Enter it below to continue.';
      }
    } catch (e) {
      console.warn('[2FA] Failed to request OTP:', e);
    }
    // Focus input
    setTimeout(() => {
      const input = document.getElementById('staff-2fa-code-input');
      if (input) input.focus();
    }, 100);
  },

  async staff2faVerify() {
    const input = document.getElementById('staff-2fa-code-input');
    const btn   = document.getElementById('staff-2fa-verify-btn');
    const errEl = document.getElementById('staff-2fa-err');
    const otp   = input ? input.value.trim() : '';

    if (!otp || otp.length < 6) {
      if (errEl) { errEl.textContent = 'Please enter the 6-digit code from your email.'; errEl.classList.add('show'); }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying...';
    if (errEl) errEl.classList.remove('show');

    try {
      const res = await fetch('/api/admin-settings/2fa/verify-session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp })
      });
      const data = await res.json();
      if (res.ok) {
        // 2FA passed — hide overlay and boot the panel
        const overlay = document.getElementById('staff-2fa-overlay');
        if (overlay) overlay.style.display = 'none';
        sessionStorage.setItem('staff_2fa_verified', '1');
        this.bootPanel();
      } else {
        if (errEl) { errEl.textContent = '⚠ ' + (data.error || 'Invalid code. Please try again.'); errEl.classList.add('show'); }
        if (input) { input.value = ''; input.focus(); }
      }
    } catch (e) {
      if (errEl) { errEl.textContent = '⚠ Network error. Please try again.'; errEl.classList.add('show'); }
    }

    btn.disabled = false;
    btn.textContent = 'Verify & Sign In';
  },

  async staff2faResend() {
    const errEl = document.getElementById('staff-2fa-err');
    const hintEl = document.getElementById('staff-2fa-hint-text');
    if (errEl) errEl.classList.remove('show');
    try {
      const res = await fetch('/api/admin-settings/2fa/request-otp', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        if (hintEl && data.email_hint) {
          hintEl.textContent = 'New code sent to ' + data.email_hint + '. Enter it below.';
        }
        const input = document.getElementById('staff-2fa-code-input');
        if (input) { input.value = ''; input.focus(); }
      } else {
        if (errEl) { errEl.textContent = '⚠ ' + (data.error || 'Could not resend code.'); errEl.classList.add('show'); }
      }
    } catch (e) {
      if (errEl) { errEl.textContent = '⚠ Network error.'; errEl.classList.add('show'); }
    }
  },

  stopAlarmSound() {
    if (this.alarmInterval) {
      if (this.alarmInterval !== true) {
        clearInterval(this.alarmInterval);
      }
      this.alarmInterval = null;
    }
    if (this.alarmAudioContext) {
      try {
        this.alarmAudioContext.close();
      } catch(e) {}
      this.alarmAudioContext = null;
    }
  },
};

// Expose panel globally so inline HTML handlers can always access it
window.panel = panel;

// Start the panel when DOM is ready
document.addEventListener('DOMContentLoaded', () => panel.init());

