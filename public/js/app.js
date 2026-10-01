// Intercept all local API fetch calls to include credentials and support Authorization header fallback
const originalFetch = window.fetch;
window.fetch = function (url, options) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    options = options || {};
    options.credentials = 'include';

    // Inject Authorization header if token exists in localStorage
    try {
      const token = localStorage.getItem('token');
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
      console.warn('LocalStorage token fetch failed:', e);
    }
  }
  return originalFetch(url, options);
};

const app = {
  user: null,
  permissions: null,
  activeTab: 'dashboard',
  activeAdminSection: 'users',
  activeWalletSection: 'deposit',
  activeHistorySection: 'all',
  notificationsList: null,
  unreadNotificationsCount: 0,
  prevTab: null,

  togglePassword(inputId, buttonEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      buttonEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    } else {
      input.type = 'password';
      buttonEl.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    }
  },

  CURRENCY_SYMBOLS: {
    USD: '$',
    EUR: '€',
    GBP: '£',
    INR: '₹',
    PKR: '₨',
    BDT: '৳',
    NPR: '₨',
    AUD: 'A$',
    CAD: 'C$',
    AED: 'د.إ',
    SAR: 'ر.س',
    RUB: '₽',
    TRY: '₺',
    CNY: '¥',
    JPY: '¥',
    BRL: 'R$',
    IDR: 'Rp',
    MYR: 'RM',
    KZT: '₸',
    THB: '฿',
    UAH: '₴',
    VND: '₫',
    NGN: '₦',
    EGP: 'E£',
    MXN: 'MX$',
    PHP: '₱',
    KRW: '₩'
  },

  formatCurrency(amount, currencyCode) {
    const code = (currencyCode || 'USD').toUpperCase();
    const symbol = this.CURRENCY_SYMBOLS[code] || (code + ' ');
    const num = parseFloat(amount || 0);
    const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${symbol}${formatted}`;
  },

  esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  async compressImage(file, maxWidth = 1024, maxHeight = 1024, quality = 0.7) {
    if (!file || !file.type.startsWith('image/')) {
      return file;
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > maxWidth) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            }
          } else {
            if (height > maxHeight) {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob((blob) => {
            if (!blob) {
              resolve(file);
              return;
            }
            const compressedFile = new File([blob], file.name, {
              type: 'image/jpeg',
              lastModified: Date.now()
            });
            resolve(compressedFile);
          }, 'image/jpeg', quality);
        };
        img.onerror = () => resolve(file);
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(file);
      reader.readAsDataURL(file);
    });
  },

  getTradeDisplayAmount(trade, targetCurrency) {
    if (!trade) return 0;
    const currentCode = (targetCurrency || (this.user ? this.user.currency : 'USD')).toUpperCase().trim();
    
    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
      EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
      IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
      THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
      PHP: 58.0, KRW: 1380.0
    };

    const origCurr = (trade.currency || 'USD').toUpperCase().trim();

    // If trade currency equals current active currency, use exact trade.amount
    if (origCurr === currentCode && Number(trade.amount) > 0) {
      return Number(trade.amount);
    }

    // Original USD stake of the trade
    let usdStake = 0;
    if (trade.amount_usd !== null && trade.amount_usd !== undefined && Number(trade.amount_usd) > 0) {
      usdStake = Number(trade.amount_usd);
    } else {
      const origRate = DEFAULT_CURRENCY_RATES[origCurr] || 1.0;
      usdStake = Number(trade.amount || 0) / origRate;
    }

    // Convert usdStake to currentCode
    let targetRate = DEFAULT_CURRENCY_RATES[currentCode] || 1.0;
    if (this.lastWalletData && this.lastWalletData.currency === currentCode && this.lastWalletData.rate) {
      const parsedRate = parseFloat(this.lastWalletData.rate);
      if (!isNaN(parsedRate) && parsedRate > 0) targetRate = parsedRate;
    }

    return usdStake * targetRate;
  },

  formatTradeAmount(trade, targetCurrency) {
    const code = (targetCurrency || (this.user ? this.user.currency : 'USD')).toUpperCase().trim();
    const convertedVal = this.getTradeDisplayAmount(trade, code);
    return this.formatCurrency(convertedVal, code);
  },

  updateNavIndicator() {
    if (window.innerWidth >= 768) return;
    const activeNav = document.querySelector('.nav-item.active');
    const navBar = document.getElementById('app-nav');
    const circle = navBar ? navBar.querySelector('.nav-indicator-circle') : null;
    const navBg = navBar ? navBar.querySelector('.nav-bg-container') : null;
    
    if (activeNav && navBar && circle) {
      if (navBg) navBg.style.display = '';
      circle.style.display = '';

      // Position the circle and notch under the active tab
      const navRect = navBar.getBoundingClientRect();
      const activeRect = activeNav.getBoundingClientRect();
      
      // If layout isn't fully rendered/calculated yet, schedule a retry
      if (activeRect.width === 0 || navRect.width === 0) {
        setTimeout(() => this.updateNavIndicator(), 50);
        return;
      }

      const activeX = (activeRect.left - navRect.left) + (activeRect.width / 2);
      navBar.style.setProperty('--active-x', `${activeX}px`);

      // Clear any previously cloned icon inside the circle
      circle.innerHTML = '';

      // Clone the active icon SVG and place it inside the circle
      const iconWrapper = activeNav.querySelector('.nav-icon-wrapper svg');
      if (iconWrapper) {
        const svgClone = iconWrapper.cloneNode(true);
        svgClone.setAttribute('width', '26');
        svgClone.setAttribute('height', '26');
        svgClone.style.width = '26px';
        svgClone.style.height = '26px';
        svgClone.style.fill = 'var(--bg-main)';
        svgClone.style.display = 'block';
        svgClone.style.flexShrink = '0';
        circle.appendChild(svgClone);
      }
    } else {
      // Cleanly hide the circle and notch when no navigation button is active
      if (circle) circle.style.display = 'none';
      if (navBg) navBg.style.display = 'none';
    }
  },
  
  // Timer references
  priceTickerInterval: null,
  activeTradeIntervals: {},
  adminTradesInterval: null,
  clockLabelInterval: null,

  notifiedTradeIds: null,
  pollingTradeIds: null,
  lastActiveTrades: null,

  // Selected state on Trade tab
  selectedDuration: 30,
  selectedClockTime: null,
  timeMode: 'countdown', // 'countdown' or 'clock'
  popoverTab: 'timer',
  tradeOptions: [],
  visibleCoins: [],
  selectedCoin: 'BTC',
  tabs: ['BTC'],
  tabSessions: {},
  allCryptoCoins: [],
  allForexPairs: [],
  currentPickerTab: 'crypto',
  stakeMode: 'amount', // 'amount' or 'percent'
  stakePercent: 10, // default 10%
  accountType: 'real', // 'demo' or 'real'
  pendingTrades: [],
  pendingMode: 'quote',

  // ─── Preferences Persistence ──────────────────────────────────────────────
  _PREFS_KEY: 'gainex_trade_prefs_v3',
  _PREFS_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days

  _saveTradePrefs() {
    try {
      const prefs = {
        selectedCoin:     this.selectedCoin,
        accountType:      this.accountType,
        selectedDuration: this.selectedDuration,
        timeMode:         this.timeMode,
        stakeMode:        this.stakeMode,
        stakePercent:     this.stakePercent,
        activeTimeframe:  (window.chart && window.chart.activeTimeframe) ? window.chart.activeTimeframe : '1m',
        _savedAt:         Date.now()
      };
      localStorage.setItem(this._PREFS_KEY, JSON.stringify(prefs));
    } catch (e) { /* localStorage unavailable */ }
  },

  _loadTradePrefs() {
    try {
      const raw = localStorage.getItem(this._PREFS_KEY);
      if (!raw) return null;
      const prefs = JSON.parse(raw);
      if (!prefs || !prefs._savedAt) return null;
      if (Date.now() - prefs._savedAt > this._PREFS_TTL_MS) {
        localStorage.removeItem(this._PREFS_KEY);
        return null;
      }
      return prefs;
    } catch (e) { return null; }
  },
  // ──────────────────────────────────────────────────────────────────────────


  // Init application
  init() {
    // Initialize Theme
    const savedTheme = localStorage.getItem('gainex_theme') || 'light';
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
      const toggleBtn = document.getElementById('settings-toggle-darkmode');
      if (toggleBtn) toggleBtn.checked = false;
      this.updateLogoImages('light');
    } else {
      document.body.classList.remove('light-theme');
      const toggleBtn = document.getElementById('settings-toggle-darkmode');
      if (toggleBtn) toggleBtn.checked = true;
      this.updateLogoImages('dark');
    }

    // Initialize Timezone settings
    const savedTz = localStorage.getItem('gainex_timezone') || 'AUTO';
    const tzSelect = document.getElementById('settings-select-timezone');
    if (tzSelect) tzSelect.value = savedTz;

    // Initialize Language settings
    this.activeLang = localStorage.getItem('lang') || 'en';
    setTimeout(() => {
      document.querySelectorAll('.lang-item').forEach(item => {
        const check = item.querySelector('.lang-check');
        if (check) {
          if (item.getAttribute('data-lang') === this.activeLang) {
            check.style.display = 'block';
          } else {
            check.style.display = 'none';
          }
        }
      });
      this.translatePage();
    }, 100);

    this.pendingTrades = JSON.parse(localStorage.getItem('pendingTrades') || '[]');
    this.loadNotificationsFromStorage();
    this.checkSession();
    this.initFloatingBotWidget();
    this.startBotActiveStatusPolling();
    this.initializeGoogleSignIn();

    // Mobile Viewport Zoom Prevention & iOS Elastic Scroll-Bounce Lock
    // Disable multi-touch pinch zoom on mobile devices, except inside the chart canvas wrapper
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) {
        if (!e.target.closest('#chart-canvas-wrap')) {
          e.preventDefault();
        }
      }
    }, { passive: false });

    // Prevent double-tap zoom on all layout elements except the chart canvas
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        if (!e.target.closest('#chart-canvas-wrap')) {
          e.preventDefault();
        }
      }
      lastTouchEnd = now;
    }, { passive: false });

    // Block non-chart gesture zoom
    document.addEventListener('gesturestart', (e) => {
      if (!e.target.closest('#chart-canvas-wrap')) {
        e.preventDefault();
      }
    });
    document.addEventListener('gesturechange', (e) => {
      if (!e.target.closest('#chart-canvas-wrap')) {
        e.preventDefault();
      }
    });

    // Prevent iOS page bounce/drag scroll while preserving scrolling inside actual scrollable boxes
    document.addEventListener('touchmove', (e) => {
      // Allow multi-touch zoom/panning only on chart canvas
      if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) {
        if (!e.target.closest('#chart-canvas-wrap')) {
          e.preventDefault();
        }
        return;
      }

      // Check if touch target is inside a scrollable container
      let isScrollable = false;
      let el = e.target;
      while (el && el !== document.body) {
        // Let trading chart handle touch events natively
        if (el.id === 'chart-canvas-wrap' || el.closest('#chart-canvas-wrap')) {
          return;
        }

        const style = window.getComputedStyle(el);
        const overflowY = style.getPropertyValue('overflow-y');
        const isScrollableEl = (overflowY === 'auto' || overflowY === 'scroll') && (el.scrollHeight > el.clientHeight);
        if (isScrollableEl) {
          isScrollable = true;
          break;
        }
        el = el.parentElement;
      }

      // Prevent body elastic bounce scroll if not inside a scrollable container
      if (!isScrollable) {
        e.preventDefault();
      }
    }, { passive: false });

    // Close dropdowns when clicking outside
    window.addEventListener('click', (e) => {
      const balMenu = document.getElementById('balance-dropdown-menu');
      if (balMenu) balMenu.style.display = 'none';

      // Close timeframe dropdown if click is outside
      const tfWrap = document.querySelector('.tf-dropdown-wrap');
      const tfMenu = document.getElementById('tf-dropdown-menu');
      if (tfMenu && tfWrap && !tfWrap.contains(e.target)) {
        tfMenu.style.display = 'none';
      }

      // Close chart style menu if click is outside
      const csWrap = document.querySelector('.chart-style-wrap');
      const csMenu = document.getElementById('chart-style-menu');
      if (csMenu && csWrap && !csWrap.contains(e.target)) {
        csMenu.style.display = 'none';
      }

      // Close mobile trade bag panel if click is outside
      const tradesPanel = document.querySelector('.tc-trades-panel-mobile-container');
      const tradesToggleBtn = document.querySelector('.btn-active-trades');
      if (tradesPanel && tradesPanel.classList.contains('expanded')) {
        if (!tradesPanel.contains(e.target) && (!tradesToggleBtn || !tradesToggleBtn.contains(e.target))) {
          tradesPanel.classList.remove('expanded');
        }
      }

      // Close timer popover if click is outside
      const timePopover = document.getElementById('tc-time-popover');
      const timeCard = document.getElementById('tc-time-group-card');
      if (timePopover && timePopover.classList.contains('active')) {
        if (!timePopover.contains(e.target) && (!timeCard || !timeCard.contains(e.target))) {
          timePopover.classList.remove('active');
        }
      }

      // Close custom select dropdown if click is outside
      const customSelectContainer = document.getElementById('deposit-custom-select-container');
      if (customSelectContainer && !customSelectContainer.contains(e.target)) {
        customSelectContainer.classList.remove('open');
      }
      const withdrawSelectContainer = document.getElementById('withdraw-custom-select-container');
      if (withdrawSelectContainer && !withdrawSelectContainer.contains(e.target)) {
        withdrawSelectContainer.classList.remove('open');
      }

      // Close kyc country dropdown if click is outside
      const kycCountryContainer = document.getElementById('kyc-country-custom-container');
      if (kycCountryContainer && !kycCountryContainer.contains(e.target)) {
        kycCountryContainer.classList.remove('open');
      }

      // Close swap custom dropdowns if click is outside
      const swapPayMenu = document.getElementById('swap-pay-menu');
      const swapRecMenu = document.getElementById('swap-receive-menu');
      const payWrap = document.getElementById('swap-pay-menu')?.closest('.swap-dropdown-wrapper');
      const recWrap = document.getElementById('swap-receive-menu')?.closest('.swap-dropdown-wrapper');
      
      if (swapPayMenu && payWrap && !payWrap.contains(e.target)) {
        swapPayMenu.style.display = 'none';
        const payArrow = document.getElementById('swap-pay-arrow');
        if (payArrow) payArrow.style.transform = 'rotate(0deg)';
        const payCard = document.getElementById('swap-pay-select')?.closest('.swap-card');
        if (payCard) payCard.style.zIndex = '1';
      }
      if (swapRecMenu && recWrap && !recWrap.contains(e.target)) {
        swapRecMenu.style.display = 'none';
        const recArrow = document.getElementById('swap-receive-arrow');
        if (recArrow) recArrow.style.transform = 'rotate(0deg)';
        const recCard = document.getElementById('swap-receive-select')?.closest('.swap-card');
        if (recCard) recCard.style.zIndex = '1';
      }
    });

    this.initResizers();
    this.updateBellBadge();
    this.loadPublicDocuments();
    this.loadPublicOnboarding();
    this.loadCurrencies();

    // Auto-fill invite code from URL or stored referral code if present
    this.applyInviteCodeFromURLOrStorage();
    const initialTab = this.getTabFromPath();
    const urlParams = new URLSearchParams(window.location.search);
    const hasRef = urlParams.get('ref') || urlParams.get('invite') || urlParams.get('code') || urlParams.get('r');
    if (initialTab === 'signup' || (hasRef && initialTab !== 'login')) {
      this.showScreen('signup');
    }

    // Update nav indicator on load and resize
    this.updateNavIndicator();
    this.handleMobileCardsLayout();
    this.updateSupportFloatVisibility();
    window.addEventListener('resize', () => {
      this.updateNavIndicator();
      this.handleMobileCardsLayout();
      this.updateSupportFloatVisibility();
    });

    // Listen for back/forward buttons
    window.addEventListener('popstate', (e) => {
      const tab = (e.state && e.state.tab) || this.getTabFromPath();
      const isAuthTab = tab === 'login' || tab === 'signup' || tab === 'onboarding';
      if (isAuthTab) {
        this.showScreen(tab);
      } else {
        this.navigateTo(tab, { popstate: true });
      }
    });

    // Initialize dynamic market sentiment pressure bar
    this.initMarketSentimentPressure();
    this.initLiveClock();
  },

  initMarketSentimentPressure() {
    // Dynamic real-time sentiment pressure is driven directly by chart.js LERP animation loop.
  },

  initLiveClock() {
    const timeEl = document.getElementById('live-clock-time-text');
    const tzEl = document.getElementById('live-clock-tz-text');
    if (!timeEl || !tzEl) return;

    let lastDisplayDay = null;

    const updateClock = () => {
      const now = new Date();
      let displayDate = now;
      const selectedTz = localStorage.getItem('gainex_timezone') || 'AUTO';
      let tzText = '';

      if (selectedTz === 'AUTO') {
        const offsetMinutes = now.getTimezoneOffset();
        if (offsetMinutes === 0) {
          tzText = 'UTC';
        } else {
          const sign = offsetMinutes > 0 ? '-' : '+';
          const absOffset = Math.abs(offsetMinutes);
          const offsetHours = Math.floor(absOffset / 60);
          const offsetRemainingMinutes = absOffset % 60;
          if (offsetRemainingMinutes > 0) {
            tzText = `UTC${sign}${offsetHours}:${String(offsetRemainingMinutes).padStart(2, '0')}`;
          } else {
            tzText = `UTC${sign}${offsetHours}`;
          }
        }
        displayDate = now;
      } else {
        tzText = selectedTz;
        const match = selectedTz.match(/UTC([+-])(\d{2}):(\d{2})/);
        if (match) {
          const sign = match[1] === '+' ? 1 : -1;
          const hours = parseInt(match[2], 10);
          const minutes = parseInt(match[3], 10);
          const offsetMs = sign * (hours * 60 + minutes) * 60 * 1000;
          const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
          displayDate = new Date(utcMs + offsetMs);
        }
      }

      const hours = String(displayDate.getHours()).padStart(2, '0');
      const minutes = String(displayDate.getMinutes()).padStart(2, '0');
      const seconds = String(displayDate.getSeconds()).padStart(2, '0');
      
      timeEl.textContent = `${hours}:${minutes}:${seconds}`;
      tzEl.textContent = tzText;

      // Reset leaderboard dynamically when Pakistan Time (UTC+05:00) crosses midnight
      const pktOffsetMs = 5 * 60 * 60 * 1000;
      const utcMs = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
      const pktDate = new Date(utcMs + pktOffsetMs);
      const currentPktDay = pktDate.getDate();

      if (lastDisplayDay !== null && currentPktDay !== lastDisplayDay) {
        // Pakistan Time midnight crossed! Reload leaderboard data immediately
        if (typeof this.loadLeaderboardData === 'function') {
          this.loadLeaderboardData();
        }
        if (typeof this.loadLeaderboardDrawerData === 'function') {
          this.loadLeaderboardDrawerData();
        }
      }
      lastDisplayDay = currentPktDay;

      this.checkPendingTradesTrigger('time');
    };

    updateClock();
    setInterval(updateClock, 1000);
  },

  updateSupportFloatVisibility() {
    const btn = document.getElementById("support-float-btn");
    if (!btn) return;

    const isMobile = window.innerWidth < 768;
    const isAuthScreen = !!document.querySelector('.auth-screen.active-screen');

    if (isMobile || isAuthScreen) {
      btn.style.display = 'none';
    } else {
      // Show ONLY if it has been minimized (floatVisible is true) and the widget itself is not currently open
      const isMinimizedVisible = app.supportChat && app.supportChat.floatVisible;
      const isWidgetOpen = app.supportChat && app.supportChat.isOpen;
      if (isMinimizedVisible && !isWidgetOpen) {
        btn.style.display = 'flex';
      } else {
        btn.style.display = 'none';
      }
    }
  },

  updateBellBadge() {
    const count = this.unreadNotificationsCount || 0;
    const badges = document.querySelectorAll('.bell-badge, .notification-badge');
    badges.forEach(badge => {
      badge.textContent = count;
      if (count === 0) {
        badge.style.display = 'none';
      } else {
        badge.style.display = 'inline-block';
      }
    });
  },

  showChartNotification(type, message) {
    const container = document.getElementById('chart-notification-container');
    if (!container) return;

    // Smoothly animate out any existing notifications
    const existingNotifs = container.querySelectorAll('.chart-notification');
    existingNotifs.forEach(oldNotif => {
      if (!oldNotif.classList.contains('fade-out')) {
        oldNotif.classList.remove('show');
        oldNotif.classList.add('fade-out');
        setTimeout(() => oldNotif.remove(), 350);
      }
    });

    const notif = document.createElement('div');
    const isRed = type === 'lose';
    notif.className = `chart-notification ${isRed ? 'notif-red' : 'notif-green'}`;

    // Solid SVG icons based on type
    let iconSvg = '';
    if (type === 'open') {
      // Solid Lightning Bolt SVG
      iconSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="display:block;"><path d="M19 11h-6V3a1 1 0 0 0-1.707-.707l-9 9A1 1 0 0 0 3 13h6v8a1 1 0 0 0 1.707.707l9-9A1 1 0 0 0 19 11z"/></svg>`;
    } else if (type === 'win') {
      // Solid Checkmark SVG
      iconSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="display:block; stroke: currentColor; stroke-width: 1.2;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    } else if (type === 'lose') {
      // Solid Close/Cross SVG
      iconSvg = `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" style="display:block; stroke: currentColor; stroke-width: 1.5;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    }

    notif.innerHTML = `
      <span class="notif-icon">${iconSvg}</span>
      <span class="notif-message">${message}</span>
      <button class="notif-close-btn">
        <svg viewBox="0 0 24 24" width="8" height="8" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;

    // Close button click handler
    const closeBtn = notif.querySelector('.notif-close-btn');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (notif.parentNode) {
          notif.classList.remove('show');
          notif.classList.add('fade-out');
          setTimeout(() => notif.remove(), 350);
        }
      };
    }

    container.appendChild(notif);

    // Force reflow to trigger transition
    notif.offsetHeight;

    // Slide/fade in
    notif.classList.add('show');

    this.saveNotificationToHistory(type, message);

    // Auto-remove after 5 seconds with animation
    setTimeout(() => {
      if (notif.parentNode && notif.classList.contains('show')) {
        notif.classList.remove('show');
        notif.classList.add('fade-out');
        setTimeout(() => notif.remove(), 350);
      }
    }, 5000);
  },

  showGlobalLoader() {
    const loader = document.getElementById('global-page-loader');
    if (!loader) return;
    loader.classList.add('visible');
    // Force reflow
    loader.offsetHeight;
    loader.classList.add('active');
  },

  hideGlobalLoader() {
    const loader = document.getElementById('global-page-loader');
    if (!loader) return;
    loader.classList.remove('active');
    // Wait for transition to complete
    setTimeout(() => {
      if (!loader.classList.contains('active')) {
        loader.classList.remove('visible');
      }
    }, 250);
  },

  getNotificationsKey() {
    if (this.user && this.user.id) {
      return `gainex_notifications_${this.user.id}`;
    }
    return 'gainex_notifications_guest';
  },

  getUnreadNotificationsKey() {
    if (this.user && this.user.id) {
      return `gainex_unread_notifications_${this.user.id}`;
    }
    return 'gainex_unread_notifications_guest';
  },

  loadNotificationsFromStorage() {
    const notifKey = this.getNotificationsKey();
    const countKey = this.getUnreadNotificationsKey();
    this.notificationsList = JSON.parse(localStorage.getItem(notifKey) || '[]');
    this.unreadNotificationsCount = parseInt(localStorage.getItem(countKey) || '0');
    this.updateBellBadge();
  },

  saveNotificationToHistory(type, message) {
    const ignoredKeywords = [
      'theme',
      'theme enabled',
      'dark mode',
      'light mode',
      'mode enabled',
      'placed a trade',
      'trade placed',
      'trade opened',
      'opened trade',
      'contract on',
      'won',
      'lost',
      'win',
      'lose'
    ];

    const msgLower = (message || '').toLowerCase();
    const shouldIgnore = ignoredKeywords.some(keyword => msgLower.includes(keyword)) || ['trade-up', 'trade-down', 'trade-win', 'trade-lose', 'win', 'lose'].includes(type);

    if (shouldIgnore) {
      return;
    }

    const notifKey = this.getNotificationsKey();
    const countKey = this.getUnreadNotificationsKey();

    if (!this.notificationsList) {
      this.notificationsList = JSON.parse(localStorage.getItem(notifKey) || '[]');
    }

    const newNotif = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      type: type,
      message: message,
      timestamp: new Date().toISOString(),
      read: false
    };

    this.notificationsList.unshift(newNotif);

    if (this.notificationsList.length > 100) {
      this.notificationsList.pop();
    }

    localStorage.setItem(notifKey, JSON.stringify(this.notificationsList));

    if (this.activeTab !== 'notifications') {
      this.unreadNotificationsCount = (this.unreadNotificationsCount || 0) + 1;
      localStorage.setItem(countKey, this.unreadNotificationsCount.toString());
      this.updateBellBadge();
    }
  },

  toggleNotificationsDropdown(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    // Find the relative dropdown
    const btn = event.currentTarget || event.target.closest('.trade-bell-btn') || event.target.closest('.notification-btn');
    if (!btn) return;
    
    const container = btn.closest('.bell-dropdown-container');
    if (!container) return;
    
    const dropdown = container.querySelector('.notifications-dropdown');
    if (!dropdown) return;
    
    const isVisible = dropdown.style.display === 'block';
    
    // Hide all dropdowns
    document.querySelectorAll('.notifications-dropdown').forEach(d => d.style.display = 'none');
    
    if (isVisible) {
      dropdown.style.display = 'none';
    } else {
      dropdown.style.display = 'block';
      this.loadNotificationsHistory();
      
      const closeDropdown = (e) => {
        if (!dropdown.contains(e.target) && !e.target.closest('.trade-bell-btn') && !e.target.closest('.notification-btn')) {
          dropdown.style.display = 'none';
          document.removeEventListener('click', closeDropdown);
        }
      };
      
      setTimeout(() => {
        document.addEventListener('click', closeDropdown);
      }, 50);
    }
  },

  clearAllNotifications(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const notifKey = this.getNotificationsKey();
    const countKey = this.getUnreadNotificationsKey();
    
    this.notificationsList = [];
    localStorage.setItem(notifKey, '[]');
    this.unreadNotificationsCount = 0;
    localStorage.setItem(countKey, '0');
    
    this.updateBellBadge();
    this.loadNotificationsHistory();
  },

  loadNotificationsHistory() {
    const list = document.getElementById('notifications-list-container');
    const dropdownLists = document.querySelectorAll('.notifications-dropdown-list');
    if (!list && dropdownLists.length === 0) return;

    const notifKey = this.getNotificationsKey();
    const countKey = this.getUnreadNotificationsKey();

    if (!this.notificationsList) {
      this.notificationsList = JSON.parse(localStorage.getItem(notifKey) || '[]');
    }

    // Mark all as read
    this.notificationsList.forEach(n => n.read = true);
    localStorage.setItem(notifKey, JSON.stringify(this.notificationsList));

    this.unreadNotificationsCount = 0;
    localStorage.setItem(countKey, '0');
    this.updateBellBadge();

    const emptyHtml = `<div style="text-align: center; color: #8e9297; padding: 24px 0; font-size: 13px;">No notifications yet.</div>`;

    if (list) list.innerHTML = '';
    dropdownLists.forEach(dl => dl.innerHTML = '');

    if (this.notificationsList.length === 0) {
      if (list) list.innerHTML = emptyHtml;
      dropdownLists.forEach(dl => dl.innerHTML = emptyHtml);
      return;
    }

    this.notificationsList.forEach(n => {
      const item = document.createElement('div');
      item.className = 'history-transaction-card notification-history-item';

      let iconHtml = '';
      let iconBgClass = '';

      if (n.type === 'win') {
        iconBgClass = 'icon-bg-inflow';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
          </svg>
        `;
      } else if (n.type === 'lose') {
        iconBgClass = 'icon-bg-rejected';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
      } else if (n.type === 'success') {
        iconBgClass = 'icon-bg-inflow';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;
      } else if (n.type === 'error') {
        iconBgClass = 'icon-bg-rejected';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
      } else if (n.type === 'warning') {
        iconBgClass = 'icon-bg-reward';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        `;
      } else if (n.type === 'info') {
        iconBgClass = 'icon-bg-outflow';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
        `;
      } else {
        iconBgClass = 'icon-bg-inflow';
        iconHtml = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
        `;
      }

      const date = new Date(n.timestamp);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });

      item.innerHTML = `
        <div class="tx-card-left">
          <div class="tx-card-icon-wrap ${iconBgClass}">
            ${iconHtml}
          </div>
          <div class="tx-card-info">
            <span class="tx-card-title" style="white-space: normal; line-height: 1.4; font-size: 13px; text-align: left;">${n.message}</span>
            <span class="tx-card-details" style="font-size: 11px;">${timeStr}</span>
          </div>
        </div>
        <div class="tx-card-right" style="align-items: flex-end;">
          <span class="tx-card-date" style="font-size: 11px;">${dateStr}</span>
        </div>
      `;
      
      if (list) list.appendChild(item.cloneNode(true));
      dropdownLists.forEach(dl => dl.appendChild(item.cloneNode(true)));
    });
  },

  initResizers() {
    const leftResizer = document.getElementById('left-resizer');
    const rightResizer = document.getElementById('right-resizer');
    const appNav = document.getElementById('app-nav');
    const tradeControls = document.getElementById('trade-controls-panel');

    // Drag left resizer
    if (leftResizer && appNav) {
      leftResizer.addEventListener('mousedown', (e) => {
        if (window.innerWidth < 768) return; // desktop only
        e.preventDefault();
        leftResizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        appNav.style.transition = 'none'; // disable transition for smooth drag

        const onMouseMove = (moveEvent) => {
          const newWidth = Math.max(180, Math.min(400, moveEvent.clientX));
          appNav.style.width = newWidth + 'px';
          appNav.style.minWidth = newWidth + 'px';
          appNav.style.maxWidth = newWidth + 'px';
        };

        const onMouseUp = () => {
          leftResizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          appNav.style.transition = ''; // restore transition
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }

    // Drag right resizer
    if (rightResizer && tradeControls) {
      rightResizer.addEventListener('mousedown', (e) => {
        if (window.innerWidth < 768) return; // desktop only
        e.preventDefault();
        rightResizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        tradeControls.style.transition = 'none'; // disable transition for smooth drag

        const onMouseMove = (moveEvent) => {
          const newWidth = Math.max(180, Math.min(400, window.innerWidth - moveEvent.clientX));
          tradeControls.style.width = newWidth + 'px';
          tradeControls.style.minWidth = newWidth + 'px';
          tradeControls.style.maxWidth = newWidth + 'px';
        };

        const onMouseUp = () => {
          rightResizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          tradeControls.style.transition = ''; // restore transition
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }
  },

  // Binds touch/mouse swipe-to-dismiss events to a toast element
  bindSwipeToDismiss(toast, duration) {
    let startX = 0, currentX = 0, isDragging = false;
    let autoDismissTimeout = setTimeout(() => {
      dismiss();
    }, duration);

    function dismiss() {
      // Phase 4: Collapse card → circle
      toast.classList.remove('di-visible');
      toast.classList.add('di-collapsing');
      setTimeout(() => {
        // Phase 5: Circle ascend → remove
        toast.classList.remove('di-collapsing');
        toast.classList.add('di-circle-exit');
        setTimeout(() => toast.remove(), 450);
      }, 420);
    }

    // Close button override
    const closeBtn = toast.querySelector('.toast-close');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(autoDismissTimeout);
        dismiss();
      };
    }

    // Touch events — swipe UP to dismiss (Dynamic Island style)
    let startY = 0, currentY = 0;
    toast.addEventListener('touchstart', e => {
      startY = e.touches[0].clientY;
      currentY = startY;
      isDragging = true;
      toast.style.transition = 'none';
    }, { passive: true });

    toast.addEventListener('touchmove', e => {
      if (!isDragging) return;
      currentY = e.touches[0].clientY;
      const dy = Math.min(0, currentY - startY); // Only swipe up (negative)
      const scale = 1 + dy * 0.003;
      toast.style.transform = `translateY(${dy}px) scale(${Math.max(0.6, scale)})`;
      toast.style.opacity = String(Math.max(0, 1 + dy / 120));
    }, { passive: true });

    toast.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      const dy = currentY - startY;
      if (dy < -50) {
        clearTimeout(autoDismissTimeout);
        dismiss();
      } else {
        toast.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.25s ease';
        toast.style.transform = 'translateY(0) scale(1)';
        toast.style.opacity = '1';
        setTimeout(() => {
          if (toast && !isDragging) toast.style.transition = '';
        }, 300);
      }
    });

    // Mouse events — drag UP to dismiss
    let mouseStartY = 0, mouseCurrentY = 0;
    toast.addEventListener('mousedown', e => {
      if (e.target.closest('.toast-close')) return;
      if (e.button !== 0) return; // Left click only
      
      e.preventDefault();
      mouseStartY = e.clientY;
      mouseCurrentY = mouseStartY;
      isDragging = true;
      toast.style.transition = 'none';
      toast.style.cursor = 'grabbing';
      
      const onMouseMove = e => {
        if (!isDragging) return;
        mouseCurrentY = e.clientY;
        const dy = Math.min(0, mouseCurrentY - mouseStartY);
        const scale = 1 + dy * 0.003;
        toast.style.transform = `translateY(${dy}px) scale(${Math.max(0.6, scale)})`;
        toast.style.opacity = String(Math.max(0, 1 + dy / 120));
      };
      
      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          toast.style.cursor = 'grab';
          const dy = mouseCurrentY - mouseStartY;
          if (dy < -50) {
            clearTimeout(autoDismissTimeout);
            dismiss();
          } else {
            toast.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.25s ease';
            toast.style.transform = 'translateY(0) scale(1)';
            toast.style.opacity = '1';
            setTimeout(() => {
              if (toast && !isDragging) toast.style.transition = '';
            }, 300);
          }
        }
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
    
    toast.style.cursor = 'grab';
    toast.style.userSelect = 'none';
  },

  // Animate toast entrance: circle descend → expand → visible
  animateToastEntrance(toast) {
    // Phase 1: Start as circle descending
    toast.classList.add('di-circle-enter');

    // Phase 2: After circle lands, expand into notification card
    setTimeout(() => {
      toast.classList.remove('di-circle-enter');
      toast.classList.add('di-expanding');

      // Phase 3: After expansion, become idle visible notification
      setTimeout(() => {
        toast.classList.remove('di-expanding');
        toast.classList.add('di-visible');
      }, 520);
    }, 480);
  },

  // Triggers recurring poll when a trade expires
  triggerTradePoll(trade) {
    if (!this.pollingTradeIds) {
      this.pollingTradeIds = new Set();
    }
    if (this.pollingTradeIds.has(trade.id)) return;
    this.pollingTradeIds.add(trade.id);

    let retries = 0;
    const pollInterval = setInterval(async () => {
      retries++;
      await this.loadUserContracts();
      await this.loadDashboardData();
      
      const isStillActive = this.lastActiveTrades && this.lastActiveTrades.some(t => t.id === trade.id);
      if (!isStillActive || retries >= 6) {
        clearInterval(pollInterval);
        this.pollingTradeIds.delete(trade.id);
      }
    }, 1000);
  },

  // Toast notifications helper
  showToast(message, type = 'success', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Clear previous toasts to keep only 1 on screen
    container.innerHTML = '';

    const titleMap = {
      success: 'Success',
      error: 'Error',
      warning: 'Warning',
      info: 'Information',
      bot: 'AI Bot'
    };
    const toastTitle = titleMap[type] || 'System Alert';

    const svgIcons = {
      success: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
      error: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
      warning: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
      info: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
      bot: `<span style="font-size:16px;line-height:1;display:inline-block;vertical-align:middle;">🤖</span>`,
      'trade-up': `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`,
      'trade-down': `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`,
      'trade-win': `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H4v2h16v-2h-5c-.55 0-1-.45-1-1v-2.34"></path><path d="M12 2a6 6 0 0 1 6 6v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8a6 6 0 0 1 6-6z"></path></svg>`,
      'trade-lose': `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
    };
    const iconContent = svgIcons[type] || '•';

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.setProperty('--toast-duration', `${duration}ms`);
    toast.innerHTML = `
      <div class="toast-icon">${iconContent}</div>
      <div class="toast-body">
        <div class="toast-title">${toastTitle}</div>
        <div class="toast-subtitle">${message}</div>
      </div>
      <button class="toast-close">✕</button>
    `;

    container.appendChild(toast);
    this.animateToastEntrance(toast);
    this.bindSwipeToDismiss(toast, duration);
    this.saveNotificationToHistory(type, message);
  },

  showTradeToast(direction, coin, amount, payout, payoutPct, durationSec) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Clear previous toasts to keep only 1 on screen
    container.innerHTML = '';
    const isUp = direction === 'UP';
    const type = isUp ? 'trade-up' : 'trade-down';
    
    const icon = isUp 
      ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`
      : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>`;

    const currency = this.user ? this.user.currency : 'USD';
    let durationLabel = '';
    if (durationSec >= 60) {
      const m = Math.floor(durationSec / 60);
      const s = durationSec % 60;
      durationLabel = s > 0 ? `${m}m ${s}s` : `${m} min`;
    } else {
      durationLabel = `${durationSec}s`;
    }
    const label = coin.includes('/') ? coin : `${coin}/USDT`;
    const toastDuration = 6000;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.setProperty('--toast-duration', `${toastDuration}ms`);
    toast.innerHTML = `
      <div class="toast-icon">${icon}</div>
      <div class="toast-body">
        <div class="toast-title">
          ${label}
          <span class="toast-dir-badge ${isUp ? 'up' : 'down'}">${direction}</span>
        </div>
        <div class="toast-subtitle">Contract placed · ${durationLabel}</div>
        <div class="toast-amounts">
          <div class="toast-amount-item">
            <span class="toast-amount-label">Invested</span>
            <span class="toast-amount-val muted">${this.formatCurrency(amount, currency)}</span>
          </div>
          <div class="toast-amount-item">
            <span class="toast-amount-label">Payout</span>
            <span class="toast-amount-val green">${this.formatCurrency(payout, currency)} (${100 + payoutPct}%)</span>
          </div>
        </div>
      </div>
      <button class="toast-close">✕</button>
    `;
    container.appendChild(toast);
    this.animateToastEntrance(toast);
    this.bindSwipeToDismiss(toast, toastDuration);
  },

  showTradeResultToast(trade) {
    const isWin = trade.status === 'win';
    const currency = this.user ? this.user.currency : 'USD';
    const coinLabel = trade.coin.includes('/') ? trade.coin : `${trade.coin}/USDT`;
    const winProfit = trade.amount * (trade.commission_pct / 100);
    const amountValue = isWin 
      ? `+${this.formatCurrency(winProfit, currency)}` 
      : `-${this.formatCurrency(trade.amount, currency)}`;

    const notifType = isWin ? 'win' : 'lose';
    const notifMsg = `Trade ${isWin ? 'Won' : 'Lost'}: ${coinLabel} ${trade.direction} (${amountValue})`;
    this.showChartNotification(notifType, notifMsg);
  },

  // Check user auth session
  async checkSession() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        this.user = data.user;
        if (data.user && data.user.has_active_bot !== undefined) {
          this.hasActiveBot = !!data.user.has_active_bot;
        }
        if (window.OneSignalWrapper) {
          window.OneSignalWrapper.login(data.user.id);
        }
        this.permissions = data.permissions;
        this.pageLoaderDelayMs = data.page_loader_delay_ms || 400;
        this.loadNotificationsFromStorage();
        this.setupHeaderAndNav();

        // Initialize floating support chat widget
        this.supportChat.init(data.user.id);
        
        // Start background auto refresh for multi-device & real-time sync
        this.startBackgroundAutoRefresh();
        
        const initialTab = this.getTabFromPath();
        await this.navigateTo(initialTab, { replaceState: true });
      } else {
        console.warn('Session check rejected:', res.status);
        const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
        const isPwa = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || window.location.search.includes('pwa=true');
        if (path === 'login' || path === 'signup') {
          this.showScreen(path);
        } else if (isPwa) {
          this.showScreen('login');
        } else {
          window.location.replace('/landing');
        }
      }
    } catch (err) {
      console.error('Session check failed with exception:', err);
      const isPwa = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || window.location.search.includes('pwa=true');
      if (isPwa) {
        this.showScreen('login');
      } else {
        window.location.replace('/landing');
      }
    } finally {
      this.hideGlobalLoader();
    }
  },

  // Background Auto Refresh for multi-device & real-time synchronization
  startBackgroundAutoRefresh() {
    if (this._userAutoRefreshInterval) return;

    // Run silent user sync every 10 seconds (lightweight balance & status check)
    this._userAutoRefreshInterval = setInterval(() => {
      this.syncUserDataSilently();
    }, 10000);

    // Trigger immediate sync on tab focus or visibility change
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible' || document.hasFocus()) {
        this.syncUserDataSilently();
      }
    };

    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
  },

  async syncUserDataSilently() {
    if (!this.user || this._isSyncingUserData) return;
    this._isSyncingUserData = true;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data && data.user) {
          const prevUser = this.user;
          const newUser = data.user;

          const kycChanged = (prevUser.kyc_status !== newUser.kyc_status);
          const statusChanged = (prevUser.status !== newUser.status) || (prevUser.real_account_active !== newUser.real_account_active);

          // Update user object & permissions
          if (newUser.has_active_bot !== undefined) {
            this.hasActiveBot = !!newUser.has_active_bot;
          } else {
            newUser.has_active_bot = !!this.hasActiveBot;
          }
          this.user = newUser;
          if (data.permissions) {
            this.permissions = data.permissions;
          }

          // Refresh UI balance displays smoothly
          this.updateBalanceDisplays();

          if (kycChanged || statusChanged) {
            this.setupHeaderAndNav();
          }
        }
      }
    } catch (e) {
      // Ignore background network errors silently
    } finally {
      this._isSyncingUserData = false;
    }
  },

  toggleFullscreen() {
    if (!document.fullscreenElement &&
        !document.mozFullScreenElement && !document.webkitFullscreenElement && !document.msFullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      } else if (document.documentElement.msRequestFullscreen) {
        document.documentElement.msRequestFullscreen();
      } else if (document.documentElement.mozRequestFullScreen) {
        document.documentElement.mozRequestFullScreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  },

  showScreen(screenId) {
    if (window.innerWidth >= 1024 && screenId === 'onboarding') {
      this.showScreen('login');
      return;
    }

    const header  = document.getElementById('app-header');
    const nav     = document.getElementById('app-nav');
    const content = document.getElementById('app-content');

    const isAuth  = screenId === 'login' || screenId === 'signup' || screenId === 'onboarding';
    const isTrade = screenId === 'trade';

    const container = document.querySelector('.app-container');
    if (container) {
      if (isAuth) {
        container.classList.add('auth-screen-active');
        container.classList.remove('has-bottom-nav');
      } else {
        container.classList.remove('auth-screen-active');
        container.classList.add('has-bottom-nav');
      }
      if (isTrade) {
        container.classList.add('trade-screen-active');
      } else {
        container.classList.remove('trade-screen-active');
      }
    }

    // ── Nav & Header visibility ──────────────────────────────
    if (header) header.style.display = (isAuth || isTrade || screenId === 'profile') ? 'none' : 'flex';
    if (nav) {
      if (isAuth) {
        nav.style.display = 'none';
      } else {
        nav.style.display = 'flex';
      }
    }

    const headerNotifBtn = document.querySelector('#app-header .notification-btn');
    if (headerNotifBtn) {
      headerNotifBtn.style.display = (screenId === 'notifications') ? 'none' : 'flex';
    }

    // ── Content area mode ────────────────────────────────────
    if (content) {
      // Reset everything first
      content.classList.remove('trade-mode');
      content.style.justifyContent = '';
      content.style.alignItems     = '';

      if (isTrade) {
        // Trade takes over completely — no padding, no scroll
        content.classList.add('trade-mode');
        content.style.padding  = '0';
        content.style.overflow = 'hidden';
      } else if (isAuth) {
        // Auth screens: vertically centred
        content.style.overflow      = 'auto';
        content.style.padding       = '40px 20px';
        content.style.justifyContent = 'center';
        content.style.alignItems    = 'center';
      } else {
        // Normal full scrollable page — let CSS handle padding responsively
        content.style.padding  = '';
        content.style.overflow = 'auto';
      }
    }

    // ── Activate ONLY the target screen, hide all others ─────
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active-screen'));
    const target = document.getElementById(`screen-${screenId}`)
                || document.getElementById(`tab-${screenId}`);
    console.log('[DEBUG showScreen]', screenId, 'target=', target, 'targetId=', target ? target.id : 'NULL');
    if (target) target.classList.add('active-screen');

    if (screenId === 'signup') {
      this.detectUserCurrency();
      this.applyInviteCodeFromURLOrStorage();
    }
    if (screenId === 'login' || screenId === 'signup') {
      this.initializeGoogleSignIn();
    }
    setTimeout(() => this.updateNavIndicator(), 50);

    if (isAuth) {
      const search = window.location.search;
      const path = `/${screenId}` + search;
      if (window.location.pathname !== path) {
        if (!(screenId === 'onboarding' && window.location.pathname === '/')) {
          history.pushState({ tab: screenId }, '', path);
        }
      }
    }
  },

  applyInviteCodeFromURLOrStorage() {
    const inviteInput = document.getElementById('signup-invite');

    const urlParams = new URLSearchParams(window.location.search);
    let code = urlParams.get('ref') || urlParams.get('invite') || urlParams.get('code') || urlParams.get('r');

    if (!code) {
      code = localStorage.getItem('gainex_invite_code') || sessionStorage.getItem('gainex_invite_code');
    }

    if (code) {
      code = code.trim().toUpperCase();
      try {
        localStorage.setItem('gainex_invite_code', code);
        sessionStorage.setItem('gainex_invite_code', code);
      } catch(e) {}
      if (inviteInput) {
        inviteInput.value = code;
      }
    }
  },

  getTabFromPath() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const allowedTabs = ['dashboard', 'trade', 'wallet', 'history', 'profile', 'notifications', 'support', 'market', 'settings', 'convert', 'help', 'claim-card', 'login', 'signup', 'onboarding'];
    if (allowedTabs.includes(path)) {
      if (path === 'settings' || path === 'convert' || path === 'help') {
        return 'profile';
      }
      return path;
    }
    return 'dashboard';
  },

  async detectUserCurrency() {
    const currencySelect = document.getElementById('signup-currency');
    if (currencySelect) {
      currencySelect.value = 'USD';
    }
  },

  setupHeaderAndNav() {
    // Proactively fetch latest user details in background and update DOM
    fetch('/api/auth/me')
      .then(res => {
        if (res.ok) return res.json();
        throw new Error('Not logged in');
      })
      .then(data => {
        this.user = data.user;
        if (data.user && data.user.has_active_bot !== undefined) {
          this.hasActiveBot = !!data.user.has_active_bot;
        }
        this.permissions = data.permissions;
        this.renderProfileUI();
        this.updateBalanceDisplays();
        this.populateCurrencySelects();
      })
      .catch(err => {
        console.warn('Session refresh failed:', err);
      });

    this.renderProfileUI();
    this.updateBalanceDisplays();
  },

  initFloatingBotWidget() {
    const el = document.getElementById('floating-bot-widget');
    if (!el) {
      if (!this._botInitRetries) this._botInitRetries = 0;
      if (this._botInitRetries < 30) {
        this._botInitRetries++;
        setTimeout(() => this.initFloatingBotWidget(), 200);
      }
      return;
    }

    let isDragging = false;
    const dragThreshold = 5;
    let startX = 0, startY = 0;
    let startElLeft = 0, startElTop = 0;

    el.onmousedown = dragMouseDown;
    el.ontouchstart = dragTouchStart;

    function dragMouseDown(e) {
      e = e || window.event;
      if (e.button !== 0) return;
      e.preventDefault();
      
      const rect = el.getBoundingClientRect();
      startElLeft = rect.left;
      startElTop = rect.top;
      
      el.style.top = startElTop + "px";
      el.style.left = startElLeft + "px";
      el.style.bottom = "auto";
      el.style.right = "auto";

      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e = e || window.event;
      e.preventDefault();
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      if (Math.abs(deltaX) > dragThreshold || Math.abs(deltaY) > dragThreshold) {
        isDragging = true;
      }

      const newTop = startElTop + deltaY;
      const newLeft = startElLeft + deltaX;
      
      const maxLeft = window.innerWidth - el.offsetWidth - 10;
      const maxTop = window.innerHeight - el.offsetHeight - 10;
      
      el.style.top = Math.max(10, Math.min(newTop, maxTop)) + "px";
      el.style.left = Math.max(10, Math.min(newLeft, maxLeft)) + "px";
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }

    function dragTouchStart(e) {
      const touch = e.touches[0];
      
      const rect = el.getBoundingClientRect();
      startElLeft = rect.left;
      startElTop = rect.top;
      
      el.style.top = startElTop + "px";
      el.style.left = startElLeft + "px";
      el.style.bottom = "auto";
      el.style.right = "auto";

      startX = touch.clientX;
      startY = touch.clientY;
      isDragging = false;
      
      document.addEventListener('touchmove', touchDrag, { passive: false });
      document.addEventListener('touchend', closeTouchDrag);
    }

    function touchDrag(e) {
      const touch = e.touches[0];
      
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      
      if (Math.abs(deltaX) > dragThreshold || Math.abs(deltaY) > dragThreshold) {
        isDragging = true;
      }

      if (isDragging) {
        e.preventDefault();
      }

      const newTop = startElTop + deltaY;
      const newLeft = startElLeft + deltaX;
      
      const maxLeft = window.innerWidth - el.offsetWidth - 10;
      const maxTop = window.innerHeight - el.offsetHeight - 10;
      
      el.style.top = Math.max(10, Math.min(newTop, maxTop)) + "px";
      el.style.left = Math.max(10, Math.min(newLeft, maxLeft)) + "px";
    }

    function closeTouchDrag() {
      document.removeEventListener('touchmove', touchDrag);
      document.removeEventListener('touchend', closeTouchDrag);
    }

    window.floatingBotClickVerifier = function() {
      return !isDragging;
    };

    // Reset inline position coordinates on mobile/desktop boundary crossing to allow default CSS placement to apply
    this._wasMobileLast = window.innerWidth < 768;
    window.addEventListener('resize', () => {
      const isMobileNow = window.innerWidth < 768;
      if (this._wasMobileLast !== isMobileNow) {
        this._wasMobileLast = isMobileNow;
        el.style.top = '';
        el.style.left = '';
        el.style.bottom = '';
        el.style.right = '';
      }
    });
  },

  startBotActiveStatusPolling() {
    console.log('🤖 startBotActiveStatusPolling initialized.');
    setInterval(async () => {
      if (!this.user) {
        console.log('🤖 polling skipped: this.user is null.');
        return;
      }
      try {
        const res = await fetch(`/api/client/bot-active-status?account_type=${this.accountType}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          const hasActiveBot = !!data.has_active_bot;
          console.log('🤖 polled active bot status:', hasActiveBot);

          this.hasActiveBot = hasActiveBot;
          if (this.user) {
            this.user.has_active_bot = hasActiveBot;
          }

          // Cache trade sequence and settings from server
          if (hasActiveBot) {
            this._botTradeSequence = (Array.isArray(data.trade_sequence) && data.trade_sequence.length > 0)
              ? data.trade_sequence
              : [{ timer: data.bot_timer || 60, pct: data.investment_pct || 10 }];
          }

          const botWidget = document.getElementById('floating-bot-widget');
          if (botWidget) {
            if (hasActiveBot) {
              if (botWidget.style.display !== 'flex') {
                console.log('🤖 showing bot widget.');
                botWidget.style.display = 'flex';
              }

              // Auto-resume bot execution after page refresh/reload if active
              const savedActive = localStorage.getItem('gainex_bot_active') === 'true';
              const savedLocked = localStorage.getItem('gainex_bot_sequence_locked') === 'true';

              // Do NOT auto-resume if daily limit is already reached
              if (data.limit_reached) {
                localStorage.removeItem('gainex_bot_active');
                localStorage.removeItem('gainex_bot_sequence_locked');
                localStorage.removeItem('gainex_bot_sequence_index');
                localStorage.removeItem('gainex_bot_last_trade_time');
                localStorage.removeItem('gainex_bot_last_step_timer');
                botWidget.classList.remove('active-trading', 'sequence-locked');
                const txt = document.getElementById('bot-widget-status-text');
                if (txt) txt.textContent = 'OFF';
              } else if (!this.botTradingActive && (savedActive || savedLocked)) {
                console.log('🤖 Auto-resuming active bot session after page reload/refresh...');
                this.botTradingActive = true;
                this.botSequenceLocked = savedLocked;
                this._botSequenceIndex = parseInt(localStorage.getItem('gainex_bot_sequence_index')) || 0;

                botWidget.classList.add('active-trading');
                if (this.botSequenceLocked) botWidget.classList.add('sequence-locked');
                const txt = document.getElementById('bot-widget-status-text');
                if (txt) txt.textContent = 'ON';

                const lastTime = parseInt(localStorage.getItem('gainex_bot_last_trade_time')) || 0;
                const lastTimer = parseInt(localStorage.getItem('gainex_bot_last_step_timer')) || 60;
                const elapsedMs = Date.now() - lastTime;
                const totalIntervalMs = (lastTimer + 60) * 1000;
                const remainingMs = Math.max(1000, totalIntervalMs - elapsedMs);

                if (!this.platformBotTimeout) {
                  this.platformBotTimeout = setTimeout(() => {
                    this.executePlatformBotTrade();
                  }, remainingMs);
                }
              }

            } else {
              if (botWidget.style.display !== 'none') {
                console.log('🤖 hiding bot widget.');
                botWidget.style.display = 'none';
              }
              this.hasActiveBot = false;
              if (this.user) this.user.has_active_bot = false;

              // Clear stored state if key unlinked/expired
              localStorage.removeItem('gainex_bot_active');
              localStorage.removeItem('gainex_bot_sequence_locked');
              localStorage.removeItem('gainex_bot_sequence_index');
              localStorage.removeItem('gainex_bot_last_trade_time');
              localStorage.removeItem('gainex_bot_last_step_timer');

              // If the bot was actively trading, shut it down since it was unlinked/disabled
              if (this.botTradingActive) {
                console.log('🤖 stopping active bot trading because bot unlinked.');
                this.botTradingActive = false;
                this.botSequenceLocked = false;
                clearTimeout(this.platformBotTimeout);
                this.platformBotTimeout = null;
                botWidget.classList.remove('active-trading', 'sequence-locked');
                const txt = document.getElementById('bot-widget-status-text');
                if (txt) txt.textContent = 'OFF';
                this.showToast('🤖 Auto-trading bot session unlinked or disabled.', 'warning');
              }
            }
          }
        }
      } catch (err) {
        console.warn('Failed to fetch bot active status:', err);
      }
    }, 5000);
  },

  async toggleBotTrading() {
    // If a sequence cycle is in progress, the user cannot stop the bot
    if (this.botSequenceLocked || localStorage.getItem('gainex_bot_sequence_locked') === 'true') {
      const seq = this._botTradeSequence || [];
      const total = seq.length || 1;
      const currentIndex = (this._botSequenceIndex !== undefined) ? this._botSequenceIndex : 0;
      const currentStepNum = Math.min(total, currentIndex > 0 ? currentIndex : 1);
      this.showToast(`Sequence in progress (${currentStepNum}/${total} trades). You cannot stop the bot until all ${total} trades finish.`, 'bot');
      return;
    }

    if (this.botTradingActive) {
      this.botTradingActive = false;
      clearTimeout(this.platformBotTimeout);
      this.platformBotTimeout = null;
      this._botSequenceIndex = 0;

      localStorage.removeItem('gainex_bot_active');
      localStorage.removeItem('gainex_bot_sequence_locked');
      localStorage.removeItem('gainex_bot_sequence_index');

      const el = document.getElementById('floating-bot-widget');
      if (el) el.classList.remove('active-trading', 'sequence-locked');
      const txt = document.getElementById('bot-widget-status-text');
      if (txt) txt.textContent = 'OFF';
      this.showToast('AI Bot auto-trading stopped.', 'bot');
    } else {
      // ── Pre-check with server BEFORE enabling bot or setting ON ──
      try {
        const res = await fetch(`/api/client/bot-active-status?account_type=${this.accountType}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          console.log('🤖 [AI-BOT] status check response:', data);
          // Block if limit_reached flag is set OR if count >= limit
          const limitHit = data.limit_reached === true ||
            (typeof data.daily_limit === 'number' && typeof data.today_bot_trades_count === 'number' && data.today_bot_trades_count >= data.daily_limit);
          console.log('🤖 [AI-BOT] limitHit evaluated to:', limitHit, 'todayCount:', data.today_bot_trades_count, 'limit:', data.daily_limit);
          if (limitHit) {
            this.showToast(`Daily bot trade limit reached (${data.today_bot_trades_count}/${data.daily_limit}). Bot resets at 12:00 AM UTC.`, 'error');
            const el = document.getElementById('floating-bot-widget');
            if (el) el.classList.remove('active-trading', 'sequence-locked');
            const txt = document.getElementById('bot-widget-status-text');
            if (txt) txt.textContent = 'OFF';
            return;
          }
        }
      } catch (err) {
        console.warn('Failed pre-checking bot status:', err);
      }

      this.botTradingActive = true;
      this._botSequenceIndex = 0; // always start from step 1

      localStorage.setItem('gainex_bot_active', 'true');

      const el = document.getElementById('floating-bot-widget');
      if (el) el.classList.add('active-trading');
      const txt = document.getElementById('bot-widget-status-text');
      if (txt) txt.textContent = 'ON';
      this.executePlatformBotTrade();
    }
  },

  async executePlatformBotTrade() {
    if (!this.botTradingActive) return;

    const widgetText = document.getElementById('bot-widget-status-text');
    const el = document.getElementById('floating-bot-widget');

    // Pre-check daily limit with server before starting SCAN/PREP or setting active lock
    try {
      const statusRes = await fetch(`/api/client/bot-active-status?account_type=${this.accountType}&t=${Date.now()}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        const limitHit = statusData.limit_reached === true ||
          (typeof statusData.daily_limit === 'number' && typeof statusData.today_bot_trades_count === 'number' && statusData.today_bot_trades_count >= statusData.daily_limit);
        if (limitHit) {
          this.botTradingActive = false;
          this.botSequenceLocked = false;
          this._botSequenceIndex = 0;
          clearTimeout(this.platformBotTimeout);
          this.platformBotTimeout = null;

          localStorage.removeItem('gainex_bot_active');
          localStorage.removeItem('gainex_bot_sequence_locked');
          localStorage.removeItem('gainex_bot_sequence_index');
          localStorage.removeItem('gainex_bot_last_trade_time');
          localStorage.removeItem('gainex_bot_last_step_timer');

          if (el) el.classList.remove('active-trading', 'sequence-locked');
          if (widgetText) widgetText.textContent = 'OFF';

          this.showToast(`Daily bot trade limit reached (${statusData.today_bot_trades_count}/${statusData.daily_limit}).`, 'error');
          return;
        }
      }
    } catch (e) {
      console.warn('Pre-check bot limit status error:', e);
    }

    // Get the current sequence (from last poll or fallback)
    const sequence = (Array.isArray(this._botTradeSequence) && this._botTradeSequence.length > 0)
      ? this._botTradeSequence
      : [{ timer: 60, pct: 10 }];

    const totalSteps = sequence.length;
    if (this._botSequenceIndex === undefined || this._botSequenceIndex === null) {
      this._botSequenceIndex = 0;
    }

    const stepIndex = this._botSequenceIndex % totalSteps;
    const step = sequence[stepIndex];
    const stepTimer = parseInt(step.timer) || 60;
    const stepPct = parseFloat(step.pct) || 10;

    // Always lock widget for the sequence
    this.botSequenceLocked = true;
    if (el) { el.classList.add('sequence-locked', 'active-trading'); }

    // Save active state & lock to localStorage for persistence across page refresh
    localStorage.setItem('gainex_bot_active', 'true');
    localStorage.setItem('gainex_bot_sequence_locked', 'true');
    localStorage.setItem('gainex_bot_sequence_index', stepIndex.toString());
    localStorage.setItem('gainex_bot_last_trade_time', Date.now().toString());
    localStorage.setItem('gainex_bot_last_step_timer', stepTimer.toString());

    try {
      // Step 1: Analyzing the market
      if (widgetText) widgetText.textContent = 'SCAN';
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!this.botTradingActive) return;

      // Step 2: Finalizing the trade
      if (widgetText) widgetText.textContent = 'PREP';
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (!this.botTradingActive) return;

      console.log(`🤖 Executing sequence trade ${stepIndex + 1}/${totalSteps}: timer=${stepTimer}s, invest=${stepPct}%`);

      // Calculate direction
      let direction = 'UP';
      const sentimentBar = document.querySelector('.chart-pressure-bar-fill');
      if (sentimentBar) {
        const pctText = sentimentBar.style.width || '50%';
        const buyersPct = parseFloat(pctText) || 50;
        direction = (buyersPct + Math.random() * 20 - 10) > 50 ? 'UP' : 'DOWN';
      } else {
        direction = Math.random() > 0.5 ? 'UP' : 'DOWN';
      }

      // Step 3: Place the trade with this step's settings
      if (widgetText) widgetText.textContent = 'ON';
      await this.placeTrade(direction, { bot_timer: stepTimer, bot_investment_pct: stepPct, bot_outcome: step.outcome });

      // Advance sequence step counter
      const nextIndex = stepIndex + 1;
      this._botSequenceIndex = nextIndex;
      const isLastStep = (nextIndex >= totalSteps);

      if (isLastStep) {
        // Full sequence cycle complete (e.g. 10/10 trades finished)
        this.botTradingActive = false;
        this.botSequenceLocked = false;
        this._botSequenceIndex = 0;
        clearTimeout(this.platformBotTimeout);
        this.platformBotTimeout = null;

        localStorage.removeItem('gainex_bot_active');
        localStorage.removeItem('gainex_bot_sequence_locked');
        localStorage.removeItem('gainex_bot_sequence_index');
        localStorage.removeItem('gainex_bot_last_trade_time');
        localStorage.removeItem('gainex_bot_last_step_timer');

        if (el) el.classList.remove('active-trading', 'sequence-locked');
        if (widgetText) widgetText.textContent = 'OFF';

        this.showToast(`🤖 Sequence finished (${totalSteps}/${totalSteps} trades completed). AI Bot turned OFF.`, 'bot');
        console.log(`🤖 Full sequence cycle complete (${totalSteps}/${totalSteps} trades executed). Bot automatically turned OFF.`);
      } else {
        localStorage.setItem('gainex_bot_sequence_index', nextIndex.toString());

        // Delay next trade: wait for current trade timer to expire + 60s (1 min) rest interval after close
        const delayMs = (stepTimer + 60) * 1000;
        if (this.botTradingActive) {
          clearTimeout(this.platformBotTimeout);
          this.platformBotTimeout = setTimeout(() => {
            this.executePlatformBotTrade();
          }, delayMs);
        }
      }

    } catch (err) {
      console.error('Bot execution error:', err.message);
      this.botTradingActive = false;
      this.botSequenceLocked = false;
      this._botSequenceIndex = 0;
      clearTimeout(this.platformBotTimeout);
      this.platformBotTimeout = null;

      localStorage.removeItem('gainex_bot_active');
      localStorage.removeItem('gainex_bot_sequence_locked');
      localStorage.removeItem('gainex_bot_sequence_index');
      localStorage.removeItem('gainex_bot_last_trade_time');
      localStorage.removeItem('gainex_bot_last_step_timer');

      if (el) el.classList.remove('active-trading', 'sequence-locked');
      if (widgetText) widgetText.textContent = 'OFF';
    }
  },

  updateBalanceDisplays() {
    if (!this.user) return;

    // Toggle floating bot widget
    const botWidget = document.getElementById('floating-bot-widget');
    if (botWidget) {
      const isBotActive = (this.hasActiveBot !== undefined)
        ? (!!this.hasActiveBot && (!this.user || this.user.has_active_bot !== false))
        : (this.user ? !!this.user.has_active_bot : false);
      if (isBotActive) {
        if (botWidget.style.display !== 'flex') {
          botWidget.style.display = 'flex';
        }
      } else {
        if (botWidget.style.display !== 'none') {
          botWidget.style.display = 'none';
        }
      }
    }
    
    const realFormatted = this.formatCurrency(this.user.balance, this.user.currency);
    const demoFormatted = this.formatCurrency(this.user.demo_balance ?? 10000.0, 'USD');
    const activeFormatted = this.accountType === 'demo' ? demoFormatted : realFormatted;
    
    const dBal = document.getElementById('dashboard-balance');
    if (dBal) dBal.textContent = realFormatted;

    const dBalLabel = document.getElementById('dashboard-balance-label');
    if (dBalLabel) {
      dBalLabel.textContent = `Total Balance (${this.user.currency || 'USD'})`;
    }
    
    const pBal = document.getElementById('profile-balance');
    if (pBal) pBal.textContent = realFormatted;
    
    const tBal = document.getElementById('trade-balance-display');
    if (tBal) tBal.textContent = activeFormatted;
    
    const thBal = document.getElementById('trade-header-balance');
    if (thBal) thBal.textContent = activeFormatted;
    
    const mDemoBal = document.getElementById('menu-demo-balance');
    if (mDemoBal) mDemoBal.textContent = demoFormatted;

    const mRealBal = document.getElementById('menu-real-balance');
    if (mRealBal) mRealBal.textContent = realFormatted;

    const wBal = document.getElementById('wallet-balance-usd');
    if (wBal) wBal.textContent = realFormatted;

    // Update checkbox icons in switcher menu
    const realIcon = document.getElementById('real-select-icon');
    const demoIcon = document.getElementById('demo-select-icon');
    const checkedSvg = `<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; color: #0088ff; fill: #0088ff; margin-right: 8px; vertical-align: middle;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
    const uncheckedSvg = `<svg viewBox="0 0 24 24" style="width: 16px; height: 16px; color: var(--text-secondary); fill: none; stroke: currentColor; stroke-width: 2.5; margin-right: 8px; vertical-align: middle;"><circle cx="12" cy="12" r="10"/></svg>`;
    
    if (realIcon && demoIcon) {
      if (this.accountType === 'demo') {
        demoIcon.innerHTML = checkedSvg;
        realIcon.innerHTML = uncheckedSvg;
      } else {
        realIcon.innerHTML = checkedSvg;
        demoIcon.innerHTML = uncheckedSvg;
      }
    }
    this.updateDashboardStats();
  },

  switchRightPanelTab(tab) {
    const activeBtn = document.getElementById('tc-tab-active');
    const pendingBtn = document.getElementById('tc-tab-pending');
    const historyBtn = document.getElementById('tc-tab-history');
    
    const activeList = document.getElementById('trade-active-mini');
    const pendingList = document.getElementById('trade-pending-mini');
    const historyList = document.getElementById('trade-history-mini');
    
    if (activeBtn) activeBtn.classList.toggle('active', tab === 'active');
    if (pendingBtn) pendingBtn.classList.toggle('active', tab === 'pending');
    if (historyBtn) historyBtn.classList.toggle('active', tab === 'history');
    
    if (activeList) activeList.style.display = tab === 'active' ? 'flex' : 'none';
    if (pendingList) pendingList.style.display = tab === 'pending' ? 'flex' : 'none';
    if (historyList) historyList.style.display = tab === 'history' ? 'flex' : 'none';
    
    if (tab === 'pending') {
      this.renderPendingTrades();
    }
  },

  toggleBalanceDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('balance-dropdown-menu');
    if (menu) {
      const isHidden = menu.style.display === 'none';
      menu.style.display = isHidden ? 'block' : 'none';
    }
  },

  switchAccountType(type) {
    const badge = document.querySelector('.account-badge');
    const selector = document.querySelector('.trade-account-selector');
    const items = document.querySelectorAll('.balance-dropdown-item');
    const iconWrap = document.querySelector('.account-status-icon-wrap');
    
    if (items.length) {
      items.forEach(item => item.classList.remove('active'));
    }

    const isManualSwitch = this._tradingPageInitialized && this.accountType !== type;
    if (isManualSwitch) {
      const chartWrap = document.getElementById('chart-canvas-wrap');
      if (chartWrap) {
        // Trigger visual blink flash
        chartWrap.classList.remove('chart-blink-active');
        void chartWrap.offsetWidth; // trigger reflow
        chartWrap.classList.add('chart-blink-active');
        setTimeout(() => {
          chartWrap.classList.remove('chart-blink-active');
        }, 550);

        // Add a beautiful, professional reconnecting loading overlay
        const loaderOverlay = document.createElement('div');
        loaderOverlay.id = 'chart-switch-loader';
        loaderOverlay.innerHTML = `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 15px; color: var(--text-primary); pointer-events: none; user-select: none;">
            <div class="chart-loading-spinner" style="width: 40px; height: 40px; border: 3px solid rgba(26,183,109,0.1); border-top-color: var(--primary); border-radius: 50%; animation: chartSpinnerSpin 0.8s linear infinite;"></div>
            <span style="font-size: 13px; font-weight: 500; letter-spacing: 0.5px; opacity: 0.85;">Reconnecting Live Data...</span>
          </div>
        `;
        loaderOverlay.style.position = 'absolute';
        loaderOverlay.style.top = '0';
        loaderOverlay.style.left = '0';
        loaderOverlay.style.width = '100%';
        loaderOverlay.style.height = '100%';
        loaderOverlay.style.background = 'rgba(15, 20, 34, 0.78)';
        loaderOverlay.style.backdropFilter = 'blur(6px)';
        loaderOverlay.style.webkitBackdropFilter = 'blur(6px)';
        loaderOverlay.style.zIndex = '100';
        loaderOverlay.style.display = 'flex';
        loaderOverlay.style.alignItems = 'center';
        loaderOverlay.style.justifyContent = 'center';
        loaderOverlay.style.opacity = '0';
        loaderOverlay.style.transition = 'opacity 0.2s ease-out';
        
        chartWrap.appendChild(loaderOverlay);
        
        // Trigger fade in
        setTimeout(() => {
          loaderOverlay.style.opacity = '1';
        }, 10);

        // Perform chart reload after 400ms
        setTimeout(() => {
          // Fade out the overlay
          loaderOverlay.style.opacity = '0';
          setTimeout(() => {
            if (loaderOverlay.parentNode) {
              loaderOverlay.parentNode.removeChild(loaderOverlay);
            }
          }, 200);

          // Force chart instance to fully re-initialize
          if (window.chart && typeof window.chart.init === 'function') {
            window.chart.init(this.selectedCoin);
          }
        }, 400);
      }
    }
    
    if (type === 'demo') {
      this.accountType = 'demo';
      if (badge) {
        badge.textContent = 'DEMO';
        badge.className = 'account-badge badge-demo';
      }
      if (selector) {
        selector.classList.remove('account-live');
        selector.classList.add('account-demo');
      }
      if (iconWrap) {
        iconWrap.innerHTML = '<svg class="account-status-icon account-icon-demo" viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/><path d="M5 13.18v4C5 19.3 8.13 21 12 21s7-1.7 7-3.82v-4L12 17l-7-3.82z"/></svg>';
      }
      const demoItem = document.getElementById('dropdown-item-demo');
      if (demoItem) demoItem.classList.add('active');
      this.updateBalanceDisplays();
      this.updateDefaultInvestmentAmount();
    } else {
      if (!this.user || this.user.real_account_active !== 1) {
        this.showToast('Real Account is currently under review. Please contact support to activate.', 'info');
        const demoItem = document.getElementById('dropdown-item-demo');
        if (demoItem) demoItem.classList.add('active');
        const menu = document.getElementById('balance-dropdown-menu');
        if (menu) menu.style.display = 'none';
        return;
      }

      if (this.user.kyc_status !== 'verified') {
        this.showToast('KYC identity verification is required to trade on your Real account.', 'warning');
      }
      
      this.accountType = 'real';
      if (badge) {
        badge.textContent = 'LIVE';
        badge.className = 'account-badge badge-live';
      }
      if (selector) {
        selector.classList.remove('account-demo');
        selector.classList.add('account-live');
      }
      if (iconWrap) {
        iconWrap.innerHTML = '<svg class="account-status-icon" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px; filter: drop-shadow(0 0 4px #00d2ff);"><path d="M6 3h12l4 6-10 12L2 9z"></path><path d="M11 3L8 9l4 12 4-12-3-6"></path><path d="M2 9h20"></path></svg>';
      }
      const realItem = document.getElementById('dropdown-item-real');
      if (realItem) realItem.classList.add('active');
      this.updateBalanceDisplays();
      this.updateDefaultInvestmentAmount();
    }
    
    const menu = document.getElementById('balance-dropdown-menu');
    if (menu) menu.style.display = 'none';
    this._saveTradePrefs(); // persist account type choice
  },

  toggleDemoEdit(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('demo-edit-section');
    if (panel) {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
      if (isHidden) {
        const input = document.getElementById('demo-balance-input');
        if (input && this.user) {
          input.value = Math.floor(this.user.demo_balance ?? 10000.0);
        }
      }
    }
  },

  async resetDemoBalance(e) {
    if (e) e.stopPropagation();
    try {
      const res = await fetch('/api/client/reset-demo-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        this.user.demo_balance = data.demo_balance;
        this.updateBalanceDisplays();
        this.showToast('Demo balance reset to $10,000.00', 'success');
      } else {
        this.showToast(data.error || 'Failed to reset demo balance.', 'error');
      }
    } catch (err) {
      console.error('Reset demo balance error:', err);
      this.showToast('Failed to reset demo balance.', 'error');
    }
  },

  async updateDemoBalance(e) {
    if (e) e.stopPropagation();
    const input = document.getElementById('demo-balance-input');
    if (!input) return;
    let val = parseFloat(input.value);
    if (isNaN(val) || val < 1) {
      this.showToast('Please enter a valid amount (minimum $1).', 'error');
      return;
    }
    if (val > 10000) {
      val = 10000;
      input.value = 10000;
    }
    try {
      const res = await fetch('/api/client/update-demo-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: val })
      });
      const data = await res.json();
      if (res.ok) {
        this.user.demo_balance = data.demo_balance;
        this.updateBalanceDisplays();
        this.showToast('Demo balance updated successfully.', 'success');
        const panel = document.getElementById('demo-edit-section');
        if (panel) panel.style.display = 'none';
      } else {
        this.showToast(data.error || 'Failed to update demo balance.', 'error');
      }
    } catch (err) {
      console.error('Update demo balance error:', err);
      this.showToast('Failed to update demo balance.', 'error');
    }
  },

  renderProfileUI() {
    if (!this.user) return;
    
    // Set Header details
    const headerUsername = document.getElementById('header-username');
    if (headerUsername) headerUsername.textContent = this.user.username;

    const avatarLetter = document.getElementById('header-avatar-letter');
    if (avatarLetter && this.user.username) {
      avatarLetter.textContent = this.user.username.charAt(0).toUpperCase();
    }
    
    const dot = document.getElementById('status-indicator-dot');
    if (dot) {
      dot.className = 'status-dot';
      if (this.user.status === 'frozen') {
        dot.classList.add('frozen');
      }
    }
    
    // Choose active user object (own user or visited user)
    const u = this.viewedUserId ? this.viewedUser : this.user;
    if (!u) return;

    // 1. Update text displays across screens
    const displayName = u.full_name || u.username;
    const handleText = '@' + u.username;

    const mainName = document.getElementById('profile-main-name');
    if (mainName) mainName.textContent = displayName;

    const settingsName = document.getElementById('profile-settings-name');
    if (settingsName) settingsName.textContent = displayName;

    const settingsHandle = document.getElementById('profile-settings-handle');
    if (settingsHandle) settingsHandle.textContent = handleText;

    // 2. Populate Edit Profile inputs (always from own user)
    const fullNameInput = document.getElementById('profile-edit-full-name');
    if (fullNameInput) {
      fullNameInput.value = this.user.full_name || '';
      fullNameInput.disabled = true;
    }

    const phoneInput = document.getElementById('profile-edit-phone');
    if (phoneInput) {
      phoneInput.value = this.user.phone_number || '';
      phoneInput.disabled = true;
    }

    const emailInput = document.getElementById('profile-edit-email');
    if (emailInput) {
      emailInput.value = this.user.email || '';
      emailInput.disabled = true;
    }

    const usernameInput = document.getElementById('profile-edit-username');
    if (usernameInput) {
      usernameInput.value = this.user.username || '';
      
      // Calculate if username can be changed (after 30 days)
      let usernameCanBeChanged = true;
      let usernameRestrictionReason = '';
      
      if (this.user.created_at) {
        const createdAt = new Date(this.user.created_at);
        const now = new Date();
        const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);
        if (daysSinceCreation < 30) {
          usernameCanBeChanged = false;
          const daysLeft = Math.ceil(30 - daysSinceCreation);
          usernameRestrictionReason = `Can change after ${daysLeft} more day${daysLeft > 1 ? 's' : ''} (30 days from creation)`;
        } else if (this.user.username_last_changed) {
          const lastChanged = new Date(this.user.username_last_changed);
          const daysSinceLastChange = (now - lastChanged) / (1000 * 60 * 60 * 24);
          if (daysSinceLastChange < 7) {
            usernameCanBeChanged = false;
            const daysLeft = Math.ceil(7 - daysSinceLastChange);
            usernameRestrictionReason = `Can change after ${daysLeft} more day${daysLeft > 1 ? 's' : ''} (once every 7 days)`;
          }
        }
      }
      
      const usernameGroup = usernameInput.closest('.profile-input-group');
      let hint = usernameGroup ? usernameGroup.querySelector('.username-hint') : null;
      
      if (!usernameCanBeChanged) {
        usernameInput.disabled = true;
        usernameInput.title = usernameRestrictionReason;
        if (usernameGroup) {
          if (!hint) {
            hint = document.createElement('div');
            hint.className = 'username-hint';
            hint.style.fontSize = '11px';
            hint.style.color = '#ff4d4d';
            hint.style.marginTop = '4px';
            hint.style.width = '100%';
            hint.style.textAlign = 'right';
            usernameGroup.style.flexWrap = 'wrap';
            usernameGroup.appendChild(hint);
          }
          hint.textContent = usernameRestrictionReason;
        }
      } else {
        usernameInput.disabled = false;
        usernameInput.title = 'You can change your username';
        if (hint) {
          hint.remove();
        }
      }
    }

    // 3. Update profile pictures and fallbacks on all screens
    const picSetups = [
      { imgId: 'profile-pic-img', fallbackId: 'profile-pic-fallback', userObj: this.user },
      { imgId: 'profile-main-pic-img', fallbackId: 'profile-main-pic-fallback', userObj: u },
      { imgId: 'profile-settings-pic-img', fallbackId: 'profile-settings-pic-fallback', userObj: this.user }
    ];

    const getBustedUrl = (url) => {
      if (!url) return '';
      if (url.includes('/images/avatars/avatar_') && !url.includes('?v=')) {
        return url + '?v=2';
      }
      return url;
    };

    picSetups.forEach(setup => {
      const img = document.getElementById(setup.imgId);
      const fallback = document.getElementById(setup.fallbackId);
      if (img) {
        if (setup.userObj && setup.userObj.profile_pic) {
          img.src = getBustedUrl(setup.userObj.profile_pic);
          img.style.display = 'block';
          if (fallback) fallback.style.display = 'none';
        } else {
          img.style.display = 'none';
          if (fallback) fallback.style.display = 'flex';
        }
      }
    });

    // Update header user avatar (mobile & desktop)
    const headerImg = document.getElementById('header-avatar-img');
    const headerLetter = document.getElementById('header-avatar-letter');
    const desktopName = document.getElementById('desktop-profile-name');
    const desktopImg = document.getElementById('desktop-avatar-img');
    const desktopLetter = document.getElementById('desktop-avatar-letter');

    if (desktopName) {
      desktopName.textContent = this.user.full_name || this.user.username;
    }

    if (this.user && this.user.profile_pic) {
      if (headerImg) {
        headerImg.src = getBustedUrl(this.user.profile_pic);
        headerImg.style.display = 'block';
      }
      if (headerLetter) headerLetter.style.display = 'none';

      if (desktopImg) {
        desktopImg.src = getBustedUrl(this.user.profile_pic);
        desktopImg.style.display = 'block';
      }
      if (desktopLetter) desktopLetter.style.display = 'none';
    } else {
      if (headerImg) headerImg.style.display = 'none';
      if (headerLetter) {
        headerLetter.style.display = 'block';
        if (this.user && this.user.username) {
          headerLetter.textContent = this.user.username.charAt(0).toUpperCase();
        }
      }

      if (desktopImg) desktopImg.style.display = 'none';
      if (desktopLetter) {
        desktopLetter.style.display = 'block';
        if (this.user && this.user.username) {
          desktopLetter.textContent = this.user.username.charAt(0).toUpperCase();
        }
      }
    }

    // 4. Update Main Profile Header elements
    const titleEl = document.getElementById('profile-main-title');
    if (titleEl) {
      titleEl.textContent = this.viewedUserId ? '@' + u.username : 'My profile';
    }

    const backBtn = document.getElementById('profile-main-back-btn');
    if (backBtn) {
      backBtn.style.display = 'block';
    }

    const cogBtn = document.getElementById('profile-main-cog-btn');
    if (cogBtn) {
      cogBtn.style.display = this.viewedUserId ? 'none' : 'block';
    }

    const addPostBtn = document.getElementById('profile-add-post-btn');
    if (addPostBtn) {
      addPostBtn.style.display = this.viewedUserId ? 'none' : 'block';
    }

    const inviteTabPill = document.getElementById('profile-tab-pill-invite');
    if (inviteTabPill) {
      inviteTabPill.style.display = this.viewedUserId ? 'none' : 'flex';
    }

    const streakCountEl = document.getElementById('profile-main-streak-count');
    if (streakCountEl) {
      streakCountEl.textContent = u.streak || 0;
    }

    const verifiedEl = document.getElementById('profile-main-verified');
    if (verifiedEl) {
      verifiedEl.style.display = (u.kyc_status === 'verified') ? 'block' : 'none';
    }

    const verifiedWrap = document.getElementById('profile-verification-status-wrap');
    if (verifiedWrap) {
      if (u.kyc_status === 'verified') {
        verifiedWrap.innerHTML = `
          <span class="verification-badge status-verified">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 12px; height: 12px; margin-right: 4px; display: inline-block; vertical-align: middle;">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 15l-4-4 1.41-1.41L10 13.17l5.59-5.59L17 9l-7 7z"/>
            </svg>Verified
          </span>`;
      } else if (u.kyc_status === 'pending') {
        verifiedWrap.innerHTML = `
          <span class="verification-badge status-pending">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 12px; height: 12px; margin-right: 4px; display: inline-block; vertical-align: middle;">
              <circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>
            </svg>Pending Verification
          </span>`;
      } else if (u.kyc_status === 'rejected') {
        verifiedWrap.innerHTML = `
          <span class="verification-badge status-unverified">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 12px; height: 12px; margin-right: 4px; display: inline-block; vertical-align: middle;">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>Rejected
          </span>`;
      } else {
        verifiedWrap.innerHTML = `
          <span class="verification-badge status-unverified">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 12px; height: 12px; margin-right: 4px; display: inline-block; vertical-align: middle;">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>Unverified
          </span>`;
      }
    }

    const desktopBadge = document.getElementById('desktop-profile-badge');
    if (desktopBadge && this.user) {
      if (this.user.kyc_status === 'verified') {
        desktopBadge.textContent = 'Verified';
        desktopBadge.style.color = '#1ab76d';
      } else if (this.user.kyc_status === 'pending') {
        desktopBadge.textContent = 'Pending';
        desktopBadge.style.color = '#f0a800';
      } else {
        desktopBadge.textContent = 'Unverified';
        desktopBadge.style.color = '#ef4444';
      }
    }
  },

  // ─── Timeframe Dropdown ────────────────────────────────────────────────
  changeTimeframe(tf, optionEl) {
    const validTfs = ['1m', '15m', '30m', '1h', '1d', '1w', '1mo'];
    if (!tf || !validTfs.includes(tf)) {
      tf = '1m';
    }

    // Update chart
    if (typeof chart !== 'undefined' && chart.changeTimeframe) {
      chart.changeTimeframe(tf);
    }
    // Update dropdown label
    const label = document.getElementById('tf-active-label');
    const labelMap = { '1m':'1m', '15m':'15m', '30m':'30m', '1h':'1h', '1d':'1d', '1w':'1w', '1mo':'1mo' };
    if (label) label.textContent = labelMap[tf] || tf;
    // Update active class on all options
    document.querySelectorAll('.tf-option').forEach(btn => btn.classList.remove('active'));
    if (optionEl) optionEl.classList.add('active');
    // Close dropdown
    const menu = document.getElementById('tf-dropdown-menu');
    if (menu) menu.style.display = 'none';
  },

  toggleTfDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('tf-dropdown-menu');
    if (!menu) return;
    const isOpen = menu.style.display === 'block';
    menu.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      // Close when clicking outside
      const closeHandler = (ev) => {
        if (!ev.target.closest('.tf-dropdown-wrap')) {
          menu.style.display = 'none';
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }
  },

  // Dynamic router
  async navigateTo(tabName, options = {}) {
    // Capture the original path before any URL rewriting below, so profile
    // sub-screen deep links (/settings, /convert, /help) survive navigation.
    const originalPathName = window.location.pathname.replace(/^\/+|\/+$/g, '');

    // Close Pair Info Modal on navigation
    this.closePairInfoModal();

    // Intercept leaderboard on desktop view on any screen
    if (tabName === 'leaderboard' && window.innerWidth >= 768) {
      this.toggleLeaderboardDrawer();
      return;
    }

    // Close leaderboard drawer if navigating to another tab
    const drawer = document.getElementById('desktop-leaderboard-drawer');
    if (drawer && drawer.classList.contains('active')) {
      drawer.classList.remove('active');
    }

    // Save previous tab
    if (this.activeTab && this.activeTab !== 'notifications') {
      this.prevTab = this.activeTab;
    }

    const isAuthTab = tabName === 'login' || tabName === 'signup' || tabName === 'onboarding';
    if (!this.user && !isAuthTab) {
      this.showScreen('onboarding');
      return;
    }

    // Clear page loops
    clearInterval(this.priceTickerInterval);
    clearInterval(this.adminTradesInterval);

    this.activeTab = tabName;
    this.showScreen(tabName);

    // Log user navigation to the server for accurate real-time tracking
    if (this.user && !isAuthTab) {
      try {
        const tabLabels = {
          dashboard: 'Viewing Home Dashboard',
          trade: 'Viewing Trading Screen',
          wallet: 'Viewing Wallet & Payments',
          history: 'Checking Transactions & Trade History',
          profile: 'Viewing Profile Settings',
          market: 'Viewing Market Analysis',
          'claim-card': 'Viewing Visa Debit Card Page',
          support: 'Accessing Help & Support Desk',
          leaderboard: 'Checking Leaderboard Standings',
          notifications: 'Reading Platform Notifications',
          'ai-bot': 'Using AI Trading Bot'
        };
        const label = tabLabels[tabName];
        if (label) {
          fetch('/api/client/activity/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: label, type: 'navigation' })
          }).catch(err => console.warn('Failed to log navigation:', err));
        }
      } catch (e) {}
    }

    // Update nav icons highlight
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });
    
    // Map claim-card to card nav item to keep the Card button highlighted
    // Map ai-bot to ai-bot nav item
    const navKey = tabName === 'claim-card' ? 'card' : tabName;
    const activeNav = document.getElementById(`nav-${navKey}`);
    if (activeNav) activeNav.classList.add('active');



    // Update URL if it doesn't match
    const path = tabName === 'dashboard' ? '/' : `/${tabName}`;
    const search = window.location.search;
    if (window.location.pathname !== path && !options.popstate) {
      if (options.replaceState) {
        history.replaceState({ tab: tabName }, '', path + search);
      } else {
        history.pushState({ tab: tabName }, '', path + search);
      }
    }

    try {
      // Load data specific to tabs
      if (tabName === 'dashboard') {
        await this.loadDashboardData();
      } else if (tabName === 'trade') {
        await this.loadTradingData();
      } else if (tabName === 'wallet') {
        await this.loadWalletData(options.action);
      } else if (tabName === 'history') {
        await this.loadHistoryData();
      } else if (tabName === 'profile') {
        if (!options.preserveViewed) {
          this.viewedUserId = null;
          this.viewedUser = null;
          this.currentProfileTab = 'feed';
        }
        this.setupHeaderAndNav();
        
        const pathName = originalPathName;
        if (pathName === 'settings') {
          this.showProfileSubScreen('settings');
        } else if (pathName === 'convert') {
          this.showProfileSubScreen('convert-currency');
        } else if (pathName === 'help') {
          this.showProfileSubScreen('contact');
        } else {
          this.showProfileSubScreen('main');
          this.showProfileMainSubTab(this.currentProfileTab || 'feed');
        }
      } else if (tabName === 'market') {
        await this.loadMarketData();
      } else if (tabName === 'claim-card') {
        await this.loadClaimCardPageData();
      } else if (tabName === 'support') {
        // Support page needs no data loading — static content
      } else if (tabName === 'leaderboard') {
        await this.loadLeaderboardData();
      } else if (tabName === 'admin') {
        await this.loadAdminData();
      } else if (tabName === 'notifications') {
        this.loadNotificationsHistory();
      } else if (tabName === 'chat') {
        await this.chatController.init();
      }
    } catch (err) {
      console.error('Error loading tab data:', err);
    }
    this.updateNavIndicator();
    this.updateSupportFloatVisibility();
  },

  // FAQ toggle
  toggleFaq(el) {
    el.classList.toggle('open');
  },

  // Helper: show inline form error
  showFormError(boxId, message, inputIds = []) {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.textContent = message;
    box.style.display = 'flex';
    // Re-trigger shake animation
    box.style.animation = 'none';
    box.offsetHeight; // reflow
    box.style.animation = 'errorShake 0.35s ease';
    // Highlight bad inputs
    document.querySelectorAll('.form-control.input-error').forEach(el => el.classList.remove('input-error'));
    inputIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('input-error');
    });
  },

  hideFormError(boxId) {
    const box = document.getElementById(boxId);
    if (box) box.style.display = 'none';
    document.querySelectorAll('.form-control.input-error').forEach(el => el.classList.remove('input-error'));
  },

  showFormSuccess(boxId, message) {
    const box = document.getElementById(boxId);
    if (!box) return;
    box.textContent = message;
    box.style.display = 'flex';
  },

  async handleLogin(e) {
    e.preventDefault();
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const btn = document.getElementById('login-submit-btn');
    const btnText = document.getElementById('login-btn-text');
    const u = usernameEl.value.trim();
    const p = passwordEl.value;

    // Clear previous errors
    this.hideFormError('login-error');

    if (!u) {
      this.showFormError('login-error', 'Please enter your username.', ['login-username']);
      usernameEl.focus();
      return;
    }
    if (!p) {
      this.showFormError('login-error', 'Please enter your password.', ['login-password']);
      passwordEl.focus();
      return;
    }

    // Loading state
    btn.classList.add('btn-loading');
    btnText.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();

      if (res.ok) {
        this.hideFormError('login-error');
        this.showToast('Welcome back, ' + data.user.username + '! 👋');
        if (data.token) {
          localStorage.setItem('token', data.token);
        }
        this.user = data.user;
        if (data.user && data.user.has_active_bot !== undefined) {
          this.hasActiveBot = !!data.user.has_active_bot;
        }
        if (window.OneSignalWrapper) {
          window.OneSignalWrapper.login(data.user.id);
        }
        if (data.permissions) this.permissions = data.permissions;
        this.accountType = 'real';
        this._saveTradePrefs();
        localStorage.removeItem('support_chat_prefer_welcome');
        this.loadNotificationsFromStorage();
        this.setupHeaderAndNav();
        await this.navigateTo('dashboard', { replaceState: true });
      } else {
        // Show specific error message based on error type
        const errMsg = data.error || '';
        if (errMsg.toLowerCase().includes('password') || errMsg.toLowerCase().includes('invalid')) {
          this.showFormError('login-error',
            'Wrong username or password. Please check your credentials and try again.',
            ['login-username', 'login-password']
          );
          passwordEl.value = '';
          passwordEl.focus();
        } else if (errMsg.toLowerCase().includes('blocked')) {
          this.showFormError('login-error',
            '🚫 Your account has been blocked. Please contact support.',
            ['login-username']
          );
        } else if (errMsg.toLowerCase().includes('frozen')) {
          this.showFormError('login-error',
            '❄️ Your account is temporarily frozen. Contact support.',
            ['login-username']
          );
        } else {
          this.showFormError('login-error', errMsg || 'Login failed. Please try again.', ['login-username', 'login-password']);
        }
      }
    } catch (err) {
      this.showFormError('login-error', 'Cannot connect to server. Please try again.', []);
    }

    btn.classList.remove('btn-loading');
    btnText.textContent = 'Sign In';
  },

  async handleSignup(e) {
    e.preventDefault();
    const fullnameEl = document.getElementById('signup-fullname');
    const usernameEl = document.getElementById('signup-username');
    const emailEl = document.getElementById('signup-email');
    const phoneEl = document.getElementById('signup-phone');
    const passwordEl = document.getElementById('signup-password');
    const confirmPasswordEl = document.getElementById('signup-confirm-password');
    const inviteEl = document.getElementById('signup-invite');
    const currencyEl = document.getElementById('signup-currency');
    const btn = document.getElementById('signup-submit-btn');
    const btnText = document.getElementById('signup-btn-text');
    const fullname = fullnameEl ? fullnameEl.value.trim() : '';
    const u = usernameEl.value.trim();
    const email = emailEl ? emailEl.value.trim() : '';
    const phone = phoneEl ? phoneEl.value.trim() : '';
    const p = passwordEl.value;
    const cp = confirmPasswordEl ? confirmPasswordEl.value : p;
    const code = inviteEl.value.trim().toUpperCase();
    const currency = currencyEl ? currencyEl.value : 'USD';

    console.log('[SIGNUP DEBUG] Form code value:', JSON.stringify(code));

    // Clear previous messages
    this.hideFormError('signup-error');
    const successBox = document.getElementById('signup-success');
    if (successBox) successBox.style.display = 'none';

    // Client-side validation
    if (!fullname) {
      this.showFormError('signup-error', 'Please enter your full name.', ['signup-fullname']);
      if (fullnameEl) fullnameEl.focus(); return;
    }
    if (!u) {
      this.showFormError('signup-error', 'Please enter a username.', ['signup-username']);
      usernameEl.focus(); return;
    }
    if (u.length < 3) {
      this.showFormError('signup-error', 'Username must be at least 3 characters long.', ['signup-username']);
      usernameEl.focus(); return;
    }
    if (!email) {
      this.showFormError('signup-error', 'Please enter your email address.', ['signup-email']);
      if (emailEl) emailEl.focus(); return;
    }
    if (!phone) {
      this.showFormError('signup-error', 'Please enter your phone number.', ['signup-phone']);
      if (phoneEl) phoneEl.focus(); return;
    }
    if (!p) {
      this.showFormError('signup-error', 'Please enter a password.', ['signup-password']);
      passwordEl.focus(); return;
    }
    if (p.length < 6) {
      this.showFormError('signup-error', 'Password must be at least 6 characters long.', ['signup-password']);
      passwordEl.focus(); return;
    }
    if (p !== cp) {
      this.showFormError('signup-error', 'Passwords do not match. Please re-enter.', ['signup-password', 'signup-confirm-password']);
      if (confirmPasswordEl) confirmPasswordEl.focus(); return;
    }

    const verificationContainer = document.getElementById('signup-verification-container');
    const isVerificationStep = verificationContainer && verificationContainer.style.display !== 'none';
    let verificationCode = '';

    if (isVerificationStep) {
      verificationCode = document.getElementById('signup-verification-code').value.trim();
      if (!verificationCode) {
        this.showFormError('signup-error', 'Please enter the email verification code.', ['signup-verification-code']);
        document.getElementById('signup-verification-code').focus();
        return;
      }
    }

    // Loading state
    btn.classList.add('btn-loading');
    btnText.textContent = isVerificationStep ? 'Verifying code...' : 'Sending code...';

    try {
      const payload = {
        username: u,
        email,
        phone_number: phone,
        password: p,
        confirm_password: cp,
        invite_code: code,
        currency,
        full_name: fullname
      };
      if (isVerificationStep) {
        payload.code = verificationCode;
      }

      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        if (data.code_required) {
          // Switch to verification code view
          document.getElementById('signup-fields-container').style.display = 'none';
          verificationContainer.style.display = 'block';
          btnText.textContent = 'Verify & Complete';
          this.showToast('Verification code sent to your email.');
        } else {
          // Registration complete
          this.showFormSuccess('signup-success', 'Account created successfully! You can now sign in.');
          document.getElementById('signup-form').reset();
          
          // Reset view state for next time
          document.getElementById('signup-fields-container').style.display = 'block';
          verificationContainer.style.display = 'none';
          btnText.textContent = 'Create Account';

          setTimeout(() => {
            this.hideFormError('signup-error');
            this.showScreen('login');
          }, 2000);
        }
      } else {
        const errMsg = data.error || '';
        console.warn('[SIGNUP DEBUG] Server rejected with error:', errMsg);
        if (errMsg === 'Invalid invite code.') {
          this.showFormError('signup-error', '❌ Invalid invite code. Please check the code and try again.', ['signup-invite']);
          inviteEl.focus();
        } else if (errMsg.toLowerCase().includes('email')) {
          this.showFormError('signup-error', 'This email is already registered.', ['signup-email']);
          if (emailEl) emailEl.focus();
        } else if (errMsg.toLowerCase().includes('username') || errMsg.toLowerCase().includes('taken') || errMsg.toLowerCase().includes('exists')) {
          this.showFormError('signup-error', 'This username is already taken. Please choose a different one.', ['signup-username']);
          usernameEl.focus();
        } else {
          this.showFormError('signup-error', errMsg || 'Registration failed. Please try again.', []);
        }
      }
    } catch (err) {
      this.showFormError('signup-error', 'Cannot connect to server. Please try again.', []);
    }

    btn.classList.remove('btn-loading');
    if (!isVerificationStep) {
      btnText.textContent = 'Create Account';
    } else {
      btnText.textContent = 'Verify & Complete';
    }
  },

  async resendSignupCode(e) {
    if (e) e.preventDefault();
    const btn = document.getElementById('btn-resend-signup-code');
    if (!btn || btn.textContent.includes('Sending')) return;

    const emailEl = document.getElementById('signup-email');
    const email = emailEl ? emailEl.value.trim() : '';
    if (!email) {
      this.showToast('Email address is missing.', 'error');
      return;
    }

    btn.textContent = 'Sending...';
    btn.style.pointerEvents = 'none';

    try {
      const payload = {
        username: document.getElementById('signup-username').value.trim(),
        email: email,
        phone_number: document.getElementById('signup-phone').value.trim(),
        password: document.getElementById('signup-password').value,
        confirm_password: document.getElementById('signup-confirm-password').value,
        invite_code: document.getElementById('signup-invite').value.trim(),
        full_name: document.getElementById('signup-fullname').value.trim()
      };

      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Verification code resent to your email.');
        let count = 60;
        const interval = setInterval(() => {
          count--;
          if (count <= 0) {
            clearInterval(interval);
            btn.textContent = 'Resend Code';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.textContent = `Retry in ${count}s`;
          }
        }, 1000);
      } else {
        this.showToast(data.error || 'Failed to resend code.', 'error');
        btn.textContent = 'Resend Code';
        btn.style.pointerEvents = 'auto';
      }
    } catch (err) {
      this.showToast('Network error resending code.', 'error');
      btn.textContent = 'Resend Code';
      btn.style.pointerEvents = 'auto';
    }
  },

  async handleLogout() {
    if (window.OneSignalWrapper) {
      window.OneSignalWrapper.logout();
    }
    try {
      localStorage.removeItem('token');
      await fetch('/api/auth/logout', { method: 'POST' });
      this.user = null;
      this.permissions = null;
      this.accountType = 'real';
      this._saveTradePrefs();
      localStorage.removeItem('support_chat_prefer_welcome');
      this.notifiedTradeIds = null;
      this.pollingTradeIds = null;
      this.lastActiveTrades = null;
      // Clear timers
      Object.values(this.activeTradeIntervals).forEach(clearInterval);
      this.activeTradeIntervals = {};
      this.loadNotificationsFromStorage();
      this.showToast('Logged out successfully.');
      this.showScreen('onboarding');
    } catch (err) {
      localStorage.removeItem('token');
      this.user = null;
      this.permissions = null;
      this.loadNotificationsFromStorage();
      this.showScreen('onboarding');
    }
  },

  async handleProfilePicUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.showToast('Image too large. Max 10MB.', 'error'); return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const cropImg = document.getElementById('crop-modal-image');
      if (cropImg) {
        cropImg.src = e.target.result;
      }
      
      const cropModal = document.getElementById('profile-crop-modal');
      if (cropModal) {
        cropModal.style.display = 'flex';
      }

      if (this.cropperInstance) {
        this.cropperInstance.destroy();
      }

      if (cropImg) {
        this.cropperInstance = new Cropper(cropImg, {
          aspectRatio: 1,
          viewMode: 1,
          dragMode: 'move',
          autoCropArea: 0.8,
          restore: false,
          guides: true,
          center: true,
          highlight: false,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: false,
        });
      }
    };
    reader.readAsDataURL(file);
    input.value = '';
  },

  closeCropModal() {
    const cropModal = document.getElementById('profile-crop-modal');
    if (cropModal) {
      cropModal.style.display = 'none';
    }
    if (this.cropperInstance) {
      this.cropperInstance.destroy();
      this.cropperInstance = null;
    }
  },

  zoomCropper(value) {
    if (this.cropperInstance) {
      this.cropperInstance.zoom(value);
    }
  },

  rotateCropper(value) {
    if (this.cropperInstance) {
      this.cropperInstance.rotate(value);
    }
  },

  async performCrop() {
    if (!this.cropperInstance) return;

    const canvas = this.cropperInstance.getCroppedCanvas({
      width: 512,
      height: 512,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });

    if (!canvas) {
      this.showToast('Failed to crop image.', 'error');
      return;
    }

    canvas.toBlob(async (blob) => {
      if (!blob) {
        this.showToast('Failed to process image data.', 'error');
        return;
      }

      const formData = new FormData();
      formData.append('profile_pic', blob, 'profile_pic.jpg');

      this.showToast('Uploading profile picture...');

      try {
        const res = await fetch('/api/client/profile/upload-pic', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (res.ok) {
          this.showToast('Profile picture uploaded successfully! ✓');
          if (this.user) {
            this.user.profile_pic = data.profile_pic;
          }
          this.setupHeaderAndNav();
          this.closeCropModal();
        } else {
          this.showToast(data.error || 'Failed to upload profile picture.', 'error');
        }
      } catch (err) {
        this.showToast('Network error uploading profile picture.', 'error');
      }
    }, 'image/jpeg', 0.9);
  },

  async selectQuickAvatar(avatarUrl) {
    if (!avatarUrl) return;
    this.showToast('Saving profile picture...');
    try {
      const res = await fetch('/api/client/profile/select-avatar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ avatar_url: avatarUrl })
      });
      const data = await res.json();
      if (res.ok) {
        this.showToast('Profile picture updated successfully! ✓');
        if (this.user) {
          this.user.profile_pic = data.profile_pic;
        }
        this.setupHeaderAndNav();
      } else {
        this.showToast(data.error || 'Failed to update profile picture.', 'error');
      }
    } catch (err) {
      console.error(err);
      this.showToast('Network error saving avatar.', 'error');
    }
  },

  // Copy referral code
  copyInviteCode() {
    const inviteInput = document.getElementById('profile-invite-code-input');
    if (!inviteInput) return;
    inviteInput.select();
    inviteInput.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(inviteInput.value);
    this.showToast('Invite code copied to clipboard!');
  },

  // --- DASHBOARD DATA ---

  async loadDashboardData() {
    try {
      // Fetch wallet, visa card, coins, and history concurrently to optimize load speed
      const walletPromise = fetch('/api/client/wallet')
        .then(async res => {
          if (res.ok) {
            const data = await res.json();
            this.user.balance = data.balance;
            this.user.demo_balance = data.demo_balance;
            this.user.real_account_active = data.real_account_active;
            this.user.status = data.status;
            this.updateBalanceDisplays();
          }
        })
        .catch(err => console.error('Error fetching wallet:', err));

      const visaPromise = fetch('/api/client/visa-card')
        .then(async visaRes => {
          if (visaRes.ok) {
            const visaData = await visaRes.json();
            const card = visaData.visaCard;
            
            const panel = document.getElementById('dashboard-visa-card-panel');
            const overlay = document.getElementById('visa-card-blur-overlay');
            const badge = document.getElementById('visa-card-status-badge');
            const numDisplay = document.getElementById('visa-card-num-display');
            const expDisplay = document.getElementById('visa-card-exp-display');
            const holderDisplay = document.getElementById('visa-card-holder-display');
            const infoText = document.getElementById('visa-card-info-text');
            const actionContainer = document.getElementById('visa-card-action-container');
            const statusLabel = document.getElementById('visa-card-status-label');

            if (panel) {
              panel.style.display = 'block';

              if (!card) {
                if (overlay) overlay.style.display = 'flex';
                if (badge) badge.style.display = 'none';
                if (numDisplay) numDisplay.textContent = '•••• •••• •••• ••••';
                if (expDisplay) expDisplay.textContent = 'EX: --/--';
                if (holderDisplay) holderDisplay.textContent = 'CARDHOLDER NAME';
                if (infoText) infoText.innerHTML = 'Order a physical premium Visa debit card directly shipped from Hong Kong. Fee: $34.00 (from deposited funds only).';
                if (actionContainer) actionContainer.style.display = 'none';
                if (statusLabel) {
                  statusLabel.className = 'visa-card-status-label inactive';
                  statusLabel.innerHTML = '<span class="status-dot"></span>Non-Active';
                }
              } else {
                if (overlay) overlay.style.display = 'none';

                // Update physical card status label
                if (statusLabel) {
                  if (card.status === 'active') {
                    statusLabel.className = 'visa-card-status-label active';
                    statusLabel.innerHTML = '<span class="status-dot"></span>Active';
                  } else {
                    statusLabel.className = 'visa-card-status-label inactive';
                    statusLabel.innerHTML = '<span class="status-dot"></span>Non-Active';
                  }
                }

                if (badge) {
                  badge.style.display = 'inline-flex';
                  badge.className = 'verification-badge';
                  if (card.status === 'pending') {
                    badge.classList.add('status-pending');
                    badge.textContent = 'in delivery process';
                  } else if (card.status === 'delivered') {
                    badge.classList.add('status-verified');
                    badge.style.backgroundColor = 'rgba(59,130,246,0.12)';
                    badge.style.borderColor = 'rgba(59,130,246,0.25)';
                    badge.style.color = '#3b82f6';
                    badge.textContent = 'delivered';
                  } else if (card.status === 'active') {
                    badge.classList.add('status-verified');
                    badge.textContent = 'active';
                  }
                }

                if (numDisplay) {
                  const cleaned = (card.card_number || '').replace(/\D/g, '');
                  const last4 = cleaned ? cleaned.slice(-4) : String(card.user_id || 0).padStart(4, '0').slice(-4);
                  numDisplay.textContent = `•••• •••• •••• ${last4}`;
                }

                if (expDisplay) {
                  if (card.card_expiry) {
                    expDisplay.textContent = card.card_expiry;
                  } else {
                    const date = card.created_at ? new Date(card.created_at) : new Date();
                    const month = String(date.getMonth() + 1).padStart(2, '0');
                    const year = String(date.getFullYear() + 5).slice(-2);
                    expDisplay.textContent = `${month}/${year}`;
                  }
                }

                if (holderDisplay) {
                  holderDisplay.textContent = card.nickname ? card.nickname.toUpperCase() : `${card.first_name} ${card.last_name}`.toUpperCase();
                }

                if (infoText) {
                  if (card.status === 'pending') {
                    infoText.innerHTML = 'Your physical premium Visa card has been claimed and is in the delivery process from Hong Kong (1-2 months).';
                  } else if (card.status === 'delivered') {
                    infoText.innerHTML = 'Your physical premium Visa card has arrived! Click below to activate it and load your $25.00 credit.';
                  } else if (card.status === 'active') {
                    infoText.innerHTML = 'Your physical Visa card is active and loaded. Enjoy global spending and ATM access.';
                  }
                }

                if (actionContainer) {
                  actionContainer.style.display = (card.status === 'delivered') ? 'block' : 'none';
                }
              }
            }
          }
        })
        .catch(err => console.error('Error loading Visa Card data on dashboard:', err));

      const coinsPromise = fetch('/api/client/coins')
        .then(async coinsRes => {
          if (coinsRes.ok) {
            const coinsData = await coinsRes.json();
            const listContainer = document.getElementById('dashboard-markets-list');
            if (coinsData.coins.length > 0) {
              const pricePromises = coinsData.coins.map(coin => this.getBinancePrice(coin));
              const prices = await Promise.all(pricePromises);

              listContainer.innerHTML = '';
              coinsData.coins.forEach((coin, index) => {
                const price = prices[index];
                const randChange = (Math.random() * 4 - 2).toFixed(2);
                const isUp = parseFloat(randChange) >= 0;

                const row = document.createElement('div');
                row.className = 'list-item';
                row.style.cursor = 'pointer';
                row.onclick = () => {
                  this.selectedCoin = coin;
                  this.navigateTo('trade');
                };
                row.innerHTML = `
                  <div class="item-left">
                    <span class="item-title">${coin}/USDT</span>
                    <span class="item-subtitle">Cryptocurrency Coin</span>
                  </div>
                  <div class="item-right">
                    <span class="item-val">$${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4})}</span>
                    <span style="font-size:11px; font-weight:700; color: ${isUp ? 'var(--primary)' : 'var(--danger)'};">
                      ${isUp ? '▲' : '▼'} ${isUp ? '+' : ''}${randChange}%
                    </span>
                  </div>
                `;
                listContainer.appendChild(row);
              });
            } else {
              listContainer.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;">No visible coins.</div>`;
            }
          }
        })
        .catch(err => console.error('Error loading coins:', err));

      const historyPromise = fetch('/api/client/history')
        .then(async histRes => {
          if (histRes.ok) {
            const histData = await histRes.json();
            this.lastTrades = histData.trades || [];
            this.updateDashboardStats();
            const activityBox = document.getElementById('dashboard-recent-activity');
            const merged = [
              ...histData.deposits.map(d => ({ ...d, logType: 'deposit' })),
              ...histData.withdrawals.map(w => ({ ...w, logType: 'withdrawal' })),
              ...histData.trades.map(t => ({ ...t, logType: 'trade' }))
            ].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

            if (merged.length > 0) {
              activityBox.innerHTML = '';
              merged.forEach(item => {
                const row = document.createElement('div');
                row.className = 'list-item';
                
                let title = '';
                let subtitle = new Date(item.created_at).toLocaleDateString() + ' ' + new Date(item.created_at).toLocaleTimeString();
                let amountText = '';
                let badgeClass = '';

                const currency = this.user ? this.user.currency : 'USD';
                if (item.logType === 'deposit') {
                  title = `Deposit Approved (${item.method})`;
                  amountText = `+${this.formatCurrency(item.amount, currency)}`;
                  badgeClass = item.status === 'approved' ? 'badge-approved' : (item.status === 'pending' ? 'badge-pending' : 'badge-rejected');
                } else if (item.logType === 'withdrawal') {
                  title = `Withdrawal Requested (${item.method})`;
                  amountText = `-${this.formatCurrency(item.amount, currency)}`;
                  badgeClass = item.status === 'approved' ? 'badge-approved' : (item.status === 'pending' ? 'badge-pending' : 'badge-rejected');
                } else if (item.logType === 'trade') {
                  title = `${item.direction} Contract on ${item.coin}`;
                  amountText = item.status === 'win' ? `+${this.formatCurrency(item.amount * (item.commission_pct/100), currency)}` : (item.status === 'active' ? `Pending` : `-${this.formatCurrency(item.amount, currency)}`);
                  badgeClass = `badge-${item.status}`;
                }

                let cancelBtnHtml = '';
                if (item.logType === 'withdrawal' && item.status === 'pending' && item.id) {
                  cancelBtnHtml = `<button type="button" class="btn-cancel-tx" onclick="app.cancelWithdrawal(${item.id}, event)" style="font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(239, 68, 68, 0.12) !important; color: #ff6251 !important; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid rgba(239, 68, 68, 0.3) !important; cursor: pointer; transition: all 0.2s ease; margin-left: 6px; display: inline-flex; align-items: center; gap: 3px;" onmouseover="this.style.background='rgba(239,68,68,0.22)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Cancel</button>`;
                }

                row.innerHTML = `
                  <div class="item-left">
                    <span class="item-title">${title}</span>
                    <span class="item-subtitle">${subtitle}</span>
                  </div>
                  <div class="item-right">
                    <span class="item-val ${amountText.startsWith('+') ? 'text-green' : (amountText.startsWith('-') ? 'text-danger' : '')}">${amountText}</span>
                    <div style="display: inline-flex; align-items: center;"><span class="badge ${badgeClass}">${item.status}</span>${cancelBtnHtml}</div>
                  </div>
                `;
                activityBox.appendChild(row);
              });
            } else {
              activityBox.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;">No recent transactions.</div>`;
            }
          }
        })
        .catch(err => console.error('Error loading history:', err));

      // Await all parallel promises
      await Promise.all([walletPromise, visaPromise, coinsPromise, historyPromise]);

    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    }
  },

  updateDashboardStats() {
    const totalTradesEl = document.getElementById('dashboard-total-trades');
    const winRateEl = document.getElementById('dashboard-win-rate');
    const netPnlEl = document.getElementById('dashboard-net-pnl');
    if (!totalTradesEl && !winRateEl && !netPnlEl) return;

    const trades = this.lastTrades || [];
    const isDemo = this.accountType === 'demo';
    const filteredTrades = trades.filter(t => isDemo ? (t.is_demo === 1) : (t.is_demo === 0 || !t.is_demo));

    let totalTrades = filteredTrades.length;
    let winTrades = filteredTrades.filter(t => t.status === 'win').length;
    let winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

    let netPnl = 0;
    filteredTrades.forEach(t => {
      if (t.status === 'win') {
        netPnl += t.amount * (t.commission_pct / 100.0);
      } else if (t.status === 'lose') {
        netPnl -= t.amount;
      }
    });

    // Custom overrides from Admin Staff management if set
    if (this.user) {
      if (isDemo) {
        if (this.user.demo_custom_total_trades !== null && this.user.demo_custom_total_trades !== undefined && this.user.demo_custom_total_trades !== '') {
          totalTrades = parseInt(this.user.demo_custom_total_trades, 10);
        }
        if (this.user.demo_custom_win_rate !== null && this.user.demo_custom_win_rate !== undefined && this.user.demo_custom_win_rate !== '') {
          winRate = parseFloat(this.user.demo_custom_win_rate);
        }
        if (this.user.demo_custom_net_pnl !== null && this.user.demo_custom_net_pnl !== undefined && this.user.demo_custom_net_pnl !== '') {
          netPnl = parseFloat(this.user.demo_custom_net_pnl);
        }
      } else {
        if (this.user.custom_total_trades !== null && this.user.custom_total_trades !== undefined && this.user.custom_total_trades !== '') {
          totalTrades = parseInt(this.user.custom_total_trades, 10);
        }
        if (this.user.custom_win_rate !== null && this.user.custom_win_rate !== undefined && this.user.custom_win_rate !== '') {
          winRate = parseFloat(this.user.custom_win_rate);
        }
        if (this.user.custom_net_pnl !== null && this.user.custom_net_pnl !== undefined && this.user.custom_net_pnl !== '') {
          netPnl = parseFloat(this.user.custom_net_pnl);
        }
      }
    }

    if (totalTradesEl) totalTradesEl.textContent = totalTrades;
    if (winRateEl) winRateEl.textContent = (typeof winRate === 'number' ? Math.round(winRate) : winRate) + '%';
    if (netPnlEl) {
      const currency = isDemo ? 'USD' : (this.user ? this.user.currency : 'USD');
      const formatted = this.formatCurrency(netPnl, currency);
      netPnlEl.textContent = (netPnl >= 0 ? '+' : '') + formatted;
      if (netPnl >= 0) {
        netPnlEl.classList.remove('text-danger');
        netPnlEl.classList.add('text-green');
      } else {
        netPnlEl.classList.remove('text-green');
        netPnlEl.classList.add('text-danger');
      }
    }
  },

  // Binance direct ticker fetch
  async getBinancePrice(coin) {
    try {
      const res = await fetch(`/api/client/price/${encodeURIComponent(coin)}`);
      if (res.ok) {
        const data = await res.json();
        return parseFloat(data.price);
      } else {
        const data = await res.json();
        if (data.error === 'Trading is not enabled for this coin.') {
          this.handleAssetDisabled(coin);
        }
      }
    } catch (err) {
      console.warn('Server price fetch failed, mocking:', coin);
    }
    const fallbacks = {
      BTC: 69200, ETH: 3800, SOL: 155, BNB: 595, DOGE: 0.138,
      XRP: 0.568, ADA: 0.453, AVAX: 36.4, MATIC: 0.712,
      LINK: 14.82, LTC: 84.5, DOT: 7.35, TRX: 0.1124,
      UNI: 9.74, ATOM: 8.96
    };
    return (fallbacks[coin.toUpperCase()] || 100.0) + (Math.random() * 2 - 1);
  },

  disabledAssetsState: {},

  handleAssetDisabled(coin) {
    if (this.selectedCoin !== coin) return;

    if (this.disabledAssetsState[coin] === 'shown' || this.disabledAssetsState[coin] === 'pending') {
      return;
    }

    const hasActiveTrade = this.lastActiveTrades && this.lastActiveTrades.some(t => t.coin === coin);

    if (hasActiveTrade) {
      this.disabledAssetsState[coin] = 'pending';
      if (!this.tabSessions[coin]) this.tabSessions[coin] = {};
      this.tabSessions[coin].hadActiveTrade = true;

      const checkInterval = setInterval(() => {
        if (this.selectedCoin !== coin) {
          clearInterval(checkInterval);
          delete this.disabledAssetsState[coin];
          return;
        }

        const stillHasActive = this.lastActiveTrades && this.lastActiveTrades.some(t => t.coin === coin);
        if (!stillHasActive) {
          clearInterval(checkInterval);
          setTimeout(() => {
            if (this.selectedCoin === coin) {
              this.showToast('Trading is not enabled for this coin.', 'error');
              this.disabledAssetsState[coin] = 'shown';
            } else {
              delete this.disabledAssetsState[coin];
            }
          }, 8000);
        }
      }, 2000);
    } else {
      this.showToast('Trading is not enabled for this coin.', 'error');
      this.disabledAssetsState[coin] = 'shown';
    }
  },

  // --- MARKET TAB ---
  async loadMarketData() {
    const cryptoList = document.getElementById('market-crypto-list');
    const forexList = document.getElementById('market-forex-list');
    if (cryptoList) cryptoList.innerHTML = '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:20px;">Loading...</div>';
    if (forexList) forexList.innerHTML = '<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:20px;">Loading...</div>';

    try {
      const coinsRes = await fetch('/api/client/coins');
      const coinsData = await coinsRes.json();

      // Crypto
      if (cryptoList && coinsRes.ok && coinsData.coins && coinsData.coins.length > 0) {
        const visibleCoins = coinsData.coins.slice(0, 12);
        // Fetch prices in parallel to optimize load speed and give full smoothness
        const pricePromises = visibleCoins.map(coin => this.getBinancePrice(coin));
        const prices = await Promise.all(pricePromises);

        cryptoList.innerHTML = '';
        visibleCoins.forEach((coin, index) => {
          const price = prices[index];
          const change = (Math.random() * 8 - 4).toFixed(2);
          const isUp = parseFloat(change) >= 0;
          const row = document.createElement('div');
          row.className = 'list-item';
          row.style.cursor = 'pointer';
          row.onclick = () => { this.selectedCoin = coin; this.navigateTo('trade'); };
          row.innerHTML = `
            <div class="item-left">
              <span class="item-title">${coin}/USDT</span>
              <span class="item-subtitle">Cryptocurrency</span>
            </div>
            <div class="item-right">
              <span class="item-val">$${price.toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:4})}</span>
              <span style="font-size:11px;font-weight:700;color:${isUp?'var(--primary)':'var(--danger)'};">${isUp?'▲':'▼'} ${isUp?'+':''}${change}%</span>
            </div>
          `;
          cryptoList.appendChild(row);
        });
      }

      // Forex
      const forexPairs = (coinsData.forex && coinsData.forex.length > 0) ? coinsData.forex : ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CHF','NZD/USD'];
      if (forexList) {
        forexList.innerHTML = '';
        forexPairs.slice(0, 8).forEach(pair => {
          const basePrice = { 'EUR/USD': 1.0882, 'GBP/USD': 1.2735, 'USD/JPY': 154.60, 'AUD/USD': 0.6548, 'USD/CHF': 0.9003, 'NZD/USD': 0.5990, 'USD/CAD': 1.3655, 'EUR/GBP': 0.8540 };
          const price = (basePrice[pair] || 1.0) + (Math.random() * 0.002 - 0.001);
          const change = (Math.random() * 1.2 - 0.6).toFixed(4);
          const isUp = parseFloat(change) >= 0;
          const row = document.createElement('div');
          row.className = 'list-item';
          row.style.cursor = 'pointer';
          row.onclick = () => { this.selectedCoin = pair; this.navigateTo('trade'); };
          row.innerHTML = `
            <div class="item-left">
              <span class="item-title">${pair}</span>
              <span class="item-subtitle">Forex Pair</span>
            </div>
            <div class="item-right">
              <span class="item-val">${price.toFixed(5)}</span>
              <span style="font-size:11px;font-weight:700;color:${isUp?'var(--primary)':'var(--danger)'};">${isUp?'▲':'▼'} ${isUp?'+':''}${change}</span>
            </div>
          `;
          forexList.appendChild(row);
        });
      }
    } catch (err) {
      console.error('Market data load failed:', err);
    }
  },

  // --- TRADING TAB SYSTEM ---

  async loadTradingData() {
    try {
      this._tradingPageInitialized = false;
      console.log('Loading trading data...');
      // 1. Fetch visible coins and forex pairs
      const coinsRes = await fetch('/api/client/coins');
      if (coinsRes.ok) {
        const coinsData = await coinsRes.json();
        this.allCryptoCoins = coinsData.coins || [];
        this.allForexPairs = coinsData.forex || [];
        this.allOtcPairs = coinsData.otc || [];
        console.log('Loaded coins from API:', this.allCryptoCoins);
      } else {
        this.allCryptoCoins = this.allCryptoCoins && this.allCryptoCoins.length > 0 ? this.allCryptoCoins : ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP', 'ADA', 'AVAX', 'MATIC', 'LINK', 'LTC', 'DOT', 'TRX', 'UNI', 'ATOM'];
        this.allForexPairs = this.allForexPairs && this.allForexPairs.length > 0 ? this.allForexPairs : ['EUR/USD', 'USD/CAD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'USD/INR', 'USD/PKR', 'USD/BDT', 'GBP/CHF'];
        this.allOtcPairs = this.allOtcPairs && this.allOtcPairs.length > 0 ? this.allOtcPairs : ['EUR/USD (OTC)', 'GBP/USD (OTC)', 'USD/JPY (OTC)', 'AUD/USD (OTC)', 'USD/CAD (OTC)', 'EUR/JPY (OTC)', 'EUR/GBP (OTC)', 'GBP/JPY (OTC)', 'BTC/USD (OTC)', 'ETH/USD (OTC)', 'SAR/CNY (OTC)', 'OMR/CNY (OTC)', 'AUD/CHF (OTC)', 'AED/CNY (OTC)', 'AED CNY (OTC)', 'USD BRL (OTC)'];
      }
      
      // Setup initial coin if not set
      if (!this.selectedCoin && this.allCryptoCoins.length > 0) {
        this.selectedCoin = this.allCryptoCoins[0];
      }

      // Restore saved preferences (coin, duration, timeMode, stakeMode, stakePercent)
      const savedPrefs = this._loadTradePrefs();
      if (savedPrefs) {
        if (savedPrefs.selectedCoin) this.selectedCoin = savedPrefs.selectedCoin;
        this.selectedDuration = Math.max(10, savedPrefs.selectedDuration || 30);
        this.timeMode = savedPrefs.timeMode || 'countdown';
        this.stakeMode = savedPrefs.stakeMode || 'amount';
        if (savedPrefs.stakePercent) this.stakePercent = savedPrefs.stakePercent;
        // accountType is restored later after confirming user's real_account_active status
        this._pendingAccountType = savedPrefs.accountType || null;
        this._pendingTimeframe   = savedPrefs.activeTimeframe || '1m';
      } else {
        this.selectedDuration = 30;
        this.timeMode = 'countdown';
        this.stakeMode = 'amount';
        this._pendingTimeframe = '1m';
      }

      // Initialize trading tabs
      this.initTradingTabs();

      // 2. Fetch trade options (durations) and populate the select dropdown
      const fetchTradeOptions = async () => {
        try {
          const optRes = await fetch('/api/client/trade-options');
          const timePicker = document.getElementById('trade-time-picker');
          if (optRes.ok) {
            const optData = await optRes.json();
            if (timePicker) {
              this.tradeOptions = optData.options || [];
            }
            this.assetPayouts = optData.asset_payouts || {};
            // populate countdown options
            this._populateTimePicker();
            this.updatePayoutPreview();
          }
        } catch (e) {
          console.error('Failed to fetch trade options:', e);
        }
      };
      await fetchTradeOptions();
      setInterval(fetchTradeOptions, 10000);

      // Set currency symbol label
      const currLabel = document.getElementById('trade-currency-symbol');
      if (currLabel && this.user && this.user.currency) {
        currLabel.textContent = this.user.currency;
      }

      // Update payout preview
      this.updatePayoutPreview();

      // 3. Initialize chart — wait for layout to settle (especially mobile flex-column)
      // Use setTimeout + multiple rAF to ensure the canvas container has proper dimensions
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              chart.init(this.selectedCoin);
            });
          });
        });
      }, 50);


      // 4. Start active price ticker interval
      this.priceTickerInterval = setInterval(() => {
        this.updatePriceTicker(this.selectedCoin);
      }, 2000);

      // 5. Restore account type (after user status is known)
      if (this._pendingAccountType === 'real' && this.user && this.user.real_account_active === 1) {
        this.switchAccountType('real');
      } else if (this._pendingAccountType === 'demo') {
        this.switchAccountType('demo');
      }
      this._pendingAccountType = null;

      // 6. Restore chart timeframe
      if (this._pendingTimeframe && window.chart) {
        setTimeout(() => {
          this.changeTimeframe(this._pendingTimeframe);
        }, 300);
      }
      this._pendingTimeframe = null;

      // 7. Load client active and past trades
      this.loadUserContracts();

      this._tradingPageInitialized = true;
    } catch (err) {
      console.error('Failed to load trading page data:', err);
    }
  },

  // --- TABS SYSTEM ---

  initTradingTabs() {
    if (!this.tabs || this.tabs.length === 0) {
      this.tabs = ['BTC'];
    }
    if (!this.selectedCoin) {
      this.selectedCoin = this.tabs[0];
    }
    
    // Ensure the selected coin is in the tabs array!
    if (!this.tabs.includes(this.selectedCoin)) {
      this.tabs.push(this.selectedCoin);
    }
    
    // Calculate default converted amount
    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
      EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
      IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
      THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
      PHP: 58.0, KRW: 1380.0
    };
    let userCurrency = (this.user && this.user.currency ? this.user.currency : 'USD').toUpperCase().trim();
    if (this.accountType === 'demo') {
      userCurrency = 'USD';
    }
    let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
    if (this.accountType !== 'demo' && this.lastWalletData && this.lastWalletData.currency === userCurrency && this.lastWalletData.rate) {
      const parsedRate = parseFloat(this.lastWalletData.rate);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        exchangeRate = parsedRate;
      }
    }
    const defaultAmount = Math.ceil(10.0 * exchangeRate);

    // Ensure all tabs have session state initialized
    this.tabs.forEach(t => {
      if (!this.tabSessions[t]) {
        this.tabSessions[t] = {
          amount: defaultAmount,
          duration: this.selectedDuration || 30,
          timeMode: this.timeMode || 'countdown',
          selectedClockTime: this.selectedClockTime || null
        };
      } else if (this.tabSessions[t].amount === 10 && defaultAmount !== 10) {
        // Correct default 10 USD fallback to target currency equivalent
        this.tabSessions[t].amount = defaultAmount;
      }
    });
    
    this.renderTradingTabs();

    // Update inputs to match the selected coin's session
    const sess = this.tabSessions[this.selectedCoin];
    if (sess) {
      const amountInput = document.getElementById('trade-amount');
      if (amountInput) amountInput.value = sess.amount;
      this.timeMode = sess.timeMode || 'countdown';
      this.selectedDuration = sess.duration || 30;
      this.selectedClockTime = sess.selectedClockTime;
    }
  },

  updateDefaultInvestmentAmount() {
    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
      EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
      IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
      THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
      PHP: 58.0, KRW: 1380.0
    };
    let userCurrency = (this.user && this.user.currency ? this.user.currency : 'USD').toUpperCase().trim();
    if (this.accountType === 'demo') {
      userCurrency = 'USD';
    }
    let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
    if (this.accountType !== 'demo' && this.lastWalletData && this.lastWalletData.currency === userCurrency && this.lastWalletData.rate) {
      const parsedRate = parseFloat(this.lastWalletData.rate);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        exchangeRate = parsedRate;
      }
    }
    const defaultAmount = Math.ceil(10.0 * exchangeRate);

    // Update currency symbol display beside input
    const currLabel = document.getElementById('trade-currency-symbol');
    if (currLabel) {
      currLabel.textContent = userCurrency;
    }

    if (this.tabs) {
      this.tabs.forEach(t => {
        if (this.tabSessions[t]) {
          this.tabSessions[t].amount = defaultAmount;
        }
      });
    }

    const amountInput = document.getElementById('trade-amount');
    if (amountInput) {
      amountInput.value = defaultAmount;
    }
    this.updatePayoutPreview();
  },

  renderTradingTabs() {
    const list = document.getElementById('asset-tabs-list');
    if (!list) return;
    list.innerHTML = '';

    this.tabs.forEach(tab => {
      const isActive = tab === this.selectedCoin;
      
      const tabEl = document.createElement('div');
      tabEl.className = `asset-tab ${isActive ? 'active' : ''}`;
      
      // On click switch tab
      tabEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('asset-tab-close')) return;
        this.switchTab(tab);
      });

      const isForex = tab.includes('/') || tab.toUpperCase().includes('OTC');
      const cleanId = tab.replace('/', '_').replace(/\s*\(OTC\)/gi, '');
      const label = isForex ? tab : `${tab}/USDT`;

      tabEl.innerHTML = `
        <div class="tc-desktop-tab-icon-wrap">
          ${this.getAssetIcon(label)}
        </div>
        <span>${label}</span>
        <button class="asset-tab-close" type="button">✕</button>
      `;

      // Close button event listener
      const closeBtn = tabEl.querySelector('.asset-tab-close');
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tab);
      });

      list.appendChild(tabEl);
    });
  },

  switchTab(symbol) {
    if (!symbol) return;

    if (this.disabledAssetsState) {
      delete this.disabledAssetsState[symbol];
    }
    
    // 1. Save current session values of the old tab
    if (this.selectedCoin) {
      const amountInput = document.getElementById('trade-amount');
      const curAmount = amountInput ? parseFloat(amountInput.value) : 10;
      this.tabSessions[this.selectedCoin] = {
        amount: curAmount,
        duration: this.selectedDuration || 30,
        timeMode: this.timeMode || 'countdown',
        selectedClockTime: this.selectedClockTime
      };
    }

    // 2. Set new active tab
    this.selectedCoin = symbol;
    this._saveTradePrefs(); // persist selected pair
    
    // 3. Load or create session state for new tab
    if (!this.tabSessions[symbol]) {
      this.tabSessions[symbol] = {
        amount: this.tabSessions[this.selectedCoin]?.amount || 10,
        duration: this.selectedDuration || 30,
        timeMode: this.timeMode || 'countdown',
        selectedClockTime: this.selectedClockTime || null
      };
    }
    
    const sess = this.tabSessions[symbol];
    
    // Apply session values to inputs
    const amountInput = document.getElementById('trade-amount');
    if (amountInput) amountInput.value = sess.amount;
    
    this.timeMode = sess.timeMode;
    this.selectedDuration = sess.duration;
    this.selectedClockTime = sess.selectedClockTime;

    // Toggle time mode buttons classes
    const timerToggle = document.getElementById('time-mode-toggle');
    const clockToggle = document.getElementById('time-mode-toggle-clock');
    if (timerToggle && clockToggle) {
      if (this.timeMode === 'countdown') {
        timerToggle.classList.add('active');
        clockToggle.classList.remove('active');
      } else {
        timerToggle.classList.remove('active');
        clockToggle.classList.add('active');
      }
    }

    // Repopulate time picker
    this._populateTimePicker();

    // Select the correct duration/clockTime in time picker dropdown
    const timePicker = document.getElementById('trade-time-picker');
    if (timePicker) {
      if (this.timeMode === 'countdown') {
        timePicker.value = this.selectedDuration;
      } else if (this.selectedClockTime) {
        timePicker.value = this.selectedClockTime;
      }
    }

    // Update payout preview label
    this.updatePayoutPreview();

    // 4. Update Header and Chart
    const label = symbol.includes('/') ? symbol : `${symbol}/USDT`;
    const headerName = document.getElementById('chart-asset-name');
    if (headerName) headerName.textContent = label;

    // Also update mobile asset name display
    const mobileAssetName = document.getElementById('tc-mobile-asset-name');
    if (mobileAssetName) mobileAssetName.textContent = label;

    // Update active tab styles
    this.renderTradingTabs();

    // ✅ Actually switch the chart to the new asset
    if (window.chart) {
      window.chart.handleAssetChange(symbol);
    }
  },

  copyReferralLink() {
    const codeInput = document.getElementById('profile-referral-code');
    if (!codeInput || !codeInput.value || codeInput.value === '—') {
      this.showToast('Referral code not available.', 'error');
      return;
    }
    const link = window.location.origin + '?invite=' + codeInput.value;
    navigator.clipboard.writeText(link).then(() => {
      this.showToast('Referral link copied to clipboard!', 'success');
    }).catch(() => {
      // Fallback if clipboard API is not available
      codeInput.select();
      document.execCommand('copy');
      this.showToast('Referral code copied!', 'success');
    });
  },

  closeTab(symbol) {
    // Remove symbol from tabs list
    this.tabs = this.tabs.filter(t => t !== symbol);
    delete this.tabSessions[symbol];

    if (this.tabs.length === 0) {
      this.tabs = ['BTC'];
    }

    // If we closed the active tab, select a new one
    if (this.selectedCoin === symbol) {
      this.switchTab(this.tabs[this.tabs.length - 1]);
    } else {
      this.renderTradingTabs();
    }
  },

  // --- ASSET PICKER MODAL ---

  openAssetPicker() {
    const modal = document.getElementById('asset-picker-modal');
    if (modal) modal.style.display = 'flex';
    
    // Toggle scroll lock class for mobile overlay
    document.documentElement.classList.add('gxm-overlay-open');
    document.body.classList.add('gxm-overlay-open');
    
    const search = document.getElementById('asset-picker-search');
    if (search) {
      search.value = '';
    }
    
    // Bind Escape key event listener
    this._escapeHandler = (e) => {
      if (e.key === 'Escape') {
        this.closeAssetPicker();
      }
    };
    window.addEventListener('keydown', this._escapeHandler);

    // Load recent assets (max 5, default to standard assets if none found)
    const stored = localStorage.getItem('gainex_recent_assets');
    if (stored) {
      this.recentAssets = JSON.parse(stored);
    } else {
      this.recentAssets = ['BTC', 'ETH', 'SOL', 'EUR/USD'];
      localStorage.setItem('gainex_recent_assets', JSON.stringify(this.recentAssets));
    }

    this.currentCategory = 'otc';

    // Reset categories selector UI state
    const btns = document.querySelectorAll('.category-btn');
    btns.forEach(btn => btn.classList.remove('active'));
    const otcBtn = document.getElementById('cat-btn-otc');
    if (otcBtn) otcBtn.classList.add('active');

    this.renderRecentPills();
    this.renderAssetPickerList('');
  },

  closeAssetPicker(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('asset-picker-modal');
    if (modal) modal.style.display = 'none';

    // Toggle scroll lock class for mobile overlay
    document.documentElement.classList.remove('gxm-overlay-open');
    document.body.classList.remove('gxm-overlay-open');

    // Unbind Escape key listener
    if (this._escapeHandler) {
      window.removeEventListener('keydown', this._escapeHandler);
      this._escapeHandler = null;
    }
  },

  addRecentAsset(symbol) {
    if (!this.recentAssets) this.recentAssets = [];
    // Remove if already exists to move to the end (most recent)
    this.recentAssets = this.recentAssets.filter(item => item !== symbol);
    this.recentAssets.push(symbol);
    // Limit to max 5
    if (this.recentAssets.length > 5) {
      this.recentAssets.shift();
    }
    localStorage.setItem('gainex_recent_assets', JSON.stringify(this.recentAssets));
    this.renderRecentPills();
  },

  renderRecentPills() {
    const container = document.getElementById('asset-picker-pills');
    if (!container) return;
    container.innerHTML = '';

    if (!this.recentAssets || this.recentAssets.length === 0) {
      container.style.display = 'none';
      const label = document.querySelector('.recent-assets-label');
      if (label) label.style.display = 'none';
      return;
    }

    const label = document.querySelector('.recent-assets-label');
    if (label) label.style.display = 'block';
    container.style.display = 'flex';

    this.recentAssets.forEach(symbol => {
      const isForex = symbol.includes('/') || symbol.toUpperCase().includes('OTC');
      const pillLabel = isForex ? symbol : `${symbol}/USDT`;
      const iconSymbol = isForex ? symbol : `${symbol}/USDT`;

      const pill = document.createElement('div');
      pill.className = 'picker-pill';
      pill.onclick = () => {
        this.addRecentAsset(symbol);
        if (!this.tabs.includes(symbol)) {
          this.tabs.push(symbol);
        }
        this.closeAssetPicker();
        this.switchTab(symbol);
      };

      const iconWrap = document.createElement('div');
      iconWrap.className = 'pill-icon-wrap';
      iconWrap.innerHTML = this.getAssetIcon(iconSymbol);

      const span = document.createElement('span');
      span.textContent = pillLabel;

      pill.appendChild(iconWrap);
      pill.appendChild(span);
      container.appendChild(pill);
    });
  },

  setAssetCategory(category) {
    this.currentCategory = category;
    
    // Update active class on categories
    const btns = document.querySelectorAll('.category-btn');
    btns.forEach(btn => btn.classList.remove('active'));
    
    const activeBtn = document.getElementById(`cat-btn-${category}`);
    if (activeBtn) activeBtn.classList.add('active');

    const searchInput = document.getElementById('asset-picker-search');
    this.renderAssetPickerList(searchInput ? searchInput.value : '');
  },

  filterAssets(query) {
    this.renderAssetPickerList(query);
  },

  async renderAssetPickerList(query = '') {
    const list = document.getElementById('asset-picker-list');
    if (!list) return;
    list.innerHTML = '';

    const cleanQuery = query.toLowerCase().trim();

    // ─── FULL HARDCODED FALLBACKS ── always show all pairs ─────────────────────
    const ALL_CRYPTO = ['BTC','ETH','SOL','BNB','DOGE','XRP','ADA','AVAX','MATIC','LINK','LTC','DOT','TRX','UNI','ATOM'];
    const ALL_FOREX  = [
      'EUR/USD','GBP/USD','USD/JPY','USD/CAD','AUD/USD','USD/CHF',
      'NZD/USD','EUR/GBP','EUR/JPY','GBP/JPY','USD/INR','USD/PKR','USD/BDT','GBP/CHF'
    ];
    const ALL_OTC = [
      'EUR/USD (OTC)', 'GBP/USD (OTC)', 'USD/JPY (OTC)', 'AUD/USD (OTC)',
      'USD/CAD (OTC)', 'EUR/JPY (OTC)', 'EUR/GBP (OTC)', 'GBP/JPY (OTC)',
      'BTC/USD (OTC)', 'ETH/USD (OTC)',
      'SAR/CNY (OTC)', 'OMR/CNY (OTC)', 'AUD/CHF (OTC)',
      'AED/CNY (OTC)', 'AED CNY (OTC)', 'USD BRL (OTC)'
    ];
    const ALL_STOCKS = ['Gold', 'Silver'];

    const cryptoCoins = (this.allCryptoCoins && this.allCryptoCoins.length > 0) ? this.allCryptoCoins : ALL_CRYPTO;
    const forexPairs  = (this.allForexPairs  && this.allForexPairs.length  > 0) ? this.allForexPairs  : ALL_FOREX;
    const otcPairs    = (this.allOtcPairs    && this.allOtcPairs.length    > 0) ? this.allOtcPairs    : ALL_OTC;

    const cryptoList = cryptoCoins.map(coin  => ({ symbol: coin,  label: `${coin}/USDT`, type: 'crypto' }));
    const forexList  = forexPairs.map(pair   => ({ symbol: pair,  label: pair,            type: 'forex'  }));
    const otcList    = otcPairs.map(pair     => ({ symbol: pair,  label: pair,            type: 'otc'    }));
    const stocksList = ALL_STOCKS.map(stock  => ({ symbol: stock, label: stock,           type: 'stocks' }));
    const allAssets  = [...cryptoList, ...forexList, ...otcList, ...stocksList];

    let filtered = cleanQuery
      ? allAssets.filter(item => item.label.toLowerCase().includes(cleanQuery))
      : allAssets;

    // Filter by selected category (crypto / forex / otc)
    if (this.currentCategory && this.currentCategory !== 'all') {
      filtered = filtered.filter(item => item.type === this.currentCategory);
    }

    if (filtered.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:30px 0;color:rgba(255,255,255,0.35);font-size:13px;">No assets found for "' + cleanQuery + '"</div>';
      return;
    }

    // Full name map
    const FULL_NAMES = {
      BTC:'Bitcoin', ETH:'Ethereum', SOL:'Solana', BNB:'Binance Coin', DOGE:'Dogecoin',
      XRP:'Ripple XRP', ADA:'Cardano', AVAX:'Avalanche', MATIC:'Polygon', LINK:'Chainlink',
      LTC:'Litecoin', DOT:'Polkadot', TRX:'TRON', UNI:'Uniswap', ATOM:'Cosmos',
      'EUR/USD':'Euro / US Dollar',      'GBP/USD':'British Pound / US Dollar',
      'USD/JPY':'US Dollar / Yen',       'USD/CAD':'US Dollar / Cdn Dollar',
      'AUD/USD':'Australian / US Dollar','USD/CHF':'US Dollar / Swiss Franc',
      'NZD/USD':'NZD / US Dollar',       'EUR/GBP':'Euro / British Pound',
      'EUR/JPY':'Euro / Japanese Yen',   'GBP/JPY':'British Pound / Yen',
      'USD/INR':'US Dollar / Rupee',     'USD/PKR':'US Dollar / Pakistani Rupee',
      'USD/BDT':'US Dollar / Taka',      'GBP/CHF':'British Pound / Swiss Franc',
      'EUR/USD (OTC)': 'Euro / US Dollar (OTC)',
      'GBP/USD (OTC)': 'British Pound / US Dollar (OTC)',
      'USD/JPY (OTC)': 'US Dollar / Yen (OTC)',
      'AUD/USD (OTC)': 'Australian / US Dollar (OTC)',
      'USD/CAD (OTC)': 'US Dollar / Cdn Dollar (OTC)',
      'EUR/JPY (OTC)': 'Euro / Japanese Yen (OTC)',
      'EUR/GBP (OTC)': 'Euro / British Pound (OTC)',
      'GBP/JPY (OTC)': 'British Pound / Yen (OTC)',
      'BTC/USD (OTC)': 'Bitcoin / US Dollar (OTC)',
      'ETH/USD (OTC)': 'Ethereum / US Dollar (OTC)',
      'SAR/CNY (OTC)': 'Saudi Riyal / Chinese Yuan (OTC)',
      'OMR/CNY (OTC)': 'Omani Rial / Chinese Yuan (OTC)',
      'AUD/CHF (OTC)': 'Australian Dollar / Swiss Franc (OTC)',
      'AED/CNY (OTC)': 'UAE Dirham / Chinese Yuan (OTC)',
      'AED CNY (OTC)': 'UAE Dirham / Chinese Yuan (OTC)',
      'USD BRL (OTC)': 'US Dollar / Brazilian Real (OTC)',
      'Gold': 'Gold (Spot)',
      'Silver': 'Silver (Spot)'
    };

    const getPayout = (item) => {
      if (this.assetPayouts && this.assetPayouts[item.label] !== undefined) {
        return parseInt(this.assetPayouts[item.label]);
      }
      const payoutMap = {
        BTC:92,ETH:88,SOL:85,BNB:82,DOGE:80,XRP:83,ADA:80,AVAX:82,
        MATIC:79,LINK:81,LTC:84,DOT:80,TRX:79,UNI:81,ATOM:80,
        'EUR/USD':92,'GBP/USD':88,'USD/JPY':86,'USD/CAD':84,'AUD/USD':83,
        'USD/CHF':82,'NZD/USD':81,'EUR/GBP':85,'EUR/JPY':84,'GBP/JPY':83,
        'USD/INR':78,'USD/PKR':76,'USD/BDT':75,'GBP/CHF':82,
        'Gold':85,'Silver':83
      };
      const cleanSym = item.symbol.replace(/\s*\(OTC\)/gi, '').trim();
      return payoutMap[cleanSym] || 80;
    };

    const sortedItems = filtered.map(item => ({
      ...item,
      payout: getPayout(item)
    })).sort((a, b) => b.payout - a.payout);

    for (const item of sortedItems) {
      const { symbol, label, type, payout } = item;
      const fullname = FULL_NAMES[symbol] || (type === 'crypto' ? 'Cryptocurrency' : type === 'stocks' ? 'Stock / Commodity' : 'Forex Pair');

      const row = document.createElement('div');
      row.className = 'asset-picker-row';

      // Pass the FULL label so icon function knows it's "BTC/USDT" or "EUR/USD"
      const iconHtml = this.getAssetIcon(label);

      row.innerHTML = `
        <div class="asset-row-left">
          <div class="asset-row-icon-wrap">
            ${iconHtml}
          </div>
          <div class="asset-row-names">
            <span class="asset-row-symbol">${label}</span>
            <span class="asset-row-fullname">${fullname}</span>
          </div>
        </div>
        <div class="asset-row-right">
          <span class="asset-row-payout">${payout}% Payout</span>
          <span class="asset-row-badge">${type === 'crypto' ? 'Crypto' : (type === 'otc' ? 'OTC' : (type === 'stocks' ? 'Stocks' : 'Forex'))}</span>
        </div>
      `;

      row.addEventListener('click', () => {
        this.addRecentAsset(symbol);
        if (!this.tabs.includes(symbol)) this.tabs.push(symbol);
        this.closeAssetPicker();
        this.switchTab(symbol);
      });

      list.appendChild(row);
    }
  },

  getAssetIcon(symbol) {
    // Stocks: Gold and Silver get real PNG icons (also handles Gold/USDT, Silver/USDT variants)
    const hasUSDT = /\/USDT$/i.test(symbol.replace(/\s*\(OTC\)/gi, '').trim());
    const cleanForStocks = symbol.replace(/\s*\(OTC\)/gi, '').replace(/\/USDT$/i, '').trim();
    const USDT_SVG = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/usdt.svg';
    if (cleanForStocks === 'Gold') {
      if (hasUSDT) {
        return `<div style="position:relative;width:42px;height:28px;flex-shrink:0;"><img src="https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/32/color/gold.png" style="width:28px;height:28px;border-radius:50%;object-fit:cover;position:absolute;left:0;top:0;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:1;" alt="Gold"/><img src="${USDT_SVG}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;position:absolute;left:16px;top:2px;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:2;" alt="USDT"/></div>`;
      }
      return `<img src="https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/32/color/gold.png" style="width:36px;height:36px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);" alt="Gold icon"/>`;
    }
    if (cleanForStocks === 'Silver') {
      if (hasUSDT) {
        return `<div style="position:relative;width:42px;height:28px;flex-shrink:0;"><img src="/images/silver.png" style="width:28px;height:28px;border-radius:50%;object-fit:cover;position:absolute;left:0;top:0;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:1;" alt="Silver"/><img src="${USDT_SVG}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;position:absolute;left:16px;top:2px;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:2;" alt="USDT"/></div>`;
      }
      return `<img src="/images/silver.png" style="width:36px;height:36px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);" alt="Silver icon"/>`;
    }
    symbol = symbol.replace(/\s*\(OTC\)/gi, '').trim();
    // CDN bases
    const CRYPTO_CDN = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color';
    const FLAG_CDN   = 'https://hatscripts.github.io/circle-flags/flags';

    // Currency code → ISO 3166-1 alpha-2 country code mapping for flags
    const CURRENCY_TO_COUNTRY = {
      EUR: 'eu', USD: 'us', GBP: 'gb', JPY: 'jp',
      AUD: 'au', CAD: 'ca', CHF: 'ch', NZD: 'nz',
      INR: 'in', PKR: 'pk', BDT: 'bd', SGD: 'sg',
      HKD: 'hk', CNY: 'cn', MXN: 'mx', BRL: 'br',
      ZAR: 'za', TRY: 'tr', SEK: 'se', NOK: 'no',
      DKK: 'dk', PLN: 'pl', CZK: 'cz', HUF: 'hu',
      RUB: 'ru', KRW: 'kr', THB: 'th', MYR: 'my',
      IDR: 'id', PHP: 'ph', AED: 'ae', SAR: 'sa',
      QAR: 'qa', KWD: 'kw', BHD: 'bh', OMR: 'om',
      EGP: 'eg', NGN: 'ng', KES: 'ke', GHS: 'gh',
      UGX: 'ug', TZS: 'tz', ETB: 'et', ZMW: 'zm'
    };

    // Crypto symbols that map to valid cryptocurrency-icons names
    const CRYPTO_NAMES = {
      BTC: 'btc', ETH: 'eth', SOL: 'sol', BNB: 'bnb', DOGE: 'doge',
      XRP: 'xrp', ADA: 'ada', AVAX: 'avax', MATIC: 'matic', LINK: 'link',
      LTC: 'ltc', DOT: 'dot', TRX: 'trx', UNI: 'uni', ATOM: 'atom',
      USDT: 'usdt', USDC: 'usdc', SHIB: 'shib', FTT: 'ftt', SAND: 'sand',
      MANA: 'mana', CRO: 'cro', ALGO: 'algo', FIL: 'fil', XLM: 'xlm',
      VET: 'vet', THETA: 'theta', ICP: 'icp', ETC: 'etc', HBAR: 'hbar'
    };

    if (symbol.includes('/') || symbol.includes(' ')) {
      const parts = symbol.includes('/') ? symbol.split('/') : symbol.split(' ');
      const base  = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();
      
      const isCrypto = CRYPTO_NAMES[base] !== undefined || CRYPTO_NAMES[quote] !== undefined;

      if (isCrypto) {
        // Crypto pair (e.g. BTC/USDT) - overlapping base and quote coin icons
        const baseName  = CRYPTO_NAMES[base]  || base.toLowerCase();
        const quoteName = CRYPTO_NAMES[quote] || quote.toLowerCase();
        return `
          <div style="position:relative;width:42px;height:28px;flex-shrink:0;">
            <img src="${CRYPTO_CDN}/${baseName}.svg"
              style="width:28px;height:28px;border-radius:50%;object-fit:cover;
                     position:absolute;left:0;top:0;
                     box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:1;"
              onerror="this.onerror=null;this.src='${CRYPTO_CDN}/generic.svg'" alt="${base}"/>
            <img src="${CRYPTO_CDN}/${quoteName}.svg"
              style="width:24px;height:24px;border-radius:50%;object-fit:cover;
                     position:absolute;left:16px;top:2px;
                     box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:2;"
              onerror="this.onerror=null;this.src='${CRYPTO_CDN}/generic.svg'" alt="${quote}"/>
          </div>
        `;
      } else {
        // Forex pair (e.g. EUR/USD) - overlapping country flags
        const baseCode  = CURRENCY_TO_COUNTRY[base]  || 'un';
        const quoteCode = CURRENCY_TO_COUNTRY[quote] || 'un';
        return `
          <div style="position:relative;width:42px;height:28px;flex-shrink:0;">
            <img src="${FLAG_CDN}/${baseCode}.svg"
              style="width:28px;height:28px;border-radius:50%;object-fit:cover;
                     position:absolute;left:0;top:0;
                     box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:1;"
              onerror="this.style.display='none'" alt="${base}"/>
            <img src="${FLAG_CDN}/${quoteCode}.svg"
              style="width:24px;height:24px;border-radius:50%;object-fit:cover;
                     position:absolute;left:16px;top:2px;
                     box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);z-index:2;"
              onerror="this.style.display='none'" alt="${quote}"/>
          </div>
        `;
      }
    }

    // CRYPTO: single colored coin icon
    const cleanSym = symbol.split('/')[0].toUpperCase();
    const name = CRYPTO_NAMES[cleanSym] || cleanSym.toLowerCase();
    return `
      <img src="${CRYPTO_CDN}/${name}.svg"
        style="width:36px;height:36px;border-radius:50%;object-fit:cover;
               box-shadow:0 0 0 1.5px rgba(255,255,255,0.2);"
        onerror="this.onerror=null;this.src='${CRYPTO_CDN}/generic.svg'"
        alt="${cleanSym} icon"/>
    `;
  },



  updatePayoutPreview() {
    const amountInput = document.getElementById('trade-amount');
    
    // Find current payout percent for the selected coin
    const coinSymbol = this.selectedCoin ? (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`) : '';
    let payoutPct = 85;
    if (this.assetPayouts) {
      payoutPct = parseInt(this.assetPayouts[coinSymbol] ?? this.assetPayouts[this.selectedCoin] ?? 85);
    }

    let amt = 10;
    if (amountInput) {
      if (this.stakeMode === 'percent') {
        const activeBalance = this.user ? (this.accountType === 'demo' ? (this.user.demo_balance ?? 10000) : this.user.balance) : 1000;
        amt = activeBalance * (this.stakePercent / 100);
      } else {
        amt = parseFloat(amountInput.value) || 10;
      }
    }
    
    // Profit = investment × payout% | Total return shown = investment + profit
    const profit = amt * (payoutPct / 100.0);
    const totalReturn = amt + profit;
    const currency = this.user ? this.user.currency : 'USD';

    const previewEl = document.getElementById('tc-payout-preview');
    if (previewEl) {
      previewEl.textContent = `+${this.formatCurrency(totalReturn, currency)}`;
    }

    const investmentEl = document.getElementById('tc-investment-preview');
    if (investmentEl) {
      investmentEl.textContent = this.formatCurrency(amt, currency);
    }

    // Update top-right chart header and mobile asset selector labels
    const chartAssetName = document.getElementById('chart-asset-name');
    if (chartAssetName && coinSymbol) {
      chartAssetName.textContent = coinSymbol;
    }
    const mobilePayout = document.getElementById('tc-mobile-asset-payout');
    if (mobilePayout) {
      mobilePayout.textContent = `${payoutPct}%`;
    }
    const mobileAssetName = document.getElementById('tc-mobile-asset-name');
    if (mobileAssetName) {
      mobileAssetName.textContent = coinSymbol;
    }
    const mobileIconWrap = document.getElementById('tc-mobile-asset-icon-wrap');
    if (mobileIconWrap) {
      mobileIconWrap.innerHTML = this.getAssetIcon(coinSymbol);
    }
    this.updatePayoutLabels(payoutPct);
  },

  toggleStakeMode() {
    this.stakeMode = this.stakeMode === 'amount' ? 'percent' : 'amount';
    const input = document.getElementById('trade-amount');
    if (input) {
      if (this.stakeMode === 'percent') {
        input.value = `${this.stakePercent} %`;
      } else {
        const bal = this.user ? this.user.balance : 1000;
        const currentAmount = Math.max(1, Math.round(bal * (this.stakePercent / 100)));
        input.value = currentAmount;
      }
    }
    this.updatePayoutPreview();
    this._saveTradePrefs(); // persist stake mode
  },

  handleAmountInput(val) {
    const input = document.getElementById('trade-amount');
    if (input) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      
      if (this.stakeMode === 'percent') {
        // Strip everything except digits
        const cleaned = val.replace(/[^\d]/g, '');
        const pct = parseInt(cleaned, 10);
        if (!isNaN(pct)) {
          this.stakePercent = Math.max(1, Math.min(100, pct));
        }
        input.value = cleaned ? `${cleaned} %` : '';
      } else {
        // Amount mode: allow only digits and at most one decimal point
        let cleaned = val.replace(/[^\d.]/g, '');
        const parts = cleaned.split('.');
        if (parts.length > 2) {
          cleaned = parts[0] + '.' + parts.slice(1).join('');
        }
        
        if (val !== cleaned) {
          input.value = cleaned;
          // Adjust cursor position to account for stripped characters
          const offset = cleaned.length - val.length;
          input.setSelectionRange(start + offset, end + offset);
        }
      }
    }
    this.updatePayoutPreview();
  },

  handleAmountBlur() {
    const input = document.getElementById('trade-amount');
    if (input) {
      if (this.stakeMode === 'percent') {
        input.value = `${this.stakePercent} %`;
      } else {
        // Set minimum stake fallback if empty or invalid
        let val = parseFloat(input.value);
        if (isNaN(val) || val <= 0) {
          const DEFAULT_CURRENCY_RATES = {
            USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
            EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
            IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
            THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
            PHP: 58.0, KRW: 1380.0
          };
          const userCurrency = (this.user && this.user.currency ? this.user.currency : 'USD').toUpperCase().trim();
          const exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
          const minStake = Math.ceil(1.0 * exchangeRate);
          val = minStake;
        }
        input.value = val;
      }
      
      // Save the cleaned amount to session
      if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
        this.tabSessions[this.selectedCoin].amount = parseFloat(input.value) || 10;
      }
      this._saveTradePrefs();
    }
    this.updatePayoutPreview();
  },

  toggleTradesPanel() {
    const container = document.querySelector('.tc-trades-panel-mobile-container');
    if (container) {
      container.classList.toggle('expanded');
    }
  },

  // Populate the time picker based on current mode
  _populateTimePicker() {
    const timePicker = document.getElementById('trade-time-picker');
    if (!timePicker) return;

    timePicker.innerHTML = '';

    if (this.timeMode === 'countdown') {
      this.tradeOptions.forEach((opt, idx) => {
        if (opt.duration < 10) return; // Skip trade options less than 10 seconds
        const o = document.createElement('option');
        const mins = opt.duration >= 60 ? `${Math.floor(opt.duration / 60)} min` : `${opt.duration} sec`;
        o.value = opt.duration;
        o.textContent = mins;
        timePicker.appendChild(o);
      });
      if (!this.selectedDuration || this.selectedDuration < 10) {
        const has30 = this.tradeOptions.some(opt => opt.duration === 30);
        this.selectedDuration = has30 ? 30 : (this.tradeOptions.find(opt => opt.duration >= 10) ? this.tradeOptions.find(opt => opt.duration >= 10).duration : 30);
      }
      if (this.selectedDuration) timePicker.value = this.selectedDuration;
    } else {
      // Clock mode: generate minute marks with 30-second rule
      const now = new Date();
      const currentSec = now.getSeconds() + now.getMilliseconds() / 1000;
      const remainingInCurrentMin = 60 - currentSec;

      const firstExpiry = new Date(now);
      firstExpiry.setSeconds(0, 0);
      if (remainingInCurrentMin >= 30) {
        firstExpiry.setMinutes(firstExpiry.getMinutes() + 1);
      } else {
        firstExpiry.setMinutes(firstExpiry.getMinutes() + 2);
      }

      const slots = [];
      for (let i = 0; i < 60; i++) {
        const t = new Date(firstExpiry.getTime() + i * 60000);
        slots.push(t);
      }

      slots.forEach((slot, idx) => {
        const o = document.createElement('option');
        const hh = slot.getHours().toString().padStart(2, '0');
        const mm = slot.getMinutes().toString().padStart(2, '0');
        const diffSec = Math.round((slot - now) / 1000);
        const diffMins = Math.floor(diffSec / 60);
        const remSecs = diffSec % 60;
        const subText = diffMins > 0 ? (remSecs > 0 ? `${diffMins}m ${remSecs}s` : `${diffMins}m`) : `${remSecs}s`;

        o.value = slot.toISOString();
        o.textContent = `${hh}:${mm} (${subText})`;
        timePicker.appendChild(o);
        if (idx === 0 && (!this.selectedClockTime || new Date(this.selectedClockTime) < firstExpiry)) {
          this.selectedClockTime = slot.toISOString();
          this._updateCommissionForDuration(diffSec);
        }
      });
    }
    this.updateTimerDisplay();
  },

  _updateCommissionForDuration(seconds) {
    if (!this.tradeOptions || this.tradeOptions.length === 0) return;
    let best = this.tradeOptions[0];
    let minDiff = Math.abs(seconds - best.duration);
    for (const opt of this.tradeOptions) {
      const diff = Math.abs(seconds - opt.duration);
      if (diff < minDiff) { minDiff = diff; best = opt; }
    }
  },

  // Helper to format duration in HH:MM:SS
  formatDurationHHMMSS(seconds) {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  },

  // Toggle Expiry Time Popover active class
  toggleTimePopover(event) {
    if (event) event.stopPropagation();
    const popover = document.getElementById('tc-time-popover');
    if (!popover) return;
    const isActive = popover.classList.contains('active');
    if (isActive) {
      popover.classList.remove('active');
    } else {
      popover.classList.add('active');
      if (this.popoverTab === 'time') {
        this.updateClockPopoverGrid();
      } else {
        this.highlightActiveDurationButton();
      }
    }
  },

  // Set the popover active tab ('timer' or 'time')
  setPopoverTab(tab) {
    this.popoverTab = tab;
    const timerTabBtn = document.getElementById('popover-tab-timer');
    const timeTabBtn = document.getElementById('popover-tab-time');
    const timerContent = document.getElementById('popover-content-timer');
    const timeContent = document.getElementById('popover-content-time');
    
    if (tab === 'timer') {
      if (timerTabBtn) timerTabBtn.classList.add('active');
      if (timeTabBtn) timeTabBtn.classList.remove('active');
      if (timerContent) timerContent.classList.add('active');
      if (timeContent) timeContent.classList.remove('active');
      this.timeMode = 'countdown';
      this.highlightActiveDurationButton();
    } else {
      if (timerTabBtn) timerTabBtn.classList.remove('active');
      if (timeTabBtn) timeTabBtn.classList.add('active');
      if (timerContent) timerContent.classList.remove('active');
      if (timeContent) timeContent.classList.add('active');
      this.timeMode = 'clock';
      this.updateClockPopoverGrid();
    }
    this.updatePayoutPreview();
  },

  // Highlight the active duration button in the popover grid
  highlightActiveDurationButton() {
    const popover = document.getElementById('tc-time-popover');
    if (!popover) return;
    const gridBtns = popover.querySelectorAll('#popover-content-timer .tc-grid-btn');
    gridBtns.forEach(btn => {
      btn.classList.remove('active');
      const txt = btn.textContent.trim();
      let presetSec = 0;
      if (txt.endsWith('s')) {
        presetSec = parseInt(txt);
      } else if (txt.endsWith('m')) {
        presetSec = parseInt(txt) * 60;
      } else if (txt.endsWith('h')) {
        presetSec = parseInt(txt) * 3600;
      } else {
        const parts = txt.split(':').map(Number);
        if (parts.length === 2) {
          // MM:SS
          presetSec = parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
          // HH:MM:SS
          presetSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }
      if (this.selectedDuration === presetSec) {
        btn.classList.add('active');
      }
    });
  },

  // Update dynamic clock options for TIME tab
  updateClockPopoverGrid() {
    const grid = document.getElementById('tc-popover-clock-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    const now = new Date();
    // Expiry intervals: 1m, 2m, 3m, 4m, 5m, 6m, 7m, 8m, 9m, 10m, 15m, 30m
    const intervals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 30];
    
    intervals.forEach(mins => {
      const slot = new Date(now.getTime() + mins * 60 * 1000);
      const hh = slot.getHours().toString().padStart(2, '0');
      const mm = slot.getMinutes().toString().padStart(2, '0');
      const timeStr = `${hh}:${mm}`;
      const isoStr = slot.toISOString();
      
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tc-grid-btn';
      
      if (this.selectedClockTime) {
        const selDate = new Date(this.selectedClockTime);
        if (selDate.getHours() === slot.getHours() && selDate.getMinutes() === slot.getMinutes()) {
          btn.classList.add('active');
        }
      }
      
      btn.textContent = timeStr;
      btn.onclick = (e) => {
        e.stopPropagation();
        this.selectPopoverClock(isoStr, timeStr, btn);
      };
      grid.appendChild(btn);
    });
  },

  // Handle preset duration selection
  selectPopoverDuration(seconds, formatStr, btn) {
    this.timeMode = 'countdown';
    let targetSec = parseInt(seconds);
    if (targetSec < 10) {
      this.showToast('Minimum trade duration is 10 seconds.', 'warning');
      targetSec = 10;
      formatStr = '10s';
    }
    this.selectedDuration = targetSec;
    this.selectedClockTime = null;
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].duration = targetSec;
      this.tabSessions[this.selectedCoin].timeMode = 'countdown';
      this.tabSessions[this.selectedCoin].selectedClockTime = null;
    }
    this._saveTradePrefs();
    
    const picker = document.getElementById('trade-time-picker');
    if (picker) {
      let found = false;
      for (let i = 0; i < picker.options.length; i++) {
        if (parseInt(picker.options[i].value) === targetSec) {
          picker.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = targetSec;
        opt.textContent = formatStr;
        picker.appendChild(opt);
        picker.value = targetSec;
      }
    }
    
    this.updateTimerDisplay();
    this.updatePayoutPreview();
    
    const popover = document.getElementById('tc-time-popover');
    if (popover) popover.classList.remove('active');
  },

  // Handle preset clock selection
  selectPopoverClock(isoString, formatStr, btn) {
    this.timeMode = 'clock';
    this.selectedClockTime = isoString;
    this.selectedDuration = null;
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].duration = null;
      this.tabSessions[this.selectedCoin].timeMode = 'clock';
      this.tabSessions[this.selectedCoin].selectedClockTime = isoString;
    }
    this._saveTradePrefs();
    
    const picker = document.getElementById('trade-time-picker');
    if (picker) {
      let found = false;
      for (let i = 0; i < picker.options.length; i++) {
        if (picker.options[i].value === isoString) {
          picker.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        const opt = document.createElement('option');
        opt.value = isoString;
        opt.textContent = formatStr;
        picker.appendChild(opt);
        picker.value = isoString;
      }
    }
    
    this.updateTimerDisplay();
    
    const diffSec = Math.round((new Date(isoString) - Date.now()) / 1000);
    this._updateCommissionForDuration(diffSec);
    this.updatePayoutPreview();
    
    const popover = document.getElementById('tc-time-popover');
    if (popover) popover.classList.remove('active');
  },

  // Toggle custom manual input form in popover
  toggleManualTimeInput(event) {
    if (event) event.stopPropagation();
    const wrap = document.getElementById('tc-popover-manual-input-wrap');
    if (wrap) {
      wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none';
    }
  },

  // Apply duration set manually via input fields
  applyManualDuration(event) {
    if (event) event.stopPropagation();
    const h = parseInt(document.getElementById('manual-hours').value) || 0;
    const m = parseInt(document.getElementById('manual-minutes').value) || 0;
    const s = parseInt(document.getElementById('manual-seconds').value) || 0;
    const totalSec = h * 3600 + m * 60 + s;
    if (totalSec <= 0) return;
    
    this.selectPopoverDuration(totalSec, this.formatDurationHHMMSS(totalSec));
    
    const wrap = document.getElementById('tc-popover-manual-input-wrap');
    if (wrap) wrap.style.display = 'none';
  },

  // Update visual text display in Timer card
  updateTimerDisplay() {
    const displayVal = document.getElementById('tc-time-display-val');
    if (!displayVal) return;
    
    if (this.timeMode === 'countdown') {
      displayVal.textContent = this.formatDurationHHMMSS(this.selectedDuration || 5);
    } else {
      if (this.selectedClockTime) {
        const date = new Date(this.selectedClockTime);
        const hh = date.getHours().toString().padStart(2, '0');
        const mm = date.getMinutes().toString().padStart(2, '0');
        const ss = date.getSeconds().toString().padStart(2, '0');
        displayVal.textContent = `${hh}:${mm}:${ss}`;
      } else {
        displayVal.textContent = '00:00:05';
      }
    }
    const label = document.getElementById('tc-timer-label');
    if (label) {
      label.textContent = this.timeMode === 'countdown' ? 'Timer' : 'Time';
    }
  },

  setTimeMode(mode) {
    this.timeMode = mode;
    
    // Toggle active class on time mode toggle buttons
    const timerToggle = document.getElementById('time-mode-toggle');
    const clockToggle = document.getElementById('time-mode-toggle-clock');
    if (timerToggle && clockToggle) {
      if (mode === 'countdown') {
        timerToggle.classList.add('active');
        clockToggle.classList.remove('active');
      } else {
        timerToggle.classList.remove('active');
        clockToggle.classList.add('active');
      }
    }
    this._populateTimePicker();
    this.updatePayoutPreview();
  },

  // +/- button on time picker
  adjustTime(delta) {
    const picker = document.getElementById('trade-time-picker');
    if (!picker || picker.options.length === 0) return;
    const currentIdx = picker.selectedIndex;
    const newIdx = Math.max(0, Math.min(picker.options.length - 1, currentIdx + delta));
    picker.selectedIndex = newIdx;
    this.handleTimeChange(picker.value);
  },

  toggleTimeMode() {
    if (this.timeMode === 'countdown') {
      this.setPopoverTab('time');
    } else {
      this.setPopoverTab('timer');
    }
  },

  // Called when select value changes
  handleTimeChange(value) {
    if (this.timeMode === 'countdown') {
      this.selectedDuration = parseInt(value);
      this.selectedClockTime = null;
    } else {
      this.selectedClockTime = value;
      this.selectedDuration = null;
      const diffSec = Math.round((new Date(value) - Date.now()) / 1000);
      this._updateCommissionForDuration(diffSec);
    }
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].duration = this.selectedDuration;
      this.tabSessions[this.selectedCoin].timeMode = this.timeMode;
      this.tabSessions[this.selectedCoin].selectedClockTime = this.selectedClockTime;
    }
    this._saveTradePrefs();
    this.updatePayoutPreview();
  },

  // Adjust trade amount by delta
  adjustAmount(delta) {
    const input = document.getElementById('trade-amount');
    if (!input) return;

    // Map delta from 10 to 1 as requested: "after clicking on + - it should add or remvoe 1$ from inestment right now it's adding 10$"
    if (delta === 10) delta = 1;
    if (delta === -10) delta = -1;

    if (this.stakeMode === 'percent') {
      let pct = parseFloat(input.value.replace(/[^\d.]/g, '')) || 10;
      // Adjust percentage in 1% steps
      const step = Math.sign(delta) * 1;
      pct = Math.max(1, Math.min(100, pct + step));
      input.value = `${pct} %`;
      this.stakePercent = pct;
    } else {
      const DEFAULT_CURRENCY_RATES = {
        USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
        EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
        IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
        THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
        PHP: 58.0, KRW: 1380.0
      };
      let userCurrency = (this.user && this.user.currency ? this.user.currency : 'USD').toUpperCase().trim();
      let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
      if (this.lastWalletData && this.lastWalletData.currency === userCurrency && this.lastWalletData.rate) {
        const parsedRate = parseFloat(this.lastWalletData.rate);
        if (!isNaN(parsedRate) && parsedRate > 0) {
          exchangeRate = parsedRate;
        }
      }
      const minStake = Math.ceil(1.0 * exchangeRate);
      const current = parseFloat(input.value) || 0;
      const newVal = Math.max(minStake, current + delta);
      input.value = newVal;
    }
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].amount = parseFloat(input.value) || 10;
    }
    this._saveTradePrefs();
    this.updatePayoutPreview();
  },

  // Add specific amount to trade stake
  addTradeAmount(amount) {
    const input = document.getElementById('trade-amount');
    if (!input) return;
    if (this.stakeMode === 'percent') {
      let pct = parseFloat(input.value.replace(/[^\d.]/g, '')) || 10;
      pct = Math.max(1, Math.min(100, pct + amount));
      input.value = `${pct} %`;
      this.stakePercent = pct;
    } else {
      const current = parseFloat(input.value) || 0;
      input.value = current + amount;
    }
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].amount = parseFloat(input.value) || 10;
    }
    this._saveTradePrefs();
    this.updatePayoutPreview();
  },

  updatePayoutLabels(payout) {
    const upLabel = document.getElementById('payout-up-label');
    const downLabel = document.getElementById('payout-down-label');
    if (upLabel) upLabel.textContent = `${payout}% Payout`;
    if (downLabel) downLabel.textContent = `${payout}% Payout`;
  },

  async updatePriceTicker(coin) {
    // Skip updating ticker text element if chart is active for this asset (chart handles its own ticks)
    if (chart && chart.activeAsset === coin && chart.candles && chart.candles.length > 0) {
      return;
    }
    const price = await this.getBinancePrice(coin);
    const tickerEl = document.getElementById('trade-live-price');
    if (tickerEl) {
      const formatted = price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 4});
      tickerEl.textContent = formatted;
    }
  },

  setTradeAmount(val) {
    const input = document.getElementById('trade-amount');
    if (!input) return;
    this.stakeMode = 'amount'; // Reset to amount mode when using fixed values
    const currentBalance = this.accountType === 'demo' ? (this.user.demo_balance ?? 10000.0) : (this.user.balance || 0);
    if (val === 'max') {
      input.value = Math.floor(currentBalance);
    } else {
      input.value = val;
    }
    if (this.selectedCoin && this.tabSessions[this.selectedCoin]) {
      this.tabSessions[this.selectedCoin].amount = parseFloat(input.value) || 10;
    }
    this._saveTradePrefs();
    this.updatePayoutPreview();
  },

  async placeTrade(direction, botOptions = null) {
    if (typeof direction === 'string') {
      direction = direction.toUpperCase();
    }
    const input = document.getElementById('trade-amount');
    if (!input) return;

    if (this.accountType === 'real' && this.user && this.user.kyc_status !== 'verified') {
      this.showToast('KYC identity verification is required to place trades on your Real account.', 'error');
      return;
    }

    let amount = 0;
    const currentBalance = this.accountType === 'demo' ? (this.user.demo_balance ?? 10000.0) : (this.user.balance || 0);
    if (this.stakeMode === 'percent') {
      const pct = parseFloat(input.value.replace(/[^\d.]/g, '')) || 10;
      amount = parseFloat((currentBalance * (pct / 100)).toFixed(2));
    } else {
      amount = parseFloat(input.value);
    }

    if (isNaN(amount) || amount <= 0) {
      this.showToast('Please enter a valid investment stake.', 'error');
      return;
    }

    // Minimum $1 USD trade stake check based on currency exchange rate
    const DEFAULT_CURRENCY_RATES = {
      USD: 1.0, PKR: 278.0, INR: 84.0, BDT: 117.0, NPR: 133.0, NRP: 133.0,
      EUR: 0.92, GBP: 0.78, AED: 3.67, SAR: 3.75, TRY: 32.5, NGN: 1500.0,
      IDR: 16000.0, BRL: 5.4, EGP: 48.0, MYR: 4.7, KZT: 475.0,
      THB: 36.0, UAH: 41.0, VND: 25400.0, MXN: 18.0, JPY: 160.0,
      PHP: 58.0, KRW: 1380.0
    };
    let userCurrency = (this.user && this.user.currency ? this.user.currency : 'USD').toUpperCase().trim();
    let exchangeRate = DEFAULT_CURRENCY_RATES[userCurrency] || 1.0;
    if (this.lastWalletData && this.lastWalletData.currency === userCurrency && this.lastWalletData.rate) {
      const parsedRate = parseFloat(this.lastWalletData.rate);
      if (!isNaN(parsedRate) && parsedRate > 0) {
        exchangeRate = parsedRate;
      }
    }

    const amountInUsd = amount / exchangeRate;
    if (amountInUsd < 0.999) {
      const minAmountFormatted = Math.ceil(1.0 * exchangeRate).toLocaleString('en-US');
      const minMsg = userCurrency === 'USD'
        ? 'Minimum trade stake is $1.00 USD.'
        : `Minimum trade stake is $1.00 USD (${minAmountFormatted} ${userCurrency}).`;
      this.showToast(minMsg, 'error');
      return;
    }

    if (amountInUsd > 3000.001) {
      const maxAmountFormatted = Math.floor(3000.0 * exchangeRate).toLocaleString('en-US');
      const maxMsg = userCurrency === 'USD'
        ? 'Maximum trade stake is $3,000.00 USD.'
        : `Maximum trade stake is $3,000.00 USD (${maxAmountFormatted} ${userCurrency}).`;
      this.showToast(maxMsg, 'error');
      return;
    }

    if (amount > currentBalance) {
      this.showToast('Insufficient funds for this trade stake.', 'error');
      return;
    }

    if (this.user.status === 'frozen') {
      this.showToast('Your account is frozen. Trading is disabled.', 'error');
      return;
    }

    // Build payload based on timeMode
    const coinSymbol = this.selectedCoin
      ? (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`)
      : '';
    let payoutPct = 85;
    if (this.assetPayouts) {
      payoutPct = parseInt(this.assetPayouts[coinSymbol] ?? this.assetPayouts[this.selectedCoin] ?? 85);
    }

    const payload = {
      coin: this.selectedCoin,
      direction: direction,
      amount: amount,
      is_demo: this.accountType === 'demo' ? 1 : 0,
      account_type: this.accountType,
      payout_pct: payoutPct
    };

    // Bot overrides: apply per-step timer and investment % from sequence
    if (botOptions) {
      const botPct = parseFloat(botOptions.bot_investment_pct) || 10;
      payload.amount = parseFloat((currentBalance * (botPct / 100)).toFixed(2));
      payload.duration = parseInt(botOptions.bot_timer) || 60;
      payload.is_bot = 1;
      if (botOptions.bot_outcome) {
        payload.bot_outcome = botOptions.bot_outcome;
      }
    }

    if (!botOptions) {
      if (this.timeMode === 'countdown') {
        if (!this.selectedDuration) {
          this.showToast('Please select a trade duration.', 'error');
          return;
        }
        if (this.selectedDuration < 10) {
          this.showToast('Minimum trade duration is 10 seconds.', 'error');
          return;
        }
        payload.duration = this.selectedDuration;
      } else {
        // Clock mode (TIME mode)
        if (!this.selectedClockTime) {
          this.showToast('Please select an expiry time.', 'error');
          return;
        }
        let expiresAt = new Date(this.selectedClockTime);
        if (expiresAt <= new Date()) {
          this.showToast('Selected expiry time has already passed. Please choose a future time.', 'error');
          this._populateTimePicker();
          return;
        }
        let durationSec = Math.round((expiresAt - Date.now()) / 1000);
        // 30-second rule: If less than 30s remain when trade is placed, roll over to next minute (+60s)
        if (durationSec < 30) {
          expiresAt = new Date(expiresAt.getTime() + 60000);
          durationSec = Math.round((expiresAt - Date.now()) / 1000);
          this.selectedClockTime = expiresAt.toISOString();
        }
        payload.expires_at = expiresAt.toISOString();
        payload.duration = durationSec;
      }
    }

    // ── Button loading spinner (only for manual user trade placement) ───────
    const btn = botOptions ? null : document.querySelector(`.tc-btn-${direction.toLowerCase()}`);
    let originalHTML = null;
    if (btn) {
      originalHTML = btn.innerHTML;
      btn.disabled = true;
      btn.style.opacity = '0.75';
      btn.innerHTML = `<svg style="width:22px;height:22px;animation:spin 0.7s linear infinite;vertical-align:middle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.3"/><path d="M12 2 a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
    }

    // ── Optimistic UI: insert trade card immediately (only for manual trades) ─────
    const optimisticId = `opt-${Date.now()}`;
    const optimisticNow = Date.now();
    const optimisticDuration = payload.duration || 60;
    const optimisticExpiry = optimisticNow + optimisticDuration * 1000;
    const coinLabel = this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`;
    const actualTradeAmount = (payload && payload.amount) ? payload.amount : amount;
    const formattedAmount = this.formatCurrency(actualTradeAmount, this.user ? this.user.currency : 'USD');

    const activeList = document.getElementById('trade-active-contracts');
    const badge = document.getElementById('floating-trades-badge');
    let optimisticCard = null;
    let optimisticTimerHandle = null;

    if (!botOptions) {
      // Optimistically update balance display immediately for manual trades
      if (this.accountType === 'demo') {
        this.user.demo_balance = (this.user.demo_balance ?? 10000.0) - actualTradeAmount;
      } else {
        this.user.balance = (this.user.balance || 0) - actualTradeAmount;
      }
      this.updateBalanceDisplays();

      if (activeList) {
        // Remove the "no active trades" placeholder if present
        const emptyMsg = activeList.querySelector('[data-empty]');
        if (emptyMsg) emptyMsg.remove();

        optimisticCard = document.createElement('div');
        optimisticCard.className = 'list-item';
        optimisticCard.id = optimisticId;
        const tagHTML = this.accountType === 'demo'
          ? '<span class="badge badge-yellow" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); vertical-align: middle;">Demo</span>'
          : '<span class="badge badge-green" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); vertical-align: middle;">Real</span>';
        optimisticCard.innerHTML = `
          <div class="item-left">
            <span class="item-title">${coinLabel} <strong class="${direction === 'UP' ? 'text-green' : 'text-danger'}">${direction}</strong>${tagHTML}</span>
            <span class="item-subtitle" style="opacity:0.6">Entry: pending… | Stake: ${formattedAmount}</span>
            <div class="timer-container">
              <div id="progress-bar-${optimisticId}" class="timer-bar" style="transform:scaleX(1)"></div>
            </div>
          </div>
          <div class="item-right">
            <span id="countdown-${optimisticId}" class="item-val">${optimisticDuration}s</span>
            <span class="badge badge-active">Live</span>
          </div>
        `;
        activeList.insertBefore(optimisticCard, activeList.firstChild);

        // Update badge count
        if (badge) {
          const current = parseInt(badge.textContent) || 0;
          badge.textContent = current + 1;
          badge.style.display = 'flex';
        }

        // Optimistic countdown timer
        optimisticTimerHandle = setInterval(() => {
          const remaining = optimisticExpiry - Date.now();
          const cd = document.getElementById(`countdown-${optimisticId}`);
          const pBar = document.getElementById(`progress-bar-${optimisticId}`);
          if (remaining <= 0) {
            clearInterval(optimisticTimerHandle);
            if (cd) cd.textContent = 'Settling…';
          } else {
            const secs = Math.ceil(remaining / 1000);
            if (cd) cd.textContent = `${secs}s`;
            if (pBar) {
              const pct = remaining / (optimisticDuration * 1000);
              pBar.style.transform = `scaleX(${Math.max(0, pct)})`;
              if (secs <= 5) pBar.classList.add('danger');
            }
          }
        }, 250);

        this.activeTradeIntervals[`opt_${optimisticId}`] = optimisticTimerHandle;
      }

      // Optimistic chart pill for manual trades
      const optimisticLivePrice = (window.chart && (window.chart.liveTickPrice || window.chart.currentPrice))
        ? parseFloat(window.chart.liveTickPrice || window.chart.currentPrice)
        : 0;
      const optimisticTrade = {
        id: optimisticId,
        coin: this.selectedCoin,
        direction: direction,
        amount: actualTradeAmount,
        open_price: optimisticLivePrice,
        created_at: new Date(optimisticNow).toISOString(),
        expires_at: new Date(optimisticExpiry).toISOString(),
        commission_pct: payoutPct,
        status: 'active',
        is_demo: this.accountType === 'demo' ? 1 : 0
      };
      if (window.chart && window.chart.setActiveTrades) {
        const existingTrades = window.chart.activeTrades || [];
        window.chart.setActiveTrades([optimisticTrade, ...existingTrades]);
      }
    }

    try {
      const res = await fetch('/api/client/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        // Show chart notification after trade is confirmed by server
        this.showChartNotification('open', `Trade opened: ${coinLabel} ${direction} ${formattedAmount}`);

        // Replace optimistic card with real confirmed data via full refresh
        clearInterval(this.activeTradeIntervals[`opt_${optimisticId}`]);
        delete this.activeTradeIntervals[`opt_${optimisticId}`];
        if (optimisticCard) optimisticCard.remove();

        // Immediately swap optimistic trade on chart with real confirmed trade payload to prevent visual disappearance
        if (window.chart && window.chart.setActiveTrades && data.trade) {
          const currentChartTrades = window.chart.activeTrades || [];
          const updatedChartTrades = currentChartTrades.map(t => t.id === optimisticId ? data.trade : t);
          if (!updatedChartTrades.some(t => t.id === data.trade.id)) {
            const clean = currentChartTrades.filter(t => t.id !== optimisticId);
            updatedChartTrades.length = 0;
            updatedChartTrades.push(data.trade, ...clean);
          }
          window.chart.setActiveTrades(updatedChartTrades);
        }

        this.loadUserContracts();

        // If in clock mode, refresh time options (times may have passed)
        if (this.timeMode === 'clock') {
          setTimeout(() => this._populateTimePicker(), 500);
        }
      } else {
        // Rollback: remove optimistic card, restore balance, show error
        clearInterval(this.activeTradeIntervals[`opt_${optimisticId}`]);
        delete this.activeTradeIntervals[`opt_${optimisticId}`];
        if (optimisticCard) optimisticCard.remove();

        if (window.chart && window.chart.setActiveTrades) {
          const clean = (window.chart.activeTrades || []).filter(t => t.id !== optimisticId);
          window.chart.setActiveTrades(clean);
        }

        // Restore balance
        if (this.accountType === 'demo') {
          this.user.demo_balance = (this.user.demo_balance ?? 0) + actualTradeAmount;
        } else {
          this.user.balance = (this.user.balance || 0) + actualTradeAmount;
        }
        this.updateBalanceDisplays();

        // Restore badge count
        if (badge) {
          const current = parseInt(badge.textContent) || 1;
          const next = Math.max(0, current - 1);
          badge.textContent = next;
          badge.style.display = next > 0 ? 'flex' : 'none';
        }

        // Restore empty placeholder if needed
        if (activeList && !activeList.querySelector('.list-item')) {
          activeList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;" data-empty>No active trades.</div>`;
        }

        const errMsg = data.error || 'Failed to place trade.';
        this.showToast(errMsg, 'error');
        if (botOptions) {
          throw new Error(errMsg);
        }
      }
    } catch (err) {
      // Network error — rollback
      clearInterval(this.activeTradeIntervals[`opt_${optimisticId}`]);
      delete this.activeTradeIntervals[`opt_${optimisticId}`];
      if (optimisticCard) optimisticCard.remove();

      if (window.chart && window.chart.setActiveTrades) {
        const clean = (window.chart.activeTrades || []).filter(t => t.id !== optimisticId);
        window.chart.setActiveTrades(clean);
      }

      if (this.accountType === 'demo') {
        this.user.demo_balance = (this.user.demo_balance ?? 0) + actualTradeAmount;
      } else {
        this.user.balance = (this.user.balance || 0) + actualTradeAmount;
      }
      this.updateBalanceDisplays();

      if (badge) {
        const current = parseInt(badge.textContent) || 1;
        const next = Math.max(0, current - 1);
        badge.textContent = next;
        badge.style.display = next > 0 ? 'flex' : 'none';
      }

      if (activeList && !activeList.querySelector('.list-item')) {
        activeList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;" data-empty>No active trades.</div>`;
      }

      const errMsg = err.message || 'Connection error.';
      this.showToast(errMsg, 'error');
      if (botOptions) {
        throw new Error(errMsg);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.style.opacity = '1';
        if (originalHTML !== null) btn.innerHTML = originalHTML;
      }
    }
  },


  async loadUserContracts() {
    try {
      const res = await fetch('/api/client/history');
      const data = await res.json();
      if (!res.ok) return;

      if (data.server_time) {
        this.clientServerTimeOffset = Date.now() - new Date(data.server_time).getTime();
      }

      const activeList = document.getElementById('trade-active-contracts');
      const historyList = document.getElementById('trade-history-contracts');

      // Clear existing interval countdown loops
      Object.values(this.activeTradeIntervals).forEach(clearInterval);
      this.activeTradeIntervals = {};

      // Load Active Trades
      const actives = data.trades.filter(t => t.status === 'active');
      this.lastActiveTrades = actives;
      const badge = document.getElementById('floating-trades-badge');
      if (badge) {
        badge.textContent = actives.length;
        badge.style.display = actives.length > 0 ? 'flex' : 'none';
      }
      if (actives && activeList) {
        if (actives.length > 0) {
          activeList.innerHTML = '';
          actives.forEach(trade => {
            const card = document.createElement('div');
            card.className = 'list-item';
            card.id = `trade-card-${trade.id}`;
            const label = trade.coin.includes('/') ? trade.coin : `${trade.coin}/USDT`;
            const tagHTML = trade.is_bot
              ? '<span class="badge badge-purple" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3); vertical-align: middle;">Bot</span>'
              : trade.is_demo
                ? '<span class="badge badge-yellow" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); vertical-align: middle;">Demo</span>'
                : '<span class="badge badge-green" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); vertical-align: middle;">Real</span>';
            card.innerHTML = `
              <div class="item-left">
                <span class="item-title">${label} <strong class="${trade.direction === 'UP' ? 'text-green' : 'text-danger'}">${trade.direction}</strong>${tagHTML}</span>
                <span class="item-subtitle">Entry: $${parseFloat(trade.open_price || 0).toFixed(2)} | Stake: ${this.formatCurrency(trade.amount, this.user ? this.user.currency : 'USD')}</span>
                <div class="timer-container">
                  <div id="progress-bar-${trade.id}" class="timer-bar"></div>
                </div>
              </div>
              <div class="item-right">
                <span id="countdown-${trade.id}" class="item-val">--s</span>
                <span class="badge badge-active">Live</span>
              </div>
            `;
            activeList.appendChild(card);

            // Setup Countdown Timer
            const expiryDate = new Date(trade.expires_at).getTime();
            const startDate = new Date(trade.created_at).getTime();
            const durationMs = expiryDate - startDate;

            const updateTimer = () => {
              const now = Date.now() - (this.clientServerTimeOffset || 0);
              const timeRemaining = expiryDate - now;

              if (timeRemaining <= 0) {
                clearInterval(this.activeTradeIntervals[`main_${trade.id}`]);
                const cd = document.getElementById(`countdown-${trade.id}`);
                if (cd) cd.textContent = 'Settling...';
                this.triggerTradePoll(trade);
              } else {
                const secondsLeft = Math.ceil(timeRemaining / 1000);
                const cd = document.getElementById(`countdown-${trade.id}`);
                if (cd) cd.textContent = `${secondsLeft}s`;

                // Progress Bar scaling
                const elapsed = now - startDate;
                const pctRemaining = 100 - (elapsed / durationMs * 100);
                const pBar = document.getElementById(`progress-bar-${trade.id}`);
                if (pBar) {
                  pBar.style.transform = `scaleX(${Math.max(0, pctRemaining / 100)})`;
                  if (secondsLeft <= 5) {
                    pBar.classList.add('danger');
                  }
                }
              }
            };

            updateTimer();
            this.activeTradeIntervals[`main_${trade.id}`] = setInterval(updateTimer, 250);
          });
        } else {
          activeList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;">No active trades.</div>`;
        }
      }

      // Load Past Trades
      const history = data.trades.filter(t => t.status !== 'active');

      // Check and trigger notifications for resolved trades
      const isFirstLoad = !this.notifiedTradeIds;
      if (isFirstLoad) {
        this.notifiedTradeIds = new Set();
        this.sessionClosedTrades = [];
      }
      if (history) {
        history.forEach(trade => {
          if (isFirstLoad) {
            this.notifiedTradeIds.add(trade.id);
          } else if (!this.notifiedTradeIds.has(trade.id)) {
            this.notifiedTradeIds.add(trade.id);
            this.showTradeResultToast(trade);
            if (!this.sessionClosedTrades) this.sessionClosedTrades = [];
            this.sessionClosedTrades.push(trade);
            // Auto dismiss after 4 seconds
            setTimeout(() => {
              this.removeClosedTradeFromChart(trade.id);
            }, 4000);
          }
        });
      }

      if (history && historyList) {
        if (history.length > 0) {
          historyList.innerHTML = '';
          history.forEach(trade => {
            const row = document.createElement('div');
            row.className = 'list-item';
            const currency = this.user ? this.user.currency : 'USD';
            // commission_pct column stores payout % directly
            const winProfit = trade.amount * (trade.commission_pct / 100);
            const payout = trade.status === 'win'
              ? `+${this.formatCurrency(winProfit, currency)}`
              : `-${this.formatCurrency(trade.amount, currency)}`;
            const badgeClass = `badge-${trade.status}`;
            const label = trade.coin.includes('/') ? trade.coin : `${trade.coin}/USDT`;

            const tagHTML = trade.is_bot
              ? '<span class="badge badge-purple" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3); vertical-align: middle;">Bot</span>'
              : trade.is_demo
                ? '<span class="badge badge-yellow" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); vertical-align: middle;">Demo</span>'
                : '<span class="badge badge-green" style="font-size: 9px; padding: 2px 4px; margin-left: 6px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); vertical-align: middle;">Real</span>';
            row.innerHTML = `
              <div class="item-left">
                <span class="item-title">${label} (${trade.direction})${tagHTML}</span>
                <span class="item-subtitle">Open: $${parseFloat(trade.open_price || 0).toFixed(2)} → Close: $${trade.close_price ? parseFloat(trade.close_price).toFixed(2) : '---'}</span>
              </div>
              <div class="item-right">
                <span class="item-val ${trade.status === 'win' ? 'text-green' : 'text-danger'}">${payout}</span>
                <span class="badge ${badgeClass}">${trade.status}</span>
              </div>
            `;
            historyList.appendChild(row);
          });
        } else {
          historyList.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 12px; padding: 10px;">No past trade contracts.</div>`;
        }
      }

      // Update active trades in custom chart engine
      if (chart) {
        chart.setActiveTrades(actives);
        const relevantClosed = (this.sessionClosedTrades || []).filter(t => {
          const tCoin = t.coin.includes('/') ? t.coin : `${t.coin}/USDT`;
          const sCoin = this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`;
          return tCoin === sCoin;
        });
        chart.setRecentClosedTrades(relevantClosed);
      }

      // 1. Render Active and History trades inside main tab
      const updateTabCounts = (aCount, hCount) => {
        const tabActive = document.getElementById('tc-tab-active');
        const tabPending = document.getElementById('tc-tab-pending');
        const pCount = (this.pendingTrades || []).length;
        
        if (tabActive) tabActive.innerHTML = `Trades <span class="tab-badge">${aCount}</span>`;
        if (tabPending) {
          tabPending.innerHTML = `
            <svg viewBox="0 0 24 24" style="width:14px; height:14px; fill:currentColor; display:inline-block; vertical-align:middle; margin-right:2px;">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
            </svg>
            Pending <span class="tab-badge">${pCount}</span>
          `;
        }
      };
      updateTabCounts(actives.length, history.length);

      const activeMini = document.getElementById('trade-active-mini');
      if (activeMini) {
        activeMini.innerHTML = '';
        
        // 1. Render Active Trades
        if (actives.length > 0) {
          actives.forEach(trade => {
            const card = document.createElement('div');
            card.className = 'tc-trade-row';
            card.id = `trade-mini-card-${trade.id}`;
            const label = trade.coin.includes('/') ? trade.coin : `${trade.coin}/USDT`;
            const currency = this.user ? this.user.currency : 'USD';
            const stakeVal = this.getTradeDisplayAmount(trade, currency);
            
            const currencySymbol = this.CURRENCY_SYMBOLS[currency.toUpperCase()] || currency;
            const displayStake = Number.isInteger(stakeVal) ? stakeVal.toString() : stakeVal.toFixed(2);
            
            const winProfit = stakeVal * (trade.commission_pct / 100.0);
            const payout = stakeVal + winProfit;
            const formattedPayout = '+' + payout.toFixed(2) + ' ' + currencySymbol;
            
            const iconClass = trade.direction === 'UP' ? 'dir-up' : 'dir-down';
            const iconArrow = trade.direction === 'UP' 
              ? `<svg viewBox="0 0 24 24" style="width: 7px; height: 7px; fill: #ffffff; display: block;"><path d="M12 4l-9 12h18z"/></svg>`
              : `<svg viewBox="0 0 24 24" style="width: 7px; height: 7px; fill: #ffffff; display: block;"><path d="M12 20L3 8h18z"/></svg>`;
            const dirClass = trade.direction === 'UP' ? 'text-green' : 'text-danger';
            
            // Calculate initial countdown
            const adjustedNow = Date.now() - (this.clientServerTimeOffset || 0);
            const timeRemaining = new Date(trade.expires_at).getTime() - adjustedNow;
            const secondsLeft = Math.max(0, Math.ceil(timeRemaining / 1000));
            const m = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
            const s = (secondsLeft % 60).toString().padStart(2, '0');
            const formattedDuration = `00:${m}:${s}`;
            
            // Build details drawer for Active Trade
            card.innerHTML = `
              <div class="tc-trade-row-new" style="cursor: pointer; user-select: none;">
                <div class="tc-trade-row-top">
                  <div class="tc-trade-row-top-left">
                    <svg class="tc-trade-caret" viewBox="0 0 24 24" style="transition: transform 0.2s ease;"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
                    <div class="tc-trade-flags-container">
                      ${this.getAssetIcon(label)}
                    </div>
                    <span class="tc-trade-symbol-text">${label}</span>
                  </div>
                  <div class="tc-trade-row-top-right">
                    <span class="tc-trade-time-text" id="countdown-mini-${trade.id}">${formattedDuration}</span>
                  </div>
                </div>
                <div class="tc-trade-row-bottom">
                  <div class="tc-trade-row-bottom-left">
                    <span class="tc-trade-arrow-circle ${iconClass}">${iconArrow}</span>
                    <span class="tc-trade-stake ${dirClass}">${displayStake} ${currencySymbol}</span>
                  </div>
                  <div class="tc-trade-row-bottom-right">
                    <span class="tc-trade-result-text text-green">${formattedPayout}</span>
                  </div>
                </div>
              </div>
              <div class="tc-trade-details" style="display: none; padding: 12px 14px; background: rgba(0, 0, 0, 0.12); border-top: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between;">
                  <span>ID:</span>
                  <span style="color: var(--text-primary); font-family: monospace; font-size: 9px; word-break: break-all; text-align: right; max-width: 170px;">${trade.id}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Trade Pair:</span>
                  <span style="color: var(--text-primary); font-weight: 700;">${label} - ${trade.commission_pct}%</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Open Price:</span>
                  <span style="color: var(--text-primary); font-weight: 700;">${trade.open_price ? parseFloat(trade.open_price).toFixed(2) : '—'}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Close Price:</span>
                  <span style="color: var(--text-primary); font-weight: 700;" id="details-close-mini-${trade.id}">Active...</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Open Time:</span>
                  <span style="color: var(--text-primary);">${new Date(trade.created_at).toLocaleString()}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Close Time:</span>
                  <span style="color: var(--text-primary);">${trade.expires_at ? new Date(trade.expires_at).toLocaleString() : '—'}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Duration:</span>
                  <span style="color: var(--text-primary);">${formattedDuration}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Difference:</span>
                  <span style="color: var(--text-primary);" id="details-diff-mini-${trade.id}">Active...</span>
                </div>
              </div>
            `;
            
            card.addEventListener('click', (e) => {
              const details = card.querySelector('.tc-trade-details');
              if (details) {
                const caret = card.querySelector('.tc-trade-caret');
                const isHidden = details.style.display === 'none';
                if (isHidden) {
                  details.style.setProperty('display', 'flex', 'important');
                  if (caret) caret.style.transform = 'rotate(180deg)';
                } else {
                  details.style.setProperty('display', 'none', 'important');
                  if (caret) caret.style.transform = 'none';
                }
              }
            });

            activeMini.appendChild(card);

            // Mini Countdown Timer
            const expiryDate = new Date(trade.expires_at).getTime();
            const updateMiniTimer = () => {
              const now = Date.now() - (this.clientServerTimeOffset || 0);
              const timeRemaining = expiryDate - now;
              const miniCd = document.getElementById(`countdown-mini-${trade.id}`);
              if (timeRemaining <= 0) {
                clearInterval(this.activeTradeIntervals[`mini_${trade.id}`]);
                if (miniCd) miniCd.textContent = 'Settling...';
                this.triggerTradePoll(trade);
              } else {
                const secondsLeft = Math.ceil(timeRemaining / 1000);
                const m = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
                const s = (secondsLeft % 60).toString().padStart(2, '0');
                if (miniCd) miniCd.textContent = `00:${m}:${s}`;
              }
            };
            updateMiniTimer();
            this.activeTradeIntervals[`mini_${trade.id}`] = setInterval(updateMiniTimer, 250);
          });
        }

        // 2. Render Closed Trades (History) directly below Active
        if (history.length > 0) {
          let lastDateStr = '';
          history.forEach(trade => {
            const tradeDate = new Date(trade.created_at || Date.now());
            const dateOptions = { day: 'numeric', month: 'long' };
            const dateStr = tradeDate.toLocaleDateString('en-US', dateOptions).toUpperCase();
            
            if (dateStr !== lastDateStr) {
              lastDateStr = dateStr;
              const countForDate = history.filter(t => {
                const d = new Date(t.created_at || Date.now());
                return d.toLocaleDateString('en-US', dateOptions).toUpperCase() === dateStr;
              }).length;
              
              const dateDivider = document.createElement('div');
              dateDivider.className = 'tc-trade-date-divider';
              dateDivider.innerHTML = `
                <span>${dateStr}</span>
                <span class="tc-trade-date-badge">${countForDate}</span>
              `;
              activeMini.appendChild(dateDivider);
            }

            const card = document.createElement('div');
            card.className = 'tc-trade-row';
            
            const isWin = trade.status === 'win';
            const currency = this.user ? this.user.currency : 'USD';
            const stakeVal = this.getTradeDisplayAmount(trade, currency);
            
            const currencySymbol = this.CURRENCY_SYMBOLS[currency.toUpperCase()] || currency;
            const displayStake = Number.isInteger(stakeVal) ? stakeVal.toString() : stakeVal.toFixed(2);
            
            let resultText = '';
            let resultClass = '';
            if (isWin) {
              const winProfit = stakeVal * (trade.commission_pct / 100.0);
              const totalPayout = stakeVal + winProfit;
              resultText = `+${totalPayout.toFixed(2)} ${currencySymbol}`;
              resultClass = 'text-green';
            } else if (trade.status === 'draw') {
              resultText = `${stakeVal.toFixed(2)} ${currencySymbol}`;
              resultClass = 'text-warning';
            } else {
              resultText = `0.00 ${currencySymbol}`;
              resultClass = 'text-danger';
            }
            
            const label = trade.coin.includes('/') ? trade.coin : `${trade.coin}/USDT`;
            const iconClass = trade.direction === 'UP' ? 'dir-up' : 'dir-down';
            const iconArrow = trade.direction === 'UP' 
              ? `<svg viewBox="0 0 24 24" style="width: 7px; height: 7px; fill: #ffffff; display: block;"><path d="M12 4l-9 12h18z"/></svg>`
              : `<svg viewBox="0 0 24 24" style="width: 7px; height: 7px; fill: #ffffff; display: block;"><path d="M12 20L3 8h18z"/></svg>`;
            const dirClass = trade.direction === 'UP' ? 'text-green' : 'text-danger';
            
            // Format static duration format: 00:00:05
            const durSec = trade.duration || 30;
            const durMin = Math.floor(durSec / 60).toString().padStart(2, '0');
            const durS = (durSec % 60).toString().padStart(2, '0');
            const formattedDuration = `00:${durMin}:${durS}`;

            // Calculate difference and sparkline details
            const diff = (trade.close_price && trade.open_price) ? (parseFloat(trade.close_price) - parseFloat(trade.open_price)) : 0;
            // Scale difference by 100 for display points similar to cryptocurrency pip scaling
            const diffDisplay = Math.round(diff * 100);
            const diffText = diffDisplay > 0 ? `+${diffDisplay}` : `${diffDisplay}`;
            const diffClass = diffDisplay > 0 ? 'text-green' : (diffDisplay < 0 ? 'text-danger' : '');

            // Build dynamic SVG Sparkline
            let sparklineSvg = '';
            if (trade.close_price && trade.open_price) {
              const p1 = 30; // entry (middle of SVG)
              const p2 = isWin ? (trade.direction === 'UP' ? 10 : 50) : (trade.direction === 'UP' ? 50 : 10);
              sparklineSvg = `
                <div class="tc-trade-sparkline" style="height: 50px; margin: 4px 0 8px; background: rgba(0,0,0,0.18); border-radius: 6px; position: relative; overflow: hidden; padding: 4px;">
                  <!-- Entry Level Line -->
                  <div style="position: absolute; top: ${p1}px; left: 0; right: 0; border-top: 1px dashed rgba(239, 68, 68, 0.35); z-index: 1;"></div>
                  <!-- Line Chart Path -->
                  <svg viewBox="0 0 100 60" preserveAspectRatio="none" style="width: 100%; height: 100%; display: block; z-index: 2; position: relative;">
                    <path d="M 0 ${p1} L 20 ${p1 + (isWin ? -4 : 4)} L 40 ${p1 + (isWin ? 8 : -8)} L 60 ${p1 + (isWin ? -12 : 12)} L 80 ${p1 + (isWin ? -6 : 6)} L 100 ${p2}" 
                          fill="none" stroke="${isWin ? '#16c784' : '#ef4444'}" stroke-width="1.8" />
                    <circle cx="0" cy="${p1}" r="2.5" fill="#ef4444" />
                    <circle cx="100" cy="${p2}" r="2.5" fill="${isWin ? '#16c784' : '#ef4444'}" />
                  </svg>
                </div>
              `;
            }
            
            card.innerHTML = `
              <div class="tc-trade-row-new" style="cursor: pointer; user-select: none;">
                <div class="tc-trade-row-top">
                  <div class="tc-trade-row-top-left">
                    <svg class="tc-trade-caret" viewBox="0 0 24 24" style="transition: transform 0.2s ease;"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg>
                    <div class="tc-trade-flags-container">
                      ${this.getAssetIcon(label)}
                    </div>
                    <span class="tc-trade-symbol-text">${label}</span>
                  </div>
                  <div class="tc-trade-row-top-right">
                    <span class="tc-trade-time-text">${formattedDuration}</span>
                  </div>
                </div>
                <div class="tc-trade-row-bottom">
                  <div class="tc-trade-row-bottom-left">
                    <span class="tc-trade-arrow-circle ${iconClass}">${iconArrow}</span>
                    <span class="tc-trade-stake ${dirClass}">${displayStake} ${currencySymbol}</span>
                  </div>
                  <div class="tc-trade-row-bottom-right">
                    <span class="tc-trade-result-text ${resultClass}">${resultText}</span>
                  </div>
                </div>
              </div>
              <div class="tc-trade-details" style="display: none; padding: 12px 14px; background: rgba(0, 0, 0, 0.12); border-top: 1px solid var(--border); font-size: 11px; color: var(--text-secondary); flex-direction: column; gap: 6px;">
                ${sparklineSvg}
                <div style="display: flex; justify-content: space-between;">
                  <span>ID:</span>
                  <span style="color: var(--text-primary); font-family: monospace; font-size: 9px; word-break: break-all; text-align: right; max-width: 170px;">${trade.id}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Trade Pair:</span>
                  <span style="color: var(--text-primary); font-weight: 700;">${label} - ${trade.commission_pct}%</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Open Price:</span>
                  <span style="color: var(--text-primary); font-weight: 700;">${trade.open_price ? parseFloat(trade.open_price).toFixed(2) : '—'}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Close Price:</span>
                  <span style="color: var(--text-primary); font-weight: 700;">${trade.close_price ? parseFloat(trade.close_price).toFixed(2) : '—'}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Open Time:</span>
                  <span style="color: var(--text-primary);">${new Date(trade.created_at).toLocaleString()}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Close Time:</span>
                  <span style="color: var(--text-primary);">${trade.expires_at ? new Date(trade.expires_at).toLocaleString() : '—'}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Duration:</span>
                  <span style="color: var(--text-primary);">${formattedDuration}</span>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span>Difference:</span>
                  <span class="${diffClass}" style="font-weight: 700;">${diffText}</span>
                </div>
              </div>
            `;
            
            card.addEventListener('click', (e) => {
              const details = card.querySelector('.tc-trade-details');
              if (details) {
                const caret = card.querySelector('.tc-trade-caret');
                const isHidden = details.style.display === 'none';
                if (isHidden) {
                  details.style.setProperty('display', 'flex', 'important');
                  if (caret) caret.style.transform = 'rotate(180deg)';
                } else {
                  details.style.setProperty('display', 'none', 'important');
                  if (caret) caret.style.transform = 'none';
                }
              }
            });

            activeMini.appendChild(card);
          });
        }

        if (actives.length === 0 && history.length === 0) {
          activeMini.innerHTML = '<div class="no-trades-mini">No trades</div>';
        }
      }

      // 3. Compute Win/Loss Statistics (for Left Stats Panel)
      const winsCount = history.filter(t => t.status === 'win').length;
      const lossesCount = history.filter(t => t.status === 'lose').length;
      const totalResolved = history.length;
      
      const winRate = totalResolved > 0 ? Math.round((winsCount / totalResolved) * 100) : 0;
      
      let totalPnl = 0;
      history.forEach(t => {
        if (t.status === 'win') {
          totalPnl += t.amount * (t.commission_pct / 100.0);
        } else if (t.status === 'lose') {
          totalPnl -= t.amount;
        }
      });

      // Update displays
      const statWins = document.getElementById('stat-wins');
      if (statWins) statWins.textContent = winsCount;
      
      const statLosses = document.getElementById('stat-losses');
      if (statLosses) statLosses.textContent = lossesCount;
      
      const statWinrate = document.getElementById('stat-winrate');
      if (statWinrate) statWinrate.textContent = `${winRate}%`;

      const statPnl = document.getElementById('stat-pnl');
      if (statPnl) {
        const sign = totalPnl >= 0 ? '+' : '';
        statPnl.textContent = sign + this.formatCurrency(totalPnl, this.user ? this.user.currency : 'USD');
        statPnl.className = 'stats-val ' + (totalPnl >= 0 ? 'text-green' : 'text-danger');
      }

    } catch (err) {
      console.error('Failed to load user contract logs:', err);
    }
  },

  removeClosedTradeFromChart(tradeId) {
    this.sessionClosedTrades = (this.sessionClosedTrades || []).filter(t => t.id !== tradeId);
    this.loadUserContracts();
  },

  // --- WALLET TAB ACTIONS ---

  toggleWalletSection(type) {
    this.activeWalletSection = type;
    document.getElementById('wallet-tab-deposit-btn').classList.remove('active');
    document.getElementById('wallet-tab-withdraw-btn').classList.remove('active');
    document.getElementById('wallet-deposit-section').classList.remove('active');
    document.getElementById('wallet-withdraw-section').classList.remove('active');

    if (type === 'deposit') {
      document.getElementById('wallet-tab-deposit-btn').classList.add('active');
      document.getElementById('wallet-deposit-section').classList.add('active');
    } else {
      document.getElementById('wallet-tab-withdraw-btn').classList.add('active');
      document.getElementById('wallet-withdraw-section').classList.add('active');
    }
  },

  async loadWalletData(action) {
    if (action) this.toggleWalletSection(action);

    try {
      // Fetch dynamic e-wallets
      try {
        const ewRes = await fetch('/api/client/e-wallets');
        if (ewRes.ok) {
          const ewData = await ewRes.json();
          this.clientEWallets = ewData.methods || [];
        }
      } catch (err) {
        console.error('Failed to load dynamic e-wallets:', err);
      }

      const res = await fetch('/api/client/wallet');
      const data = await res.json();
      if (!res.ok) return;

      // Set Balances
      const rate = data.rate || 1.0;
      const cryptoEquivalent = data.balance / rate;

      this.user.balance = data.balance;
      this.user.status = data.status;
      this.updateBalanceDisplays();

      document.getElementById('wallet-balance-usdt').textContent = `$${cryptoEquivalent.toFixed(2)} USDT`;
      document.getElementById('wallet-balance-usdc').textContent = `$${cryptoEquivalent.toFixed(2)} USDC`;

      // Update all wallet currency labels
      document.querySelectorAll('.wallet-currency-label').forEach(el => {
        el.textContent = data.currency || 'USD';
      });

      // Cache wallet data for dynamic UI population
      this.lastWalletData = data;
      const isPakistan = (data && data.is_pakistan) || (this.user && this.user.currency && this.user.currency.toUpperCase() === 'PKR') || (this.user && this.user.kyc_country && this.user.kyc_country.toLowerCase().includes('pakistan'));
      const hasEWallets = (Array.isArray(this.clientEWallets) && this.clientEWallets.length > 0) || isPakistan;
      if (!hasEWallets) {
        this.activeDepositCategory = 'crypto';
        this.activeWithdrawCategory = 'crypto';
      } else {
        this.activeDepositCategory = this.activeDepositCategory || 'crypto';
        this.activeWithdrawCategory = this.activeWithdrawCategory || 'crypto';
      }
      this.activeDepositMode = this.activeDepositMode || 'manual';
      
      // Update UI active state and methods based on activeDepositMode
      this.setDepositMode(this.activeDepositMode);

      // Cache and set active withdraw category
      this.setWithdrawCategory(this.activeWithdrawCategory || 'crypto');

    } catch (err) {
      console.error('Wallet fetch failed:', err);
    }
  },

  toggleDepositGroup(id, visible, displayType = 'flex') {
    const el = document.getElementById(id);
    if (!el) return;
    if (visible) {
      el.style.setProperty('display', displayType, 'important');
    } else {
      el.style.setProperty('display', 'none', 'important');
    }
  },

  updateDepositHint(mode, method) {
    const hint = document.getElementById('deposit-auto-hint');
    if (!hint) return;
    const hintText = hint.querySelector('span');
    
    if (mode === 'auto') {
      if (hintText) hintText.textContent = "A deposit address will be generated after you enter the amount above.";
      hint.style.display = 'flex';
      return;
    }

    // Manual mode
    const isEWallet = (this.activeDepositCategory === 'ewallet') || 
                      (method && this.clientEWallets && this.clientEWallets.some(ew => ew.name.toUpperCase() === method.toUpperCase()));

    if (isEWallet) {
      if (hintText) hintText.textContent = "You can transfer funds from any Bank or E-Wallet.";
      hint.style.display = 'flex';
    } else {
      hint.style.display = 'none';
    }
  },

  setDepositMode(mode) {
    this.activeDepositMode = mode;
    this.activeDepositCategory = this.activeDepositCategory || 'crypto';
    
    const autoBtn = document.getElementById('deposit-mode-auto-btn');
    const manualBtn = document.getElementById('deposit-mode-manual-btn');
    const autoRadio = autoBtn ? autoBtn.querySelector('.wallet-mode-radio') : null;
    const manualRadio = manualBtn ? manualBtn.querySelector('.wallet-mode-radio') : null;
    const hint = document.getElementById('deposit-auto-hint');
    
    const proofTextInput = document.getElementById('deposit-proof-text');
    const ewalletInstDiv = document.getElementById('deposit-ewallet-instructions');
    
    const formCard = document.getElementById('deposit-form-card');
    if (formCard) {
      if (mode === 'auto') {
        formCard.classList.add('deposit-mode-auto');
        formCard.classList.remove('deposit-mode-manual');
      } else {
        formCard.classList.add('deposit-mode-manual');
        formCard.classList.remove('deposit-mode-auto');
      }
    }
    
    if (mode === 'auto') {
      if (autoBtn) {
        autoBtn.classList.add('wallet-mode-btn--active');
        autoBtn.style.removeProperty('background');
        autoBtn.style.removeProperty('borderColor');
      }
      if (autoRadio) autoRadio.classList.add('wallet-mode-radio--active');
      if (manualBtn) {
        manualBtn.classList.remove('wallet-mode-btn--active');
        manualBtn.style.removeProperty('background');
        manualBtn.style.removeProperty('borderColor');
      }
      if (manualRadio) manualRadio.classList.remove('wallet-mode-radio--active');
      if (hint) hint.style.display = 'flex';
      
      this.toggleDepositGroup('deposit-manual-category-group', false);
      
      // Hide proof fields and make them optional for auto mode
      this.toggleDepositGroup('deposit-proof-text-group', false);
      this.toggleDepositGroup('deposit-proof-file-group', false);
      if (proofTextInput) proofTextInput.removeAttribute('required');
      this.toggleDepositGroup('deposit-user-account-group', false);
      this.toggleDepositGroup('deposit-user-bank-group', false);
      if (ewalletInstDiv) ewalletInstDiv.style.display = 'none';
      
      // Always show USD amount field in auto mode
      this.toggleDepositGroup('deposit-amount-usd-group', true);
      this.toggleDepositGroup('deposit-amount-pkr-group', false);
      const usdInpAuto = document.getElementById('deposit-amount');
      if (usdInpAuto) usdInpAuto.setAttribute('required', 'required');
    } else {
      if (manualBtn) {
        manualBtn.classList.add('wallet-mode-btn--active');
        manualBtn.style.removeProperty('background');
        manualBtn.style.removeProperty('borderColor');
      }
      if (manualRadio) manualRadio.classList.add('wallet-mode-radio--active');
      if (autoBtn) {
        autoBtn.classList.remove('wallet-mode-btn--active');
        autoBtn.style.removeProperty('background');
        autoBtn.style.removeProperty('borderColor');
      }
      if (autoRadio) autoRadio.classList.remove('wallet-mode-radio--active');
      const hasEWallets = Array.isArray(this.clientEWallets) && this.clientEWallets.length > 0;
      const ewBtn = document.getElementById('deposit-cat-ewallet-btn');
      if (!hasEWallets) {
        this.activeDepositCategory = 'crypto';
        this.toggleDepositGroup('deposit-manual-category-group', false);
        if (ewBtn) ewBtn.style.display = 'none';
      } else {
        this.toggleDepositGroup('deposit-manual-category-group', true);
        if (ewBtn) ewBtn.style.display = 'flex';
      }
      
      // Category specific displays
      this.setDepositCategory(this.activeDepositCategory);
      this.updateDepositHint(mode, document.getElementById('deposit-method-select')?.value);
      return; // setDepositCategory will trigger repopulateDepositMethods
    }
    
    // Repopulate method selector
    this.repopulateDepositMethods();
    this.updateDepositHint(mode, document.getElementById('deposit-method-select')?.value);
  },

  setDepositCategory(cat) {
    const hasEWallets = Array.isArray(this.clientEWallets) && this.clientEWallets.length > 0;
    if (!hasEWallets) {
      cat = 'crypto';
    }
    this.activeDepositCategory = cat;
    const cryptoBtn = document.getElementById('deposit-cat-crypto-btn');
    const ewalletBtn = document.getElementById('deposit-cat-ewallet-btn');
    const cryptoRadio = cryptoBtn ? cryptoBtn.querySelector('.wallet-mode-radio') : null;
    const ewalletRadio = ewalletBtn ? ewalletBtn.querySelector('.wallet-mode-radio') : null;

    if (cat === 'crypto') {
      if (cryptoBtn) cryptoBtn.classList.add('wallet-mode-btn--active');
      if (cryptoRadio) cryptoRadio.classList.add('wallet-mode-radio--active');
      if (ewalletBtn) ewalletBtn.classList.remove('wallet-mode-btn--active');
      if (ewalletRadio) ewalletRadio.classList.remove('wallet-mode-radio--active');
      
      // Restore USD amount field
      this.toggleDepositGroup('deposit-amount-usd-group', true);
      this.toggleDepositGroup('deposit-amount-pkr-group', false);
      const usdInpCat = document.getElementById('deposit-amount');
      if (usdInpCat) usdInpCat.setAttribute('required', 'required');
    } else {
      if (ewalletBtn) ewalletBtn.classList.add('wallet-mode-btn--active');
      if (ewalletRadio) ewalletRadio.classList.add('wallet-mode-radio--active');
      if (cryptoBtn) cryptoBtn.classList.remove('wallet-mode-btn--active');
      if (cryptoRadio) cryptoRadio.classList.remove('wallet-mode-radio--active');
      
      // Switch to PKR amount field
      this.toggleDepositGroup('deposit-amount-usd-group', false);
      this.toggleDepositGroup('deposit-amount-pkr-group', true);
      const usdInpEw = document.getElementById('deposit-amount');
      if (usdInpEw) usdInpEw.removeAttribute('required');
    }

    // Repopulate method selector
    this.repopulateDepositMethods();
    this.updateDepositHint(this.activeDepositMode, document.getElementById('deposit-method-select')?.value);
  },

  repopulateDepositMethods() {
    const optionsContainer = document.getElementById('deposit-methods-grid') || document.getElementById('deposit-custom-select-options');
    const methodInput = document.getElementById('deposit-method-select');
    if (!optionsContainer || !methodInput) return;
    
    optionsContainer.innerHTML = '';
    
    const data = this.lastWalletData;
    if (!data) return;
    
    const options = [];
    
    if (this.activeDepositMode === 'auto') {
      if (data.deposit && data.deposit.binance_auto && data.deposit.binance_auto.enabled) {
        options.push({ label: 'Binance Auto Payment', value: 'BINANCE_AUTO', sub: 'Instant • Min. $10.00' });
      }
      options.push({ label: 'Bitcoin (BTC)', value: 'NOWPAYMENTS_BTC', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Ethereum (ETH)', value: 'NOWPAYMENTS_ETH', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Litecoin (LTC)', value: 'NOWPAYMENTS_LTC', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Tron (TRX)', value: 'NOWPAYMENTS_TRX', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Solana (SOL)', value: 'NOWPAYMENTS_SOL', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Binance Coin (BNB)', value: 'NOWPAYMENTS_BNB', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Dogecoin (DOGE)', value: 'NOWPAYMENTS_DOGE', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'USD Coin (USDC)', value: 'NOWPAYMENTS_USDC', sub: 'Instant • Min. $10.00' });
      options.push({ label: 'Tether (USDT)', value: 'NOWPAYMENTS_USDTTRC20', sub: 'Instant • Min. $10.00' });
    } else {
      if (this.activeDepositCategory === 'crypto') {
        if (data.deposit && data.deposit.binance_manual && data.deposit.binance_manual.enabled) {
          options.push({ label: 'Binance', value: 'BINANCE_MANUAL', sub: 'Min. $10.00' });
        }
        if (data.deposit && data.deposit.usdt && data.deposit.usdt.enabled) {
          options.push({ label: 'USDT (TRC-20)', value: 'USDT_TRC20', sub: 'Min. $10.00' });
          options.push({ label: 'USDT (ERC-20)', value: 'USDT_ERC20', sub: 'Min. $10.00' });
          options.push({ label: 'USDT (BEP-20)', value: 'USDT_BEP20', sub: 'Min. $10.00' });
          options.push({ label: 'USDT (Litecoin Network)', value: 'USDT_LTC', sub: 'Min. $10.00' });
          options.push({ label: 'USDT (Aptos Network)', value: 'USDT_APTOS', sub: 'Min. $10.00' });
        }

        // Load custom manual deposit methods
        let customDeps = [];
        try {
          customDeps = typeof data.custom_deposit_methods === 'string'
            ? JSON.parse(data.custom_deposit_methods || '[]')
            : (data.custom_deposit_methods || []);
        } catch (e) {
          console.error('Failed parsing custom deposit methods:', e);
        }
        customDeps.forEach((dep, idx) => {
          options.push({ label: dep.name, value: `CUSTOM_DEP_${idx}`, sub: 'Min. $10.00' });
        });
      } else {
        // E-Wallets
        if (this.clientEWallets) {
          this.clientEWallets.forEach(ew => {
            const minDepVal = ew.min_deposit !== undefined && ew.min_deposit !== null ? ew.min_deposit : 10;
            const rate = ew.pkr_rate || 283;
            const minPkr = Math.round(minDepVal * rate);
            options.push({ label: ew.name, value: ew.name, logo: ew.logo_url, sub: `Instant • Min ${minPkr.toLocaleString('en-US')} PKR` });
          });
        }
      }
    }
    
    let defaultSelected = null;
    options.forEach(opt => {
      const subText = opt.sub || (this.user && this.user.currency === 'PKR' ? 'Min. 2,800 PKR' : 'Min. $10.00');
      const cardBtn = document.createElement('div');
      cardBtn.className = 'payment-method-btn';
      cardBtn.setAttribute('data-value', opt.value);
      cardBtn.innerHTML = `
        <div class="payment-method-btn-left">
          <div class="payment-method-icon-wrap">
            ${this.getMethodIconSvg(opt.value, opt.label, opt.logo)}
          </div>
          <div class="payment-method-info">
            <div class="payment-method-title">${opt.label}</div>
            <div class="payment-method-sub">${subText}</div>
          </div>
        </div>
        <svg class="payment-method-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      `;
      cardBtn.onclick = (e) => {
        e.stopPropagation();
        this.selectCustomOption(opt.value, opt.label);
      };
      optionsContainer.appendChild(cardBtn);
      if (!defaultSelected) {
        defaultSelected = opt;
      }
    });
    
    if (defaultSelected) {
      this.selectCustomOption(defaultSelected.value, defaultSelected.label);
    } else {
      methodInput.value = '';
      const textBox = document.getElementById('deposit-instructions-text');
      if (textBox) textBox.textContent = 'All deposit channels are offline.';
    }
  },

  getMethodIconSvg(value, label, logoUrl) {
    const valUpper = String(value || label || '').toUpperCase();
    const lblUpper = String(label || value || '').toUpperCase();

    let imgFile = '';

    if (valUpper.includes('BNB') || lblUpper.includes('BNB') || lblUpper.includes('BINANCE')) {
      imgFile = '/images/methods/bnb_user.png';
    } else if (valUpper.includes('DOGE') || lblUpper.includes('DOGE') || lblUpper.includes('DOGECOIN')) {
      imgFile = '/images/methods/doge_user.png';
    } else if (valUpper.includes('USDT') || lblUpper.includes('USDT') || lblUpper.includes('TETHER') || valUpper.includes('BEP') || lblUpper.includes('BEP') || valUpper.includes('TRC') || lblUpper.includes('TRC') || valUpper.includes('ERC') || lblUpper.includes('ERC')) {
      imgFile = '/images/methods/usdt_user.png';
    } else if (valUpper.includes('USDC') || lblUpper.includes('USDC')) {
      imgFile = '/images/methods/usdc_user.png';
    } else if (valUpper.includes('BTC') || lblUpper.includes('BITCOIN')) {
      imgFile = '/images/methods/btc_user.png';
    } else if (valUpper.includes('ETH') || lblUpper.includes('ETHEREUM')) {
      imgFile = '/images/methods/eth_user.png';
    } else if (valUpper.includes('TRX') || lblUpper.includes('TRON')) {
      imgFile = '/images/methods/trx_user.png';
    } else if (valUpper.includes('SOL') || lblUpper.includes('SOLANA')) {
      imgFile = '/images/methods/sol_user.png';
    } else if (valUpper.includes('LTC') || lblUpper.includes('LITECOIN')) {
      imgFile = '/images/methods/ltc_user.png';
    } else if (valUpper.includes('JAZZCASH') || lblUpper.includes('JAZZCASH')) {
      imgFile = '/images/methods/jazzcash_3d.png';
    } else if (valUpper.includes('EASYPAISA') || lblUpper.includes('EASYPAISA')) {
      imgFile = '/images/methods/easypaisa_3d.png';
    } else if (valUpper.includes('NAYAPAY') || lblUpper.includes('NAYAPAY')) {
      imgFile = '/images/methods/nayapay_3d.png';
    } else if (valUpper.includes('ZINDAGI') || lblUpper.includes('ZINDAGI')) {
      imgFile = '/images/methods/zindagi_3d.png';
    } else if (valUpper.includes('SADAPAY') || lblUpper.includes('SADAPAY')) {
      imgFile = '/images/methods/sadapay_3d.png';
    } else if (valUpper.includes('BANK') || lblUpper.includes('BANK')) {
      imgFile = '/images/methods/bank.svg';
    }

    if (imgFile) {
      return `<img src="${imgFile}" alt="${label || value}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; display: block; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.15));">`;
    }

    if (logoUrl) {
      return `<img src="${logoUrl}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; display: block;">`;
    }

    return `<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="16" fill="url(#defaultG)"/><defs><linearGradient id="defaultG" x1="0" y1="0" x2="32" y2="32"><stop stop-color="#10B981"/><stop offset="1" stop-color="#059669"/></linearGradient></defs><path d="M16 9v14M9 16h14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>`;
  },

  selectCustomOption(value, label) {
    const methodInput = document.getElementById('deposit-method-select');
    const optionsContainer = document.getElementById('deposit-methods-grid') || document.getElementById('deposit-custom-select-options');
    
    if (methodInput) {
      methodInput.value = value;
      methodInput.dispatchEvent(new Event('change'));
    }
    
    if (optionsContainer) {
      const options = optionsContainer.querySelectorAll('.payment-method-btn, .custom-select-option');
      options.forEach(opt => {
        if (opt.getAttribute('data-value') === value) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      });
    }
    
    this.handleDepositMethodChange(value);
  },

  toggleCustomSelect(e) {
    if (e) e.stopPropagation();
  },

  toggleWithdrawCustomSelect(e) {
    if (e) e.stopPropagation();
  },

  syncWithdrawCustomSelect() {
    const realSelect = document.getElementById('withdraw-method-select');
    const customOptionsContainer = document.getElementById('withdraw-methods-grid') || document.getElementById('withdraw-custom-select-options');
    if (!realSelect || !customOptionsContainer) return;

    customOptionsContainer.innerHTML = '';
    const options = Array.from(realSelect.options);

    let defaultSelected = null;
    options.forEach((opt, idx) => {
      const isPak = ['JAZZCASH', 'EASYPAISA', 'NAYAPAY', 'ZINDAGI', 'SADAPAY'].includes(opt.value);
      let subText = '1-3 Days • Min. $10.00';
      const ew = this.clientEWallets ? this.clientEWallets.find(ew => ew.name.toUpperCase() === opt.value.toUpperCase()) : null;
      if (ew) {
        const minWdVal = ew.min_withdrawal !== undefined && ew.min_withdrawal !== null ? ew.min_withdrawal : 10;
        const rate = ew.pkr_rate || 283;
        const minPkr = Math.round(minWdVal * rate);
        subText = `Instant • Min ${minPkr.toLocaleString('en-US')} PKR`;
      } else if (isPak) {
        subText = 'Instant • Min 2,800 PKR';
      }
      const cardBtn = document.createElement('div');
      cardBtn.className = 'payment-method-btn';
      cardBtn.setAttribute('data-value', opt.value);
      cardBtn.innerHTML = `
        <div class="payment-method-btn-left">
          <div class="payment-method-icon-wrap">
            ${this.getMethodIconSvg(opt.value, opt.text, null)}
          </div>
          <div class="payment-method-info">
            <div class="payment-method-title">${opt.text}</div>
            <div class="payment-method-sub">${subText}</div>
          </div>
        </div>
        <svg class="payment-method-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
      `;
      cardBtn.onclick = (e) => {
        e.stopPropagation();
        this.selectWithdrawCustomOption(opt.value, opt.text);
      };
      customOptionsContainer.appendChild(cardBtn);
      if (idx === 0) {
        defaultSelected = opt;
      }
    });

    if (defaultSelected) {
      this.selectWithdrawCustomOption(defaultSelected.value, defaultSelected.text);
    }
  },

  setWithdrawCategory(category) {
    const isPakistan = (this.lastWalletData && this.lastWalletData.is_pakistan) || (this.user && this.user.currency && this.user.currency.toUpperCase() === 'PKR') || (this.user && this.user.kyc_country && this.user.kyc_country.toLowerCase().includes('pakistan'));
    const hasEWallets = (Array.isArray(this.clientEWallets) && this.clientEWallets.length > 0) || isPakistan;
    const ewBtn = document.getElementById('withdraw-cat-ewallet-btn');
    const catGroup = document.getElementById('withdraw-manual-category-group') || document.querySelector('.withdraw-category-selector');

    if (!hasEWallets) {
      category = 'crypto';
      if (ewBtn) ewBtn.style.display = 'none';
      if (catGroup) catGroup.style.display = 'none';
    } else {
      if (ewBtn) ewBtn.style.display = 'flex';
      if (catGroup) catGroup.style.display = 'flex';
    }

    this.activeWithdrawCategory = category;

    // Toggle button active classes
    const cryptoBtn = document.getElementById('withdraw-cat-crypto-btn');
    const ewalletBtn = document.getElementById('withdraw-cat-ewallet-btn');
    const cryptoRadio = document.getElementById('withdraw-radio-crypto');
    const ewalletRadio = document.getElementById('withdraw-radio-ewallet');

    if (category === 'crypto') {
      if (cryptoBtn) cryptoBtn.classList.add('wallet-mode-btn--active');
      if (ewalletBtn) ewalletBtn.classList.remove('wallet-mode-btn--active');
      if (cryptoRadio) cryptoRadio.classList.add('wallet-mode-radio--active');
      if (ewalletRadio) ewalletRadio.classList.remove('wallet-mode-radio--active');
    } else {
      if (cryptoBtn) cryptoBtn.classList.remove('wallet-mode-btn--active');
      if (ewalletBtn) ewalletBtn.classList.add('wallet-mode-btn--active');
      if (cryptoRadio) cryptoRadio.classList.remove('wallet-mode-radio--active');
      if (ewalletRadio) ewalletRadio.classList.add('wallet-mode-radio--active');
    }

    this.populateWithdrawMethods();
  },

  populateWithdrawMethods() {
    const wSelect = document.getElementById('withdraw-method-select');
    if (!wSelect) return;

    wSelect.innerHTML = '';
    const data = this.lastWalletData;
    if (!data) return;

    const isPakistan = data.is_pakistan || (this.user && this.user.currency && this.user.currency.toUpperCase() === 'PKR') || (this.user && this.user.kyc_country && this.user.kyc_country.toLowerCase().includes('pakistan'));
    const category = this.activeWithdrawCategory || 'crypto';

    // Parse custom methods
    let customWiths = [];
    try {
      customWiths = typeof data.custom_withdrawal_methods === 'string'
        ? JSON.parse(data.custom_withdrawal_methods || '[]')
        : (data.custom_withdrawal_methods || []);
    } catch (e) {
      console.error('Failed parsing custom withdrawal methods:', e);
    }

    // Helper to determine if a method name is crypto
    const isCryptoMethod = (name) => {
      if (!name) return false;
      const lower = name.toLowerCase();
      if (lower.includes('jazzcash') || lower.includes('easypaisa') || lower.includes('nayapay') || lower.includes('zindagi') || lower.includes('sadapay')) {
        return false;
      }
      const cryptoKeywords = [
        'usdt', 'usdc', 'trc-20', 'trc20', 'erc-20', 'erc20', 'bep-20', 'bep20', 'bep-2', 'bep2',
        'solana', 'sol', 'trx', 'tron', 'bitcoin', 'btc', 'ethereum', 'eth', 'binance', 'bnb', 
        'litecoin', 'ltc', 'crypto', 'polygon', 'matic', 'aptos', 'apt', 'cardano', 'ada',
        'ripple', 'xrp', 'doge', 'dogecoin', 'tether'
      ];
      return cryptoKeywords.some(keyword => lower.includes(keyword));
    };

    if (category === 'crypto') {
      // 1. Show default USDT & USDC if enabled
      if (data.withdrawal && data.withdrawal.usdt && data.withdrawal.usdt.enabled) wSelect.appendChild(new Option('USDT (TRC-20)', 'USDT'));
      if (data.withdrawal && data.withdrawal.usdc && data.withdrawal.usdc.enabled) wSelect.appendChild(new Option('USDC (ERC-20)', 'USDC'));

      // 2. Show custom crypto methods
      customWiths.forEach((item, idx) => {
        if (isCryptoMethod(item.name)) {
          wSelect.appendChild(new Option(item.name, `CUSTOM_WITH_${idx}`));
        }
      });
    } else {
      // 1. If user is from Pakistan, include default Pakistani E-Wallet options: Easypaisa, Jazzcash, SadaPay, NayaPay, Zindgi
      if (isPakistan) {
        const defaultPakWallets = [
          { name: 'Easypaisa', value: 'EASYPAISA' },
          { name: 'Jazzcash', value: 'JAZZCASH' },
          { name: 'SadaPay', value: 'SADAPAY' },
          { name: 'NayaPay', value: 'NAYAPAY' },
          { name: 'Zindgi', value: 'ZINDAGI' }
        ];
        defaultPakWallets.forEach(pw => {
          const exists = this.clientEWallets && this.clientEWallets.some(ew => ew.name.toUpperCase() === pw.value || ew.name.toUpperCase() === pw.name.toUpperCase());
          if (!exists) {
            wSelect.appendChild(new Option(pw.name, pw.value));
          }
        });
      }

      // 2. Show dynamic E-Wallets for user's country
      if (this.clientEWallets && this.clientEWallets.length > 0) {
        this.clientEWallets.forEach(ew => {
          wSelect.appendChild(new Option(ew.name, ew.name.toUpperCase()));
        });
      }

      if (data.withdrawal && data.withdrawal.bank && data.withdrawal.bank.enabled) {
        wSelect.appendChild(new Option('Bank Transfer', 'BANK'));
      }

      // 3. Show custom non-crypto methods
      customWiths.forEach((item, idx) => {
        if (!isCryptoMethod(item.name)) {
          wSelect.appendChild(new Option(item.name, `CUSTOM_WITH_${idx}`));
        }
      });
    }

    this.syncWithdrawCustomSelect();
  },

  selectWithdrawCustomOption(value, label) {
    const realSelect = document.getElementById('withdraw-method-select');
    const customTriggerText = document.getElementById('withdraw-custom-select-trigger-text');
    const container = document.getElementById('withdraw-custom-select-container');
    const optionsContainer = document.getElementById('withdraw-methods-grid') || document.getElementById('withdraw-custom-select-options');

    if (realSelect) {
      realSelect.value = value;
      realSelect.dispatchEvent(new Event('change'));
    }
    if (customTriggerText) customTriggerText.textContent = label;
    if (container) container.classList.remove('open');

    if (optionsContainer) {
      const options = optionsContainer.querySelectorAll('.payment-method-btn, .custom-select-option');
      options.forEach(opt => {
        if (opt.getAttribute('data-value') === value) {
          opt.classList.add('selected');
        } else {
          opt.classList.remove('selected');
        }
      });
    }

    // Dynamically update withdrawal address field placeholder & label
    const fieldsContainer = document.getElementById('withdraw-details-fields-container');
    const labelEl = document.getElementById('withdraw-details-label');
    const data = this.lastWalletData;
    const isPakistan = data && (data.is_pakistan || (this.user && this.user.currency && this.user.currency.toUpperCase() === 'PKR'));

    if (fieldsContainer) {
      const isDynamicEWallet = this.clientEWallets && this.clientEWallets.some(ew => ew.name.toUpperCase() === String(value).toUpperCase());
      const isPakWallet = ['JAZZCASH', 'EASYPAISA', 'NAYAPAY', 'ZINDAGI', 'SADAPAY'].includes(value) || isDynamicEWallet;
      if (isPakWallet) {
        if (labelEl) labelEl.textContent = '4. Account Details';
        fieldsContainer.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div>
              <label class="form-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Account Holder Name (Username)</label>
              <input type="text" id="withdraw-input-username" class="form-control" placeholder="Enter account holder name" required style="height: 40px; border-radius: 8px;">
            </div>
            <div>
              <label class="form-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Mobile / Wallet Number</label>
              <input type="text" id="withdraw-input-number" class="form-control" placeholder="Enter wallet account number" required style="height: 40px; border-radius: 8px;">
            </div>
            <!-- Hidden textarea for backward compatibility -->
            <textarea id="withdraw-payout-details" style="display: none;"></textarea>
          </div>
        `;
      } else if (value === 'BANK') {
        if (labelEl) labelEl.textContent = '4. Bank Account Details';
        fieldsContainer.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div>
              <label class="form-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Bank Name</label>
              <input type="text" id="withdraw-input-bankname" class="form-control" placeholder="e.g. HBL, Alfalah, UBL" required style="height: 40px; border-radius: 8px;">
            </div>
            <div>
              <label class="form-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">Account Holder Name (Username)</label>
              <input type="text" id="withdraw-input-username" class="form-control" placeholder="Enter account holder name" required style="height: 40px; border-radius: 8px;">
            </div>
            <div>
              <label class="form-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">IBAN</label>
              <input type="text" id="withdraw-input-iban" class="form-control" placeholder="Enter 24-character IBAN" required style="height: 40px; border-radius: 8px; text-transform: uppercase;">
            </div>
            <!-- Hidden textarea for backward compatibility -->
            <textarea id="withdraw-payout-details" style="display: none;"></textarea>
          </div>
        `;
      } else {
        if (labelEl) labelEl.textContent = '4. Wallet Address';
        fieldsContainer.innerHTML = `
          <textarea id="withdraw-payout-details" class="form-control" rows="3" placeholder="Provide your Wallet address" required></textarea>
        `;
        const detailsInput = document.getElementById('withdraw-payout-details');
        if (detailsInput) {
          if (value.startsWith('CUSTOM_WITH_')) {
            let customWiths = [];
            try {
              customWiths = typeof data.custom_withdrawal_methods === 'string'
                ? JSON.parse(data.custom_withdrawal_methods || '[]')
                : (data.custom_withdrawal_methods || []);
            } catch(e) {}
            const idx = parseInt(value.replace('CUSTOM_WITH_', ''));
            const withItem = customWiths[idx];
            if (withItem) {
              detailsInput.placeholder = withItem.placeholder || 'Provide your Wallet address';
            }
          } else {
            if (value === 'USDT') {
              detailsInput.placeholder = 'Enter USDT TRC-20 wallet address';
            } else if (value === 'USDC') {
              detailsInput.placeholder = 'Enter USDC ERC-20 wallet address';
            } else if (value === 'BANK') {
              detailsInput.placeholder = 'Enter Bank details (Account name, Number, Bank name, SWIFT/IFSC)';
            } else {
              detailsInput.placeholder = 'Provide your Wallet address';
            }
          }
        }
      }
    }
  },

  async handleDepositMethodChange(method) {
    try {
      const data = this.lastWalletData;
      if (!data) return;

      // KYC verification check — block address generation for unverified users
      if (this.user && this.user.kyc_status !== 'verified') {
        this.showKycLockModal();
        return;
      }

      const textBox = document.getElementById('deposit-instructions-text');
      const instDiv = document.getElementById('deposit-instructions');
      const ewalletInstDiv = document.getElementById('deposit-ewallet-instructions');
      const proofTextGrp = document.getElementById('deposit-proof-text-group');
      const proofFileGrp = document.getElementById('deposit-proof-file-group');
      const submitBtn = document.getElementById('deposit-submit-btn');
      
      const userAccountGrp = document.getElementById('deposit-user-account-group');
      const userBankGrp = document.getElementById('deposit-user-bank-group');
      
      const proofTextInput = document.getElementById('deposit-proof-text');
      const proofFileInput = document.getElementById('deposit-proof-file');
      
      const userAccountInput = document.getElementById('deposit-user-account');
      const userBankInput = document.getElementById('deposit-user-bank');

      const isEWallet = this.clientEWallets && this.clientEWallets.some(ew => ew.name.toUpperCase() === method.toUpperCase());

      if (isEWallet) {
        const ew = this.clientEWallets.find(ew => ew.name.toUpperCase() === method.toUpperCase());
        
        if (instDiv) instDiv.style.display = 'none';
        
        if (ewalletInstDiv) {
          ewalletInstDiv.style.display = 'flex';
          const logoImg = document.getElementById('ewallet-logo-img');
          if (logoImg) {
            if (ew.logo_url) {
              logoImg.src = ew.logo_url;
              logoImg.style.display = 'block';
            } else {
              logoImg.style.display = 'none';
            }
          }
          
          const nameLabel = document.getElementById('ewallet-name-label');
          if (nameLabel) nameLabel.textContent = `${ew.name} Details:`;
          
          const holderText = document.getElementById('ewallet-holder-text');
          if (holderText) holderText.textContent = ew.account_name;
          
          const numberText = document.getElementById('ewallet-number-text');
          if (numberText) numberText.textContent = ew.account_number;
          
          const ibanContainer = document.getElementById('ewallet-iban-container');
          const ibanText = document.getElementById('ewallet-iban-text');
          if (ibanContainer && ibanText) {
            if (ew.iban) {
              ibanText.textContent = ew.iban;
              ibanContainer.style.display = 'block';
            } else {
              ibanContainer.style.display = 'none';
            }
          }
        }
        
        this.toggleDepositGroup('deposit-user-account-group', true);
        this.toggleDepositGroup('deposit-user-bank-group', true);
        this.toggleDepositGroup('deposit-proof-text-group', true);
        this.toggleDepositGroup('deposit-proof-file-group', true);

        // Switch amount field to PKR
        this.toggleDepositGroup('deposit-amount-usd-group', false);
        this.toggleDepositGroup('deposit-amount-pkr-group', true);
        const usdInput = document.getElementById('deposit-amount');
        if (usdInput) usdInput.removeAttribute('required');

        // Dynamically update the PKR rate note text based on the configured rate of this E-Wallet
        const activeRate = ew ? (ew.pkr_rate || 283) : 283;
        const minDepUsd = ew && ew.min_deposit !== undefined && ew.min_deposit !== null ? ew.min_deposit : 10;
        const maxDepUsd = ew && ew.max_deposit !== undefined && ew.max_deposit !== null ? ew.max_deposit : 10000;
        const minPkr = Math.round(minDepUsd * activeRate);
        const maxPkr = Math.round(maxDepUsd * activeRate);
        const rateNote = document.getElementById('deposit-pkr-rate-note');
        if (rateNote) {
          rateNote.innerHTML = `Rate: ${activeRate} PKR = $1 USD &nbsp;|&nbsp; Limits: ${minPkr.toLocaleString()} PKR - ${maxPkr.toLocaleString()} PKR (~$${minDepUsd} - ~$${maxDepUsd})`;
        }
        
        if (proofTextInput) {
          proofTextInput.placeholder = 'Enter Transaction ID';
          proofTextInput.required = true;
          proofTextInput.setAttribute('required', 'required');
        }
        if (userAccountInput) {
          userAccountInput.required = true;
          userAccountInput.setAttribute('required', 'required');
        }
        if (userBankInput) {
          userBankInput.required = true;
          userBankInput.setAttribute('required', 'required');
        }
        if (proofFileInput) {
          proofFileInput.required = true;
          proofFileInput.setAttribute('required', 'required');
        }
        
        if (submitBtn) {
          submitBtn.querySelector('span').textContent = 'Submit E-Wallet Deposit';
        }
      } else if (method.startsWith('NOWPAYMENTS_')) {
        // Hide manual instructions and proof fields
        if (instDiv) instDiv.style.display = 'none';
        if (ewalletInstDiv) ewalletInstDiv.style.display = 'none';
        this.toggleDepositGroup('deposit-proof-text-group', false);
        this.toggleDepositGroup('deposit-proof-file-group', false);
        this.toggleDepositGroup('deposit-user-account-group', false);
        this.toggleDepositGroup('deposit-user-bank-group', false);
        
        // Make inputs not required
        if (proofTextInput) {
          proofTextInput.required = false;
          proofTextInput.removeAttribute('required');
        }
        if (userAccountInput) {
          userAccountInput.required = false;
          userAccountInput.removeAttribute('required');
        }
        if (userBankInput) {
          userBankInput.required = false;
          userBankInput.removeAttribute('required');
        }
        if (proofFileInput) {
          proofFileInput.required = false;
          proofFileInput.removeAttribute('required');
        }

        // Restore USD amount field
        this.toggleDepositGroup('deposit-amount-usd-group', true);
        this.toggleDepositGroup('deposit-amount-pkr-group', false);
        const usdInput2 = document.getElementById('deposit-amount');
        if (usdInput2) usdInput2.setAttribute('required', 'required');
        
        if (submitBtn) {
          submitBtn.querySelector('span').textContent = 'Generate Deposit Address';
        }
      } else if (method === 'BINANCE_AUTO' || method === 'BINANCE_MANUAL') {
        // Show manual instructions and proof fields
        if (instDiv) instDiv.style.display = 'block';
        if (ewalletInstDiv) ewalletInstDiv.style.display = 'none';
        this.toggleDepositGroup('deposit-proof-text-group', true);
        this.toggleDepositGroup('deposit-proof-file-group', true);
        this.toggleDepositGroup('deposit-user-account-group', false);
        this.toggleDepositGroup('deposit-user-bank-group', false);
        
        // Restore required fields
        if (proofTextInput) {
          proofTextInput.required = true;
          proofTextInput.setAttribute('required', 'required');
        }
        if (userAccountInput) {
          userAccountInput.required = false;
          userAccountInput.removeAttribute('required');
        }
        if (userBankInput) {
          userBankInput.required = false;
          userBankInput.removeAttribute('required');
        }
        if (proofFileInput) {
          proofFileInput.required = true;
          proofFileInput.setAttribute('required', 'required');
        }

        // Restore USD amount field
        this.toggleDepositGroup('deposit-amount-usd-group', true);
        this.toggleDepositGroup('deposit-amount-pkr-group', false);
        const usdInput3 = document.getElementById('deposit-amount');
        if (usdInput3) usdInput3.setAttribute('required', 'required');

        if (submitBtn) {
          submitBtn.querySelector('span').textContent = method === 'BINANCE_AUTO' ? 'Submit Binance Auto Payment' : 'Submit Binance Deposit';
        }

        const binDetails = method === 'BINANCE_AUTO' ? data.deposit.binance_auto : data.deposit.binance_manual;
        let address = binDetails ? (binDetails.address || '') : '';
        let showCrypto = true;
        let customPlaceholder = 'Enter Binance TxID / Reference ID';
        textBox.textContent = 'Binance Pay ID / Deposit Address';

        if (proofTextInput) {
          proofTextInput.placeholder = customPlaceholder;
        }

        const qrWrap = document.getElementById('deposit-qr-wrap');
        const qrImg = document.getElementById('deposit-qr-img');
        const copyWrap = document.getElementById('deposit-address-copy-wrap');
        const addressText = document.getElementById('deposit-address-val-text');

        if (address) {
          if (binDetails && binDetails.qr_url) {
            if (qrImg) qrImg.src = binDetails.qr_url;
          } else {
            if (qrImg) qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&color=1ab76d&bgcolor=ffffff&data=${encodeURIComponent(address)}`;
          }
          if (qrWrap) qrWrap.style.display = 'flex';
          if (copyWrap) copyWrap.style.display = 'flex';
          if (addressText) addressText.textContent = address;
        } else {
          if (qrWrap) qrWrap.style.display = 'none';
          if (copyWrap) copyWrap.style.display = 'none';
          textBox.textContent = 'Binance payment details not configured.';
        }
      } else {
        // Show manual instructions and proof fields
        if (instDiv) instDiv.style.display = 'block';
        if (ewalletInstDiv) ewalletInstDiv.style.display = 'none';
        this.toggleDepositGroup('deposit-proof-text-group', true);
        this.toggleDepositGroup('deposit-proof-file-group', true);
        this.toggleDepositGroup('deposit-user-account-group', false);
        this.toggleDepositGroup('deposit-user-bank-group', false);
        
        // Restore required fields
        if (proofTextInput) {
          proofTextInput.required = true;
          proofTextInput.setAttribute('required', 'required');
        }
        if (userAccountInput) {
          userAccountInput.required = false;
          userAccountInput.removeAttribute('required');
        }
        if (userBankInput) {
          userBankInput.required = false;
          userBankInput.removeAttribute('required');
        }
        if (proofFileInput) {
          proofFileInput.required = false;
          proofFileInput.removeAttribute('required');
        }

        // Restore USD amount field
        this.toggleDepositGroup('deposit-amount-usd-group', true);
        this.toggleDepositGroup('deposit-amount-pkr-group', false);
        const usdInput3 = document.getElementById('deposit-amount');
        if (usdInput3) usdInput3.setAttribute('required', 'required');

        if (submitBtn) {
          submitBtn.querySelector('span').textContent = 'Submit Deposit Request';
        }

        let address = '';
        let showCrypto = false;
        let customPlaceholder = 'Paste transaction hash / TXID here';

        if (method.startsWith('CUSTOM_DEP_')) {
          let customDeps = [];
          try {
            customDeps = typeof data.custom_deposit_methods === 'string'
              ? JSON.parse(data.custom_deposit_methods || '[]')
              : (data.custom_deposit_methods || []);
          } catch(e) {}
          const idx = parseInt(method.replace('CUSTOM_DEP_', ''));
          const depItem = customDeps[idx];
          if (depItem) {
            address = depItem.details || '';
            showCrypto = address && /^[a-zA-Z0-9]{25,60}$/.test(address.trim());
            customPlaceholder = depItem.placeholder || 'Paste transaction hash / TXID here';
            textBox.textContent = showCrypto ? `Network: ${depItem.name}` : address;
          }
        } else if (method === 'USDT_TRC20') {
          address = data.deposit.usdt_trc20.address;
          showCrypto = true;
          textBox.textContent = 'Network: TRON (TRC-20)';
        } else if (method === 'USDT_ERC20') {
          address = data.deposit.usdt_erc20.address;
          showCrypto = true;
          textBox.textContent = 'Network: Ethereum (ERC-20)';
        } else if (method === 'USDT_BEP20') {
          address = data.deposit.usdt_bep20.address;
          showCrypto = true;
          textBox.textContent = 'Network: BNB Smart Chain (BEP-20)';
        } else if (method === 'USDT_LTC') {
          address = data.deposit.usdt_ltc.address;
          showCrypto = true;
          textBox.textContent = 'Network: Litecoin (LTC)';
        } else if (method === 'USDT_APTOS') {
          address = data.deposit.usdt_aptos.address;
          showCrypto = true;
          textBox.textContent = 'Network: Aptos Network';
        }

        // Dynamically update the proof text input placeholder
        if (proofTextInput) {
          proofTextInput.placeholder = customPlaceholder;
        }

        const qrWrap = document.getElementById('deposit-qr-wrap');
        const qrImg = document.getElementById('deposit-qr-img');
        const copyWrap = document.getElementById('deposit-address-copy-wrap');
        const addressText = document.getElementById('deposit-address-val-text');

        if (address) {
          if (showCrypto) {
            if (qrImg) qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&color=1ab76d&bgcolor=ffffff&data=${encodeURIComponent(address)}`;
            if (qrWrap) qrWrap.style.display = 'flex';
            if (copyWrap) copyWrap.style.display = 'flex';
            if (addressText) addressText.textContent = address;
          } else {
            if (qrWrap) qrWrap.style.display = 'none';
            if (copyWrap) copyWrap.style.display = 'none';
            textBox.textContent = address;
          }
        } else {
          if (qrWrap) qrWrap.style.display = 'none';
          if (copyWrap) copyWrap.style.display = 'none';
          if (method === 'BANK') {
            textBox.textContent = data.deposit.bank.details;
          } else {
            textBox.textContent = 'All deposit channels are offline.';
          }
        }
      }
      this.updateDepositHint(this.activeDepositMode, method);
    } catch (err) {
      console.error('Failed instructions updates:', err);
    }
  },

  handleFileUploadNameChange(input) {
    const label = document.getElementById('file-upload-label');
    if (input.files && input.files[0]) {
      label.textContent = `Attached: ${input.files[0].name.slice(0, 25)}...`;
      label.style.color = 'var(--primary)';
    } else {
      label.textContent = 'Click to upload screenshot/slip';
      label.style.color = 'var(--text-secondary)';
    }
  },

  async handleDepositSubmit(e) {
    e.preventDefault();
    const method = document.getElementById('deposit-method-select').value;
    const amount = document.getElementById('deposit-amount').value;

    // KYC verification check
    if (this.user && this.user.kyc_status !== 'verified') {
      this.showKycLockModal();
      return;
    }

    if (this.user.status === 'frozen') {
      this.showToast('Your account is frozen. Deposits are disabled.', 'error');
      return;
    }

    if (method === 'BINANCE_AUTO' || method === 'BINANCE_MANUAL') {
      const txid = document.getElementById('deposit-proof-text').value.trim();
      const fileInput = document.getElementById('deposit-proof-file');
      
      if (!amount || parseFloat(amount) < 10) {
        this.showToast('Minimum deposit amount for Binance is $10.', 'error');
        return;
      }
      if (!txid) {
        this.showToast('Please enter the Binance Transaction ID / TxID.', 'error');
        return;
      }
      if (!fileInput.files[0]) {
        this.showToast('Please upload a screenshot of your deposit.', 'error');
        return;
      }

      const fileToUpload = await this.compressImage(fileInput.files[0]);
      const formData = new FormData();
      formData.append('method', method);
      formData.append('amount', amount);
      formData.append('proof_text', txid);
      formData.append('slip', fileToUpload);

      try {
        const res = await fetch('/api/client/deposit', {
          method: 'POST',
          body: formData
        });
        
        let data = {};
        if (res.headers.get('content-type')?.includes('application/json')) {
          data = await res.json();
        } else {
          data = { error: `Server error (${res.status})` };
        }

        if (res.ok) {
          this.showToast(data.message || 'Deposit submitted successfully.', 'success');
          document.getElementById('deposit-form').reset();
          document.getElementById('file-upload-label').textContent = 'Click to upload screenshot/slip';
          document.getElementById('file-upload-label').style.color = 'var(--text-secondary)';
          this.navigateTo('dashboard');
        } else {
          this.showToast(data.error || 'Failed deposit submission.', 'error');
        }
      } catch (err) {
        this.showToast('Network error during deposit.', 'error');
      }
      return;
    }

    if (method.startsWith('NOWPAYMENTS_')) {
      if (this.user && this.user.currency && this.user.currency !== 'USD') {
        this.showToast('Please change your currency to USD for Deposit and Withdrawal.', 'error');
        return;
      }

      if (!amount || parseFloat(amount) < 10) {
        this.showToast('Minimum deposit amount for Auto Instant is $10.', 'error');
        return;
      }

      const coin = method.replace('NOWPAYMENTS_', '').toLowerCase();
      try {
        const res = await fetch('/api/client/nowpayments/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ amount, coin })
        });
        const data = await res.json();
        if (!res.ok) {
          this.showToast(data.error || 'Failed to create auto deposit.', 'error');
          return;
        }

        // Show Invoice UI
        document.getElementById('deposit-form-card').style.display = 'none';
        document.getElementById('deposit-invoice-card').style.display = 'block';

        let displayAmount = data.pay_amount;
        const curUpper = data.pay_currency.toUpperCase();
        if (curUpper === 'TRX' || curUpper.includes('USDT') || curUpper.includes('USDC') || curUpper.includes('BUSD') || curUpper.includes('TUSD')) {
          const parsed = parseFloat(data.pay_amount);
          if (!isNaN(parsed)) {
            displayAmount = parsed.toFixed(2);
          }
        }

        document.getElementById('invoice-crypto-amount').textContent = `${displayAmount} ${curUpper}`;
        document.getElementById('invoice-usd-amount').textContent = `($${parseFloat(amount).toFixed(2)} USD)`;
        document.getElementById('invoice-address').value = data.pay_address;
        
        // Generate QR code using public api.qrserver.com
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.pay_address)}`;
        document.getElementById('invoice-qr-code').src = qrUrl;

        // Clear any existing polling
        if (this.invoicePollInterval) {
          clearInterval(this.invoicePollInterval);
        }

        this.showToast('Payment address generated successfully!');

        // Poll for completion
        this.invoicePollInterval = setInterval(() => {
          this.checkInvoiceStatus(data.payment_id);
        }, 5000);

      } catch (err) {
        console.error('NOWPayments checkout error:', err);
        this.showToast('Network error during checkout.', 'error');
      }
      return;
    }

    // Check if dynamic E-Wallet method
    const isEWallet = this.clientEWallets && this.clientEWallets.some(ew => ew.name.toUpperCase() === method.toUpperCase());
    if (isEWallet) {
      const pkrInput = document.getElementById('deposit-amount-pkr');
      const pkrAmount = pkrInput ? parseFloat(pkrInput.value) : 0;
      
      const ew = this.clientEWallets.find(ew => ew.name.toUpperCase() === method.toUpperCase());
      const activeRate = ew ? (ew.pkr_rate || 283) : 283;
      
      const minDepUsd = ew && ew.min_deposit !== undefined && ew.min_deposit !== null ? ew.min_deposit : 10;
      const maxDepUsd = ew && ew.max_deposit !== undefined && ew.max_deposit !== null ? ew.max_deposit : 10000;
      
      const minPkr = Math.round(minDepUsd * activeRate);
      const maxPkr = Math.round(maxDepUsd * activeRate);

      if (!pkrAmount || pkrAmount < minPkr) {
        this.showToast(`Minimum deposit is ${minPkr.toLocaleString('en-US')} PKR (~$${minDepUsd.toLocaleString('en-US')}). Please enter a valid amount.`, 'error');
        return;
      }
      if (pkrAmount > maxPkr) {
        this.showToast(`Maximum deposit is ${maxPkr.toLocaleString('en-US')} PKR (~$${maxDepUsd.toLocaleString('en-US')}) per transaction.`, 'error');
        return;
      }

      const usdAmount = (pkrAmount / activeRate).toFixed(2);

      const userAccount = document.getElementById('deposit-user-account').value.trim();
      const userBank = document.getElementById('deposit-user-bank').value.trim();
      const txid = document.getElementById('deposit-proof-text').value.trim();
      const fileInput = document.getElementById('deposit-proof-file');
      
      if (!userAccount || !userBank || !txid || !fileInput.files[0]) {
        this.showToast('All payment details and screenshot proof are required.', 'error');
        return;
      }
      
      const fileToUpload = await this.compressImage(fileInput.files[0]);
      const formData = new FormData();
      formData.append('method', method);
      formData.append('amount', usdAmount);
      formData.append('proof_text', `Sender Account: ${userAccount}\nSender Bank: ${userBank}\nTransaction ID: ${txid}\nPKR Amount: ${pkrAmount.toLocaleString('en-US')} PKR`);
      formData.append('slip', fileToUpload);
      
      try {
        const res = await fetch('/api/client/deposit', {
          method: 'POST',
          body: formData
        });
        
        let data = {};
        if (res.headers.get('content-type')?.includes('application/json')) {
          data = await res.json();
        } else {
          data = { error: `Server error (${res.status})` };
        }

        if (res.ok) {
          this.showToast('Deposit request is submited your funds willl be added in 15 Minutes', 'success');
          document.getElementById('deposit-form').reset();
          if (pkrInput) pkrInput.value = '';
          document.getElementById('file-upload-label').textContent = 'Click to upload screenshot/slip';
          document.getElementById('file-upload-label').style.color = 'var(--text-secondary)';
          this.navigateTo('dashboard');
        } else {
          this.showToast(data.error || 'Failed deposit submission.', 'error');
        }
      } catch (err) {
        this.showToast('Network error during deposit.', 'error');
      }
      return;
    }

    // Legacy manual deposit
    const proof_text = document.getElementById('deposit-proof-text').value;
    const fileInput = document.getElementById('deposit-proof-file');
    
    let fileToUpload = null;
    if (fileInput.files[0]) {
      fileToUpload = await this.compressImage(fileInput.files[0]);
    }
    
    const formData = new FormData();
    
    // Map custom deposit method key to actual custom method name for database readability
    let customMethodName = method;
    if (method.startsWith('CUSTOM_DEP_')) {
      const idx = parseInt(method.replace('CUSTOM_DEP_', ''));
      const customDeps = typeof this.lastWalletData.custom_deposit_methods === 'string'
        ? JSON.parse(this.lastWalletData.custom_deposit_methods || '[]')
        : (this.lastWalletData.custom_deposit_methods || []);
      if (customDeps[idx]) {
        customMethodName = customDeps[idx].name;
      }
    }

    formData.append('method', customMethodName);
    formData.append('amount', amount);
    formData.append('proof_text', proof_text);
    if (fileToUpload) {
      formData.append('slip', fileToUpload);
    }

    try {
      const res = await fetch('/api/client/deposit', {
        method: 'POST',
        body: formData
      });
      
      let data = {};
      if (res.headers.get('content-type')?.includes('application/json')) {
        data = await res.json();
      } else {
        data = { error: `Server error (${res.status})` };
      }

      if (res.ok) {
        this.showToast('Deposit request submitted! Awaiting administrator confirmation.');
        document.getElementById('deposit-form').reset();
        document.getElementById('file-upload-label').textContent = 'Click to upload screenshot/slip';
        document.getElementById('file-upload-label').style.color = 'var(--text-secondary)';
        this.navigateTo('dashboard');
      } else {
        this.showToast(data.error || 'Failed deposit submission.', 'error');
      }
    } catch (err) {
      this.showToast('Network error during deposit.', 'error');
    }
  },

  copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => this.showToast('Copied to clipboard!'))
        .catch(() => this.showToast('Failed to copy.', 'error'));
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.showToast('Copied to clipboard!');
      } catch (err) {
        this.showToast('Failed to copy.', 'error');
      }
      document.body.removeChild(textarea);
    }
  },

  copyWholeEWalletDetails() {
    const nameLabel = document.getElementById('ewallet-name-label')?.textContent || '';
    const holderText = document.getElementById('ewallet-holder-text')?.textContent || '';
    const numberText = document.getElementById('ewallet-number-text')?.textContent || '';
    const ibanText = document.getElementById('ewallet-iban-text')?.textContent || '';
    
    let details = `${nameLabel}\n`;
    details += `Account Holder: ${holderText}\n`;
    details += `Account Number: ${numberText}\n`;
    if (ibanText && document.getElementById('ewallet-iban-container').style.display !== 'none') {
      details += `IBAN: ${ibanText}\n`;
    }
    
    this.copyText(details);
  },

  async handleWithdrawSubmit(e) {
    e.preventDefault();

    // KYC verification check
    if (this.user && this.user.kyc_status !== 'verified') {
      this.showKycLockModal();
      return;
    }

    if (this.user && this.user.currency && this.user.currency !== 'USD' && this.user.currency !== 'PKR') {
      this.showToast('Please change your currency to USD or PKR for Deposit and Withdrawal.', 'error');
      return;
    }

    const usernameInput = document.getElementById('withdraw-input-username');
    const numberInput = document.getElementById('withdraw-input-number');
    const banknameInput = document.getElementById('withdraw-input-bankname');
    const ibanInput = document.getElementById('withdraw-input-iban');
    const payoutDetailsTextarea = document.getElementById('withdraw-payout-details');

    // Build payout_details from structured inputs into the hidden textarea
    if (usernameInput && numberInput && usernameInput.value.trim() && numberInput.value.trim()) {
      const assembled = `Account Holder Name: ${usernameInput.value.trim()}\nAccount / Wallet Number: ${numberInput.value.trim()}`;
      if (payoutDetailsTextarea) payoutDetailsTextarea.value = assembled;
    } else if (banknameInput && usernameInput && ibanInput && banknameInput.value.trim() && usernameInput.value.trim() && ibanInput.value.trim()) {
      const assembled = `Bank Name: ${banknameInput.value.trim()}\nAccount Holder Name: ${usernameInput.value.trim()}\nIBAN: ${ibanInput.value.trim().toUpperCase()}`;
      if (payoutDetailsTextarea) payoutDetailsTextarea.value = assembled;
    }

    const methodSelect = document.getElementById('withdraw-method-select');
    const method = methodSelect ? methodSelect.value : '';
    const amountInput = document.getElementById('withdraw-amount');
    const amount = amountInput ? parseFloat(amountInput.value) : 0;

    // Build payout_details: prefer hidden textarea (now updated), fallback to direct input assembly
    let payout_details = payoutDetailsTextarea ? payoutDetailsTextarea.value.trim() : '';
    if (!payout_details) {
      if (usernameInput && numberInput && usernameInput.value.trim() && numberInput.value.trim()) {
        payout_details = `Account Holder Name: ${usernameInput.value.trim()}\nAccount / Wallet Number: ${numberInput.value.trim()}`;
      } else if (banknameInput && usernameInput && ibanInput && banknameInput.value.trim() && usernameInput.value.trim() && ibanInput.value.trim()) {
        payout_details = `Bank Name: ${banknameInput.value.trim()}\nAccount Holder Name: ${usernameInput.value.trim()}\nIBAN: ${ibanInput.value.trim().toUpperCase()}`;
      }
    }

    if (!payout_details) {
      this.showToast('Please fill in all required account details.', 'error');
      return;
    }

    const codeInput = document.getElementById('withdraw-code');
    const code = codeInput ? codeInput.value.trim() : '';

    if (!code) {
      this.showToast('Please click "Get Code" and enter the verification code sent to your email.', 'error');
      return;
    }

    if (this.user.status === 'frozen') {
      this.showToast('Your account is frozen. Withdrawals are disabled.', 'error');
      return;
    }

    // Map custom withdrawal method key to actual custom method name for database readability
    let customMethodName = method;
    if (method.startsWith('CUSTOM_WITH_')) {
      const idx = parseInt(method.replace('CUSTOM_WITH_', ''));
      const customWiths = typeof this.lastWalletData.custom_withdrawal_methods === 'string'
        ? JSON.parse(this.lastWalletData.custom_withdrawal_methods || '[]')
        : (this.lastWalletData.custom_withdrawal_methods || []);
      if (customWiths[idx]) {
        customMethodName = customWiths[idx].name;
      }
    }

    const payload = { method: customMethodName, amount, payout_details, code };

    try {
      const res = await fetch('/api/client/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (res.ok) {
        this.showToast('Withdrawal request submitted! Amount locked for transfer.');
        document.getElementById('withdraw-form').reset();
        const btn = document.getElementById('btn-request-withdraw-code');
        if (btn) {
          btn.textContent = 'Get Code';
          btn.style.pointerEvents = 'auto';
        }
        this.navigateTo('dashboard');
      } else {
        this.showToast(data.error || 'Withdrawal failed.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  async cancelWithdrawal(id, event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!id) return;

    try {
      const res = await fetch(`/api/client/withdraw/${id}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const data = await res.json();
      if (!res.ok) {
        this.showToast(data.error || 'Failed to cancel withdrawal.', 'error');
        return;
      }

      this.showToast(data.message || 'Withdrawal canceled successfully. Funds refunded to your balance.', 'success');

      if (this.fetchUserProfile) await this.fetchUserProfile();
      if (this.loadWalletData) await this.loadWalletData();
      if (this.loadHistoryData) await this.loadHistoryData();
      if (this.loadDashboardData) await this.loadDashboardData();
    } catch (err) {
      console.error('Error canceling withdrawal:', err);
      this.showToast('Network error while canceling withdrawal. Please try again.', 'error');
    }
  },

  async requestWithdrawalCode(e) {
    if (e) e.preventDefault();

    // KYC verification check
    if (this.user && this.user.kyc_status !== 'verified') {
      this.showKycLockModal();
      return;
    }

    if (this.user && this.user.currency && this.user.currency !== 'USD' && this.user.currency !== 'PKR') {
      this.showToast('Please change your currency to USD or PKR for Deposit and Withdrawal.', 'error');
      return;
    }

    const btn = document.getElementById('btn-request-withdraw-code');
    if (!btn || btn.textContent.includes('Sending')) return;

    btn.textContent = 'Sending...';
    btn.style.pointerEvents = 'none';

    try {
      const res = await fetch('/api/client/withdraw/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Verification code sent to your email.');
        let count = 60;
        const interval = setInterval(() => {
          count--;
          if (count <= 0) {
            clearInterval(interval);
            btn.textContent = 'Get Code';
            btn.style.pointerEvents = 'auto';
          } else {
            btn.textContent = `Retry in ${count}s`;
          }
        }, 1000);
      } else {
        this.showToast(data.error || 'Failed to send verification code.', 'error');
        btn.textContent = 'Get Code';
        btn.style.pointerEvents = 'auto';
      }
    } catch (err) {
      this.showToast('Network error requested code.', 'error');
      btn.textContent = 'Get Code';
      btn.style.pointerEvents = 'auto';
    }
  },

  copyInvoiceText(elementId) {
    const input = document.getElementById(elementId);
    if (input) {
      input.select();
      input.setSelectionRange(0, 99999);
      navigator.clipboard.writeText(input.value)
        .then(() => this.showToast('Address copied to clipboard!'))
        .catch(() => this.showToast('Failed to copy. Please copy manually.', 'error'));
    }
  },

  cancelInvoice() {
    if (this.invoicePollInterval) {
      clearInterval(this.invoicePollInterval);
      this.invoicePollInterval = null;
    }
    document.getElementById('deposit-invoice-card').style.display = 'none';
    document.getElementById('deposit-form-card').style.display = 'flex';
    document.getElementById('deposit-form').reset();
    
    const label = document.getElementById('file-upload-label');
    if (label) {
      label.textContent = 'Click to upload screenshot/slip';
      label.style.color = 'var(--text-secondary)';
    }
  },

  async checkInvoiceStatus(paymentId) {
    try {
      const res = await fetch(`/api/client/nowpayments/status/${paymentId}`);
      const data = await res.json();
      if (!res.ok) return;

      if (data.status === 'approved') {
        if (this.invoicePollInterval) {
          clearInterval(this.invoicePollInterval);
          this.invoicePollInterval = null;
        }

        this.showToast('Payment confirmed! Funds have been credited to your balance.');
        
        document.getElementById('deposit-invoice-card').style.display = 'none';
        document.getElementById('deposit-form-card').style.display = 'block';
        document.getElementById('deposit-form').reset();

        await this.loadWalletData();
        this.navigateTo('dashboard');
      } else if (data.status === 'rejected') {
        if (this.invoicePollInterval) {
          clearInterval(this.invoicePollInterval);
          this.invoicePollInterval = null;
        }
        this.showToast('Payment request has expired or was rejected.', 'error');
        this.cancelInvoice();
      }
    } catch (err) {
      console.error('Error checking invoice status:', err);
    }
  },

  // --- LEDGER / HISTORY TABS ---

  toggleHistorySection(type) {
    this.activeHistorySection = type;
    
    // Deactivate all history tab buttons
    const buttons = ['all', 'wins', 'losses', 'rewards', 'deposits', 'withdrawals', 'convert', 'ledger'];
    buttons.forEach(btn => {
      const el = document.getElementById(`history-tab-${btn}-btn`);
      if (el) el.classList.remove('active');
    });

    // Activate the selected tab button
    const activeEl = document.getElementById(`history-tab-${type}-btn`);
    if (activeEl) activeEl.classList.add('active');

    this.loadHistoryData();
  },

  async loadHistoryData() {
    const box = document.getElementById('history-list-container');
    if (!box) return;

    try {
      const res = await fetch('/api/client/history');
      const data = await res.json();
      if (!res.ok) {
        box.innerHTML = `<div style="text-align: center; color: #8e9297; padding: 15px;">Failed to load history data.</div>`;
        return;
      }

      const currency = this.user ? this.user.currency : 'USD';
      box.innerHTML = '';

      let combined = [];

      // 1. Process Trades
      if (data.trades && data.trades.length > 0) {
        data.trades.filter(t => t && t.status !== 'active').forEach(t => {
          const isWin = t.status === 'win';
          const coinName = t.coin || 'Asset';
          const label = coinName.includes('/') ? coinName : `${coinName}/USDT`;
          const stakeVal = this.getTradeDisplayAmount(t, currency) || 0;
          const commission = t.commission_pct !== undefined && t.commission_pct !== null ? parseFloat(t.commission_pct) : 0;
          const pnl = isWin ? (stakeVal * (commission / 100.0)) : -stakeVal;
          const openPrice = parseFloat(t.open_price || 0);
          const closePrice = t.close_price ? parseFloat(t.close_price) : null;
          const dateVal = new Date(t.resolved_at || t.expires_at || t.created_at || Date.now());
          combined.push({
            type: 'trade',
            tradeStatus: t.status || 'lose',
            title: `Trade ${isWin ? 'Win' : 'Loss'} (${label})`,
            subtitle: `${t.direction || 'BUY'} @${openPrice.toFixed(2)} → @${closePrice ? closePrice.toFixed(2) : '---'}`,
            amount: pnl,
            status: t.status || 'lose',
            date: isNaN(dateVal.getTime()) ? new Date() : dateVal
          });
        });
      }

      // 2. Process Deposits
      if (data.deposits && data.deposits.length > 0) {
        data.deposits.forEach(d => {
          if (!d) return;
          const dateVal = new Date(d.created_at || Date.now());
          combined.push({
            type: 'deposit',
            title: `Deposit (${d.method || 'E-Wallet'})`,
            subtitle: `Ref: ${d.proof_text || 'Direct'}`,
            amount: parseFloat(d.amount || 0),
            status: d.status || 'pending',
            reject_reason: d.reject_reason || '',
            date: isNaN(dateVal.getTime()) ? new Date() : dateVal
          });
        });
      }

      // 3. Process Withdrawals
      if (data.withdrawals && data.withdrawals.length > 0) {
        data.withdrawals.forEach(w => {
          if (!w) return;
          const dateVal = new Date(w.created_at || Date.now());
          combined.push({
            id: w.id,
            type: 'withdrawal',
            title: `Withdrawal (${w.method || 'E-Wallet'})`,
            subtitle: w.status === 'approved' ? 'Processed' : (w.status === 'pending' ? 'Pending Approval' : 'Rejected'),
            amount: -parseFloat(w.amount || 0),
            status: w.status || 'pending',
            reject_reason: w.reject_reason || '',
            date: isNaN(dateVal.getTime()) ? new Date() : dateVal
          });
        });
      }

      // 4. Process Ledger (Conversions & system transactions)
      if (data.ledger && data.ledger.length > 0) {
        data.ledger.forEach(l => {
          if (!l) return;
          if (l.type === 'admin_add' || l.type === 'admin_subtract') return;
          // Identify conversions
          const desc = String(l.description || '');
          const isConvert = l.type === 'convert' || desc.toLowerCase().includes('convert');
          
          // Identify rewards/bonuses
          const descLower = desc.toLowerCase();
          const isReward = l.type === 'referral_commission' || 
                           descLower.includes('bonus') || 
                           descLower.includes('reward') || 
                           descLower.includes('promo') || 
                           descLower.includes('commission') ||
                           descLower.includes('gift') ||
                           descLower.includes('prize') ||
                           descLower.includes('referral');

          const dateVal = new Date(l.created_at || Date.now());
          combined.push({
            type: isReward ? 'reward' : (isConvert ? 'convert' : 'ledger'),
            title: isReward ? (l.description || 'System Reward') : (isConvert ? 'Currency Conversion' : (l.description || 'System Transaction')),
            subtitle: isReward ? 'Reward Bonus' : (isConvert ? desc : `Balance: ${this.formatCurrency(l.balance_after || 0, currency)}`),
            amount: parseFloat(l.amount || 0),
            status: 'approved',
            date: isNaN(dateVal.getTime()) ? new Date() : dateVal
          });
        });
      }

      // Filter based on active section
      let filtered = [];
      const sec = this.activeHistorySection;

      if (sec === 'all') {
        // In 'all' view, exclude ledger duplicates
        filtered = combined.filter(item => {
          if (item.type === 'ledger') {
            const desc = (item.title || '').toLowerCase();
            return !(desc.includes('trade') || desc.includes('deposit') || desc.includes('withdraw'));
          }
          return true;
        });
      } else if (sec === 'wins') {
        filtered = combined.filter(item => item.type === 'trade' && item.tradeStatus === 'win');
      } else if (sec === 'losses') {
        filtered = combined.filter(item => item.type === 'trade' && item.tradeStatus === 'lose');
      } else if (sec === 'rewards') {
        filtered = combined.filter(item => item.type === 'reward');
      } else if (sec === 'deposits') {
        filtered = combined.filter(item => item.type === 'deposit');
      } else if (sec === 'withdrawals') {
        filtered = combined.filter(item => item.type === 'withdrawal');
      } else if (sec === 'convert') {
        filtered = combined.filter(item => item.type === 'convert');
      } else if (sec === 'ledger') {
        filtered = combined.filter(item => item.type === 'ledger' || item.type === 'convert');
      }

      // Sort descending by date
      filtered.sort((a, b) => b.date - a.date);

      if (filtered.length === 0) {
        box.innerHTML = `<div style="text-align: center; color: #8e9297; padding: 30px 0; font-size: 14px;">No transactions found.</div>`;
        return;
      }

      // Render cards
      filtered.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-transaction-card';

        // Icon setup
        let iconHtml = '';
        let iconBgClass = '';

        if (item.type === 'reward') {
          iconBgClass = 'icon-bg-reward';
          iconHtml = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          `;
        } else if (item.status === 'rejected' || item.status === 'lose') {
          iconBgClass = 'icon-bg-rejected';
          iconHtml = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          `;
        } else if (item.amount < 0) {
          iconBgClass = 'icon-bg-outflow';
          iconHtml = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          `;
        } else {
          iconBgClass = 'icon-bg-inflow';
          iconHtml = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="tx-card-icon">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <polyline points="19 12 12 19 5 12"></polyline>
            </svg>
          `;
        }

        const dateVal = item.date;
        let dateStr = '---';
        if (dateVal && !isNaN(dateVal.getTime())) {
          dateStr = dateVal.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
        }
        
        // Clean subtitle/details text
        let details = String(item.subtitle || '');
        if (item.type === 'deposit' || item.type === 'withdrawal') {
          details = details.replace('Ref: ', '').trim();
          if (details === 'Direct' || !details || details === 'Processed' || details === 'Pending Approval') {
            details = (item.title && item.title.includes('BANK')) ? 'Bank Transfer' : 'Crypto Transaction';
          }
        }

        let amountClass = 'tx-amount-inflow';
        let prefix = '+ ';
        if (item.type === 'reward') {
          amountClass = 'tx-amount-reward';
          prefix = '+ ';
        } else if (item.amount < 0) {
          amountClass = 'tx-amount-outflow';
          prefix = '- ';
        } else if (item.amount === 0) {
          amountClass = 'tx-amount-neutral';
          prefix = '';
        }

        let formattedVal = this.formatCurrency(Math.abs(parseFloat(item.amount || 0)), currency);
        if (item.type === 'convert') {
          formattedVal = 'Converted';
          amountClass = 'tx-amount-neutral';
          prefix = '';
        }

        let statusHtml = '';
        if (item.type === 'deposit' || item.type === 'withdrawal') {
          if (item.status === 'pending') {
            const cancelBtnHtml = (item.type === 'withdrawal' && item.id)
              ? `<button type="button" class="btn-cancel-tx" onclick="app.cancelWithdrawal(${item.id}, event)" style="font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 4px; background: rgba(239, 68, 68, 0.12) !important; color: #ff6251 !important; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid rgba(239, 68, 68, 0.3) !important; cursor: pointer; transition: all 0.2s ease; margin-left: 4px; display: inline-flex; align-items: center; gap: 3px;" onmouseover="this.style.background='rgba(239,68,68,0.22)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Cancel</button>`
              : '';
            statusHtml = `<span class="tx-status-badge" style="font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(245, 158, 11, 0.12) !important; color: #f59e0b !important; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid rgba(245, 158, 11, 0.2) !important; flex-shrink: 0; display: inline-block;">Processing</span>${cancelBtnHtml}`;
          } else if (item.status === 'approved') {
            statusHtml = `<span class="tx-status-badge" style="font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(26, 183, 109, 0.12) !important; color: #1ab76d !important; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid rgba(26, 183, 109, 0.2) !important; flex-shrink: 0; display: inline-block;">Completed</span>`;
          } else if (item.status === 'rejected') {
            statusHtml = `<span class="tx-status-badge" style="font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(239, 68, 68, 0.12) !important; color: #ff6251 !important; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid rgba(239, 68, 68, 0.2) !important; flex-shrink: 0; display: inline-block;">Rejected</span>`;
          }
        }

        let rejectReasonHtml = '';
        if (item.status === 'rejected' && item.reject_reason) {
          rejectReasonHtml = `
            <div class="tx-reject-reason" style="width: 100%; margin-top: 8px; padding: 6px 10px; background: rgba(239, 68, 68, 0.04); border-left: 3px solid #ff6251; border-radius: 4px; font-size: 11px; color: #ff8b7e; text-align: left; box-sizing: border-box; line-height: 1.3;">
              <strong>Rejection Reason:</strong> ${this.esc(item.reject_reason)}
            </div>
          `;
        }

        div.innerHTML = `
          <div style="display: flex; flex-direction: column; width: 100%; gap: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
              <div class="tx-card-left">
                <div class="tx-card-icon-wrap ${iconBgClass}">
                  ${iconHtml}
                </div>
                <div class="tx-card-info">
                  <span class="tx-card-title">${item.title}</span>
                  <span class="tx-card-details">${details}</span>
                </div>
              </div>
              <div class="tx-card-right" style="display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 4px;">
                <span class="tx-card-amount ${amountClass}">${prefix}${formattedVal}</span>
                <div style="display: flex; align-items: center; gap: 6px; justify-content: flex-end; flex-wrap: wrap;">
                  ${statusHtml}
                  <span class="tx-card-date">${dateStr}</span>
                </div>
              </div>
            </div>
            ${rejectReasonHtml}
          </div>
        `;
        box.appendChild(div);
      });

    } catch (err) {
      console.error('Failed to load history list:', err);
      box.innerHTML = `<div style="text-align: center; color: #8e9297; padding: 15px;">Error loading history.</div>`;
    }
  },

  // --- STAFF ADMIN PANEL INTERFACE ---

  toggleAdminSection(section) {
    this.activeAdminSection = section;
    document.querySelectorAll('#tab-admin .tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('#tab-admin .tab-pane').forEach(pane => pane.classList.remove('active'));

    const btn = document.getElementById(`admin-tab-${section}-btn`);
    const pane = document.getElementById(`admin-${section}-pane`);
    if (btn) btn.classList.add('active');
    if (pane) pane.classList.add('active');

    clearInterval(this.adminTradesInterval);
    this.loadAdminData();
  },

  async loadAdminData() {
    if (this.activeAdminSection === 'users') {
      await this.loadAdminUsersList();
    } else if (this.activeAdminSection === 'trades') {
      await this.loadAdminActiveTrades();
      // Poll active trades list for countdown synchronization
      this.adminTradesInterval = setInterval(() => this.loadAdminActiveTrades(), 2000);
    } else if (this.activeAdminSection === 'deposits') {
      await this.loadAdminDeposits();
    } else if (this.activeAdminSection === 'withdrawals') {
      await this.loadAdminWithdrawals();
    } else if (this.activeAdminSection === 'employees') {
      await this.loadAdminEmployees();
    } else if (this.activeAdminSection === 'settings') {
      await this.loadAdminSettings();
    }
  },

  async loadAdminUsersList() {
    try {
      const search = document.getElementById('admin-user-search-input').value;
      const res = await fetch(`/api/admin/users?search=${encodeURIComponent(search)}`);
      const data = await res.json();
      if (!res.ok) return;

      const container = document.getElementById('admin-users-list');
      container.innerHTML = '';

      if (data.users.length > 0) {
        data.users.forEach(u => {
          const row = document.createElement('div');
          row.className = 'list-item';
          row.style.cursor = 'pointer';
          row.onclick = () => this.showAdminUserDetail(u.id);

          let statusStyle = '';
          if (u.status === 'frozen') statusStyle = 'color: #3b82f6;';
          if (u.status === 'blocked') statusStyle = 'color: var(--danger);';

          row.innerHTML = `
            <div class="item-left">
              <span class="item-title">${u.username}</span>
              <span class="item-subtitle">Referral Code: ${u.invite_code || 'None'}</span>
            </div>
            <div class="item-right">
              <span class="item-val">${this.formatCurrency(u.balance, u.currency)}</span>
              <span style="font-size:11px; font-weight:700; ${statusStyle}">${u.status.toUpperCase()}</span>
            </div>
          `;
          container.appendChild(row);
        });
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 10px;">No matching client accounts.</div>`;
      }
    } catch (err) {
      console.error(err);
    }
  },

  selectedAdminUserId: null,
  async showAdminUserDetail(userId) {
    try {
      const res = await fetch(`/api/admin/users/${userId}/details`);
      const data = await res.json();
      if (!res.ok) return;

      this.selectedAdminUserId = userId;
      
      document.getElementById('detail-username').textContent = `Manage: ${data.user.username}`;
      document.getElementById('detail-balance').textContent = this.formatCurrency(data.user.balance, data.user.currency);
      
      const statusLabel = document.getElementById('detail-status');
      statusLabel.textContent = data.user.status;
      statusLabel.style.color = data.user.status === 'active' ? 'var(--primary)' : (data.user.status === 'frozen' ? '#3b82f6' : 'var(--danger)');

      document.getElementById('admin-user-detail-card').style.display = 'block';
    } catch (err) {
      console.error(err);
    }
  },

  closeAdminUserDetail() {
    document.getElementById('admin-user-detail-card').style.display = 'none';
    this.selectedAdminUserId = null;
  },

  async submitBalanceAdjustment() {
    if (!this.selectedAdminUserId) return;
    const action = document.getElementById('balance-adjust-action').value;
    const amount = document.getElementById('balance-adjust-amount').value;
    const description = document.getElementById('balance-adjust-desc').value;

    try {
      const res = await fetch(`/api/admin/users/${this.selectedAdminUserId}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, amount, description })
      });
      const data = await res.json();

      if (res.ok) {
        this.showToast('Balance updated successfully!');
        this.showAdminUserDetail(this.selectedAdminUserId);
        this.loadAdminUsersList();
        document.getElementById('balance-adjust-amount').value = '';
        document.getElementById('balance-adjust-desc').value = '';
      } else {
        this.showToast(data.error || 'Failed adjustment.', 'error');
      }
    } catch (err) {
      this.showToast('Error adjusting balance.', 'error');
    }
  },

  async updateUserStatus(status) {
    if (!this.selectedAdminUserId) return;
    try {
      const res = await fetch(`/api/admin/users/${this.selectedAdminUserId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const data = await res.json();

      if (res.ok) {
        this.showToast(`Account status set to: ${status}`);
        this.showAdminUserDetail(this.selectedAdminUserId);
        this.loadAdminUsersList();
      } else {
        this.showToast(data.error || 'Failed status update.', 'error');
      }
    } catch (err) {
      this.showToast('Error modifying status.', 'error');
    }
  },

  // ADMIN ACTIVE TRADES CONTROL
  async loadAdminActiveTrades() {
    try {
      const res = await fetch('/api/admin/trades/active');
      const data = await res.json();
      if (!res.ok) return;

      const container = document.getElementById('admin-active-trades-list');
      container.innerHTML = '';

      if (data.trades.length > 0) {
        data.trades.forEach(trade => {
          const card = document.createElement('div');
          card.className = 'active-trade-card';

          const adjustedNow = Date.now() - (this.clientServerTimeOffset || 0);
          const timeRemaining = Math.max(0, Math.ceil((new Date(trade.expires_at).getTime() - adjustedNow) / 1000));
          
          card.innerHTML = `
            <div class="trade-info">
              <div>User: <strong>${trade.username}</strong></div>
              <div>Coin: <strong>${trade.coin}</strong></div>
              <div>Selection: <strong class="${trade.direction === 'UP' ? 'text-green' : 'text-danger'}">${trade.direction}</strong></div>
              <div>Countdown: <strong class="text-green">${timeRemaining}s</strong></div>
              <div>Stake: <strong>${this.formatCurrency(trade.amount, trade.currency)}</strong></div>
              <div>Entry Price: <strong>$${parseFloat(trade.open_price || 0).toFixed(2)}</strong></div>
              <div style="grid-column: span 2; color: var(--text-secondary); font-size:11px;">
                Override State: <strong class="text-green" style="text-transform:uppercase;">${trade.admin_control}</strong>
              </div>
            </div>
            <div class="trade-controls-row">
              <button class="btn btn-primary" style="padding: 6px; font-size: 11px; box-shadow:none;" onclick="app.forceTradeOutcome(${trade.id}, 'win')">Force WIN</button>
              <button class="btn btn-danger" style="padding: 6px; font-size: 11px; box-shadow:none;" onclick="app.forceTradeOutcome(${trade.id}, 'lose')">Force LOSE</button>
            </div>
          `;
          container.appendChild(card);
        });
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 10px;">No active trades in system.</div>`;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async forceTradeOutcome(tradeId, outcome) {
    try {
      const res = await fetch(`/api/admin/trades/${tradeId}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome })
      });
      if (res.ok) {
        this.showToast(`Forced outcome set to ${outcome.toUpperCase()}`);
        this.loadAdminActiveTrades();
      } else {
        const d = await res.json();
        this.showToast(d.error || 'Failed to force outcome.', 'error');
      }
    } catch (err) {
      this.showToast('Connection error.', 'error');
    }
  },

  // ADMIN DEPOSITS APPROVAL
  async loadAdminDeposits() {
    try {
      const res = await fetch('/api/admin/deposits');
      const data = await res.json();
      if (!res.ok) return;

      const container = document.getElementById('admin-deposits-list');
      container.innerHTML = '';

      const pendings = data.deposits.filter(d => d.status === 'pending');
      if (pendings.length > 0) {
        pendings.forEach(d => {
          const card = document.createElement('div');
          card.className = 'card';
          card.style.marginBottom = '10px';
          
          let slipHtml = '';
          if (d.proof_file) {
            slipHtml = `
              <div style="margin-top: 8px; margin-bottom: 8px;">
                <span class="form-label">Attached Slip Slip:</span>
                <a href="${d.proof_file}" target="_blank" style="display:inline-block; margin-top:4px;">
                  <img src="${d.proof_file}" alt="slip" style="max-width: 100%; max-height: 120px; border-radius:4px; border: 1px solid var(--border-color);">
                </a>
              </div>
            `;
          }

          card.innerHTML = `
            <div style="font-size: 13px; display:flex; flex-direction:column; gap:4px; margin-bottom: 8px;">
              <div>User: <strong>${d.username}</strong></div>
              <div>Method: <strong>${d.method}</strong></div>
              <div>Amount: <strong class="text-green">${this.formatCurrency(d.amount, d.currency)}</strong></div>
              <div style="word-break: break-all;">Proof ref: <code style="color:var(--text-green);">${d.proof_text || 'None'}</code></div>
              ${slipHtml}
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button class="btn btn-primary" style="padding: 6px; font-size: 11px;" onclick="app.resolveDepositSlip(${d.id}, 'approved')">Approve</button>
              <button class="btn btn-danger" style="padding: 6px; font-size: 11px;" onclick="app.resolveDepositSlip(${d.id}, 'rejected')">Reject</button>
            </div>
          `;
          container.appendChild(card);
        });
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 10px;">No pending deposits.</div>`;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async resolveDepositSlip(depositId, status) {
    try {
      const res = await fetch(`/api/admin/deposits/${depositId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        this.showToast(`Deposit slip marked as ${status}`);
        this.loadAdminDeposits();
      } else {
        const d = await res.json();
        this.showToast(d.error || 'Failed deposit resolution.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  // ADMIN WITHDRAWALS APPROVAL
  async loadAdminWithdrawals() {
    try {
      const res = await fetch('/api/admin/withdrawals');
      const data = await res.json();
      if (!res.ok) return;

      const container = document.getElementById('admin-withdrawals-list');
      container.innerHTML = '';

      const pendings = data.withdrawals.filter(w => w.status === 'pending');
      if (pendings.length > 0) {
        pendings.forEach(w => {
          const card = document.createElement('div');
          card.className = 'card';
          card.style.marginBottom = '10px';

          card.innerHTML = `
            <div style="font-size: 13px; display:flex; flex-direction:column; gap:4px; margin-bottom: 8px;">
              <div>User: <strong>${w.username}</strong></div>
              <div>Method: <strong>${w.method}</strong></div>
              <div>Original Requested: <strong class="text-danger">${this.formatCurrency(w.amount, w.currency)}</strong></div>
              <div style="white-space:pre-wrap; word-break:break-all; font-family:monospace; background:rgba(255,255,255,0.02); padding: 6px; border-radius:4px; border:1px solid var(--border-color);">Payout: ${w.payout_details}</div>
            </div>
            
            <div class="form-group" style="margin-bottom: 10px;">
              <label class="form-label" style="font-size:11px;">Adjust Payout Amount (Admin Override)</label>
              <input type="number" id="payout-adjust-${w.id}" class="form-control" style="padding:6px; font-size:12px;" placeholder="Leave blank to pay original" max="${w.amount}">
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button class="btn btn-primary" style="padding: 6px; font-size: 11px;" onclick="app.resolveWithdrawalRequest(${w.id}, 'approved')">Approve Payout</button>
              <button class="btn btn-danger" style="padding: 6px; font-size: 11px;" onclick="app.resolveWithdrawalRequest(${w.id}, 'rejected')">Reject Payout</button>
            </div>
          `;
          container.appendChild(card);
        });
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 10px;">No pending withdrawals.</div>`;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async resolveWithdrawalRequest(wId, status) {
    let payload = { status };
    if (status === 'approved') {
      const input = document.getElementById(`payout-adjust-${wId}`);
      if (input && input.value) {
        payload.amount = parseFloat(input.value);
      }
    }

    try {
      const res = await fetch(`/api/admin/withdrawals/${wId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        this.showToast(`Withdrawal resolved as: ${status}`);
        this.loadAdminWithdrawals();
      } else {
        const d = await res.json();
        this.showToast(d.error || 'Failed withdrawal resolution.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  // ADMIN STAFF MANAGEMENT (Admins only)
  async loadAdminEmployees() {
    try {
      const res = await fetch('/api/admin/employees');
      const data = await res.json();
      if (!res.ok) return;

      const container = document.getElementById('admin-employees-list');
      container.innerHTML = '';

      if (data.employees.length > 0) {
        data.employees.forEach(emp => {
          const div = document.createElement('div');
          div.className = 'list-item';
          
          let permsText = [];
          if (emp.full_access) permsText.push('Full Access');
          else {
            if (emp.user_management) permsText.push('Users');
            if (emp.deposit_approval) permsText.push('Deposits');
            if (emp.withdrawal_approval) permsText.push('Withdrawals');
            if (emp.trade_monitoring) permsText.push('Trades');
          }
          if (permsText.length === 0) permsText.push('None');

          div.innerHTML = `
            <div class="item-left">
              <span class="item-title">${emp.username}</span>
              <span class="item-subtitle">Signup Code: ${emp.invite_code}</span>
              <span class="item-subtitle" style="font-size:10px; color:var(--primary);">Perms: ${permsText.join(', ')}</span>
            </div>
            <div class="item-right">
              <button class="btn btn-secondary" style="padding: 2px 6px; font-size:10px; width:auto;" onclick="app.editEmployeePermissions(${emp.id}, '${emp.username}')">Modify Perms</button>
            </div>
          `;
          container.appendChild(div);
        });
      } else {
        container.innerHTML = `<div style="text-align: center; color: var(--text-secondary); padding: 10px;">No employees created.</div>`;
      }
    } catch (err) {
      console.error(err);
    }
  },

  async handleCreateEmployee(e) {
    e.preventDefault();
    const username = document.getElementById('employee-username').value;
    const password = document.getElementById('employee-password').value;

    const permissions = {
      user_management: document.getElementById('perm-user-mgmt').checked,
      deposit_approval: document.getElementById('perm-deposit-app').checked,
      withdrawal_approval: document.getElementById('perm-withdraw-app').checked,
      trade_monitoring: document.getElementById('perm-trade-mon').checked,
      full_access: document.getElementById('perm-full').checked
    };

    try {
      const res = await fetch('/api/admin/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, permissions })
      });
      const data = await res.json();

      if (res.ok) {
        this.showToast('Employee account created! Invite code generated.');
        document.getElementById('create-employee-form').reset();
        this.loadAdminEmployees();
      } else {
        this.showToast(data.error || 'Failed creation.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  // Edit permissions dynamically
  async editEmployeePermissions(empId, empUsername) {
    const pm = confirm(`Do you want to toggle Full Access for employee: ${empUsername}? Click Cancel to customize checkboxes.`);
    
    let permissions = {
      user_management: true,
      deposit_approval: true,
      withdrawal_approval: true,
      trade_monitoring: true,
      full_access: pm
    };

    if (!pm) {
      const u = confirm(`Grant User Management access to ${empUsername}?`);
      const d = confirm(`Grant Deposit Approvals access to ${empUsername}?`);
      const w = confirm(`Grant Withdrawal Approvals access to ${empUsername}?`);
      const t = confirm(`Grant Trade Monitoring access to ${empUsername}?`);
      permissions = {
        user_management: u,
        deposit_approval: d,
        withdrawal_approval: w,
        trade_monitoring: t,
        full_access: false
      };
    }

    try {
      const res = await fetch(`/api/admin/employees/${empId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions })
      });
      if (res.ok) {
        this.showToast('Employee permissions updated!');
        this.loadAdminEmployees();
      } else {
        const d = await res.json();
        this.showToast(d.error || 'Failed permissions adjust.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  // ADMIN SYSTEM CONFIG SETTINGS
  async loadAdminSettings() {
    try {
      const res = await fetch('/api/admin/settings');
      const data = await res.json();
      if (!res.ok) return;

      const settings = {};
      data.settings.forEach(s => {
        settings[s.key] = s.value;
      });

      // Fill inputs
      document.getElementById('setting-usdt-address').value = settings['usdt_deposit_address'] || '';
      document.getElementById('setting-usdc-address').value = settings['usdc_deposit_address'] || '';
      document.getElementById('setting-bank-details').value = settings['bank_deposit_details'] || '';

      document.getElementById('setting-usdt-enabled').checked = settings['deposit_usdt_enabled'] === 'true';
      document.getElementById('setting-w-usdt-enabled').checked = settings['withdrawal_usdt_enabled'] === 'true';
      
      document.getElementById('setting-usdc-enabled').checked = settings['deposit_usdc_enabled'] === 'true';
      document.getElementById('setting-w-usdc-enabled').checked = settings['withdrawal_usdc_enabled'] === 'true';
      
      document.getElementById('setting-bank-enabled').checked = settings['deposit_bank_enabled'] === 'true';
      document.getElementById('setting-w-bank-enabled').checked = settings['withdrawal_bank_enabled'] === 'true';

      // Load Coin checkboxes
      let visibleCoins = [];
      const rawCoins = settings['crypto_visible_coins'];
      if (rawCoins) {
        try {
          if (rawCoins.trim().startsWith('[')) {
            visibleCoins = JSON.parse(rawCoins);
          } else {
            visibleCoins = rawCoins.split(',').map(s => s.trim()).filter(Boolean);
          }
        } catch(e) {}
      }
      document.querySelectorAll('.coin-visibility-chk').forEach(chk => {
        chk.checked = visibleCoins.includes(chk.value);
      });

    } catch (err) {
      console.error(err);
    }
  },

  async handleSettingsSubmit(e) {
    e.preventDefault();
    const payload = {
      usdt_deposit_address: document.getElementById('setting-usdt-address').value,
      usdc_deposit_address: document.getElementById('setting-usdc-address').value,
      bank_deposit_details: document.getElementById('setting-bank-details').value,
      deposit_usdt_enabled: String(document.getElementById('setting-usdt-enabled').checked),
      withdrawal_usdt_enabled: String(document.getElementById('setting-w-usdt-enabled').checked),
      deposit_usdc_enabled: String(document.getElementById('setting-usdc-enabled').checked),
      withdrawal_usdc_enabled: String(document.getElementById('setting-w-usdc-enabled').checked),
      deposit_bank_enabled: String(document.getElementById('setting-bank-enabled').checked),
      withdrawal_bank_enabled: String(document.getElementById('setting-w-bank-enabled').checked)
    };

    // Grab coin visibility array
    const coins = [];
    document.querySelectorAll('.coin-visibility-chk').forEach(chk => {
      if (chk.checked) coins.push(chk.value);
    });
    payload.crypto_visible_coins = coins;

    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        this.showToast('System settings updated successfully!');
        this.loadAdminSettings();
      } else {
        const data = await res.json();
        this.showToast(data.error || 'Failed settings save.', 'error');
      }
    } catch (err) {
      this.showToast('Network error.', 'error');
    }
  },

  // --- KYC IDENTITY VERIFICATION WIZARD ---
  kycStream: null,
  kycSelfieBlob: null,
  kycSelfieBase64: null,

  clearKycErrors() {
    ['kyc-address-line1', 'kyc-city', 'kyc-postal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('kyc-input-error');
      const err = document.getElementById(`kyc-error-${id.substring(4)}`);
      if (err) err.style.display = 'none';
    });

    ['kyc-front-zone', 'kyc-back-zone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('kyc-input-error');
      const err = document.getElementById(`kyc-error-${id === 'kyc-front-zone' ? 'front' : 'back'}`);
      if (err) err.style.display = 'none';
    });

    const selfieContainer = document.getElementById('kyc-camera-container');
    if (selfieContainer) selfieContainer.classList.remove('kyc-input-error');
    const selfieErr = document.getElementById('kyc-error-selfie');
    if (selfieErr) selfieErr.style.display = 'none';
  },

  toggleKycCountryDropdown(e) {
    e.stopPropagation();
    const container = document.getElementById('kyc-country-custom-container');
    if (container) {
      container.classList.toggle('open');
    }
  },

  selectKycCountry(c) {
    const select = document.getElementById('kyc-country-select');
    if (select) {
      select.value = c;
    }
    
    const triggerText = document.getElementById('kyc-country-trigger-text');
    if (triggerText) {
      triggerText.textContent = c;
    }

    const container = document.getElementById('kyc-country-custom-container');
    if (container) {
      container.classList.remove('open');
    }

    // Update selected class in custom options list
    const options = document.querySelectorAll('#kyc-country-custom-options .custom-select-option');
    options.forEach(opt => {
      const text = opt.querySelector('span:not(.option-bullet)')?.textContent;
      if (text === c) {
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    });
  },

  showKycLockModal() {
    // Remove any existing modal first
    const existing = document.getElementById('kyc-lock-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'kyc-lock-backdrop';
    backdrop.className = 'kyc-lock-backdrop';
    backdrop.innerHTML = `
      <div class="kyc-lock-modal">
        <div class="kyc-lock-icon-wrap">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div class="kyc-lock-title">Account Not Verified</div>
        <p class="kyc-lock-text">Your account is not verified. Please complete KYC verification to access deposits, withdrawals, and address generation.</p>
        <button class="kyc-lock-btn-primary" id="kyc-lock-go-verify-btn">
          ✅ Verify My Account Now
        </button>
        <button class="kyc-lock-btn-secondary" id="kyc-lock-dismiss-btn">
          Maybe Later
        </button>
      </div>
    `;

    document.body.appendChild(backdrop);

    // Dismiss on backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    document.getElementById('kyc-lock-dismiss-btn').addEventListener('click', () => {
      backdrop.remove();
    });

    document.getElementById('kyc-lock-go-verify-btn').addEventListener('click', () => {
      backdrop.remove();
      this.navigateTo('profile');
      this.showProfileSubScreen('settings');
      setTimeout(() => { this.openKycWizard(); }, 200);
    });
  },

  openKycWizard() {
    this.clearKycErrors();
    const modal = document.getElementById('kyc-wizard-modal');
    if (!modal) return;

    const statusContainer = document.getElementById('kyc-status-container');
    const stepsIndicator = document.getElementById('kyc-steps-indicator');
    const formBody = document.getElementById('kyc-form-body');

    // Escaper helper
    const esc = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Check user KYC status
    const status = this.user?.kyc_status || 'unverified';

    if (status !== 'unverified') {
      // Hide the form and steps indicator, show the status screen
      if (stepsIndicator) stepsIndicator.style.display = 'none';
      if (formBody) formBody.style.display = 'none';
      if (statusContainer) {
        statusContainer.style.display = 'flex';
        
        if (status === 'verified') {
          statusContainer.innerHTML = `
            <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(16, 185, 129, 0.1); border: 2px solid #10b981; display: flex; align-items: center; justify-content: center; margin: 0 auto; box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);">
              <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 40px; height: 40px;"><polyline points="20 6 9 17 4 12"></polyline></svg>
            </div>
            <div style="margin-top: 10px;">
              <h3 style="color: #ffffff; font-size: 20px; font-weight: 800; margin: 0 0 8px 0; font-family: 'Outfit', sans-serif;">Account Verified</h3>
              <p style="color: var(--text-secondary); font-size: 13.5px; line-height: 1.6; margin: 0; max-width: 380px; font-family: 'Inter', sans-serif;">Congratulations! Your identity has been successfully verified. You now have full access to all features, including fast withdrawals and higher trading volumes.</p>
            </div>
            <button type="button" onclick="app.closeKycWizard()" class="btn btn-primary" style="width: 100%; max-width: 200px; height: 44px; border-radius: 22px; font-weight: 700; margin-top: 10px; background:#10b981; color:#fff; border:none; cursor:pointer; font-family: 'Inter', sans-serif; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.35);">Great!</button>
          `;
        } else if (status === 'pending') {
          statusContainer.innerHTML = `
            <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(245, 158, 11, 0.1); border: 2px solid #f59e0b; display: flex; align-items: center; justify-content: center; margin: 0 auto; box-shadow: 0 0 20px rgba(245, 158, 11, 0.2); animation: pulseDot 2s infinite;">
              <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 38px; height: 38px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </div>
            <div style="margin-top: 10px;">
              <h3 style="color: #ffffff; font-size: 20px; font-weight: 800; margin: 0 0 8px 0; font-family: 'Outfit', sans-serif;">Verification Pending</h3>
              <p style="color: var(--text-secondary); font-size: 13.5px; line-height: 1.6; margin: 0; max-width: 380px; font-family: 'Inter', sans-serif;">Your identity documents have been submitted and are currently under review by our compliance team. This process typically takes between 15 minutes and a few hours.</p>
            </div>
            <button type="button" onclick="app.closeKycWizard()" class="btn" style="width: 100%; max-width: 200px; height: 44px; border-radius: 22px; font-weight: 700; margin-top: 10px; background:rgba(255,255,255,0.08); color:#fff; border:1px solid var(--border-color); cursor:pointer; font-family: 'Inter', sans-serif;">Close</button>
          `;
        } else if (status === 'rejected') {
          statusContainer.innerHTML = `
            <div style="width: 80px; height: 80px; border-radius: 50%; background: rgba(239, 68, 68, 0.1); border: 2px solid #ef4444; display: flex; align-items: center; justify-content: center; margin: 0 auto; box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);">
              <svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width: 38px; height: 38px;"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </div>
            <div style="margin-top: 10px; display: flex; flex-direction: column; align-items: center;">
              <h3 style="color: #ffffff; font-size: 20px; font-weight: 800; margin: 0 0 8px 0; font-family: 'Outfit', sans-serif;">Verification Rejected</h3>
              <p style="color: var(--text-secondary); font-size: 13.5px; line-height: 1.6; margin: 0 0 12px 0; max-width: 380px; font-family: 'Inter', sans-serif;">Unfortunately, your identity verification was rejected by our compliance team.</p>
              <div style="background: rgba(239, 68, 68, 0.05); border: 1.5px solid rgba(239, 68, 68, 0.2); border-radius: 8px; padding: 12px; font-size: 13px; color: #fca5a5; line-height: 1.4; text-align: left; max-width: 380px; width: 100%; box-sizing: border-box; font-family: monospace;">
                <strong>Reason:</strong> ${esc(this.user.kyc_rejected_reason || 'Document photo was blurry or incomplete. Please re-upload clear photos.')}
              </div>
            </div>
            <div style="display: flex; gap: 10px; width: 100%; max-width: 320px; margin-top: 15px; box-sizing: border-box;">
              <button type="button" onclick="app.closeKycWizard()" class="btn" style="flex: 1; height: 42px; border-radius: 21px; font-weight: 700; background:rgba(255,255,255,0.05); color:#fff; border:1px solid var(--border-color); cursor:pointer; font-family: 'Inter', sans-serif;">Cancel</button>
              <button type="button" onclick="app.showKycForm()" class="btn btn-primary" style="flex: 2; height: 42px; border-radius: 21px; font-weight: 700; background:#10b981; color:#fff; border:none; cursor:pointer; font-family: 'Inter', sans-serif; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25);">Re-submit</button>
            </div>
          `;
        }
        
        modal.style.display = 'flex';
        return;
      }
    }

    // Otherwise, ensure form view is visible
    this.showKycForm();

    // Reset steps & inputs (including new fields)
    document.getElementById('kyc-address-input').value = '';
    if (document.getElementById('kyc-address-line1')) document.getElementById('kyc-address-line1').value = '';
    if (document.getElementById('kyc-address-line2')) document.getElementById('kyc-address-line2').value = '';
    if (document.getElementById('kyc-city')) document.getElementById('kyc-city').value = '';
    if (document.getElementById('kyc-state')) document.getElementById('kyc-state').value = '';
    if (document.getElementById('kyc-postal')) document.getElementById('kyc-postal').value = '';

    document.getElementById('kyc-doc-front').value = '';
    document.getElementById('kyc-doc-back').value = '';
    document.getElementById('kyc-selfie-upload').value = '';
    
    // Reset placeholders and labels
    if (document.getElementById('kyc-front-placeholder')) document.getElementById('kyc-front-placeholder').style.display = 'block';
    if (document.getElementById('kyc-back-placeholder')) document.getElementById('kyc-back-placeholder').style.display = 'block';
    
    const labelFront = document.getElementById('kyc-label-front');
    if (labelFront) {
      labelFront.textContent = '';
      labelFront.style.display = 'none';
    }
    const labelBack = document.getElementById('kyc-label-back');
    if (labelBack) {
      labelBack.textContent = '';
      labelBack.style.display = 'none';
    }
    const labelSelfie = document.getElementById('kyc-label-selfie');
    if (labelSelfie) labelSelfie.textContent = 'Choose selfie image file';

    const prevFront = document.getElementById('kyc-preview-front');
    if (prevFront) {
      prevFront.style.display = 'none';
      prevFront.src = '';
    }
    const prevBack = document.getElementById('kyc-preview-back');
    if (prevBack) {
      prevBack.style.display = 'none';
      prevBack.src = '';
    }
    
    document.getElementById('kyc-selfie-preview').style.display = 'none';
    document.getElementById('kyc-selfie-preview').src = '';
    
    this.kycSelfieBlob = null;
    this.kycSelfieBase64 = null;
    this.stopKycCamera();

    // Populate country selector
    const countries = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
    const select = document.getElementById('kyc-country-select');
    let defaultCountry = "United States";
    
    // Currency-based fallback initialization
    if (this.user && this.user.currency) {
      if (this.user.currency === 'INR') defaultCountry = 'India';
      else if (this.user.currency === 'PKR') defaultCountry = 'Pakistan';
      else if (this.user.currency === 'BDT') defaultCountry = 'Bangladesh';
      else if (this.user.currency === 'NPR') defaultCountry = 'Nepal';
    }

    if (select) {
      select.innerHTML = '';
      countries.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        if (c === defaultCountry) opt.selected = true;
        select.appendChild(opt);
      });
    }

    const customOptionsContainer = document.getElementById('kyc-country-custom-options');
    const customTriggerText = document.getElementById('kyc-country-trigger-text');

    if (customOptionsContainer) {
      customOptionsContainer.innerHTML = '';
      countries.forEach(c => {
        const optDiv = document.createElement('div');
        optDiv.className = 'custom-select-option' + (c === defaultCountry ? ' selected' : '');
        optDiv.innerHTML = `<span class="option-bullet"></span><span>${c}</span>`;
        optDiv.onclick = () => {
          this.selectKycCountry(c);
        };
        customOptionsContainer.appendChild(optDiv);
      });
    }

    if (customTriggerText) {
      customTriggerText.textContent = defaultCountry;
    }

    // IP-based GeoIP lookup with currency-based fallback
    const detectMsg = document.getElementById('kyc-country-detect-msg');
    if (detectMsg) {
      detectMsg.innerHTML = `<svg viewBox="0 0 24 24" class="kyc-svg-icon" style="width:12px; height:12px; flex-shrink:0; color:rgba(255,255,255,0.4);"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> <span>Detecting your location automatically...</span>`;
      detectMsg.style.color = 'rgba(255,255,255,0.4)';
    }

    // Trigger async fetch for country detection
    (async () => {
      try {
        const response = await Promise.race([
          fetch('https://ipapi.co/json/').then(r => {
            if (!r.ok) throw new Error('Network error');
            return r.json();
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
        ]);
        if (response && response.country_name) {
          const detected = response.country_name;
          if (select) {
            let found = false;
            for (let i = 0; i < select.options.length; i++) {
              if (select.options[i].value.toLowerCase() === detected.toLowerCase()) {
                this.selectKycCountry(select.options[i].value);
                found = true;
                break;
              }
            }
            if (found && detectMsg) {
              detectMsg.innerHTML = `<svg viewBox="0 0 24 24" class="kyc-svg-icon" style="width:12px; height:12px; flex-shrink:0; color:#10b981;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> <span>Location detected: <strong>${select.value}</strong></span>`;
              detectMsg.style.color = '#10b981';
              return;
            }
          }
        }
        throw new Error('Could not parse country');
      } catch (err) {
        console.warn('IP country detection failed, keeping fallback default:', err);
        if (detectMsg) {
          detectMsg.innerHTML = `<svg viewBox="0 0 24 24" class="kyc-svg-icon" style="width:12px; height:12px; flex-shrink:0; color:rgba(255,255,255,0.4);"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> <span>Could not detect location. Using default: <strong>${defaultCountry}</strong></span>`;
          detectMsg.style.color = 'rgba(255,255,255,0.4)';
        }
      }
    })();

    this.kycGoToStep(1);
    modal.style.display = 'flex';
  },

  closeKycWizard() {
    const modal = document.getElementById('kyc-wizard-modal');
    if (modal) modal.style.display = 'none';
    this.stopKycCamera();
  },

  showKycForm() {
    const statusContainer = document.getElementById('kyc-status-container');
    const stepsIndicator = document.getElementById('kyc-steps-indicator');
    const formBody = document.getElementById('kyc-form-body');

    if (statusContainer) statusContainer.style.display = 'none';
    if (stepsIndicator) stepsIndicator.style.display = 'flex';
    if (formBody) formBody.style.display = 'block';
  },

  kycGoToStep(step) {
    // Find current active step
    let currentStep = 1;
    for (let s = 1; s <= 3; s++) {
      const dot = document.getElementById(`kyc-step-dot-${s}`);
      if (dot && dot.classList.contains('active')) {
        currentStep = s;
      }
    }

    // Only validate when navigating forwards
    if (step > currentStep) {
      if (currentStep === 1) {
        const address1El = document.getElementById('kyc-address-line1');
        const cityEl = document.getElementById('kyc-city');
        const postalEl = document.getElementById('kyc-postal');

        const address1 = address1El?.value.trim();
        const city = cityEl?.value.trim();
        const postal = postalEl?.value.trim();

        let hasError = false;

        if (!address1) {
          address1El?.classList.add('kyc-input-error');
          const err = document.getElementById('kyc-error-address-line1');
          if (err) err.style.display = 'block';
          hasError = true;
        }
        if (!city) {
          cityEl?.classList.add('kyc-input-error');
          const err = document.getElementById('kyc-error-city');
          if (err) err.style.display = 'block';
          hasError = true;
        }
        if (!postal) {
          postalEl?.classList.add('kyc-input-error');
          const err = document.getElementById('kyc-error-postal');
          if (err) err.style.display = 'block';
          hasError = true;
        }

        if (hasError) {
          this.showToast('Please fill out all required personal details (Address Line 1, City, and Postal Code) before continuing.', 'error');
          return;
        }
      }
      if (currentStep === 2) {
        const docFront = document.getElementById('kyc-doc-front')?.files?.[0];
        const docBack = document.getElementById('kyc-doc-back')?.files?.[0];

        let hasError = false;

        if (!docFront) {
          const zone = document.getElementById('kyc-front-zone');
          zone?.classList.add('kyc-input-error');
          const err = document.getElementById('kyc-error-front');
          if (err) err.style.display = 'block';
          hasError = true;
        }
        if (!docBack) {
          const zone = document.getElementById('kyc-back-zone');
          zone?.classList.add('kyc-input-error');
          const err = document.getElementById('kyc-error-back');
          if (err) err.style.display = 'block';
          hasError = true;
        }

        if (hasError) {
          this.showToast('Please upload both the front and back sides of your identity document before continuing.', 'error');
          return;
        }
      }
    }

    document.querySelectorAll('.kyc-step').forEach(el => el.style.display = 'none');
    
    // Update step indicator styling using CSS classes
    for (let s = 1; s <= 3; s++) {
      const dot   = document.getElementById(`kyc-step-dot-${s}`);
      const label = document.getElementById(`kyc-step-label-${s}`);
      if (dot && label) {
        if (step >= s) {
          dot.classList.add('active');
          label.classList.add('active');
        } else {
          dot.classList.remove('active');
          label.classList.remove('active');
        }
      }
    }

    const line1 = document.getElementById('kyc-progress-line-1');
    if (line1) line1.classList.toggle('active', step >= 2);

    const line2 = document.getElementById('kyc-progress-line-2');
    if (line2) line2.classList.toggle('active', step >= 3);

    const stepEl = document.getElementById(`kyc-step-${step}`);
    if (stepEl) stepEl.style.display = 'block';

    if (step === 3) {
      this.startKycCamera();
    } else {
      this.stopKycCamera();
    }
  },

  handleKycPreview(input, imgId) {
    if (input.files && input.files[0]) {
      const file = input.files[0];
      const preview = document.getElementById(imgId);
      const labelId = imgId === 'kyc-preview-front' ? 'kyc-label-front' : 'kyc-label-back';
      const label = document.getElementById(labelId);
      
      // Clear error UI for this zone
      const zoneId = imgId === 'kyc-preview-front' ? 'kyc-front-zone' : 'kyc-back-zone';
      const zone = document.getElementById(zoneId);
      if (zone) zone.classList.remove('kyc-input-error');
      const errId = imgId === 'kyc-preview-front' ? 'kyc-error-front' : 'kyc-error-back';
      const errEl = document.getElementById(errId);
      if (errEl) errEl.style.display = 'none';

      if (label) {
        label.textContent = file.name;
        label.style.display = 'block';
      }

      const placeholderId = imgId === 'kyc-preview-front' ? 'kyc-front-placeholder' : 'kyc-back-placeholder';
      const placeholder = document.getElementById(placeholderId);
      if (placeholder) placeholder.style.display = 'none';

      const reader = new FileReader();
      reader.onload = (e) => {
        if (preview) {
          preview.src = e.target.result;
          preview.style.display = 'inline-block';
        }
      };
      reader.readAsDataURL(file);
    }
  },

  async startKycCamera() {
    const video = document.getElementById('kyc-video');
    const errEl = document.getElementById('kyc-camera-error');
    if (!video) return;

    video.style.display = 'block';
    document.getElementById('kyc-canvas').style.display = 'none';
    document.getElementById('kyc-selfie-preview').style.display = 'none';
    document.getElementById('kyc-snap-btn').style.display = 'block';
    document.getElementById('kyc-retake-btn').style.display = 'none';

    try {
      this.kycStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, 
        audio: false 
      });
      video.srcObject = this.kycStream;
      if (errEl) errEl.style.display = 'none';
    } catch (err) {
      console.warn('Camera stream error:', err);
      video.style.display = 'none';
      if (errEl) errEl.style.display = 'block';
      document.getElementById('kyc-snap-btn').style.display = 'none';
    }
  },

  stopKycCamera() {
    const video = document.getElementById('kyc-video');
    if (video) video.srcObject = null;
    if (this.kycStream) {
      this.kycStream.getTracks().forEach(track => track.stop());
      this.kycStream = null;
    }
  },

  kycSnapSelfie() {
    const video = document.getElementById('kyc-video');
    const canvas = document.getElementById('kyc-canvas');
    const preview = document.getElementById('kyc-selfie-preview');
    if (!video || !canvas || !preview) return;

    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    
    // Draw flipped frame for natural mirrored selfie
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset

    const dataUrl = canvas.toDataURL('image/png');
    this.kycSelfieBase64 = dataUrl;
    this.kycSelfieBlob = null; // Clear manual fallback

    // Clear selfie error UI
    const selfieContainer = document.getElementById('kyc-camera-container');
    if (selfieContainer) selfieContainer.classList.remove('kyc-input-error');
    const selfieErr = document.getElementById('kyc-error-selfie');
    if (selfieErr) selfieErr.style.display = 'none';

    preview.src = dataUrl;
    preview.style.display = 'block';
    video.style.display = 'none';
    
    document.getElementById('kyc-snap-btn').style.display = 'none';
    document.getElementById('kyc-retake-btn').style.display = 'block';
    
    this.stopKycCamera();
  },

  kycRetakeSelfie() {
    const preview = document.getElementById('kyc-selfie-preview');
    if (preview) {
      preview.style.display = 'none';
      preview.src = '';
    }
    this.kycSelfieBase64 = null;
    this.startKycCamera();
  },

  handleSelfieUploadFallback(input) {
    if (input.files && input.files[0]) {
      const file = input.files[0];
      this.kycSelfieBlob = file;
      this.kycSelfieBase64 = null; // Clear camera snap
      
      // Clear selfie error UI
      const selfieContainer = document.getElementById('kyc-camera-container');
      if (selfieContainer) selfieContainer.classList.remove('kyc-input-error');
      const selfieErr = document.getElementById('kyc-error-selfie');
      if (selfieErr) selfieErr.style.display = 'none';

      const preview = document.getElementById('kyc-selfie-preview');
      const video = document.getElementById('kyc-video');
      
      this.stopKycCamera();
      if (video) video.style.display = 'none';
      document.getElementById('kyc-canvas').style.display = 'none';
      
      const reader = new FileReader();
      reader.onload = (e) => {
        if (preview) {
          preview.src = e.target.result;
          preview.style.display = 'block';
        }
      };
      reader.readAsDataURL(file);
      
      document.getElementById('kyc-snap-btn').style.display = 'none';
      document.getElementById('kyc-retake-btn').style.display = 'none';
      document.getElementById('kyc-label-selfie').textContent = file.name;
    }
  },

  async submitKyc() {
    const country = document.getElementById('kyc-country-select').value;
    
    // Combine structured address fields
    const line1 = document.getElementById('kyc-address-line1').value.trim();
    const line2 = document.getElementById('kyc-address-line2').value.trim();
    const city = document.getElementById('kyc-city').value.trim();
    const state = document.getElementById('kyc-state').value.trim();
    const postal = document.getElementById('kyc-postal').value.trim();

    if (!line1 || !city || !postal) {
      if (!line1) {
        document.getElementById('kyc-address-line1')?.classList.add('kyc-input-error');
        const err = document.getElementById('kyc-error-address-line1');
        if (err) err.style.display = 'block';
      }
      if (!city) {
        document.getElementById('kyc-city')?.classList.add('kyc-input-error');
        const err = document.getElementById('kyc-error-city');
        if (err) err.style.display = 'block';
      }
      if (!postal) {
        document.getElementById('kyc-postal')?.classList.add('kyc-input-error');
        const err = document.getElementById('kyc-error-postal');
        if (err) err.style.display = 'block';
      }
      this.showToast('Please fill out all required address fields (Address Line 1, City, and Postal Code).', 'error');
      return;
    }

    const address = `${line1}${line2 ? '\n' + line2 : ''}\n${city}${state ? ', ' + state : ''}\n${postal}`;
    document.getElementById('kyc-address-input').value = address;

    const docFront = document.getElementById('kyc-doc-front').files[0];
    const docBack = document.getElementById('kyc-doc-back').files[0];

    if (!country || !address) {
      this.showToast('Please enter your country and residential address.', 'error');
      return;
    }
    if (!docFront || !docBack) {
      if (!docFront) {
        const zone = document.getElementById('kyc-front-zone');
        zone?.classList.add('kyc-input-error');
        const err = document.getElementById('kyc-error-front');
        if (err) err.style.display = 'block';
      }
      if (!docBack) {
        const zone = document.getElementById('kyc-back-zone');
        zone?.classList.add('kyc-input-error');
        const err = document.getElementById('kyc-error-back');
        if (err) err.style.display = 'block';
      }
      this.showToast('Please upload front and back document files.', 'error');
      return;
    }
    if (!this.kycSelfieBase64 && !this.kycSelfieBlob) {
      const selfieContainer = document.getElementById('kyc-camera-container');
      if (selfieContainer) selfieContainer.classList.add('kyc-input-error');
      const selfieErr = document.getElementById('kyc-error-selfie');
      if (selfieErr) selfieErr.style.display = 'block';
      this.showToast('Please capture or upload a selfie photo.', 'error');
      return;
    }

    const submitBtn = document.getElementById('kyc-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    const formData = new FormData();
    formData.append('country', country);
    formData.append('address', address);
    formData.append('document_front', docFront);
    formData.append('document_back', docBack);

    if (this.kycSelfieBlob) {
      formData.append('selfie', this.kycSelfieBlob);
    } else if (this.kycSelfieBase64) {
      formData.append('selfie_base64', this.kycSelfieBase64);
    }

    try {
      const res = await fetch('/api/client/kyc/submit', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Verification submitted successfully!', 'success');
        this.closeKycWizard();
        if (this.user) {
          this.user.kyc_status = 'pending';
        }
        await this.loadDashboardData();
        this.navigateTo('profile');
      } else {
        this.showToast(data.error || 'Failed to submit verification.', 'error');
      }
    } catch (err) {
      console.error(err);
      this.showToast('Network error.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Verification';
      }
    }
  },

  async submitClaimCardForm(event) {
    event.preventDefault();
    const firstName = document.getElementById('visa-first-name').value.trim();
    const lastName = document.getElementById('visa-last-name').value.trim();
    const nickname = document.getElementById('visa-nickname').value.trim();
    
    const addr1 = (document.getElementById('visa-address-1')?.value || '').trim();
    const addr2 = (document.getElementById('visa-address-2')?.value || '').trim();
    const city = (document.getElementById('visa-city')?.value || '').trim();
    const state = (document.getElementById('visa-state')?.value || '').trim();
    const zip = (document.getElementById('visa-zip')?.value || '').trim();
    const country = (document.getElementById('visa-country')?.value || '').trim();

    const fileInput = document.getElementById('visa-bank-statement');
    const statementFile = fileInput ? fileInput.files[0] : null;

    if (!firstName || !lastName || !nickname || !addr1 || !city || !state || !zip || !country || !statementFile) {
      this.showToast('All form fields and a bank statement file are required.', 'error');
      return;
    }

    const parts = [addr1];
    if (addr2) parts.push(addr2);
    parts.push(city, state, zip, country);
    const address = parts.join(', ');

    const submitBtn = document.getElementById('visa-claim-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing Payment...';
    }

    const formData = new FormData();
    formData.append('first_name', firstName);
    formData.append('last_name', lastName);
    formData.append('nickname', nickname);
    formData.append('address', address);
    formData.append('bank_statement', statementFile);

    try {
      const res = await fetch('/api/client/visa-card/claim', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(data.message || 'Visa Card claimed successfully!', 'success');
        document.getElementById('visa-claim-form').reset();
        
        // Reset file name display and preview
        const fileNameSpan = document.getElementById('visa-file-name');
        if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';
        const previewEl = document.getElementById('claim-card-address-preview');
        if (previewEl) {
          previewEl.textContent = 'Hong Kong to Global';
          previewEl.title = 'Hong Kong to Global';
        }

        await this.loadDashboardData();
        this.navigateTo('dashboard');
      } else {
        this.showToast(data.error || 'Failed to claim Visa Card.', 'error');
      }
    } catch (err) {
      console.error('Error claiming visa card:', err);
      this.showToast('Network error while claiming card.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Pay $34.00 & Claim Card';
      }
    }
  },

  updateAddressPreview() {
    const addr1 = (document.getElementById('visa-address-1')?.value || '').trim();
    const addr2 = (document.getElementById('visa-address-2')?.value || '').trim();
    const city = (document.getElementById('visa-city')?.value || '').trim();
    const state = (document.getElementById('visa-state')?.value || '').trim();
    const zip = (document.getElementById('visa-zip')?.value || '').trim();
    const country = (document.getElementById('visa-country')?.value || '').trim();

    const parts = [];
    if (addr1) parts.push(addr1);
    if (addr2) parts.push(addr2);
    if (city) parts.push(city);
    if (state) parts.push(state);
    if (zip) parts.push(zip);
    if (country) parts.push(country);

    const addressStr = parts.join(', ');
    const previewEl = document.getElementById('claim-card-address-preview');
    if (previewEl) {
      if (addressStr) {
        previewEl.textContent = addressStr;
        previewEl.title = addressStr;
      } else {
        previewEl.textContent = 'Hong Kong to Global';
        previewEl.title = 'Hong Kong to Global';
      }
    }
  },

  handleVisaFileChange(input) {
    const fileNameSpan = document.getElementById('visa-file-name');
    if (fileNameSpan) {
      if (input.files && input.files.length > 0) {
        fileNameSpan.textContent = input.files[0].name;
      } else {
        fileNameSpan.textContent = 'No file chosen';
      }
    }
  },

  activateVisaCard() {
    this.navigateTo('claim-card');
    setTimeout(() => {
      this.showActivateCardModal();
    }, 200);
  },

  async loadClaimCardPageData() {
    const claimFormView = document.getElementById('visa-card-claim-form-view');
    const activeView = document.getElementById('visa-card-active-view');
    const loadingView = document.getElementById('visa-card-loading-view');

    if (loadingView) loadingView.style.display = 'flex';
    if (claimFormView) claimFormView.style.display = 'none';
    if (activeView) activeView.style.display = 'none';

    if (!claimFormView || !activeView) return;

    try {
      // Fetch wallet balance and visa card concurrently
      const [walletRes, visaRes] = await Promise.all([
        fetch('/api/client/wallet'),
        fetch('/api/client/visa-card')
      ]);

      let balance = 0.00;
      let currency = 'USD';
      if (walletRes.ok) {
        const walletData = await walletRes.json();
        balance = walletData.balance || 0.00;
        currency = walletData.currency || 'USD';
        this.user.balance = balance;
        this.updateBalanceDisplays();
      }

      // Populate user balance display on active card page
      const balDisplay = document.getElementById('active-card-user-balance');
      if (balDisplay) {
        const currencySymbols = {
          'USD': '$',
          'EUR': '€',
          'GBP': '£',
          'INR': '₹',
          'PKR': 'Rs',
          'BDT': '৳',
          'NPR': 'Rs',
          'JPY': '¥',
          'CAD': 'CA$',
          'AUD': 'A$',
          'CNY': '¥'
        };
        const symbol = currencySymbols[currency] || (currencySymbols[currency.toUpperCase()] || '$');
        balDisplay.textContent = `${symbol}${parseFloat(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
      }

      if (visaRes.ok) {
        const visaData = await visaRes.json();
        const card = visaData.visaCard;

        if (loadingView) loadingView.style.display = 'none';

        if (!card) {
          // User doesn't have a card yet, show claim form
          claimFormView.style.display = 'block';
          activeView.style.display = 'none';
        } else {
          // User has a card, show active card page details
          claimFormView.style.display = 'none';
          activeView.style.display = 'block';

          // 1. Populate card mockup details
          const numDisplay = document.getElementById('active-card-num-display');
          const expDisplay = document.getElementById('active-card-exp-display');
          const holderDisplay = document.getElementById('active-card-holder-display');

          if (numDisplay) {
            const cleaned = (card.card_number || '').replace(/\D/g, '');
            const last4 = cleaned ? cleaned.slice(-4) : String(card.user_id || 0).padStart(4, '0').slice(-4);
            numDisplay.textContent = `•••• •••• •••• ${last4}`;
          }

          if (expDisplay) {
            if (card.card_expiry) {
              expDisplay.textContent = card.card_expiry;
            } else {
              const date = card.created_at ? new Date(card.created_at) : new Date();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const year = String(date.getFullYear() + 5).slice(-2);
              expDisplay.textContent = `${month}/${year}`;
            }
          }

          if (holderDisplay) {
            holderDisplay.textContent = card.nickname ? card.nickname.toUpperCase() : `${card.first_name} ${card.last_name}`.toUpperCase();
          }

          // Update claim-card page status label
          const activeStatusLabel = document.getElementById('active-visa-card-status-label');
          if (activeStatusLabel) {
            if (card.status === 'active') {
              activeStatusLabel.className = 'visa-card-status-label active';
              activeStatusLabel.innerHTML = '<span class="status-dot"></span>Active';
            } else {
              activeStatusLabel.className = 'visa-card-status-label inactive';
              activeStatusLabel.innerHTML = '<span class="status-dot"></span>Non-Active';
            }
          }

          // 2. Setup progress tracker steps
          const currentStatus = card.status || 'pending'; // 'pending' maps to 'preparing' step

          // Reset tracker classes
          document.querySelectorAll('.visa-tracker-step').forEach(el => {
            el.classList.remove('completed', 'active', 'pulsate');
          });

          const progressBar = document.getElementById('visa-tracker-progress-bar');
          let progressPercent = 0;

          const stepPreparing = document.getElementById('step-preparing');
          const stepShipping = document.getElementById('step-shipping');
          const stepDelivered = document.getElementById('step-delivered');

          if (currentStatus === 'pending' || currentStatus === 'preparing') {
            if (stepPreparing) stepPreparing.classList.add('active', 'pulsate');
            progressPercent = 0;
          } else if (currentStatus === 'shipping') {
            if (stepPreparing) stepPreparing.classList.add('completed');
            if (stepShipping) stepShipping.classList.add('active', 'pulsate');
            progressPercent = 50;
          } else if (currentStatus === 'delivered') {
            if (stepPreparing) stepPreparing.classList.add('completed');
            if (stepShipping) stepShipping.classList.add('completed');
            if (stepDelivered) stepDelivered.classList.add('active', 'pulsate');
            progressPercent = 100;
          } else if (currentStatus === 'active') {
            if (stepPreparing) stepPreparing.classList.add('completed');
            if (stepShipping) stepShipping.classList.add('completed');
            if (stepDelivered) stepDelivered.classList.add('completed');
            progressPercent = 100;
          }

          if (progressBar) {
            progressBar.style.width = `${progressPercent}%`;
          }

          // Description text
          const statusDesc = document.getElementById('visa-tracker-status-desc');
          if (statusDesc) {
            if (currentStatus === 'pending' || currentStatus === 'preparing') {
              statusDesc.textContent = 'Preparing & Packaging: Your premium physical card is being packaged and prepared for shipping in our Hong Kong center.';
            } else if (currentStatus === 'shipping') {
              statusDesc.textContent = 'Shipping: Your physical card has been shipped from Hong Kong and is in transit to your delivery address (estimated 1-2 months).';
            } else if (currentStatus === 'delivered') {
              statusDesc.textContent = 'Delivered: Your card has arrived! Please check your package, locate the activation code, and activate the card below to claim your $25.00 bonus.';
            } else if (currentStatus === 'active') {
              statusDesc.textContent = 'Card Active: Your Premium Visa Debit Card is fully activated. Enjoy global spendings, offline merchant payments, and ATM withdrawals.';
            }
          }

          // 3. Card Options (Freeze, Unblock, Limits) and Activation Button States
          const overlay = document.getElementById('active-card-options-overlay');
          const blockInput = document.getElementById('setting-block-card');
          const unblockInput = document.getElementById('setting-unblock-card');
          const limitSlider = document.getElementById('setting-limit-slider');
          const limitLabel = document.getElementById('setting-limit-label');
          const btnContainer = document.getElementById('active-card-btn-container');

          // Initialize states based on database values
          if (blockInput && unblockInput) {
            const isBlocked = !!card.is_blocked;
            blockInput.checked = isBlocked;
            unblockInput.checked = !isBlocked;
          }

          if (limitSlider && card.daily_limit !== undefined && card.daily_limit !== null) {
            limitSlider.value = card.daily_limit;
          }

          if (limitSlider && limitLabel) {
            const currencySymbols = {
              'USD': '$',
              'EUR': '€',
              'GBP': '£',
              'INR': '₹',
              'PKR': 'Rs',
              'BDT': '৳',
              'NPR': 'Rs',
              'JPY': '¥',
              'CAD': 'CA$',
              'AUD': 'A$',
              'CNY': '¥'
            };
            const symbol = currencySymbols[currency] || (currencySymbols[currency.toUpperCase()] || '$');
            
            const updateLimitLabel = (val) => {
              limitLabel.textContent = `${symbol}${parseInt(val).toLocaleString()}`;
            };
            
            updateLimitLabel(limitSlider.value);
            limitSlider.oninput = (e) => updateLimitLabel(e.target.value);

            // API update helper
            const saveCardSettings = async (settings) => {
              try {
                const res = await fetch('/api/client/visa-card/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(settings)
                });
                if (!res.ok) {
                  this.showToast('Failed to update card settings.', 'error');
                }
              } catch (err) {
                console.error('Error updating card settings:', err);
                this.showToast('Network error updating card settings.', 'error');
              }
            };

            // Bind block input listener
            if (blockInput) {
              blockInput.onchange = (e) => {
                const checked = e.target.checked;
                if (unblockInput) unblockInput.checked = !checked;
                saveCardSettings({ is_blocked: checked });
                if (checked) {
                  this.showToast('Your premium card has been blocked/frozen.', 'warning');
                  this.saveNotificationToHistory('info', 'Your premium Visa Debit Card has been temporarily frozen/blocked.');
                } else {
                  this.showToast('Your premium card has been unblocked.', 'success');
                  this.saveNotificationToHistory('success', 'Your premium Visa Debit Card has been successfully unblocked.');
                }
              };
            }

            // Bind unblock input listener
            if (unblockInput) {
              unblockInput.onchange = (e) => {
                const checked = e.target.checked;
                if (blockInput) blockInput.checked = !checked;
                saveCardSettings({ is_blocked: !checked });
                if (checked) {
                  this.showToast('Your premium card has been unblocked.', 'success');
                  this.saveNotificationToHistory('success', 'Your premium Visa Debit Card has been successfully unblocked.');
                } else {
                  this.showToast('Your premium card has been blocked/frozen.', 'warning');
                  this.saveNotificationToHistory('info', 'Your premium Visa Debit Card has been temporarily frozen/blocked.');
                }
              };
            }

            // Bind limit slider change listener
            limitSlider.onchange = (e) => {
              const val = parseInt(e.target.value);
              saveCardSettings({ daily_limit: val });
              this.showToast('Daily usage limit updated.', 'success');
              this.saveNotificationToHistory('info', `Your daily usage limit was changed to ${symbol}${val.toLocaleString()}.`);
            };
          }


          if (currentStatus === 'active') {
            // Card is active: hide activation button, hide overlay, enable inputs
            if (overlay) overlay.style.opacity = '0';
            setTimeout(() => { if (overlay && card.status === 'active') overlay.style.display = 'none'; }, 300);
            if (blockInput) blockInput.disabled = false;
            if (unblockInput) unblockInput.disabled = false;
            if (limitSlider) limitSlider.disabled = false;
            if (btnContainer) btnContainer.style.display = 'none';
          } else {
            // Card is not active: show activation button, show overlay, disable inputs
            if (overlay) {
              overlay.style.display = 'flex';
              overlay.style.opacity = '1';
            }
            if (blockInput) blockInput.disabled = true;
            if (unblockInput) unblockInput.disabled = true;
            if (limitSlider) limitSlider.disabled = true;
            if (btnContainer) {
              btnContainer.style.display = 'block';
            }
          }
        }
      } else {
        // API failed, hide spinner and show claim form as fallback
        if (loadingView) loadingView.style.display = 'none';
        claimFormView.style.display = 'block';
        activeView.style.display = 'none';
      }
    } catch (err) {
      if (loadingView) loadingView.style.display = 'none';
      if (claimFormView) claimFormView.style.display = 'block';
      console.error('Error loading Visa card page data:', err);
      this.showToast('Failed to load card page data.', 'error');
    }
  },

  showActivateCardModal() {
    const modal = document.getElementById('visa-activation-modal');
    if (modal) {
      const codeInput = document.getElementById('visa-activation-code-input');
      if (codeInput) codeInput.value = '';
      modal.style.display = 'flex';
    }
  },

  closeActivateCardModal() {
    const modal = document.getElementById('visa-activation-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  async submitVisaCardActivation(event) {
    event.preventDefault();
    const codeInput = document.getElementById('visa-activation-code-input');
    if (!codeInput) return;
    const code = codeInput.value.trim();

    if (!code || code.length !== 6) {
      this.showToast('Please enter a valid 6-digit activation code.', 'error');
      return;
    }

    const submitBtn = event.submitter || event.target.querySelector('button[type="submit"]');
    const origText = submitBtn ? submitBtn.textContent : 'Activate Now';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Activating...';
    }

    try {
      const res = await fetch('/api/client/visa-card/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(data.message || 'Visa Card activated successfully! $25 loaded to your account.', 'success');
        this.closeActivateCardModal();
        await this.loadClaimCardPageData();
        await this.loadDashboardData();
      } else {
        this.showToast(data.error || 'Failed to activate Visa Card. Please check your code.', 'error');
      }
    } catch (err) {
      console.error('Error activating Visa card:', err);
      this.showToast('Network error during activation.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = origText;
      }
    }
  },

  // ─── Google Login ──────────────────────────────────────────────────────
  async initializeGoogleSignIn() {
    if (typeof google === 'undefined') {
      setTimeout(() => this.initializeGoogleSignIn(), 500);
      return;
    }

    try {
      const configRes = await fetch('/api/auth/google/client-id');
      const configData = await configRes.json();
      const client_id = configData.client_id;

      google.accounts.id.initialize({
        client_id: client_id,
        callback: (response) => this.handleGoogleCredentialResponse(response)
      });

      const btnLogin = document.getElementById('google-signin-btn-login');
      if (btnLogin) {
        google.accounts.id.renderButton(btnLogin, {
          theme: 'outline',
          size: 'large',
          width: btnLogin.offsetWidth || 280,
          text: 'signin_with',
          logo_alignment: 'left'
        });
      }

      const btnSignup = document.getElementById('google-signin-btn-signup');
      if (btnSignup) {
        google.accounts.id.renderButton(btnSignup, {
          theme: 'outline',
          size: 'large',
          width: btnSignup.offsetWidth || 280,
          text: 'signup_with',
          logo_alignment: 'left'
        });
      }
    } catch (err) {
      console.warn('Google Sign-In initialization failed:', err);
    }
  },

  async handleGoogleCredentialResponse(response) {
    this.showToast('Signing in with Google...', 'info');
    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential })
      });
      const data = await res.json();
      if (!res.ok) {
        this.showToast(data.error || 'Google sign-in failed.', 'error');
        return;
      }

      if (data.is_new_user) {
        this.tempGoogleCredential = response.credential;
        this.showGoogleCompletionModal(data.default_username);
        return;
      }

      localStorage.setItem('token', data.token);
      this.user = data.user;
      if (window.OneSignalWrapper) {
        window.OneSignalWrapper.login(data.user.id);
      }
      if (data.permissions) this.permissions = data.permissions;
      
      this.showToast('Logged in successfully via Google!', 'success');
      
      this.loadNotificationsFromStorage();
      this.setupHeaderAndNav();
      await this.navigateTo('dashboard', { replaceState: true });
    } catch (err) {
      console.error('Google Sign-In callback error:', err);
      this.showToast('Network error during Google Sign-In.', 'error');
    }
  },

  showGoogleCompletionModal(defaultUsername) {
    const modal = document.getElementById('google-completion-modal');
    if (!modal) return;
    
    const usernameInput = document.getElementById('google-complete-username');
    if (usernameInput) {
      usernameInput.value = defaultUsername || '';
    }
    
    const phoneInput = document.getElementById('google-complete-phone');
    if (phoneInput) {
      phoneInput.value = '';
    }
    
    const inviteInput = document.getElementById('google-complete-invite');
    if (inviteInput) {
      const urlParams = new URLSearchParams(window.location.search);
      const urlInvite = urlParams.get('invite') || urlParams.get('ref');
      const normalInvite = document.getElementById('signup-invite');
      
      if (urlInvite) {
        inviteInput.value = urlInvite.toUpperCase();
      } else if (normalInvite && normalInvite.value) {
        inviteInput.value = normalInvite.value.toUpperCase();
      } else {
        inviteInput.value = '';
      }
    }
    
    modal.style.display = 'flex';
  },

  closeGoogleCompletionModal() {
    const modal = document.getElementById('google-completion-modal');
    if (modal) modal.style.display = 'none';
  },

  async submitGoogleCompletion(event) {
    event.preventDefault();
    
    const credential = this.tempGoogleCredential;
    const username = document.getElementById('google-complete-username').value.trim();
    const phone_number = document.getElementById('google-complete-phone').value.trim();
    const invite_code = document.getElementById('google-complete-invite').value.trim();
    
    if (!credential) {
      this.showToast('Authentication credentials missing. Please sign in with Google again.', 'error');
      this.closeGoogleCompletionModal();
      return;
    }
    
    if (!username || !phone_number) {
      this.showToast('Please fill in both the username and phone number.', 'error');
      return;
    }
    
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const origText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Completing registration...';
    
    try {
      const res = await fetch('/api/auth/google/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, username, phone_number, invite_code })
      });
      
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Failed to parse response JSON:', text);
        this.showToast('Server response error (not JSON). Status: ' + res.status, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = origText;
        return;
      }

      if (!res.ok) {
        this.showToast(data.error || 'Failed to complete registration.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = origText;
        return;
      }
      
      localStorage.setItem('token', data.token);
      this.user = data.user;
      if (window.OneSignalWrapper) {
        window.OneSignalWrapper.login(data.user.id);
      }
      if (data.permissions) this.permissions = data.permissions;
      
      this.showToast('Registered and logged in successfully via Google!', 'success');
      this.closeGoogleCompletionModal();
      
      this.loadNotificationsFromStorage();
      this.setupHeaderAndNav();
      await this.navigateTo('dashboard', { replaceState: true });
      
    } catch (err) {
      console.error('Google completion submit error:', err);
      this.showToast('Error: ' + err.message, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
    }
  },

  loginWithGoogle() {
    this.initializeGoogleSignIn();
  },

  // ─── Referral Link Copy ────────────────────────────────────────────────
  copyReferralLink() {
    const code = (this.user && this.user.invite_code) ? this.user.invite_code : '';
    if (!code) {
      this.showToast('Invite code not available.', 'error');
      return;
    }
    const link = `${window.location.origin}/?invite=${code}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => {
        this.showToast('Invite link copied to clipboard! 🎉', 'success');
      }).catch(() => {
        this._fallbackCopy(link);
      });
    } else {
      this._fallbackCopy(link);
    }
  },

  copyInviteCode(code) {
    if (!code) {
      this.showToast('Invite code not available.', 'error');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => {
        this.showToast('Invite code copied! 🎉', 'success');
      }).catch(() => {
        this._fallbackCopy(code);
      });
    } else {
      this._fallbackCopy(code);
    }
  },

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      this.showToast('Invite link copied! 🎉', 'success');
    } catch (e) {
      this.showToast('Could not copy. Please copy manually: ' + text, 'info');
    }
    document.body.removeChild(ta);
  },

  // ─── Phone Edit Modal ──────────────────────────────────────────────────
  openPhoneEditModal() {
    const modal = document.getElementById('phone-edit-modal');
    if (!modal) return;
    const input = document.getElementById('phone-edit-input');
    if (input && this.user) input.value = this.user.phone_number || '';
    const err = document.getElementById('phone-edit-error');
    if (err) { err.style.display = 'none'; err.textContent = ''; }
    modal.style.display = 'flex';
  },

  closePhoneEditModal() {
    const modal = document.getElementById('phone-edit-modal');
    if (modal) modal.style.display = 'none';
  },

  async savePhoneNumber() {
    const input = document.getElementById('phone-edit-input');
    const errBox = document.getElementById('phone-edit-error');
    const btn = document.getElementById('phone-save-btn');
    const phone = (input ? input.value.trim() : '');

    if (!phone) {
      if (errBox) { errBox.textContent = 'Please enter a phone number.'; errBox.style.display = 'block'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      const res = await fetch('/api/profile/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone })
      });
      const data = await res.json();
      if (data.success) {
        if (this.user) this.user.phone_number = phone;
        this.renderProfileUI();
        this.closePhoneEditModal();
        this.showToast('Phone number updated!', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to update.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Please try again.'; errBox.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
  },

  // ─── Edit Profile Redesign Submit ──────────────────────────────────────
  async handleProfileUpdate(event) {
    if (event) event.preventDefault();
    const btn = document.getElementById('profile-save-btn');
    const fullNameVal = document.getElementById('profile-edit-full-name')?.value || '';
    const phoneVal = document.getElementById('profile-edit-phone')?.value || '';
    const emailVal = document.getElementById('profile-edit-email')?.value || '';
    const usernameVal = document.getElementById('profile-edit-username')?.value || '';

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }

    try {
      const res = await fetch('/api/profile/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullNameVal,
          phone_number: phoneVal,
          email: emailVal,
          username: usernameVal
        })
      });
      const data = await res.json();
      if (data.success) {
        this.user = data.user;
        this.renderProfileUI();
        this.showToast('Profile updated successfully! 🎉', 'success');
      } else {
        this.showToast(data.error || 'Failed to update profile.', 'error');
      }
    } catch (e) {
      this.showToast('Network error updating profile.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save Changes';
      }
    }
  },

  async handleDeleteAccountClick() {
    const confirmDelete = confirm(
      "Are you sure you want to delete your account? This action is permanent and cannot be undone."
    );
    if (!confirmDelete) return;

    try {
      const res = await fetch('/api/profile/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        this.showToast('Your account was deleted successfully.', 'success');
        this.handleLogout();
      } else {
        this.showToast(data.error || 'Failed to delete account.', 'error');
      }
    } catch (e) {
      this.showToast('Network error deleting account.', 'error');
    }
  },

  // ─── Email Change 4-Step Modal ─────────────────────────────────────────
  openEmailChangeModal() {
    const modal = document.getElementById('email-change-modal');
    if (!modal) return;
    this._ecGoToStep(1);
    
    const newEmailEl = document.getElementById('ec-new-email');
    if (newEmailEl) newEmailEl.value = '';
    
    document.querySelectorAll('#ec-current-otp-wrap .otp-field, #ec-new-otp-wrap .otp-field').forEach(input => {
      input.value = '';
      input.classList.remove('has-value');
    });
    document.querySelectorAll('#ec-current-otp-wrap, #ec-new-otp-wrap').forEach(el => {
      el.classList.remove('otp-complete');
    });
    
    ['ec-step1-error','ec-step2-error','ec-step3-error','ec-step4-error'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.textContent = ''; }
    });
    
    modal.style.display = 'flex';
    this.setupOtpPaste('ec-current-otp-wrap');
    this.setupOtpPaste('ec-new-otp-wrap');
  },

  closeEmailChangeModal() {
    const modal = document.getElementById('email-change-modal');
    if (modal) modal.style.display = 'none';
  },

  _ecGoToStep(step) {
    [1,2,3,4].forEach(s => {
      const panel = document.getElementById(`ec-step-${s}`);
      if (panel) panel.style.display = s === step ? 'block' : 'none';
    });
    [1,2,3,4].forEach(s => {
      const dot = document.getElementById(`ec-dot-${s}`);
      if (!dot) return;
      if (s < step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = '✓';
      } else if (s === step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = String(s);
      } else {
        dot.style.background = 'var(--border)';
        dot.style.color = 'var(--text-secondary)';
        dot.textContent = String(s);
      }
    });
    [[1,2],[2,3],[3,4]].forEach(([a,b]) => {
      const line = document.getElementById(`ec-line-${a}${b}`);
      if (line) line.style.background = step > a ? 'var(--primary)' : 'var(--border)';
    });
  },

  async ecRequestCurrent() {
    const btn = document.getElementById('ec-btn-send-current');
    const errBox = document.getElementById('ec-step1-error');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    try {
      const res = await fetch('/api/profile/change-email/request-current', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const hint = document.getElementById('ec-step2-hint');
        if (hint && this.user) hint.textContent = `A 6-digit code was sent to ${this.user.email}. Check your inbox.`;
        this._ecGoToStep(2);
        this.showToast('Verification code sent to your current email.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to send code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
    }
  },

  async ecVerifyCurrent() {
    const code = this.getOtpValue('ec-current-otp-wrap');
    const errBox = document.getElementById('ec-step2-error');
    if (!code || code.length < 6) {
      if (errBox) { errBox.textContent = 'Please enter the 6-digit verification code.'; errBox.style.display = 'block'; }
      return;
    }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    try {
      const res = await fetch('/api/profile/change-email/verify-current', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (data.success) {
        this._ecGoToStep(3);
        this.showToast('Current email verified! Now enter your new email.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Invalid or expired code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    }
  },

  async ecRequestNew() {
    const newEmail = (document.getElementById('ec-new-email') || {}).value?.trim();
    const errBox = document.getElementById('ec-step3-error');
    const btn = document.getElementById('ec-btn-send-new');
    if (!newEmail || !newEmail.includes('@')) {
      if (errBox) { errBox.textContent = 'Please enter a valid email address.'; errBox.style.display = 'block'; }
      return;
    }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const res = await fetch('/api/profile/change-email/request-new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_email: newEmail })
      });
      const data = await res.json();
      if (data.success) {
        const hint = document.getElementById('ec-step4-hint');
        if (hint) hint.textContent = `A 6-digit code was sent to ${newEmail}. Check your inbox.`;
        this._ecGoToStep(4);
        this.showToast('Code sent to your new email address.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to send code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Code to New Email'; }
    }
  },

  async ecVerifyNew() {
    const code = this.getOtpValue('ec-new-otp-wrap');
    const errBox = document.getElementById('ec-step4-error');
    if (!code || code.length < 6) {
      if (errBox) { errBox.textContent = 'Please enter the 6-digit verification code.'; errBox.style.display = 'block'; }
      return;
    }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    try {
      const res = await fetch('/api/profile/change-email/verify-new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (data.success) {
        if (data.new_email && this.user) {
          this.user.email = data.new_email;
        }
        this.renderProfileUI();
        this.closeEmailChangeModal();
        this.showToast('Email address updated successfully! ✅', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Invalid or expired code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    }
  },

  // ─── Password Change 3-Step Modal ───
  openPasswordChangeModal() {
    const modal = document.getElementById('password-change-modal');
    if (!modal) return;
    this._pcGoToStep(1);
    
    ['pc-new-password', 'pc-confirm-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    document.querySelectorAll('#pc-otp-wrap .otp-field').forEach(input => {
      input.value = '';
      input.classList.remove('has-value');
    });
    const pcOtpWrap = document.getElementById('pc-otp-wrap');
    if (pcOtpWrap) pcOtpWrap.classList.remove('otp-complete');
    
    ['pc-step1-error','pc-step2-error','pc-step3-error'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.textContent = ''; }
    });
    
    modal.style.display = 'flex';
    this.setupOtpPaste('pc-otp-wrap');
  },

  closePasswordChangeModal() {
    const modal = document.getElementById('password-change-modal');
    if (modal) modal.style.display = 'none';
  },

  _pcGoToStep(step) {
    [1,2,3].forEach(s => {
      const panel = document.getElementById(`pc-step-${s}`);
      if (panel) panel.style.display = s === step ? 'block' : 'none';
    });
    [1,2,3].forEach(s => {
      const dot = document.getElementById(`pc-dot-${s}`);
      if (!dot) return;
      if (s < step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = '✓';
      } else if (s === step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = String(s);
      } else {
        dot.style.background = 'var(--border)';
        dot.style.color = 'var(--text-secondary)';
        dot.textContent = String(s);
      }
    });
    [[1,2],[2,3]].forEach(([a,b]) => {
      const line = document.getElementById(`pc-line-${a}${b}`);
      if (line) line.style.background = step > a ? 'var(--primary)' : 'var(--border)';
    });
  },

  async pcRequestCode() {
    const btn = document.getElementById('pc-btn-send');
    const errBox = document.getElementById('pc-step1-error');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    try {
      const res = await fetch('/api/profile/change-password/request', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const hint = document.getElementById('pc-step2-hint');
        if (hint && this.user) hint.textContent = `A 6-digit verification code was sent to ${this.user.email}. Check your inbox.`;
        this._pcGoToStep(2);
        this.showToast('Verification code sent to your email.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to send code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
    }
  },

  async pcVerifyCode() {
    const code = this.getOtpValue('pc-otp-wrap');
    const errBox = document.getElementById('pc-step2-error');
    if (!code || code.length < 6) {
      if (errBox) { errBox.textContent = 'Please enter the 6-digit verification code.'; errBox.style.display = 'block'; }
      return;
    }
    this._pcVerifiedCode = code;
    this._pcGoToStep(3);
    this.showToast('Verification successful! Set your new password.', 'success');
  },

  async pcSubmitChange() {
    const newPass = (document.getElementById('pc-new-password') || {}).value;
    const confPass = (document.getElementById('pc-confirm-password') || {}).value;
    const errBox = document.getElementById('pc-step3-error');
    if (!newPass || newPass.length < 6) {
      if (errBox) { errBox.textContent = 'Password must be at least 6 characters.'; errBox.style.display = 'block'; }
      return;
    }
    if (newPass !== confPass) {
      if (errBox) { errBox.textContent = 'Passwords do not match.'; errBox.style.display = 'block'; }
      return;
    }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    try {
      const res = await fetch('/api/profile/change-password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this._pcVerifiedCode, new_password: newPass })
      });
      const data = await res.json();
      if (data.success) {
        this.closePasswordChangeModal();
        this.showToast('Password updated successfully! ✅', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to update password.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    }
  },

  // ─── Forgot Password 3-Step Modal ───
  openForgotPasswordModal() {
    const modal = document.getElementById('forgot-password-modal');
    if (!modal) return;
    this._fpGoToStep(1);

    const userEl = document.getElementById('fp-username');
    if (userEl) userEl.value = '';

    ['fp-new-password', 'fp-confirm-password'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    document.querySelectorAll('#fp-otp-wrap .otp-field').forEach(input => {
      input.value = '';
      input.classList.remove('has-value');
    });
    const fpOtpWrap = document.getElementById('fp-otp-wrap');
    if (fpOtpWrap) fpOtpWrap.classList.remove('otp-complete');

    ['fp-step1-error','fp-step2-error','fp-step3-error'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.style.display = 'none'; el.textContent = ''; }
    });

    modal.style.display = 'flex';
    this.setupOtpPaste('fp-otp-wrap');
  },

  closeForgotPasswordModal() {
    const modal = document.getElementById('forgot-password-modal');
    if (modal) modal.style.display = 'none';
  },

  _fpGoToStep(step) {
    [1,2,3].forEach(s => {
      const panel = document.getElementById(`fp-step-${s}`);
      if (panel) panel.style.display = s === step ? 'block' : 'none';
    });
    [1,2,3].forEach(s => {
      const dot = document.getElementById(`fp-dot-${s}`);
      if (!dot) return;
      if (s < step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = '✓';
      } else if (s === step) {
        dot.style.background = 'var(--primary)';
        dot.style.color = '#000';
        dot.textContent = String(s);
      } else {
        dot.style.background = 'var(--border)';
        dot.style.color = 'var(--text-secondary)';
        dot.textContent = String(s);
      }
    });
    [[1,2],[2,3]].forEach(([a,b]) => {
      const line = document.getElementById(`fp-line-${a}${b}`);
      if (line) line.style.background = step > a ? 'var(--primary)' : 'var(--border)';
    });
  },

  async fpRequestCode() {
    const userEl = document.getElementById('fp-username');
    const usernameOrEmail = userEl ? userEl.value.trim() : '';
    const btn = document.getElementById('fp-btn-send');
    const errBox = document.getElementById('fp-step1-error');

    if (!usernameOrEmail) {
      if (errBox) { errBox.textContent = 'Please enter your username or email address.'; errBox.style.display = 'block'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }

    try {
      const res = await fetch('/api/auth/forgot-password/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail })
      });
      const data = await res.json();
      if (data.success) {
        const hint = document.getElementById('fp-step2-hint');
        if (hint) hint.textContent = `A 6-digit verification code was sent to the email associated with ${usernameOrEmail}. Check your inbox.`;
        this._fpUsernameOrEmail = usernameOrEmail;
        this._fpGoToStep(2);
        this.showToast('Verification code sent to your email.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to send code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; }
    }
  },

  async fpVerifyCode() {
    const code = this.getOtpValue('fp-otp-wrap');
    const errBox = document.getElementById('fp-step2-error');
    if (!code || code.length < 6) {
      if (errBox) { errBox.textContent = 'Please enter the 6-digit verification code.'; errBox.style.display = 'block'; }
      return;
    }
    
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }

    try {
      const res = await fetch('/api/auth/forgot-password/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: this._fpUsernameOrEmail, code })
      });
      const data = await res.json();
      if (data.success) {
        this._fpVerifiedCode = code;
        this._fpGoToStep(3);
        this.showToast('Verification successful! Set your new password.', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Invalid or expired code.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    }
  },

  async fpSubmitChange() {
    const newPass = (document.getElementById('fp-new-password') || {}).value;
    const confPass = (document.getElementById('fp-confirm-password') || {}).value;
    const errBox = document.getElementById('fp-step3-error');

    if (!newPass || newPass.length < 6) {
      if (errBox) { errBox.textContent = 'Password must be at least 6 characters.'; errBox.style.display = 'block'; }
      return;
    }
    if (newPass !== confPass) {
      if (errBox) { errBox.textContent = 'Passwords do not match.'; errBox.style.display = 'block'; }
      return;
    }
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }

    try {
      const res = await fetch('/api/auth/forgot-password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usernameOrEmail: this._fpUsernameOrEmail,
          code: this._fpVerifiedCode,
          new_password: newPass
        })
      });
      const data = await res.json();
      if (data.success) {
        this.closeForgotPasswordModal();
        this.showToast('Password reset successfully! You can now log in. ✅', 'success');
      } else {
        if (errBox) { errBox.textContent = data.error || 'Failed to update password.'; errBox.style.display = 'block'; }
      }
    } catch (e) {
      if (errBox) { errBox.textContent = 'Network error. Try again.'; errBox.style.display = 'block'; }
    }
  },

  // ─── OTP Input Handling Utilities ───
  handleOtpInput(input, index) {
    input.value = input.value.replace(/[^0-9]/g, '');
    if (input.value.length > 0) {
      input.classList.add('has-value');
    } else {
      input.classList.remove('has-value');
    }
    
    if (input.value.length === 1 && index < 6) {
      const fields = input.parentElement.querySelectorAll('.otp-field');
      const nextField = fields[index];
      if (nextField) nextField.focus();
    }

    const container = input.parentElement;
    const fields = container.querySelectorAll('.otp-field');
    let completedCount = 0;
    fields.forEach(f => {
      if (f.value.trim().length > 0) completedCount++;
    });
    
    if (completedCount === 6) {
      container.classList.add('otp-complete');
    } else {
      container.classList.remove('otp-complete');
    }
  },

  handleOtpKeydown(input, index, event) {
    if (event.key === 'Backspace' && input.value.length === 0 && index > 1) {
      const fields = input.parentElement.querySelectorAll('.otp-field');
      const prevField = fields[index - 2];
      if (prevField) {
        prevField.focus();
        prevField.value = '';
        prevField.classList.remove('has-value');
        input.parentElement.classList.remove('otp-complete');
      }
    }
  },

  getOtpValue(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return '';
    const fields = container.querySelectorAll('.otp-field');
    let code = '';
    fields.forEach(f => {
      code += f.value.trim();
    });
    return code;
  },

  setupOtpPaste(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const handlePaste = (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').trim().replace(/[^0-9]/g, '').slice(0, 6);
      const fields = container.querySelectorAll('.otp-field');
      
      fields.forEach((f, idx) => {
        f.value = text[idx] || '';
        if (f.value.length > 0) {
          f.classList.add('has-value');
        } else {
          f.classList.remove('has-value');
        }
      });

      if (text.length === 6) {
        container.classList.add('otp-complete');
      } else {
        container.classList.remove('otp-complete');
      }
      
      const focusIdx = Math.min(text.length, 5);
      if (fields[focusIdx]) fields[focusIdx].focus();
    };

    container.removeEventListener('paste', handlePaste);
    container.addEventListener('paste', handlePaste);
  },

  // ─── Timeframe Dropdown ──────────────────────────────────────────────────────
  toggleTfDropdown(e) {
    e.stopPropagation();
    const menu = document.getElementById('tf-dropdown-menu');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
  },

  changeTimeframe(tf, btn) {
    const validTfs = ['1m', '15m', '30m', '1h', '1d', '1w', '1mo'];
    if (!tf || !validTfs.includes(tf)) {
      tf = '1m';
    }

    // Update active class on buttons
    document.querySelectorAll('.tf-option').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // Update the label shown on the button
    const label = document.getElementById('tf-active-label');
    const labels = { '1m': '1m', '15m': '15m', '30m': '30m', '1h': '1h', '1d': '1D', '1w': '1W', '1mo': '1Mo' };
    if (label) label.textContent = labels[tf] || tf;

    // Close the dropdown
    const menu = document.getElementById('tf-dropdown-menu');
    if (menu) menu.style.display = 'none';

    // Delegate to chart engine
    if (window.chart) window.chart.changeTimeframe(tf);
    this._saveTradePrefs(); // persist selected timeframe
  },

  // ─── Chart Style Switcher ────────────────────────────────────────────────────
  toggleChartStyleMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('chart-style-menu');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'flex';
  },

  setChartStyle(style, btn, e) {
    if (e) e.stopPropagation();
    // Update active class
    document.querySelectorAll('.chart-style-option').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Close menu
    const menu = document.getElementById('chart-style-menu');
    if (menu) menu.style.display = 'none';
    // Delegate to chart engine
    if (window.chart) window.chart.setChartStyle(style);
  },

  // ─── Profile Sub-Screen Controller ───────────────────────────────────────────
  showProfileSubScreen(subScreenName) {
    if (subScreenName === 'support-center' || subScreenName === 'support') {
      subScreenName = 'contact';
    }
    this.currentProfileSubScreen = subScreenName;
    this.updateSupportFloatVisibility();
    document.querySelectorAll('.profile-sub-screen').forEach(screen => {
      screen.classList.remove('profile-sub-active');
      screen.style.display = '';
    });

    const target = document.getElementById(`profile-sub-${subScreenName}`);
    if (target) {
      target.classList.add('profile-sub-active');
    }

    if (subScreenName === 'convert-currency') {
      this.initConvertCurrencyScreen();
    }



    if (subScreenName === 'general') {
      const emailToggle = document.getElementById('settings-toggle-email-notifications');
      if (emailToggle) {
        const saved = localStorage.getItem('gainex_email_notifications');
        emailToggle.checked = saved !== 'false';
      }
    }

    if (subScreenName === 'settings') {
      const tzSelect = document.getElementById('settings-select-timezone');
      if (tzSelect) {
        tzSelect.value = localStorage.getItem('gainex_timezone') || 'AUTO';
      }
    }

    // Update URL based on subscreen
    if (this.activeTab === 'profile') {
      let path = '/profile';
      if (subScreenName === 'settings') path = '/settings';
      else if (subScreenName === 'convert-currency') path = '/convert';
      else if (subScreenName === 'support-center') path = '/help';
      
      const search = window.location.search;
      if (window.location.pathname !== path) {
        history.pushState({ tab: 'profile' }, '', path + search);
      }
    }
  },

  async loadPublicDocuments() {
    try {
      const res = await fetch('/api/public/documents');
      if (res.ok) {
        const data = await res.json();
        if (data.terms_description) {
          const container = document.getElementById('terms-description-container');
          if (container) container.innerHTML = data.terms_description;
        }
        if (data.policy_description) {
          const container = document.getElementById('policy-description-container');
          if (container) container.innerHTML = data.policy_description;
        }
        if (data.faq_description) {
          const container = document.getElementById('faq-description-container');
          if (container) container.innerHTML = data.faq_description;
        }
        if (data.auth_description) {
          document.querySelectorAll('.auth-sidebar-desc').forEach(el => {
            el.innerHTML = data.auth_description;
          });
        }
        if (data.risk_description) {
          const container = document.getElementById('risk-description-container');
          if (container) container.innerHTML = data.risk_description;
        }
        if (data.aml_description) {
          const container = document.getElementById('aml-description-container');
          if (container) container.innerHTML = data.aml_description;
        }
        if (data.contact_description) {
          const container = document.getElementById('contact-description-container');
          if (container) container.innerHTML = data.contact_description;
        }
        if (data.kyc_description) {
          const container = document.getElementById('kyc-description-container');
          if (container) container.innerHTML = data.kyc_description;
        }
        if (data.refund_policy_description) {
          const container = document.getElementById('refund-policy-description-container');
          if (container) container.innerHTML = data.refund_policy_description;
        }
        if (data.shipping_policy_description) {
          const container = document.getElementById('shipping-policy-description-container');
          if (container) container.innerHTML = data.shipping_policy_description;
        }
        if (data.office_address) {
          const container = document.getElementById('office-address-container');
          if (container) container.textContent = data.office_address;
        }
        if (data.office_number) {
          const container = document.getElementById('office-number-container');
          if (container) container.textContent = data.office_number;
        }
      }
    } catch(e) {
      console.warn('Failed to load public document descriptions:', e);
    }
  },

  async loadPublicOnboarding() {
    const defaultSlides = [
      { title: 'Welcome to Gain EX 👋', description: 'The best app to invest in various crypto stocks in the world today!', image: '/images/onboarding1.png' },
      { title: 'Get Better Returns 🚀', description: 'Invest in the biggest crypto market & unlock amazing returns of investment.', image: '/images/onboarding2.png' },
      { title: 'Start with Just $1.00 💰', description: "You don't have to buy a whole share, you can buy a fraction.", image: '/images/onboarding3.png' },
      { title: 'Your Safety is First 🛡️', description: 'Your brokerage account is secured with advanced military-grade encryption.', image: '/images/onboarding4.png' },
      { title: 'No Commissions ⚡', description: 'No commissions ever, just trade and maximize your returns.', image: '/images/onboarding5.png' }
    ];

    let slides = defaultSlides;

    try {
      const res = await fetch('/api/public/onboarding');
      if (res.ok) {
        const data = await res.json();
        if (data && data.slides && data.slides.length > 0) {
          slides = data.slides;
        }
      }
    } catch(e) {
      console.warn('Failed to load public onboarding slides, using defaults:', e);
    }

    const track = document.getElementById('onboarding-track');
    const dotsContainer = document.getElementById('onboarding-dots');
    if (!track) return;

    // Render slides
    let slidesHtml = '';
    let dotsHtml = '';
    
    slides.forEach((slide, idx) => {
      let formattedTitle = slide.title || '';
      // Escape HTML to prevent XSS
      formattedTitle = formattedTitle
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
        
      // Apply theme span formatting
      formattedTitle = formattedTitle.replace(/(Gain EX)/g, '<span>$1</span>');
      formattedTitle = formattedTitle.replace(/(\$1\.00)/g, '<span>$1</span>');
      
      const escapedDesc = (slide.description || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
        
      const escapedImg = (slide.image || '')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
      const escapedAlt = (slide.title || '')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      slidesHtml += `
        <div class="onboarding-slide">
          <div class="onboarding-image-container">
            <img src="${escapedImg}" alt="${escapedAlt}">
          </div>
          <h2 class="onboarding-title">${formattedTitle}</h2>
          <p class="onboarding-desc">${escapedDesc}</p>
        </div>
      `;
      
      dotsHtml += `<span class="dot${idx === 0 ? ' active' : ''}" data-index="${idx}"></span>`;
    });
    
    track.innerHTML = slidesHtml;
    if (dotsContainer) {
      dotsContainer.innerHTML = dotsHtml;
    }

    // Set up auto-scroll interval and event listeners
    if (this.onboardingInterval) {
      clearInterval(this.onboardingInterval);
      this.onboardingInterval = null;
    }

    const startAutoScroll = () => {
      this.onboardingInterval = setInterval(() => {
        const currentSlides = track.querySelectorAll('.onboarding-slide');
        if (currentSlides.length <= 1) return;
        const currentIndex = Math.round(track.scrollLeft / track.clientWidth);
        const nextIndex = (currentIndex + 1) % currentSlides.length;
        track.scrollTo({
          left: nextIndex * track.clientWidth,
          behavior: 'smooth'
        });
      }, 5000);
    };

    const resetAutoScroll = () => {
      if (this.onboardingInterval) {
        clearInterval(this.onboardingInterval);
      }
      startAutoScroll();
    };

    // Bind scroll listener for active dot state
    track.addEventListener('scroll', () => {
      const index = Math.round(track.scrollLeft / track.clientWidth);
      const dynamicDots = document.querySelectorAll('.onboarding-dots .dot');
      dynamicDots.forEach((dot, idx) => {
        if (idx === index) {
          dot.classList.add('active');
        } else {
          dot.classList.remove('active');
        }
      });
    });

    // Bind click listener to dots container
    if (dotsContainer) {
      dotsContainer.onclick = (e) => {
        const dot = e.target.closest('.dot');
        if (dot) {
          resetAutoScroll();
          const idx = parseInt(dot.getAttribute('data-index'), 10);
          track.scrollTo({
            left: idx * track.clientWidth,
            behavior: 'smooth'
          });
        }
      };
    }

    // Reset auto-scroll on manual swipe/drag interactions
    track.addEventListener('touchstart', resetAutoScroll, { passive: true });
    track.addEventListener('mousedown', resetAutoScroll);

    // Start initial auto-scroll
    startAutoScroll();
  },


  async showProfileMainSubTab(tabName) {
    this.currentProfileTab = tabName;

    const pills = ['feed', 'invite', 'badge'];
    pills.forEach(p => {
      const el = document.getElementById(`profile-tab-pill-${p}`);
      if (el) el.classList.remove('active');
    });

    const activeEl = document.getElementById(`profile-tab-pill-${tabName}`);
    if (activeEl) activeEl.classList.add('active');

    const feedContainer = document.getElementById('profile-main-feed-container');
    if (!feedContainer) return;

    if (tabName === 'feed') {
      await this.loadFeedPosts();
    } else if (tabName === 'invite') {
      // Invite / Referral tab
      const inviteCode = (this.user && this.user.invite_code) ? this.user.invite_code : null;
      const inviteLink = inviteCode ? `${window.location.origin}/?invite=${inviteCode}` : null;
      const commPct = (this.user && this.user.referral_commission_pct) ? this.user.referral_commission_pct : '5';

      feedContainer.innerHTML = `
        <div class="invite-tab-container">
          <div class="invite-hero">
            <div class="invite-hero-icon">🎁</div>
            <h3 class="invite-hero-title">Invite Friends & Earn</h3>
            <p class="invite-hero-desc">Share your personal invite link or code. When friends join and deposit, you earn ${commPct}% commission on their first 5 deposits!</p>
          </div>

          ${inviteCode ? `
          <!-- Invite Code -->
          <div class="invite-block">
            <div class="invite-block-label">Your Invite Code</div>
            <div class="invite-code-row">
              <span class="invite-code-text">${inviteCode}</span>
              <button class="invite-copy-btn" onclick="app.copyInviteCode('${inviteCode}')" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px;margin-right:5px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                Copy Code
              </button>
            </div>
          </div>

          <!-- Invite Link -->
          <div class="invite-block">
            <div class="invite-block-label">Your Invite Link</div>
            <div class="invite-link-row">
              <span class="invite-link-text">${inviteLink}</span>
              <button class="invite-copy-btn" onclick="app.copyReferralLink()" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:15px;height:15px;margin-right:5px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>
                Share Link
              </button>
            </div>
          </div>
          ` : `
          <div class="invite-block" style="text-align:center; padding: 24px;">
            <div style="font-size:28px; margin-bottom:10px;">🔒</div>
            <p style="color:var(--text-secondary); font-size:13px;">Your invite code is not available. Please contact support.</p>
          </div>
          `}

          <!-- How it works -->
          <div class="invite-how-section">
            <div class="invite-how-title">How it works</div>
            <div class="invite-steps">
              <div class="invite-step">
                <div class="invite-step-num">1</div>
                <div class="invite-step-text">
                  <strong>Share your link</strong>
                  <span>Send your personal invite code or link to friends</span>
                </div>
              </div>
              <div class="invite-step">
                <div class="invite-step-num">2</div>
                <div class="invite-step-text">
                  <strong>Friend signs up</strong>
                  <span>They register using your invite code</span>
                </div>
              </div>
              <div class="invite-step">
                <div class="invite-step-num">3</div>
                <div class="invite-step-text">
                  <strong>You both earn</strong>
                  <span>Earn ${commPct}% commission on their first 5 deposits</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    } else if (tabName === 'badge') {
      feedContainer.innerHTML = '<div class="badges-tab-container"><div style="text-align:center;padding:32px;color:var(--text-secondary);">Loading badges...</div></div>';
      try {
        const res = await fetch('/api/client/badges/my-badges', { credentials: 'include' });
        if (!res.ok) throw new Error('Failed');
        const data = await res.json();
        const badges = data.badges || [];
        const totalVolume = data.total_volume || 0;
        const isOwnProfile = !this.viewedUserId;

        let badgesHtml = '<div class="badges-tab-container">';
        badges.forEach(b => {
          const isUnlocked = totalVolume >= b.volume_threshold;
          const progress = Math.min(100, (totalVolume / b.volume_threshold) * 100).toFixed(1);
          const claim = b.claim;

          let bonusBtn = '';
          if (isOwnProfile && isUnlocked) {
            if (!claim) {
              bonusBtn = `<button class="badge-claim-btn" onclick="app.claimBadgeBonus('${b.key}', this)">🎁 Claim $${b.bonus_amount} Bonus</button>`;
            } else if (claim.status === 'pending') {
              bonusBtn = `<button class="badge-claim-btn pending" disabled>⏳ Pending Approval</button>`;
            } else if (claim.status === 'approved') {
              bonusBtn = `<span class="badge-claim-approved">✅ $${Number(claim.bonus_amount).toFixed(2)} Claimed</span>`;
            } else if (claim.status === 'rejected') {
              bonusBtn = `<span class="badge-claim-rejected">❌ Claim Rejected</span>`;
            }
          }

          badgesHtml += `
            <div class="profile-badge-card ${isUnlocked ? 'unlocked' : 'locked'}">
              <div class="badge-icon-wrap">${b.icon || '🏅'}</div>
              <div class="badge-info-wrap">
                <div class="badge-title-row">
                  <span class="badge-title">${b.name}</span>
                  <span class="badge-status ${isUnlocked ? 'unlocked-text' : 'locked-text'}">${isUnlocked ? 'Unlocked ✓' : 'Locked'}</span>
                </div>
                <p class="badge-description">${b.desc || `Unlock by trading a total volume of $${Number(b.volume_threshold).toLocaleString()} across all trades.`}</p>
                <div class="badge-progress-container">
                  <div class="badge-progress-text">$${totalVolume.toFixed(2)} / $${Number(b.volume_threshold).toFixed(2)} (${progress}%)</div>
                  <div class="badge-progress-bar-bg">
                    <div class="badge-progress-bar-fill" style="width: ${progress}%;"></div>
                  </div>
                </div>
                ${bonusBtn ? `<div class="badge-bonus-row">${bonusBtn}</div>` : ''}
              </div>
            </div>
          `;
        });
        badgesHtml += '</div>';
        feedContainer.innerHTML = badgesHtml;
      } catch(e) {
        // Fallback to static display if API fails
        const totalVolume = this.viewedUserId ? (this.viewedUser.total_volume || 0) : (this.user.total_volume || 0);
        const badges = [
          { name: 'Trader Badge', volume_threshold: 100, icon: '🥇', desc: 'Unlock by trading a total volume of $100.00 across all trades.' },
          { name: 'Master Badge', volume_threshold: 1000, icon: '🔥', desc: 'Unlock by trading a total volume of $1,000.00 across all trades.' },
          { name: 'Pro Badge', volume_threshold: 10000, icon: '💎', desc: 'Unlock by trading a total volume of $10,000.00 across all trades.' }
        ];
        let badgesHtml = '<div class="badges-tab-container">';
        badges.forEach(b => {
          const isUnlocked = totalVolume >= b.volume_threshold;
          const progress = Math.min(100, (totalVolume / b.volume_threshold) * 100).toFixed(1);
          badgesHtml += `
            <div class="profile-badge-card ${isUnlocked ? 'unlocked' : 'locked'}">
              <div class="badge-icon-wrap">${b.icon}</div>
              <div class="badge-info-wrap">
                <div class="badge-title-row">
                  <span class="badge-title">${b.name}</span>
                  <span class="badge-status ${isUnlocked ? 'unlocked-text' : 'locked-text'}">${isUnlocked ? 'Unlocked ✓' : 'Locked'}</span>
                </div>
                <p class="badge-description">${b.desc}</p>
                <div class="badge-progress-container">
                  <div class="badge-progress-text">$${totalVolume.toFixed(2)} / $${b.volume_threshold.toFixed(2)} (${progress}%)</div>
                  <div class="badge-progress-bar-bg">
                    <div class="badge-progress-bar-fill" style="width: ${progress}%;"></div>
                  </div>
                </div>
              </div>
            </div>`;
        });
        badgesHtml += '</div>';
        feedContainer.innerHTML = badgesHtml;
      }

    }
  },

  // ─── Badge Bonus Claim ─────────────────────────────────────────────────────────
  async claimBadgeBonus(badgeKey, btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Claiming...'; }
    try {
      const res = await fetch('/api/client/badges/claim', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ badge_key: badgeKey })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast(data.message || 'Badge bonus claimed! Pending approval.', 'success');
        // Reload the badge tab to reflect new state
        await this.showProfileMainSubTab('badge');
      } else {
        this.showToast(data.error || 'Failed to claim badge bonus.', 'error');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🎁 Claim Bonus'; }
      }
    } catch(e) {
      this.showToast('Network error claiming badge bonus.', 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🎁 Claim Bonus'; }
    }
  },

  // ─── Friends System Handlers ──────────────────────────────────────────────────
  async handleFriendsSearch(val) {
    const resultsSection = document.getElementById('friends-search-results-section');
    const resultsList = document.getElementById('friends-search-results-list');
    if (!resultsSection || !resultsList) return;

    if (!val || !val.trim()) {
      resultsSection.style.display = 'none';
      resultsList.innerHTML = '';
      return;
    }

    try {
      const res = await fetch('/api/friends/search?query=' + encodeURIComponent(val.trim()));
      if (res.ok) {
        const data = await res.json();
        resultsSection.style.display = 'flex';
        
        if (data.results && data.results.length > 0) {
          resultsList.innerHTML = data.results.map(u => {
            let actionBtn = '';
            if (u.friendStatus === 'none') {
              actionBtn = `<button class="friend-btn-primary" onclick="app.sendFriendRequest(${u.id})">Add Friend</button>`;
            } else if (u.friendStatus === 'pending_outgoing') {
              actionBtn = `<button class="friend-btn-secondary" onclick="app.rejectFriendRequest(${u.friendshipId})">Requested</button>`;
            } else if (u.friendStatus === 'pending_incoming') {
              actionBtn = `<button class="friend-btn-primary" onclick="app.acceptFriendRequest(${u.friendshipId})">Accept</button>`;
            } else if (u.friendStatus === 'accepted') {
              actionBtn = `<button class="friend-btn-danger" onclick="app.rejectFriendRequest(${u.friendshipId})">Unfriend</button>`;
            }

            return `
              <div class="friend-row-item">
                <div class="friend-item-left" onclick="app.viewUserProfile(${u.id})">
                  <div class="friend-item-avatar-wrap">
                    ${u.profile_pic ? `<img src="${u.profile_pic}" class="friend-item-avatar-img">` : `
                      <div class="friend-item-avatar-fallback">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                      </div>
                    `}
                  </div>
                  <div class="friend-item-name-wrap">
                    <span class="friend-item-name">${u.full_name || u.username} ${u.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:12px; margin-left:4px;">✓</span>' : ''}</span>
                    <span class="friend-item-username">@${u.username}</span>
                  </div>
                </div>
                <div class="friend-actions-row">
                  ${actionBtn}
                </div>
              </div>
            `;
          }).join('');
        } else {
          resultsList.innerHTML = '<div class="friends-empty-msg">No users found.</div>';
        }
      }
    } catch (e) {
      console.error('Error searching friends:', e);
    }
  },

  async sendFriendRequest(targetId) {
    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Friend request sent! ✉️', 'success');
        const searchInput = document.querySelector('.friends-search-input');
        if (searchInput && searchInput.value) {
          await this.handleFriendsSearch(searchInput.value);
        }
        await this.loadFriendsData();
      } else {
        this.showToast(data.error || 'Failed to send friend request.', 'error');
      }
    } catch (e) {
      this.showToast('Network error sending request.', 'error');
    }
  },

  async acceptFriendRequest(friendshipId) {
    try {
      const res = await fetch('/api/friends/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendshipId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Friend request accepted! 🎉', 'success');
        const searchInput = document.querySelector('.friends-search-input');
        if (searchInput && searchInput.value) {
          await this.handleFriendsSearch(searchInput.value);
        }
        await this.loadFriendsData();
        this.setupHeaderAndNav();
      } else {
        this.showToast(data.error || 'Failed to accept friend request.', 'error');
      }
    } catch (e) {
      this.showToast('Network error accepting request.', 'error');
    }
  },

  async rejectFriendRequest(friendshipId) {
    try {
      const res = await fetch('/api/friends/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendshipId })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Connection updated.', 'info');
        const searchInput = document.querySelector('.friends-search-input');
        if (searchInput && searchInput.value) {
          await this.handleFriendsSearch(searchInput.value);
        }
        await this.loadFriendsData();
        this.setupHeaderAndNav();
      } else {
        this.showToast(data.error || 'Action failed.', 'error');
      }
    } catch (e) {
      this.showToast('Network error processing request.', 'error');
    }
  },

  async loadFriendsData() {
    const incSec = document.getElementById('friends-incoming-section');
    const incList = document.getElementById('friends-incoming-list');
    const outSec = document.getElementById('friends-outgoing-section');
    const outList = document.getElementById('friends-outgoing-list');
    const allList = document.getElementById('friends-all-list');

    if (!allList) return;

    try {
      const res = await fetch('/api/friends/list');
      if (res.ok) {
        const data = await res.json();
        
        // Incoming
        if (data.incoming && data.incoming.length > 0) {
          incSec.style.display = 'flex';
          incList.innerHTML = data.incoming.map(req => `
            <div class="friend-row-item">
              <div class="friend-item-left" onclick="app.viewUserProfile(${req.user_id})">
                <div class="friend-item-avatar-wrap">
                  ${req.profile_pic ? `<img src="${req.profile_pic}" class="friend-item-avatar-img">` : `
                    <div class="friend-item-avatar-fallback">
                      <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                    </div>
                  `}
                </div>
                <div class="friend-item-name-wrap">
                  <span class="friend-item-name">${req.full_name || req.username} ${req.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:12px; margin-left:4px;">✓</span>' : ''}</span>
                  <span class="friend-item-username">@${req.username}</span>
                </div>
              </div>
              <div class="friend-actions-row">
                <button class="friend-btn-primary" onclick="app.acceptFriendRequest(${req.friendship_id})">Accept</button>
                <button class="friend-btn-danger" onclick="app.rejectFriendRequest(${req.friendship_id})">Decline</button>
              </div>
            </div>
          `).join('');
        } else {
          incSec.style.display = 'none';
          incList.innerHTML = '';
        }

        // Outgoing
        if (data.outgoing && data.outgoing.length > 0) {
          outSec.style.display = 'flex';
          outList.innerHTML = data.outgoing.map(req => `
            <div class="friend-row-item">
              <div class="friend-item-left" onclick="app.viewUserProfile(${req.user_id})">
                <div class="friend-item-avatar-wrap">
                  ${req.profile_pic ? `<img src="${req.profile_pic}" class="friend-item-avatar-img">` : `
                    <div class="friend-item-avatar-fallback">
                      <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                    </div>
                  `}
                </div>
                <div class="friend-item-name-wrap">
                  <span class="friend-item-name">${req.full_name || req.username} ${req.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:12px; margin-left:4px;">✓</span>' : ''}</span>
                  <span class="friend-item-username">@${req.username}</span>
                </div>
              </div>
              <div class="friend-actions-row">
                <button class="friend-btn-secondary" onclick="app.rejectFriendRequest(${req.friendship_id})">Cancel</button>
              </div>
            </div>
          `).join('');
        } else {
          outSec.style.display = 'none';
          outList.innerHTML = '';
        }

        // All Friends
        if (data.friends && data.friends.length > 0) {
          allList.innerHTML = data.friends.map(f => `
            <div class="friend-row-item">
              <div class="friend-item-left" onclick="app.viewUserProfile(${f.user_id})">
                <div class="friend-item-avatar-wrap">
                  ${f.profile_pic ? `<img src="${f.profile_pic}" class="friend-item-avatar-img">` : `
                    <div class="friend-item-avatar-fallback">
                      <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                    </div>
                  `}
                </div>
                <div class="friend-item-name-wrap">
                  <span class="friend-item-name">${f.full_name || f.username} ${f.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:12px; margin-left:4px;">✓</span>' : ''}</span>
                  <span class="friend-item-username">@${f.username}</span>
                </div>
              </div>
              <div class="friend-actions-row">
                <button class="friend-btn-danger" onclick="app.rejectFriendRequest(${f.friendship_id})">Unfriend</button>
              </div>
            </div>
          `).join('');
        } else {
          allList.innerHTML = '<div class="friends-empty-msg">No friends added yet. Search usernames to add friends.</div>';
        }
      }
    } catch (err) {
      allList.innerHTML = '<div class="friends-empty-msg">Failed to load friends list.</div>';
    }
  },

  // ─── Leaderboard and Profile Popup System ─────────────────────────────────────
  toggleLeaderboardDrawer(show) {
    const drawer = document.getElementById('desktop-leaderboard-drawer');
    if (!drawer) return;
    
    const isShowing = show !== undefined ? show : !drawer.classList.contains('active');
    
    if (isShowing) {
      drawer.classList.add('active');
      this.loadLeaderboardDrawerData();
      
      // Close when clicking outside
      const outsideClickListener = (e) => {
        const navLeaderboard = document.getElementById('nav-leaderboard');
        // Do not close if clicking inside the drawer, or clicking the leaderboard nav button,
        // or clicking any modal/popup that might open on top (like profile popup).
        if (!drawer.contains(e.target) && 
            (!navLeaderboard || !navLeaderboard.contains(e.target)) && 
            !e.target.closest('#leaderboard-profile-modal') && 
            !e.target.closest('.modal-content')) {
          drawer.classList.remove('active');
          document.removeEventListener('click', outsideClickListener);
        }
      };
      
      setTimeout(() => {
        document.addEventListener('click', outsideClickListener);
      }, 50);
    } else {
      drawer.classList.remove('active');
    }
  },

  getCountryFlag(countryName) {
    if (!countryName) return '🌐';
    const name = countryName.toLowerCase().trim();
    if (name.includes('pakistan')) return '🇵🇰';
    if (name.includes('india')) return '🇮🇳';
    if (name.includes('bangladesh')) return '🇧🇩';
    if (name.includes('nepal')) return '🇳🇵';
    if (name.includes('brazil')) return '🇧🇷';
    if (name.includes('nigeria')) return '🇳🇬';
    if (name.includes('indonesia')) return '🇮🇩';
    if (name.includes('egypt')) return '🇪🇬';
    if (name.includes('germany') || name.includes('deutschland')) return '🇩🇪';
    if (name.includes('united kingdom') || name.includes('uk') || name.includes('britain')) return '🇬🇧';
    if (name.includes('united states') || name.includes('usa') || name.includes('us')) return '🇺🇸';
    if (name.includes('turkey') || name.includes('türkiye')) return '🇹🇷';
    if (name.includes('vietnam')) return '🇻🇳';
    if (name.includes('philippines')) return '🇵🇭';
    if (name.includes('russia')) return '🇷🇺';
    return '🌐';
  },

  renderUserPositionCard(pos, elementId) {
    const wrap = document.getElementById(elementId);
    if (!wrap) return;
    if (!pos) {
      wrap.style.display = 'none';
      return;
    }

    const profitVal = Number(pos.profit || 0);
    const profitSign = profitVal >= 0 ? '+' : '-';
    const formattedProfit = profitSign + '$' + Math.abs(profitVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const profitColor = profitVal >= 0 ? '#1ab76d' : '#ef4444';

    const flag = this.getCountryFlag(pos.kyc_country);
    const displayName = pos.full_name || pos.username;
    
    const avatarHtml = pos.profile_pic
      ? `<img src="${pos.profile_pic}" style="width:28px; height:28px; border-radius:50%; object-fit:cover; vertical-align:middle;">`
      : `<div style="width:28px; height:28px; border-radius:50%; background: var(--bg-card-hover); color: var(--text-secondary); display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; vertical-align:middle;">${pos.username.charAt(0).toUpperCase()}</div>`;

    wrap.innerHTML = `
      <div class="user-rank-banner" style="background: rgba(26,183,109,0.06); border: 1px solid rgba(26,183,109,0.18); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 8px;">
            ${avatarHtml}
            <span style="font-size: 13.5px; font-weight: 600; color: var(--text-primary); display: inline-flex; align-items: center; gap: 4px;">
              <span style="font-size:14px;">${flag}</span>
              <span>${displayName}</span>
            </span>
          </div>
          <span style="font-weight: 700; font-size: 14px; color: ${profitColor};">
            ${formattedProfit}
          </span>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 8px; margin-top: 2px;">
          <span>Your position:</span>
          <strong style="color: var(--text-primary); font-weight: 700; font-size: 13px;">#${pos.rank}</strong>
        </div>
      </div>
    `;
    wrap.style.display = 'block';
  },

  async loadLeaderboardDrawerData() {
    const tbody = document.getElementById('desktop-leaderboard-drawer-tbody');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 30px;">
          <div style="display:inline-block; width:16px; height:16px; border:2px solid var(--primary); border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:8px; vertical-align:middle;"></div>
          Loading...
        </td>
      </tr>
    `;

    try {
      let selectedTz = localStorage.getItem('gainex_timezone') || 'AUTO';
      if (selectedTz === 'AUTO') {
        const now = new Date();
        const offsetMinutes = now.getTimezoneOffset();
        if (offsetMinutes === 0) {
          selectedTz = 'UTC+00:00';
        } else {
          const sign = offsetMinutes > 0 ? '-' : '+';
          const absOffset = Math.abs(offsetMinutes);
          const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
          const offsetRemainingMinutes = String(absOffset % 60).padStart(2, '0');
          selectedTz = `UTC${sign}${offsetHours}:${offsetRemainingMinutes}`;
        }
      }
      const res = await fetch(`/api/client/leaderboard?timezone=${encodeURIComponent(selectedTz)}&_=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        const traders = data.leaderboard || [];

        // Render logged in user rank banner at the top
        this.renderUserPositionCard(data.userPosition, 'desktop-leaderboard-user-rank-wrap');

        if (traders.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 20px;">No traders recorded yet.</td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = traders.slice(0, 20).map((t, index) => {
          const rank = index + 1;
          let rankBadgeHtml = rank;
          if (rank === 1) rankBadgeHtml = '<span class="rank-badge rank-1">🥇</span>';
          else if (rank === 2) rankBadgeHtml = '<span class="rank-badge rank-2">🥈</span>';
          else if (rank === 3) rankBadgeHtml = '<span class="rank-badge rank-3">🥉</span>';

          const profitVal = Number(t.net_profit || 0);
          const profitColor = profitVal >= 0 ? '#1ab76d' : '#ef4444';
          const profitSign = profitVal >= 0 ? '+' : '-';
          
          const isMe = this.user && Number(this.user.id) === Number(t.id);
          let finalDisplayProfit = '';
          if (profitVal > 30000 && !isMe) {
            finalDisplayProfit = '30,000$+';
          } else {
            finalDisplayProfit = profitSign + '$' + Math.abs(profitVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          }

          const avatarHtml = t.profile_pic
            ? `<img src="${t.profile_pic}" class="leaderboard-avatar-img" onclick="app.openLeaderboardProfileModal(${t.id})" style="width:28px; height:28px; border-radius:50%; object-fit:cover; cursor:pointer;">`
            : `<div class="leaderboard-avatar-initials" onclick="app.openLeaderboardProfileModal(${t.id})" style="width:28px; height:28px; border-radius:50%; background: var(--bg-card-hover); color: var(--text-secondary); display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; cursor:pointer;">${t.username.charAt(0).toUpperCase()}</div>`;

          const displayName = t.full_name || t.username;
          const formattedName = displayName.length > 15 ? displayName.substring(0, 12) + '...' : displayName;
          const flag = this.getCountryFlag(t.kyc_country);

          return `
            <tr class="leaderboard-row" data-user-id="${t.id}" style="border-bottom: 1px solid rgba(255,255,255,0.03); transition: var(--transition);">
              <td style="padding: 10px 8px; text-align: center; font-weight: 700;">${rankBadgeHtml}</td>
              <td style="padding: 10px 8px;">
                <div class="leaderboard-avatar-wrap" style="display: flex; align-items: center; gap: 8px;">
                  ${avatarHtml}
                  <span class="leaderboard-trader-name" onclick="app.openLeaderboardProfileModal(${t.id})" title="${displayName}" style="cursor: pointer; font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px;">
                    <span style="font-size: 13px; margin-right: 2px;">${flag}</span>
                    <span>${formattedName}</span>
                  </span>
                  ${t.streak ? `
                  <span class="profile-streak-badge" style="display: inline-flex; align-items: center; background: rgba(255,100,0,0.1); color: #ff6400; padding: 2px 4px; border-radius: 5px; font-size: 9px; font-weight: 700; gap: 1px; height: 14px; vertical-align: middle;" title="Daily Streak">
                    <span style="font-size: 8px; display: inline-block; transform: translateY(-0.5px);">🔥</span>
                    <span>${t.streak}</span>
                  </span>
                  ` : ''}
                </div>
              </td>
              <td style="padding: 10px 8px; text-align: right; font-weight: 700; font-size: 12px; color: ${profitColor};">
                ${finalDisplayProfit}
              </td>
            </tr>
          `;
        }).join('');
        this.bindLeaderboardHover(tbody);
      } else {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--danger); padding: 20px;">Failed to load.</td></tr>';
      }
    } catch (err) {
      console.error('Error loading leaderboard drawer data:', err);
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--danger); padding: 20px;">Failed to load.</td></tr>';
    }
  },

  async loadLeaderboardData() {
    const tbody = document.getElementById('leaderboard-list-tbody');
    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 30px;">
          <div style="display:inline-block; width:20px; height:20px; border:2px solid var(--primary); border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:8px; vertical-align:middle;"></div>
          Loading leaderboard...
        </td>
      </tr>
    `;

    try {
      let selectedTz = localStorage.getItem('gainex_timezone') || 'AUTO';
      if (selectedTz === 'AUTO') {
        const now = new Date();
        const offsetMinutes = now.getTimezoneOffset();
        if (offsetMinutes === 0) {
          selectedTz = 'UTC+00:00';
        } else {
          const sign = offsetMinutes > 0 ? '-' : '+';
          const absOffset = Math.abs(offsetMinutes);
          const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
          const offsetRemainingMinutes = String(absOffset % 60).padStart(2, '0');
          selectedTz = `UTC${sign}${offsetHours}:${offsetRemainingMinutes}`;
        }
      }
      const res = await fetch(`/api/client/leaderboard?timezone=${encodeURIComponent(selectedTz)}&_=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        const traders = data.leaderboard || [];

        // Render logged in user rank banner at the top
        this.renderUserPositionCard(data.userPosition, 'main-leaderboard-user-rank-wrap');

        if (traders.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 30px;">No traders recorded yet.</td>
            </tr>
          `;
          return;
        }

        tbody.innerHTML = traders.slice(0, 20).map((t, index) => {
          const rank = index + 1;
          let rankBadgeHtml = rank;
          if (rank === 1) rankBadgeHtml = '<span class="rank-badge rank-1">🥇</span>';
          else if (rank === 2) rankBadgeHtml = '<span class="rank-badge rank-2">🥈</span>';
          else if (rank === 3) rankBadgeHtml = '<span class="rank-badge rank-3">🥉</span>';

          const displayName = t.full_name || t.username;
          const formattedName = displayName.length > 15 ? displayName.substring(0, 12) + '...' : displayName;
          const flag = this.getCountryFlag(t.kyc_country);

          const avatarHtml = t.profile_pic 
            ? `<img src="${t.profile_pic}" class="leaderboard-avatar-img" onclick="app.openLeaderboardProfileModal(${t.id})">`
            : `<div class="leaderboard-avatar-initials" onclick="app.openLeaderboardProfileModal(${t.id})" style="background: var(--bg-card-hover); color: var(--text-secondary);">${t.username.charAt(0).toUpperCase()}</div>`;

          const profitVal = Number(t.net_profit || 0);
          const profitColor = profitVal >= 0 ? '#1ab76d' : '#ef4444';
          const profitSign = profitVal >= 0 ? '+' : '-';
          
          const isMe = this.user && Number(this.user.id) === Number(t.id);
          let finalDisplayProfit = '';
          if (profitVal > 30000 && !isMe) {
            finalDisplayProfit = '30,000$+';
          } else {
            finalDisplayProfit = profitSign + '$' + Math.abs(profitVal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          }

          return `
            <tr class="leaderboard-row" data-user-id="${t.id}" style="border-bottom: 1px solid rgba(255,255,255,0.05); transition: var(--transition);">
              <td style="padding: 12px 4px 12px 8px; text-align: center; font-weight: 700; vertical-align: middle;">${rankBadgeHtml}</td>
              <td style="padding: 12px 6px; vertical-align: middle; overflow: hidden;">
                <div class="leaderboard-avatar-wrap">
                  ${avatarHtml}
                  <span class="leaderboard-trader-name" onclick="app.openLeaderboardProfileModal(${t.id})" title="${displayName}">
                    <span style="font-size: 13px; margin-right: 2px;">${flag}</span>
                    <span>${formattedName}</span>${t.kyc_status === 'verified' ? ' <span style="color:var(--primary); font-size:11px;" title="Verified">✓</span>' : ''}
                  </span>
                </div>
              </td>
              <td style="padding: 12px 4px; text-align: center; vertical-align: middle;">
                <div class="profile-streak-badge" style="display:inline-flex; align-items:center; background:rgba(255,100,0,0.1); color:#ff6400; padding:2px 4px; border-radius:5px; font-size:9px; font-weight:700; gap:1px; height:14px; vertical-align:middle;">
                  <span style="font-size: 8px; display: inline-block; transform: translateY(-0.5px);">🔥</span>
                  <span>${t.streak || 0}</span>
                </div>
              </td>
              <td style="padding: 12px 8px 12px 4px; text-align: right; font-weight: 700; color: ${profitColor}; vertical-align: middle; font-size: 12px;">
                ${finalDisplayProfit}
              </td>
            </tr>
          `;
        }).join('');
        this.bindLeaderboardHover(tbody);
      } else {
        tbody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align: center; color: var(--danger); padding: 30px;">Failed to load leaderboard.</td>
          </tr>
        `;
      }
    } catch (err) {
      console.error('Error loading leaderboard data:', err);
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--danger); padding: 30px;">Failed to load leaderboard.</td>
        </tr>
      `;
    }
  },

  async openLeaderboardProfileModal(userId) {
    const modal = document.getElementById('leaderboard-profile-modal');
    if (!modal) return;

    // Show loading state
    document.getElementById('leaderboard-popup-name').textContent = 'Loading...';
    document.getElementById('leaderboard-popup-country').textContent = 'Loading...';
    document.getElementById('leaderboard-popup-streak').textContent = '0';
    document.getElementById('leaderboard-popup-verified').style.display = 'none';
    const diamondEl = document.getElementById('leaderboard-popup-diamond');
    if (diamondEl) diamondEl.style.display = 'none';
    
    // Clear stats loading indicators
    document.getElementById('leaderboard-popup-trades-count').textContent = '...';
    document.getElementById('leaderboard-popup-profitable-trades').textContent = '...';
    document.getElementById('leaderboard-popup-trades-profit').textContent = '...';
    document.getElementById('leaderboard-popup-avg-profit').textContent = '...';
    document.getElementById('leaderboard-popup-min-amount').textContent = '...';
    document.getElementById('leaderboard-popup-max-amount').textContent = '...';
    
    const avatarImg = document.getElementById('leaderboard-popup-avatar-img');
    const avatarFallback = document.getElementById('leaderboard-popup-avatar-fallback');
    avatarImg.style.display = 'none';
    avatarFallback.style.display = 'block';
    avatarFallback.textContent = '...';

    const feedContainer = document.getElementById('leaderboard-popup-feed-container');
    feedContainer.innerHTML = '<div style="text-align:center; color:var(--text-secondary); padding:20px;">Loading posts...</div>';

    modal.style.display = 'flex';

    try {
      // 1. Fetch public profile
      const userRes = await fetch(`/api/client/users/${userId}/public-profile`);
      if (userRes.ok) {
        const userData = await userRes.json();
        const user = userData.user;
        const stats = user.stats || {};

        document.getElementById('leaderboard-popup-name').textContent = user.full_name || user.username;
        document.getElementById('leaderboard-popup-country').textContent = user.kyc_country || 'Global Trader';
        document.getElementById('leaderboard-popup-streak').textContent = user.streak || 0;

        // Show correct verification badge
        const isVerified = user.kyc_status === 'verified';
        document.getElementById('leaderboard-popup-verified').style.display = isVerified ? 'inline-block' : 'none';
        document.getElementById('leaderboard-popup-unverified').style.display = isVerified ? 'none' : 'inline-block';

        // Update user badge icon
        if (diamondEl) {
          if (user.badge) {
            diamondEl.textContent = user.badge.icon;
            diamondEl.title = user.badge.name;
            diamondEl.style.display = 'inline-block';
          } else {
            diamondEl.style.display = 'none';
          }
        }

        // Populate trading stats
        document.getElementById('leaderboard-popup-trades-count').textContent = stats.trades_count || 0;
        document.getElementById('leaderboard-popup-profitable-trades').textContent = stats.profitable_trades || 0;
        
        // Trades Profit formatting
        const profit = Number(stats.trades_profit || 0);
        const profitEl = document.getElementById('leaderboard-popup-trades-profit');
        const isMe = this.user && Number(this.user.id) === Number(userId);
        if (profit > 30000 && !isMe) {
          profitEl.textContent = '30,000$+';
        } else {
          profitEl.textContent = (profit >= 0 ? '+' : '-') + '$' + Math.abs(profit).toFixed(2);
        }
        profitEl.style.color = profit >= 0 ? '#1ab76d' : 'var(--danger)';

        // Average Profit formatting
        const avgProfit = Number(stats.avg_profit || 0);
        const avgEl = document.getElementById('leaderboard-popup-avg-profit');
        avgEl.textContent = (avgProfit >= 0 ? '+' : '-') + '$' + Math.abs(avgProfit).toFixed(2);
        avgEl.style.color = avgProfit >= 0 ? '#1ab76d' : 'var(--danger)';

        // Min & Max Trade amounts
        document.getElementById('leaderboard-popup-min-amount').textContent = '$' + Number(stats.min_trade_amount || 0).toFixed(2);
        document.getElementById('leaderboard-popup-max-amount').textContent = '$' + Number(stats.max_trade_amount || 0).toFixed(2);

        if (user.profile_pic) {
          avatarImg.src = user.profile_pic;
          avatarImg.style.display = 'block';
          avatarFallback.style.display = 'none';
        } else {
          avatarImg.style.display = 'none';
          avatarFallback.style.display = 'block';
          avatarFallback.textContent = user.username.charAt(0).toUpperCase();
        }

        // 2. Fetch user posts
        const postsRes = await fetch(`/api/profile/posts?userId=${userId}`);
        if (postsRes.ok) {
          const postsData = await postsRes.json();
          const posts = postsData.posts || [];

          if (posts.length === 0) {
            feedContainer.innerHTML = `
              <div style="text-align: center; padding: 24px; color: var(--text-secondary);">
                <div style="font-size: 24px; margin-bottom: 8px;">📭</div>
                <p style="font-size: 13px; margin: 0;">No public posts from this user.</p>
              </div>
            `;
          } else {
            feedContainer.innerHTML = posts.map(p => {
              let mediaHtml = '';
              if (p.media_type === 'video') {
                mediaHtml = `<video src="${p.media_url}" controls style="max-height:200px; width:100%; object-fit:cover; border-radius:8px; display:block;"></video>`;
              } else {
                mediaHtml = `<img src="${p.media_url}" style="max-height:200px; width:100%; object-fit:cover; border-radius:8px; display:block;" alt="Post media">`;
              }

              return `
                <div style="background: var(--bg-card-hover); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 11px; color: var(--text-secondary);">${this.formatTimeAgo(p.created_at)}</span>
                  </div>
                  ${p.description ? `<p style="margin: 0; font-size: 13px; color: var(--text-primary); line-height: 1.4;">${p.description}</p>` : ''}
                  <div>
                    ${mediaHtml}
                  </div>
                  <div style="display: flex; gap: 14px; font-size: 12px; color: var(--text-secondary); border-top: 1px solid rgba(255,255,255,0.04); padding-top: 8px; margin-top: 4px;">
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                      <span>${p.comments_count || 0}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                      <svg viewBox="0 0 24 24" fill="${p.has_liked ? 'var(--danger)' : 'none'}" stroke="${p.has_liked ? 'var(--danger)' : 'currentColor'}" stroke-width="2" style="width: 14px; height: 14px; color: ${p.has_liked ? 'var(--danger)' : 'inherit'};"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                      <span>${p.likes_count || 0}</span>
                    </div>
                  </div>
                </div>
              `;
            }).join('');
          }
        } else {
          feedContainer.innerHTML = '<div style="text-align:center; color:var(--danger); padding:20px;">Failed to load user posts.</div>';
        }
      } else {
        document.getElementById('leaderboard-popup-name').textContent = 'Error Loading Profile';
        feedContainer.innerHTML = '';
      }
    } catch (err) {
      console.error('Error loading public profile details:', err);
      document.getElementById('leaderboard-popup-name').textContent = 'Error Loading Profile';
      feedContainer.innerHTML = '';
    }
  },

  closeLeaderboardProfileModal() {
    const modal = document.getElementById('leaderboard-profile-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  async openStreakMilestonesModal() {
    const modal = document.getElementById('streak-milestones-modal');
    if (!modal) return;

    const streakCountEl = document.getElementById('streak-modal-current-count');
    const milestonesList = document.getElementById('streak-modal-milestones-list');
    
    // Check if body has light-theme
    const isLight = document.body.classList.contains('light-theme');
    const textMuted = isLight ? 'rgba(30, 41, 59, 0.6)' : 'rgba(255, 255, 255, 0.5)';
    const spinnerBorderColor = isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';

    // Set initial loading state
    if (streakCountEl) streakCountEl.textContent = this.user ? (this.user.streak || 0) : '0';
    if (milestonesList) {
      milestonesList.innerHTML = `
        <div style="text-align: center !important; padding: 30px !important; color: ${textMuted} !important;">
          <div class="spinner" style="width: 24px !important; height: 24px !important; border: 2px solid ${spinnerBorderColor} !important; border-top-color: #ff6400 !important; border-radius: 50% !important; animation: spin 1s linear infinite !important; margin: 0 auto 10px auto !important;"></div>
          <span style="font-size: 13px !important; font-weight: 500 !important;">Loading milestones & progress...</span>
        </div>
      `;
    }

    modal.style.display = 'flex';

    try {
      const res = await fetch('/api/client/bonuses/my-progress');
      if (!res.ok) throw new Error('Failed to fetch streak milestones progress');

      const data = await res.json();
      if (data.success) {
        // Update streak count
        if (streakCountEl) streakCountEl.textContent = data.streak || 0;

        // Render milestones
        if (milestonesList) {
          const criteria = data.criteria || [];
          const claims = data.claims || [];
          
          if (criteria.length === 0) {
            milestonesList.innerHTML = `
              <div style="text-align: center !important; padding: 20px !important; color: ${textMuted} !important; font-size: 13px !important;">
                No milestone criteria configured.
              </div>
            `;
            return;
          }

          // Sort criteria by days requirement ascending
          const sortedCriteria = [...criteria].sort((a, b) => a.days - b.days);

          milestonesList.innerHTML = sortedCriteria.map((crit, index) => {
            // Find if there is a claim for this milestone
            const claim = claims.find(c => c.milestone === crit.milestone);
            
            let statusBadge = '';
            let progressHtml = '';
            
            // Theme adaptation variables
            const isLight = document.body.classList.contains('light-theme');
            const textColor = isLight ? '#1e293b' : '#ffffff';
            const cardTextMuted = isLight ? 'rgba(30, 41, 59, 0.6)' : 'rgba(255, 255, 255, 0.5)';
            const progressTrackBg = isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

            let cardBorderColor = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.05)';
            let cardBg = isLight ? 'rgba(0, 0, 0, 0.02)' : 'rgba(255, 255, 255, 0.01)';
            
            // Calculate tiered progress toward this specific milestone
            const currentStreak = data.streak || 0;
            const prevDays = (index === 0) ? 0 : sortedCriteria[index - 1].days;
            const targetSpan = crit.days - prevDays;
            
            const completedDays = currentStreak <= prevDays ? 0 : Math.min(targetSpan, currentStreak - prevDays);
            const progressPct = Math.min(100, Math.round((completedDays / targetSpan) * 100));

            if (claim) {
              if (claim.status === 'approved') {
                statusBadge = `
                  <span style="font-size: 10.5px !important; padding: 3px 8px !important; border-radius: 8px !important; background: rgba(26, 183, 109, 0.12) !important; color: #1ab76d !important; border: 1px solid rgba(26, 183, 109, 0.25) !important; font-weight: 700 !important;">
                    ✓ Claimed
                  </span>`;
                cardBorderColor = 'rgba(26, 183, 109, 0.25)';
                cardBg = isLight ? 'rgba(26, 183, 109, 0.06)' : 'rgba(26, 183, 109, 0.03)';
                progressHtml = `
                  <div style="margin-top: 8px !important;">
                    <div style="display: flex !important; justify-content: space-between !important; font-size: 11px !important; color: ${cardTextMuted} !important; margin-bottom: 4px !important;">
                      <span>Milestone Completed</span>
                      <span style="color: ${textColor} !important; font-weight: 600 !important;">${targetSpan}/${targetSpan} Days</span>
                    </div>
                    <div style="height: 6px !important; background: ${progressTrackBg} !important; border-radius: 4px !important; overflow: hidden !important;">
                      <div style="height: 100% !important; width: 100% !important; background: #1ab76d !important; border-radius: 4px !important; box-shadow: 0 0 8px rgba(26, 183, 109, 0.5) !important;"></div>
                    </div>
                  </div>`;
              } else if (claim.status === 'pending') {
                statusBadge = `
                  <span style="font-size: 10.5px !important; padding: 3px 8px !important; border-radius: 8px !important; background: rgba(255, 140, 0, 0.12) !important; color: #ff8c00 !important; border: 1px solid rgba(255, 140, 0, 0.25) !important; font-weight: 700 !important;">
                    ⏳ Pending Approval
                  </span>`;
                cardBorderColor = 'rgba(255, 140, 0, 0.28)';
                cardBg = isLight ? 'rgba(255, 140, 0, 0.06)' : 'rgba(255, 140, 0, 0.03)';
                progressHtml = `
                  <div style="margin-top: 8px !important;">
                    <div style="display: flex !important; justify-content: space-between !important; font-size: 11px !important; color: ${cardTextMuted} !important; margin-bottom: 4px !important;">
                      <span>Milestone Achieved</span>
                      <span style="color: ${textColor} !important; font-weight: 600 !important;">${targetSpan}/${targetSpan} Days</span>
                    </div>
                    <div style="height: 6px !important; background: ${progressTrackBg} !important; border-radius: 4px !important; overflow: hidden !important;">
                      <div style="height: 100% !important; width: 100% !important; background: #ff8c00 !important; border-radius: 4px !important; box-shadow: 0 0 8px rgba(255, 140, 0, 0.5) !important;"></div>
                    </div>
                  </div>`;
              } else if (claim.status === 'rejected') {
                statusBadge = `
                  <span style="font-size: 10.5px !important; padding: 3px 8px !important; border-radius: 8px !important; background: rgba(239, 68, 68, 0.12) !important; color: #ef4444 !important; border: 1px solid rgba(239, 68, 68, 0.25) !important; font-weight: 700 !important;">
                    ✗ Rejected
                  </span>`;
                cardBorderColor = 'rgba(239, 68, 68, 0.22)';
                progressHtml = `
                  <div style="margin-top: 8px !important;">
                    <div style="display: flex !important; justify-content: space-between !important; font-size: 11px !important; color: ${cardTextMuted} !important; margin-bottom: 4px !important;">
                      <span>Milestone Completed</span>
                      <span style="color: ${textColor} !important; font-weight: 600 !important;">${targetSpan}/${targetSpan} Days</span>
                    </div>
                    <div style="height: 6px !important; background: ${progressTrackBg} !important; border-radius: 4px !important; overflow: hidden !important;">
                      <div style="height: 100% !important; width: 100% !important; background: #ef4444 !important; border-radius: 4px !important;"></div>
                    </div>
                  </div>`;
              }
            } else {
              // No claim yet. Is it completed or in progress?
              if (currentStreak >= crit.days) {
                statusBadge = `
                  <span style="font-size: 10.5px !important; padding: 3px 8px !important; border-radius: 8px !important; background: rgba(255, 100, 0, 0.12) !important; color: #ff6400 !important; border: 1px solid rgba(255, 100, 0, 0.25) !important; font-weight: 700 !important;">
                    Achieved
                  </span>`;
                cardBorderColor = 'rgba(255, 100, 0, 0.3)';
                cardBg = isLight ? 'rgba(255, 100, 0, 0.06)' : 'rgba(255, 100, 0, 0.03)';
                progressHtml = `
                  <div style="margin-top: 8px !important;">
                    <div style="display: flex !important; justify-content: space-between !important; font-size: 11px !important; color: ${cardTextMuted} !important; margin-bottom: 4px !important;">
                      <span>Milestone Achieved</span>
                      <span style="color: ${textColor} !important; font-weight: 600 !important;">${targetSpan}/${targetSpan} Days</span>
                    </div>
                    <div style="height: 6px !important; background: ${progressTrackBg} !important; border-radius: 4px !important; overflow: hidden !important;">
                      <div style="height: 100% !important; width: 100% !important; background: #ff6400 !important; border-radius: 4px !important; box-shadow: 0 0 8px rgba(255, 100, 0, 0.5) !important;"></div>
                    </div>
                  </div>`;
              } else {
                statusBadge = `
                  <span style="font-size: 10.5px !important; padding: 3px 8px !important; border-radius: 8px !important; background: ${isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.04)'} !important; color: ${isLight ? 'rgba(30, 41, 59, 0.5)' : 'rgba(255, 255, 255, 0.4)'} !important; border: 1px solid ${isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.06)'} !important; font-weight: 700 !important;">
                    Locked
                  </span>`;
                progressHtml = `
                  <div style="margin-top: 8px !important;">
                    <div style="display: flex !important; justify-content: space-between !important; font-size: 11px !important; color: ${cardTextMuted} !important; margin-bottom: 4px !important;">
                      <span>Progress: ${progressPct}%</span>
                      <span style="color: ${textColor} !important; font-weight: 600 !important;">${completedDays}/${targetSpan} Days</span>
                    </div>
                    <div style="height: 6px !important; background: ${progressTrackBg} !important; border-radius: 4px !important; overflow: hidden !important;">
                      <div style="height: 100% !important; width: ${progressPct}% !important; background: linear-gradient(90deg, #ff8c00, #ff4500) !important; border-radius: 4px !important; box-shadow: 0 0 6px rgba(255, 100, 0, 0.3) !important;"></div>
                    </div>
                  </div>`;
              }
            }

            return `
              <div style="background: ${cardBg} !important; border: 1px solid ${cardBorderColor} !important; border-radius: 16px !important; padding: 16px !important; display: flex !important; flex-direction: column !important; gap: 8px !important; transition: border-color 0.2s, background-color 0.2s !important; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15) !important;">
                <div style="display: flex !important; justify-content: space-between !important; align-items: flex-start !important; gap: 8px !important;">
                  <div style="text-align: left !important;">
                    <h4 style="margin: 0 !important; font-size: 14.5px !important; font-weight: 700 !important; color: ${textColor} !important;">Milestone ${crit.milestone}: ${crit.days} Days</h4>
                    <div style="font-size: 11.5px !important; color: ${cardTextMuted} !important; margin-top: 4px !important;">
                      Min Daily Volume: <strong style="color: ${textColor} !important;">$${Number(crit.min_volume).toFixed(2)}</strong>
                    </div>
                  </div>
                  <div style="display: flex !important; flex-direction: column !important; align-items: flex-end !important; gap: 6px !important;">
                    <div style="font-size: 15px !important; font-weight: 900 !important; color: #1ab76d !important; text-shadow: 0 0 10px rgba(26, 183, 109, 0.25) !important;">+$${Number(crit.bonus).toFixed(2)}</div>
                    ${statusBadge}
                  </div>
                </div>
                ${progressHtml}
              </div>
            `;
          }).join('');
        }
      }
    } catch (err) {
      console.error('Error fetching milestones progress:', err);
      if (milestonesList) {
        milestonesList.innerHTML = `
          <div style="text-align: center !important; padding: 30px !important; color: #ef4444 !important; font-size: 13px !important; font-weight: 500 !important; line-height: 1.5 !important;">
            Failed to load streak milestone details.<br>Please check connection or try again later.
          </div>
        `;
      }
    }
  },

  closeStreakMilestonesModal() {
    const modal = document.getElementById('streak-milestones-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  // ─── Feed Posts System Handlers ───────────────────────────────────────────────
  async loadFeedPosts() {
    const feedContainer = document.getElementById('profile-main-feed-container');
    if (!feedContainer) return;

    // Immediately replace any old tab content with loading state
    feedContainer.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px;">
        <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:18px; padding:16px; height:120px; opacity:0.5;"></div>
        <div style="background:var(--bg-card); border:1px solid var(--border-color); border-radius:18px; padding:16px; height:80px; opacity:0.3;"></div>
      </div>
    `;

    try {
      const targetUserId = this.viewedUserId || (this.user ? this.user.id : null);
      if (!targetUserId) {
        feedContainer.innerHTML = '<div style="text-align:center; color:var(--text-secondary); padding:20px;">Please log in to view feed posts.</div>';
        return;
      }
      const res = await fetch('/api/profile/posts?userId=' + targetUserId);
      if (res.ok) {
        const data = await res.json();
        this.currentFeedPosts = data.posts || [];

        if (data.posts && data.posts.length > 0) {
          feedContainer.innerHTML = data.posts.map(p => {
            const isOwner = p.user_id === this.user.id;
            let mediaHtml = '';
            if (p.media_type === 'video') {
              mediaHtml = `<video src="${p.media_url}" controls class="feed-card-img" style="max-height:240px; width:100%; object-fit:cover; display:block;"></video>`;
            } else {
              mediaHtml = `<img src="${p.media_url}" class="feed-card-img" style="max-height:240px; width:100%; object-fit:cover; display:block;" alt="Feed media">`;
            }

            return `
              <div class="profile-feed-card">
                <div class="feed-card-header">
                  <div class="feed-card-user-info">
                    <div class="feed-card-avatar-wrap">
                      ${p.profile_pic ? `<img src="${p.profile_pic}" class="feed-card-avatar-img">` : `
                        <div class="feed-card-avatar-fallback">
                          <svg viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                        </div>
                      `}
                    </div>
                    <div class="feed-card-name-wrap">
                      <span class="feed-card-name">${p.full_name || p.username} ${p.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:12px; margin-left:4px;">✓</span>' : ''}</span>
                      <span class="feed-card-time">${this.formatTimeAgo(p.created_at)}</span>
                    </div>
                  </div>
                  ${isOwner ? `
                    <button class="feed-card-delete-btn" onclick="app.deletePost(${p.id})" type="button" title="Delete Post">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                  ` : `
                    <button class="feed-card-menu-btn" type="button">
                      <svg viewBox="0 0 24 24" fill="currentColor" style="width: 16px; height: 16px;"><circle cx="12" cy="12" r="1.5"></circle><circle cx="6" cy="12" r="1.5"></circle><circle cx="18" cy="12" r="1.5"></circle></svg>
                    </button>
                  `}
                </div>
                <div class="feed-card-body">
                  ${p.description ? `<p class="feed-card-text">${p.description}</p>` : ''}
                  <div class="feed-card-image-wrap">
                    ${mediaHtml}
                  </div>
                </div>
                <div class="feed-card-footer">
                  <div class="feed-action-item" onclick="app.openCommentsModal(${p.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 16px; height: 16px;"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                    <span>${p.comments_count || 0}</span>
                  </div>
                  <div class="feed-action-item" onclick="app.likePost(${p.id})">
                    <svg viewBox="0 0 24 24" fill="${p.has_liked ? 'var(--danger)' : 'none'}" stroke="${p.has_liked ? 'var(--danger)' : 'currentColor'}" stroke-width="2" style="width: 16px; height: 16px; color: ${p.has_liked ? 'var(--danger)' : 'inherit'};"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                    <span>${p.likes_count || 0}</span>
                  </div>
                </div>
              </div>
            `;
          }).join('');
        } else {
          feedContainer.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--text-secondary);">
              <div style="font-size: 32px; margin-bottom: 12px;">📭</div>
              <h4 style="color: var(--text-primary); margin-bottom: 6px; font-weight: 700;">No Posts Yet</h4>
              <p style="font-size: 13px; max-width: 280px; margin: 0 auto; line-height: 1.5;">Share images, GIFs, or short trading videos to show your progress!</p>
            </div>
          `;
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        feedContainer.innerHTML = `<div style="text-align:center; color:var(--text-secondary); padding:20px;">Failed to load feed posts: ${errData.error || res.statusText}</div>`;
      }
    } catch (e) {
      feedContainer.innerHTML = '<div style="text-align:center; color:var(--text-secondary); padding:20px;">Failed to load feed posts.</div>';
    }
  },

  openCreatePostModal() {
    if (this.currentFeedPosts && this.currentFeedPosts.length >= 5) {
      this.showToast('Limit reached! You can upload max 5 feed posts. Please delete one first. 🚫', 'error');
      return;
    }

    document.getElementById('post-media-input').value = '';
    document.getElementById('post-desc-input').value = '';
    
    const previewContainer = document.getElementById('post-media-preview-container');
    previewContainer.style.display = 'none';
    previewContainer.innerHTML = '';

    const errorMsg = document.getElementById('post-media-error-msg');
    errorMsg.style.display = 'none';
    errorMsg.textContent = '';

    document.getElementById('profile-create-post-modal').style.display = 'flex';
  },

  closeCreatePostModal() {
    document.getElementById('profile-create-post-modal').style.display = 'none';
  },

  handlePostMediaChange(input) {
    const file = input.files[0];
    const previewContainer = document.getElementById('post-media-preview-container');
    const errorMsg = document.getElementById('post-media-error-msg');
    const placeholder = document.getElementById('create-post-upload-placeholder');

    if (!previewContainer || !errorMsg) return;

    previewContainer.style.display = 'none';
    previewContainer.innerHTML = '';
    errorMsg.style.display = 'none';
    errorMsg.textContent = '';
    if (placeholder) placeholder.style.display = 'block';

    if (!file) return;

    const mime = file.type.toLowerCase();
    
    if (mime.startsWith('video/')) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        const duration = video.duration;
        window.URL.revokeObjectURL(video.src);
        if (duration < 5 || duration > 25) {
          errorMsg.textContent = `Video must be between 5s and 25s long (current: ${duration.toFixed(1)}s).`;
          errorMsg.style.display = 'block';
          input.value = '';
        } else {
          const previewUrl = window.URL.createObjectURL(file);
          previewContainer.innerHTML = `<video src="${previewUrl}" controls style="width:100%; display:block; border-radius:12px; max-height:220px; object-fit:cover;"></video>`;
          previewContainer.style.display = 'block';
          if (placeholder) placeholder.style.display = 'none';
        }
      };
      video.src = URL.createObjectURL(file);
    } else if (mime.startsWith('image/') || mime.includes('gif')) {
      const previewUrl = window.URL.createObjectURL(file);
      previewContainer.innerHTML = `<img src="${previewUrl}" style="width:100%; display:block; border-radius:12px; max-height:220px; object-fit:cover;" alt="Preview media">`;
      previewContainer.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    } else {
      errorMsg.textContent = 'Unsupported file type. Please select an image, GIF, or video.';
      errorMsg.style.display = 'block';
      input.value = '';
    }
  },

  async handleCreatePost(event) {
    if (event) event.preventDefault();

    const mediaInput = document.getElementById('post-media-input');
    const descInput = document.getElementById('post-desc-input');
    const btn = document.getElementById('post-submit-btn');

    const file = mediaInput?.files[0];
    if (!file) {
      this.showToast('Please select a file to upload.', 'error');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Uploading...';
    }

    try {
      const formData = new FormData();
      formData.append('media', file);
      formData.append('description', descInput?.value || '');

      const token = localStorage.getItem('token') || '';
      const res = await fetch('/api/profile/posts', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      const data = await res.json();

      if (res.ok && data.success) {
        this.showToast('Post created successfully! 🚀', 'success');
        this.closeCreatePostModal();
        await this.loadFeedPosts();
      } else {
        this.showToast(data.error || 'Failed to upload post.', 'error');
      }
    } catch (e) {
      this.showToast('Network error uploading post.', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Post to Feed';
      }
    }
  },

  async deletePost(postId) {
    const confirmDel = confirm('Are you sure you want to delete this post?');
    if (!confirmDel) return;

    try {
      const res = await fetch('/api/profile/posts/' + postId, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        this.showToast('Post deleted successfully. ✓', 'success');
        await this.loadFeedPosts();
      } else {
        this.showToast(data.error || 'Failed to delete post.', 'error');
      }
    } catch (e) {
      this.showToast('Network error deleting post.', 'error');
    }
  },

  async likePost(postId) {
    try {
      const res = await fetch(`/api/profile/posts/${postId}/like`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        await this.loadFeedPosts();
      }
    } catch (e) {
      console.error('Error liking post:', e);
    }
  },

  // ─── Post Comments Handlers ──────────────────────────────────────────────────
  async openCommentsModal(postId) {
    this.activeCommentPostId = postId;
    const modal = document.getElementById('profile-comments-modal');
    const input = document.getElementById('post-comment-input');
    if (modal) modal.style.display = 'flex';
    if (input) input.value = '';

    await this.loadPostComments(postId);
  },

  closeCommentsModal() {
    const modal = document.getElementById('profile-comments-modal');
    if (modal) modal.style.display = 'none';
    this.activeCommentPostId = null;
  },

  async loadPostComments(postId) {
    const list = document.getElementById('profile-comments-list');
    if (!list) return;

    list.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:20px;">Loading comments...</div>';

    try {
      const res = await fetch(`/api/profile/posts/${postId}/comments`);
      if (res.ok) {
        const data = await res.json();
        
        if (data.comments && data.comments.length > 0) {
          list.innerHTML = data.comments.map(c => `
            <div class="comment-item">
              <div class="comment-avatar-wrap">
                ${c.profile_pic ? `<img src="${c.profile_pic}" class="comment-avatar-img">` : `
                  <div class="comment-avatar-fallback">
                    <svg viewBox="0 0 24 24" style="width: 12px; height: 12px; fill: var(--text-secondary);"><path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 3.58-8 8v1h16v-1c0-4.42-3.58-8-8-8z"/></svg>
                  </div>
                `}
              </div>
              <div class="comment-content-wrap">
                <div class="comment-header-row">
                  <span class="comment-author-name">${c.full_name || c.username} ${c.kyc_status === 'verified' ? '<span style="color:var(--primary); font-size:11px; margin-left:2px;">✓</span>' : ''}</span>
                  <span class="comment-time">${this.formatTimeAgo(c.created_at)}</span>
                </div>
                <p class="comment-body-text">${c.text}</p>
              </div>
            </div>
          `).join('');
        } else {
          list.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:20px;">No comments yet. Be the first to comment!</div>';
        }
      }
    } catch (e) {
      list.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:20px;">Failed to load comments.</div>';
    }
  },

  async handleNewComment(event) {
    if (event) event.preventDefault();

    const input = document.getElementById('post-comment-input');
    const btn = document.getElementById('post-comment-btn');
    const text = input?.value || '';

    if (!text.trim() || !this.activeCommentPostId) return;

    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/profile/posts/${this.activeCommentPostId}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        input.value = '';
        await this.loadPostComments(this.activeCommentPostId);
        await this.loadFeedPosts();
      } else {
        this.showToast(data.error || 'Failed to submit comment.', 'error');
      }
    } catch (e) {
      this.showToast('Network error submitting comment.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // ─── Visiting Other Profiles ─────────────────────────────────────────────────
  async viewUserProfile(userId) {
    if (userId === this.user.id) {
      this.exitUserProfile();
      return;
    }

    try {
      const res = await fetch('/api/profile/details/' + userId);
      if (res.ok) {
        const data = await res.json();
        
        this.viewedUserId = userId;
        this.viewedUser = data.user;

        this.currentProfileTab = 'feed';

        this.renderProfileUI();
        await this.showProfileMainSubTab('feed');
        this.navigateTo('profile', { preserveViewed: true });
      } else {
        this.showToast('Failed to load user profile.', 'error');
      }
    } catch (e) {
      this.showToast('Network error loading profile.', 'error');
    }
  },

  handleProfileBack() {
    if (this.viewedUserId) {
      this.exitUserProfile();
    } else {
      this.navigateTo('dashboard');
    }
  },

  exitUserProfile() {
    this.viewedUserId = null;
    this.viewedUser = null;
    
    this.currentProfileTab = 'feed';

    this.renderProfileUI();
    this.showProfileMainSubTab('feed');
    this.navigateTo('profile');
  },

  formatTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const seconds = Math.floor((new Date() - date) / 1000);
    
    let interval = Math.floor(seconds / 31536000);
    if (interval >= 1) return interval + "y ago";
    interval = Math.floor(seconds / 2592000);
    if (interval >= 1) return interval + "mo ago";
    interval = Math.floor(seconds / 86400);
    if (interval >= 1) return interval + "d ago";
    interval = Math.floor(seconds / 3600);
    if (interval >= 1) return interval + "h ago";
    interval = Math.floor(seconds / 60);
    if (interval >= 1) return interval + "m ago";
    
    return "just now";
  },

  handleThemeToggle(el) {
    const isDark = el.checked;
    const theme = isDark ? 'dark' : 'light';
    localStorage.setItem('gainex_theme', theme);
    
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
    
    // Refresh swap badges if they exist on screen
    const paySelect = document.getElementById('swap-pay-select');
    const receiveSelect = document.getElementById('swap-receive-select');
    if (paySelect) this.updateSwapBadge('swap-pay-badge', paySelect.value);
    if (receiveSelect) this.updateSwapBadge('swap-receive-badge', receiveSelect.value);
    
    this.updateLogoImages(theme);
    
    if (window.chart) {
      window.chart.applyTheme(theme);
    }
    this.showToast(`${theme === 'dark' ? 'Dark' : 'Light'} mode enabled`, 'success');
  },

  handleTimezoneChange(val) {
    localStorage.setItem('gainex_timezone', val);
    
    // Show global page loader and display reload toast
    this.showGlobalLoader();
    this.showToast(`Timezone changed to ${val === 'AUTO' ? 'Auto (System)' : val}. Reloading...`, 'success');
    
    // Perform page reload after 800ms to cleanly refresh the entire application state with new timezone
    setTimeout(() => {
      window.location.reload();
    }, 800);
  },

  updateLogoImages(theme) {
    const isLight = theme === 'light';
    const logoLightSrc = '/logo-light.png';
    const logoDarkSrc = '/logo-dark.png';
    
    const logoElements = document.querySelectorAll(
      '.logo-mobile, .logo-desktop, .header-logo-img, .splash-logo, .trade-logo-area img, .trade-logo-img, .auth-logo-img'
    );
    
    logoElements.forEach(img => {
      img.src = isLight ? logoLightSrc : logoDarkSrc;
    });
  },

  handleEmailNotificationsToggle(el) {
    const isEnabled = el.checked;
    localStorage.setItem('gainex_email_notifications', isEnabled ? 'true' : 'false');
    this.showToast(isEnabled ? 'Email notifications enabled' : 'Email notifications disabled', 'success');
  },

  currencyRates: {},
  
  async loadCurrencies() {
    try {
      const res = await fetch('/api/public/currencies');
      if (res.ok) {
        const data = await res.json();
        this.currencyRates = data.currencies || {};
        for (const code of Object.keys(this.currencyRates)) {
          if (!this.CURRENCY_SYMBOLS[code]) {
            this.CURRENCY_SYMBOLS[code] = code + ' ';
          }
        }
        this.populateCurrencySelects();
      }
    } catch (e) {
      console.warn('Failed to load currencies:', e);
    }
  },

  isCryptoCurrency(code) {
    return ['BTC', 'ETH', 'BNB', 'SOL', 'USDT', 'USDC'].includes((code || '').toUpperCase());
  },

  populateCurrencySelects() {
    const signupSelect = document.getElementById('signup-currency');
    if (signupSelect && signupSelect.tagName === 'SELECT') {
      signupSelect.innerHTML = '';
      Object.keys(this.currencyRates).forEach(code => {
        if (this.isCryptoCurrency(code)) return;
        const symbol = this.CURRENCY_SYMBOLS[code] ? ` (${this.CURRENCY_SYMBOLS[code].trim()})` : '';
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${code}${symbol}`;
        signupSelect.appendChild(opt);
      });
    }

    const paySelect = document.getElementById('swap-pay-select');
    if (paySelect) {
      paySelect.innerHTML = '';
      Object.keys(this.currencyRates).forEach(code => {
        if (this.isCryptoCurrency(code)) return;
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code;
        paySelect.appendChild(opt);
      });
    }

    const receiveSelect = document.getElementById('swap-receive-select');
    if (receiveSelect) {
      receiveSelect.innerHTML = '';
      Object.keys(this.currencyRates).forEach(code => {
        if (this.isCryptoCurrency(code)) return;
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code;
        receiveSelect.appendChild(opt);
      });
    }

    // Populate custom dropdown menus
    this.populateCustomSwapDropdowns();
  },

  getRateInUnitsPerUsd(code, rawRate) {
    const codeUpper = code.toUpperCase();
    if (codeUpper === 'USD') return 1.0;
    if (['BTC', 'ETH', 'BNB', 'SOL'].includes(codeUpper)) {
      return 1.0 / (rawRate || 1.0);
    }
    return rawRate || 1.0;
  },

  getCurrencySymbolText(code) {
    const symbols = {
      USD: '$',
      USDT: '₮',
      USDC: 'C',
      BNB: 'B',
      BTC: '₿',
      ETH: 'Ξ',
      SOL: 'S',
      PKR: '₨',
      INR: '₹',
      BDT: '৳',
      NPR: '₨',
      GBP: '£',
      BRL: 'R$',
      IDR: 'Rp',
      MYR: 'RM',
      KZT: '₸',
      THB: '฿',
      UAH: '₴',
      VND: '₫',
      NGN: '₦',
      EGP: 'E£',
      MXN: 'MX$',
      JPY: '¥',
      PHP: '₱',
      TRY: '₺',
      KRW: '₩'
    };
    return symbols[code.toUpperCase()] || code.substring(0, 1).toUpperCase();
  },

  populateCustomSwapDropdowns() {
    if (!this.user) return;
    const activeCurrency = (this.user.currency || 'USD').toUpperCase();
    const paySelect = document.getElementById('swap-pay-select');
    const receiveSelect = document.getElementById('swap-receive-select');
    if (!paySelect || !receiveSelect) return;

    // Enforce that Pay currency is ALWAYS locked to the active currency
    paySelect.value = activeCurrency;

    const payMenu = document.getElementById('swap-pay-menu');
    const receiveMenu = document.getElementById('swap-receive-menu');

    // Pay list only has the active wallet currency
    const payList = [activeCurrency];

    // Receive list has all other available fiat currencies (excluding crypto and the active currency itself)
    const allFiats = Object.keys(this.currencyRates).filter(c => !this.isCryptoCurrency(c));
    const receiveList = allFiats.filter(c => c !== activeCurrency);

    // Now populate payMenu
    if (payMenu) {
      payMenu.innerHTML = '';
      payList.forEach(code => {
        const item = document.createElement('div');
        item.className = 'swap-dropdown-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '10px';
        item.style.padding = '8px 12px';
        item.style.borderRadius = '10px';
        item.style.cursor = 'pointer';
        item.style.transition = 'background 0.2s';
        
        const badgeColor = this.getCurrencyColor(code);
        const isLightTheme = document.body.classList.contains('light-theme');
        item.innerHTML = `
          <div class="swap-dropdown-item-badge" style="width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0; ${isLightTheme ? 'background: rgba(0,0,0,0.05) !important; color: #000000 !important;' : `background: ${badgeColor}; color: #ffffff;`}">${this.getCurrencySymbolText(code)}</div>
          <span class="swap-dropdown-item-code" style="font-size: 14px; font-weight: 600;">${code}</span>
        `;
        item.onclick = (e) => this.handleCustomSelect('pay', code, e);
        item.onmouseenter = () => { item.style.background = 'rgba(16, 185, 129, 0.12)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        payMenu.appendChild(item);
      });
    }

    // Now populate receiveMenu
    if (receiveMenu) {
      receiveMenu.innerHTML = '';
      receiveList.forEach(code => {
        const item = document.createElement('div');
        item.className = 'swap-dropdown-item';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.gap = '10px';
        item.style.padding = '8px 12px';
        item.style.borderRadius = '10px';
        item.style.cursor = 'pointer';
        item.style.transition = 'background 0.2s';
        
        const badgeColor = this.getCurrencyColor(code);
        const isLightTheme = document.body.classList.contains('light-theme');
        item.innerHTML = `
          <div class="swap-dropdown-item-badge" style="width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; flex-shrink: 0; ${isLightTheme ? 'background: rgba(0,0,0,0.05) !important; color: #000000 !important;' : `background: ${badgeColor}; color: #ffffff;`}">${this.getCurrencySymbolText(code)}</div>
          <span class="swap-dropdown-item-code" style="font-size: 14px; font-weight: 600;">${code}</span>
        `;
        item.onclick = (e) => this.handleCustomSelect('receive', code, e);
        item.onmouseenter = () => { item.style.background = 'rgba(16, 185, 129, 0.12)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        receiveMenu.appendChild(item);
      });
    }
  },

  toggleSwapDropdown(type, event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(`swap-${type}-menu`);
    const otherType = type === 'pay' ? 'receive' : 'pay';
    const otherMenu = document.getElementById(`swap-${otherType}-menu`);
    const arrow = document.getElementById(`swap-${type}-arrow`);
    const otherArrow = document.getElementById(`swap-${otherType}-arrow`);
    
    if (otherMenu) otherMenu.style.display = 'none';
    if (otherArrow) otherArrow.style.transform = 'rotate(0deg)';

    // Reset z-indexes of both cards
    const payCard = document.getElementById('swap-pay-select')?.closest('.swap-card');
    const receiveCard = document.getElementById('swap-receive-select')?.closest('.swap-card');
    if (payCard) payCard.style.zIndex = '1';
    if (receiveCard) receiveCard.style.zIndex = '1';
    
    if (menu) {
      const isOpen = menu.style.display === 'block';
      menu.style.display = isOpen ? 'none' : 'block';
      if (arrow) {
        arrow.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
      }
      
      // Elevate active card z-index to 999 when opening
      if (!isOpen) {
        const activeCard = document.getElementById(`swap-${type}-select`)?.closest('.swap-card');
        if (activeCard) activeCard.style.zIndex = '999';
      }
    }
  },

  handleCustomSelect(type, code, event) {
    if (event) event.stopPropagation();
    const select = document.getElementById(`swap-${type}-select`);
    if (select) {
      select.value = code;
      if (type === 'pay') {
        this.handleSwapPaySelectChange();
      } else {
        this.handleSwapReceiveSelectChange();
      }
    }
    const menu = document.getElementById(`swap-${type}-menu`);
    if (menu) menu.style.display = 'none';
    const arrow = document.getElementById(`swap-${type}-arrow`);
    if (arrow) arrow.style.transform = 'rotate(0deg)';

    const card = select?.closest('.swap-card');
    if (card) card.style.zIndex = '1';
    
    // Refresh lists based on the newly selected options
    this.populateCustomSwapDropdowns();
  },

  getCurrencyColor(code) {
    const colors = {
      USD: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      USDT: 'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)',
      USDC: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
      BNB: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
      BTC: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
      ETH: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
      SOL: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
      PKR: 'linear-gradient(135deg, #15803d 0%, #166534 100%)',
      INR: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)',
      BDT: 'linear-gradient(135deg, #047857 0%, #065f46 100%)',
      NPR: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)'
    };
    return colors[code.toUpperCase()] || 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)';
  },

  updateSwapBadge(elementId, code) {
    const badge = document.getElementById(elementId);
    if (!badge) return;
    badge.textContent = this.getCurrencySymbolText(code);
    
    const isLightTheme = document.body.classList.contains('light-theme');
    if (isLightTheme) {
      badge.style.setProperty('background', 'rgba(0, 0, 0, 0.05)', 'important');
      badge.style.setProperty('color', '#000000', 'important');
    } else {
      badge.style.setProperty('background', this.getCurrencyColor(code), 'important');
      badge.style.setProperty('color', '#ffffff', 'important');
    }
  },

  calculateSwapPreview() {
    if (!this.user) return;
    
    const paySelect = document.getElementById('swap-pay-select');
    const receiveSelect = document.getElementById('swap-receive-select');
    const payInput = document.getElementById('swap-pay-input');
    const receiveInput = document.getElementById('swap-receive-input');
    
    if (!paySelect || !receiveSelect || !payInput || !receiveInput) return;
    
    const payCode = paySelect.value;
    const receiveCode = receiveSelect.value;
    
    const payAmount = parseFloat(payInput.value) || 0;
    
    const currentCode = (this.user.currency || 'USD').toUpperCase();
    const payRateRaw = this.currencyRates[payCode] || 1.0;
    const receiveRateRaw = this.currencyRates[receiveCode] || 1.0;
    
    const payRate = this.getRateInUnitsPerUsd(payCode, payRateRaw);
    const receiveRate = this.getRateInUnitsPerUsd(receiveCode, receiveRateRaw);
    
    const multiplier = receiveRate / payRate;
    const convertedAmount = payAmount * multiplier;
    
    const decimals = ['BTC', 'ETH', 'BNB', 'SOL'].includes(receiveCode) ? 8 : 4;
    receiveInput.value = convertedAmount.toFixed(decimals);
    
    // Update Badge display
    this.updateSwapBadge('swap-pay-badge', payCode);
    this.updateSwapBadge('swap-receive-badge', receiveCode);
    
    const payCodeSpan = document.getElementById('swap-pay-code');
    if (payCodeSpan) payCodeSpan.textContent = payCode;
    
    const receiveCodeSpan = document.getElementById('swap-receive-code');
    if (receiveCodeSpan) receiveCodeSpan.textContent = receiveCode;
    
    // Fiat approx calculations (rate to USD)
    const usdApproxPay = payAmount / payRate;
    const usdApproxReceive = convertedAmount / receiveRate;
    
    const payApproxEl = document.getElementById('swap-pay-fiat-approx');
    if (payApproxEl) {
      payApproxEl.textContent = `≈ $${usdApproxPay.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} USD`;
    }
    
    const receiveApproxEl = document.getElementById('swap-receive-fiat-approx');
    if (receiveApproxEl) {
      receiveApproxEl.textContent = `≈ $${usdApproxReceive.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} USD`;
    }
    
    // Rate details: e.g. "1 BNB = 673.45108 (198.98 USD)"
    const rateText = document.getElementById('swap-rate-text');
    if (rateText) {
      const singleMultiplier = receiveRate / payRate;
      const usdPayValue = 1.0 / payRate;
      rateText.textContent = `1 ${payCode} = ${singleMultiplier.toFixed(5)} ${receiveCode} (${usdPayValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} USD)`;
    }
    
    // Fee display (e.g. 0.00)
    const feeText = document.getElementById('swap-fee-text');
    if (feeText) {
      feeText.innerHTML = `0.00 ${receiveCode} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 11px; height: 11px; display: inline-block; vertical-align: middle; margin-left: 2px;"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    }

    // Dynamic Balance display
    const payBalEl = document.getElementById('swap-pay-balance-text');
    if (payBalEl) {
      if (payCode === currentCode) {
        payBalEl.textContent = this.formatCurrency(this.user.balance, currentCode);
      } else {
        const payRateCurrent = this.getRateInUnitsPerUsd(currentCode, this.currencyRates[currentCode] || 1.0);
        const payBalEquivalent = (this.user.balance || 0) * (payRate / payRateCurrent);
        payBalEl.textContent = this.formatCurrency(payBalEquivalent, payCode);
      }
    }

    const receiveBalEl = document.getElementById('swap-receive-balance-text');
    if (receiveBalEl) {
      if (receiveCode === currentCode) {
        receiveBalEl.textContent = this.formatCurrency(this.user.balance, currentCode);
      } else {
        const payRateCurrent = this.getRateInUnitsPerUsd(currentCode, this.currencyRates[currentCode] || 1.0);
        const receiveBalEquivalent = (this.user.balance || 0) * (receiveRate / payRateCurrent);
        receiveBalEl.textContent = this.formatCurrency(receiveBalEquivalent, receiveCode);
      }
    }
  },

  handleSwapMax() {
    if (!this.user) return;
    const paySelect = document.getElementById('swap-pay-select');
    const payInput = document.getElementById('swap-pay-input');
    if (!paySelect || !payInput) return;
    
    const payCode = paySelect.value;
    const currentCode = (this.user.currency || 'USD').toUpperCase();
    
    if (payCode === currentCode) {
      const precision = ['BTC', 'ETH', 'BNB', 'SOL'].includes(payCode) ? 6 : 2;
      payInput.value = (this.user.balance || 0).toFixed(precision);
    } else {
      const payRate = this.getRateInUnitsPerUsd(payCode, this.currencyRates[payCode] || 1.0);
      const currentRate = this.getRateInUnitsPerUsd(currentCode, this.currencyRates[currentCode] || 1.0);
      const payBalEquivalent = (this.user.balance || 0) * (payRate / currentRate);
      const precision = ['BTC', 'ETH', 'BNB', 'SOL'].includes(payCode) ? 6 : 2;
      payInput.value = payBalEquivalent.toFixed(precision);
    }
    
    this.calculateSwapPreview();
  },

  handleSwapPaySelectChange() {
    this.calculateSwapPreview();
    this.populateCustomSwapDropdowns();
  },
  
  handleSwapReceiveSelectChange() {
    this.calculateSwapPreview();
    this.populateCustomSwapDropdowns();
  },

  handleSwapPayInput() {
    this.calculateSwapPreview();
  },

  handleSwapDirection() {
    // Disabled: Pay is always locked to active wallet currency
  },

  initConvertCurrencyScreen() {
    if (!this.user) return;
    const currentCode = (this.user.currency || 'USD').toUpperCase();
    
    this.populateCurrencySelects();

    const paySelect = document.getElementById('swap-pay-select');
    if (paySelect) {
      paySelect.value = currentCode;
      this.updateSwapBadge('swap-pay-badge', currentCode);
    }

    const receiveSelect = document.getElementById('swap-receive-select');
    if (receiveSelect) {
      // Find all available fiat currencies except the current pay currency
      const availableFiats = Object.keys(this.currencyRates).filter(code => 
        code.toUpperCase() !== currentCode && !this.isCryptoCurrency(code)
      );
      
      let targetCode = 'USD';
      if (availableFiats.length > 0) {
        // Choose a random currency from the list
        const randomIndex = Math.floor(Math.random() * availableFiats.length);
        targetCode = availableFiats[randomIndex];
      }
      
      receiveSelect.value = targetCode;
      this.updateSwapBadge('swap-receive-badge', targetCode);
    }

    const payInput = document.getElementById('swap-pay-input');
    if (payInput) {
      payInput.value = parseFloat(this.user.balance || 0).toFixed(2);
    }

    this.calculateSwapPreview();
    this.populateCustomSwapDropdowns();
    this.initSlideToSwap();
  },

  initSlideToSwap() {
    const handle = document.getElementById('swap-slide-handle');
    const container = document.getElementById('swap-slide-container');
    if (!handle || !container) return;

    handle.style.left = '5px';
    handle.style.transition = 'none';
    const progress = document.getElementById('swap-slide-progress');
    if (progress) {
      progress.style.width = '0px';
      progress.style.transition = 'none';
    }

    let isDragging = false;
    let startX = 0;
    let maxSlide = 0;

    const onStart = (e) => {
      isDragging = true;
      startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
      handle.style.transition = 'none';
      maxSlide = container.clientWidth - handle.clientWidth - 10;

      if (progress) {
        progress.style.transition = 'none';
      }
      
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);

      document.body.style.userSelect = 'none';
    };

    const onMove = (e) => {
      if (!isDragging) return;
      
      if (e.cancelable) {
        e.preventDefault();
      }

      const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
      let diff = currentX - startX;
      if (diff < 0) diff = 0;
      if (diff > maxSlide) diff = maxSlide;
      handle.style.left = `${diff + 5}px`;

      if (progress) {
        progress.style.width = `${diff + 32}px`;
      }

      const text = document.getElementById('swap-slide-text');
      if (text) {
        text.style.opacity = Math.max(0, 1 - (diff / (maxSlide * 0.7)));
      }
    };

    const onEnd = () => {
      if (!isDragging) return;
      isDragging = false;
      
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);

      document.body.style.userSelect = '';

      const currentLeft = parseFloat(handle.style.left) - 5;
      if (currentLeft >= maxSlide - 5) {
        handle.style.left = `${maxSlide + 5}px`;
        if (progress) {
          progress.style.width = '100%';
        }
        this.submitConvertCurrency();
      } else {
        handle.style.transition = 'left 0.2s ease';
        handle.style.left = '5px';
        if (progress) {
          progress.style.transition = 'width 0.2s ease';
          progress.style.width = '0px';
        }
        const text = document.getElementById('swap-slide-text');
        if (text) text.style.opacity = '1';
      }
    };

    handle.onmousedown = onStart;
    handle.ontouchstart = onStart;
  },

  async submitConvertCurrency() {
    const paySelect = document.getElementById('swap-pay-select');
    const receiveSelect = document.getElementById('swap-receive-select');
    if (!paySelect || !receiveSelect || !paySelect.value || !receiveSelect.value) {
      this.showToast('Please select target currency.', 'error');
      this.resetSwapSlider();
      return;
    }

    const payCode = paySelect.value;
    const targetCode = receiveSelect.value;
    const currentCode = (this.user.currency || 'USD').toUpperCase();

    if (payCode !== currentCode) {
      this.showToast(`Your wallet is in ${currentCode}. Set "You Pay" to ${currentCode} to swap.`, 'error');
      paySelect.value = currentCode;
      this.calculateSwapPreview();
      this.resetSwapSlider();
      return;
    }

    if (this.isCryptoCurrency(payCode) || this.isCryptoCurrency(targetCode)) {
      this.showToast('Cryptocurrency conversions are not supported.', 'error');
      this.resetSwapSlider();
      return;
    }

    if (targetCode === currentCode) {
      this.showToast('Already in target currency.', 'error');
      this.resetSwapSlider();
      return;
    }

    try {
      const res = await fetch('/api/client/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetCurrency: targetCode })
      });
      const data = await res.json();
      if (res.ok) {
        this.user = data.user;
        this.showToast(`Converted successfully to ${targetCode}!`);
        
        this.renderProfileUI();
        this.updateBalanceDisplays();
        this.initConvertCurrencyScreen();
        this.updateDefaultInvestmentAmount();
      } else {
        this.showToast(data.error || 'Conversion failed.', 'error');
        this.resetSwapSlider();
      }
    } catch (e) {
      this.showToast('Network error during conversion.', 'error');
      this.resetSwapSlider();
    }
  },

  resetSwapSlider() {
    const handle = document.getElementById('swap-slide-handle');
    if (handle) {
      handle.style.transition = 'left 0.2s ease';
      handle.style.left = '5px';
    }
    const progress = document.getElementById('swap-slide-progress');
    if (progress) {
      progress.style.transition = 'width 0.2s ease';
      progress.style.width = '0px';
    }
    const text = document.getElementById('swap-slide-text');
    if (text) text.style.opacity = '1';
  },

  handleConvertBack() {
    if (this.prevTab === 'dashboard') {
      this.navigateTo('dashboard');
    } else {
      this.navigateTo('profile');
      this.showProfileSubScreen('main');
    }
  },

  copyInviteCode(code) {
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      this.showToast('Invite code copied to clipboard!', 'success');
    }).catch(err => {
      console.error('Failed to copy invite code:', err);
      // Fallback
      const tempInput = document.createElement('input');
      tempInput.value = code;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
      this.showToast('Invite code copied to clipboard!', 'success');
    });
  },

  copyReferralLink() {
    const inviteCode = (this.user && this.user.invite_code) ? this.user.invite_code : null;
    if (!inviteCode) return;
    const inviteLink = `${window.location.origin}/?invite=${inviteCode}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
      this.showToast('Invite link copied to clipboard!', 'success');
    }).catch(err => {
      console.error('Failed to copy invite link:', err);
      // Fallback
      const tempInput = document.createElement('input');
      tempInput.value = inviteLink;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
      this.showToast('Invite link copied to clipboard!', 'success');
    });
  },

  handleMobileCardsLayout() {
    if (window.innerWidth < 768) {
      if (!this.isMobileLayout) {
        this.isMobileLayout = true;
        const balanceCard = document.querySelector('.balance-card-wrapper');
        const visaCard = document.getElementById('dashboard-visa-card-panel');
        const slide1 = document.getElementById('mobile-slide-1');
        const slide2 = document.getElementById('mobile-slide-2');
        
        if (balanceCard && slide1) slide1.appendChild(balanceCard);
        if (visaCard && slide2) slide2.appendChild(visaCard);
        
        this.initMobileCardsSlider();
      }
    } else {
      if (this.isMobileLayout || this.isMobileLayout === undefined) {
        this.isMobileLayout = false;
        const balanceCard = document.querySelector('.balance-card-wrapper');
        const visaCard = document.getElementById('dashboard-visa-card-panel');
        const placeholder1 = document.getElementById('desktop-balance-card-placeholder');
        const placeholder2 = document.getElementById('desktop-visa-card-placeholder');
        
        if (balanceCard && placeholder1) placeholder1.appendChild(balanceCard);
        if (visaCard && placeholder2) placeholder2.appendChild(visaCard);
        
        // Reset slider track transform
        const track = document.getElementById('mobile-cards-slider-track');
        if (track) track.style.transform = 'translateX(0%)';
        const dots = document.querySelectorAll('.mobile-cards-slider .slider-dot');
        dots.forEach((dot, idx) => {
          dot.classList.toggle('active', idx === 0);
        });
        this.mobileSlideIndex = 0;
      }
    }
  },

  initMobileCardsSlider() {
    this.mobileSlideIndex = 0;
    
    // Reset track position on initialization
    const track = document.getElementById('mobile-cards-slider-track');
    if (track) track.style.transform = 'translateX(0%)';
    
    const dots = document.querySelectorAll('.mobile-cards-slider .slider-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === 0);
    });

    if (this.mobileSliderInitialized) return;
    this.mobileSliderInitialized = true;

    const slider = document.getElementById('mobile-cards-slider');
    if (!slider) return;

    let startX = 0;
    let startY = 0;
    let isSwiping = false;

    slider.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      isSwiping = true;
    }, { passive: true });

    slider.addEventListener('touchmove', (e) => {
      if (!isSwiping) return;
      const touch = e.touches[0];
      const diffX = touch.clientX - startX;
      const diffY = touch.clientY - startY;
      
      // If moving horizontally more than vertically, prevent default scrolling
      if (Math.abs(diffX) > Math.abs(diffY)) {
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    slider.addEventListener('touchend', (e) => {
      if (!isSwiping) return;
      isSwiping = false;
      
      const touch = e.changedTouches[0];
      const diffX = touch.clientX - startX;
      const diffY = touch.clientY - startY;

      if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY)) {
        if (diffX < 0) {
          // Swipe left -> Show Visa Card (Slide index 1)
          this.setMobileSlide(1);
        } else {
          // Swipe right -> Show Balance Card (Slide index 0)
          this.setMobileSlide(0);
        }
      }
    }, { passive: true });

    // Handle dots click
    dots.forEach(dot => {
      dot.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        this.setMobileSlide(idx);
      });
    });
  },

  setMobileSlide(index) {
    this.mobileSlideIndex = index;
    const track = document.getElementById('mobile-cards-slider-track');
    if (track) {
      track.style.transform = `translateX(-${index * 50}%)`;
    }
    const dots = document.querySelectorAll('.mobile-cards-slider .slider-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('active', idx === index);
    });
  },

  bindLeaderboardHover(tbody) {
    if (!tbody) return;
    let hoverTimeout = null;

    tbody.onmouseover = (e) => {
      const row = e.target.closest('.leaderboard-row');
      if (!row) return;

      const userId = row.getAttribute('data-user-id');
      if (!userId) return;

      if (this.activeHoveredRowId === userId) return;
      this.activeHoveredRowId = userId;

      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        this.showLeaderboardHoverCard(row, userId);
      }, 150);
    };

    tbody.onmouseout = (e) => {
      const row = e.target.closest('.leaderboard-row');
      if (!row) return;

      const related = e.relatedTarget;
      if (related && row.contains(related)) return;

      this.activeHoveredRowId = null;
      clearTimeout(hoverTimeout);
      this.hideLeaderboardHoverCard();
    };
  },

  showLeaderboardHoverCard(row, userId) {
    if (window.innerWidth < 768) return;

    let card = document.getElementById('leaderboard-hover-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'leaderboard-hover-card';
      card.className = 'leaderboard-hover-card';
      document.body.appendChild(card);
    }

    const rect = row.getBoundingClientRect();
    card.style.left = `${rect.right + 15}px`;
    card.style.display = 'block';

    const adjustPosition = () => {
      const cardHeight = card.offsetHeight || 180;
      let top = rect.top + window.scrollY;
      const viewportBottom = window.innerHeight + window.scrollY;
      if (top + cardHeight > viewportBottom - 15) {
        top = viewportBottom - cardHeight - 15;
      }
      if (top < window.scrollY + 10) {
        top = window.scrollY + 10;
      }
      card.style.top = `${top}px`;
    };

    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; height: 120px; color: var(--text-secondary); font-size: 11px;">
        <div style="display:inline-block; width:14px; height:14px; border:2px solid var(--primary); border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; margin-right:8px; vertical-align:middle;"></div>
        Loading statistics...
      </div>
    `;
    adjustPosition();

    fetch(`/api/client/users/${userId}/public-profile`)
      .then(res => res.json())
      .then(data => {
        if (this.activeHoveredRowId !== userId) return;

        const user = data.user || {};
        const stats = user.stats || {};
        const profitVal = Number(stats.trades_profit || 0);
        const profitColorClass = profitVal >= 0 ? 'profit' : 'loss';
        const profitSign = profitVal >= 0 ? '+' : '-';
        
        const isMe = this.user && Number(this.user.id) === Number(userId);
        let finalDisplayProfit = '';
        if (profitVal > 30000 && !isMe) {
          finalDisplayProfit = '30,000$+';
        } else {
          finalDisplayProfit = profitSign + '$' + Math.abs(profitVal).toFixed(2);
        }

        const country = user.kyc_country || 'Global';
        const avatarHtml = user.profile_pic
          ? `<img src="${user.profile_pic}" class="lh-card-avatar">`
          : `<div class="lh-card-avatar-initials">${(user.username || '').charAt(0).toUpperCase()}</div>`;

        card.innerHTML = `
          <div class="lh-card-header">
            ${avatarHtml}
            <div class="lh-card-user-info">
              <div class="lh-card-country">${country}</div>
              <div class="lh-card-username-row">
                <span class="lh-card-username">${user.full_name || user.username || ''}</span>
                ${user.badge ? `<span class="lh-card-vip" title="${user.badge.name}">${user.badge.icon}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="lh-card-divider"></div>
          <div class="lh-card-grid">
            <div>
              <div class="lh-card-stat-val">${stats.trades_count || 0}</div>
              <div class="lh-card-stat-label">Trades count</div>
            </div>
            <div>
              <div class="lh-card-stat-val">${stats.profitable_trades || 0}</div>
              <div class="lh-card-stat-label">Profitable trades</div>
            </div>
            <div>
              <div class="lh-card-stat-val ${profitColorClass}">${finalDisplayProfit}</div>
              <div class="lh-card-stat-label">Trades profit</div>
            </div>
            <div>
              <div class="lh-card-stat-val">${Number(stats.avg_profit || 0).toFixed(2)}</div>
              <div class="lh-card-stat-label">Average profit</div>
            </div>
            <div>
              <div class="lh-card-stat-val">$${Number(stats.min_trade_amount || 0).toFixed(2)}</div>
              <div class="lh-card-stat-label">Min trade amount</div>
            </div>
            <div>
              <div class="lh-card-stat-val">$${Number(stats.max_trade_amount || 0).toFixed(2)}</div>
              <div class="lh-card-stat-label">Max trade amount</div>
            </div>
          </div>
        `;
        adjustPosition();
      })
      .catch(err => {
        console.error('Hover card fetch error:', err);
        card.innerHTML = `<div style="padding: 10px; color: var(--danger); text-align: center; font-size: 12px;">Failed to load.</div>`;
        adjustPosition();
      });
  },


  hideLeaderboardHoverCard() {
    const card = document.getElementById('leaderboard-hover-card');
    if (card) card.style.display = 'none';
  },

  copyDepositAddress() {
    const textEl = document.getElementById('deposit-address-val-text');
    const address = textEl ? textEl.textContent.trim() : '';
    if (!address || address === 'ADDRESS') return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address)
        .then(() => this.showToast('Address copied to clipboard!'))
        .catch(() => this.showToast('Failed to copy address.', 'error'));
    } else {
      // Fallback selector using a temporary textarea
      const textarea = document.createElement('textarea');
      textarea.value = address;
      textarea.style.position = 'fixed'; // Avoid scrolling to bottom
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.showToast('Address copied to clipboard!');
      } catch (err) {
        this.showToast('Failed to copy address.', 'error');
      }
      document.body.removeChild(textarea);
    }
  },

  // =========================================================================
  // 🎧 SUPPORT CHAT CONTROLLER — Live Customer Support Widget
  // =========================================================================
  supportChat: {
    ably: null,
    channel: null,
    conversation: null,
    messages: [],
    isLoadingMessages: false,
    hasMoreMessages: true,
    oldestTs: null,
    replyTo: null,
    staffTypingTimeout: null,
    mediaRecorder: null,
    audioChunks: [],
    isRecordingVoice: false,
    voiceTimerInterval: null,
    voiceSeconds: 0,
    isOpen: false,
    floatVisible: false,
    emojiPicker: null,
    emojiPickerOpen: false,
    _userId: null,
    isMobile() { return window.innerWidth < 768; },

    playSound(type) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(type === "new_request" ? 880 : 660, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.25);
      } catch(e) {}
    },

    async init(userId) {
      this._userId = userId;
      const btn = document.getElementById("support-float-btn");
      if (btn) app.updateSupportFloatVisibility();
      
      window.addEventListener("resize", () => {
        if (this.isOpen) {
          const body = document.getElementById("support-widget-body");
          if (this.isMobile()) {
            const mobBody = document.getElementById("support-mobile-body");
            const mob = document.getElementById("support-mobile-screen");
            const w = document.getElementById("support-widget-container");
            if (mobBody && body && body.parentNode !== mobBody) {
              mobBody.appendChild(body);
              if (mob) { mob.style.display = "flex"; mob.style.transform = "translateY(0)"; }
              if (w) { w.style.display = "none"; w.style.pointerEvents = "none"; }
            }
          } else {
            const w = document.getElementById("support-widget-container");
            const mob = document.getElementById("support-mobile-screen");
            if (w && body && body.parentNode !== w) {
              w.insertBefore(body, document.getElementById("support-file-input"));
              w.style.display = "flex";
              w.style.pointerEvents = "auto";
              w.style.transform = "translateY(0)";
              w.style.opacity = "1";
              if (mob) mob.style.display = "none";
            }
          }
        }
      });

      await this.refreshUnreadBadge();
    },

    async refreshUnreadBadge() {
      try {
        const res = await fetch("/api/support/conversation", { credentials: "include" });
        if (!res.ok) return;
        const { conversation } = await res.json();
        if (conversation && conversation.unread_count > 0) this._setBadge(conversation.unread_count);
      } catch(e) {}
    },

    _setBadge(count) {
      const show = count > 0;
      ["support-float-badge"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = count;
        el.style.display = show ? "flex" : "none";
      });
    },

    toggle() {
      if (this.isOpen) {
        this.minimize();
      } else {
        this.open();
      }
    },

    open() {
      this.isOpen = true;
      this.floatVisible = false; // Hide floating button when widget is open
      const body = document.getElementById("support-widget-body");
      if (this.isMobile()) {
        const mobBody = document.getElementById("support-mobile-body");
        if (mobBody && body) mobBody.appendChild(body);
        const mob = document.getElementById("support-mobile-screen");
        if (mob) { mob.style.display = "flex"; requestAnimationFrame(() => { mob.style.transform = "translateY(0)"; }); }
      } else {
        const w = document.getElementById("support-widget-container");
        if (w && body) {
          w.insertBefore(body, document.getElementById("support-file-input"));
          w.classList.add("open-widget");
          w.style.display = "flex";
          w.style.pointerEvents = "auto";
          requestAnimationFrame(() => { w.style.transform = "translateY(0)"; w.style.opacity = "1"; });
        }
      }
      this._setBadge(0);
      this._loadOrOpenConversation();
      app.updateSupportFloatVisibility();
    },

    close() {
      // If a conversation is active, show end-chat confirmation instead of closing
      if (this.conversation && this.conversation.status !== 'closed' && this.conversation.status !== 'resolved') {
        this.showEndConfirm();
        return;
      }
      this.isOpen = false;
      this.floatVisible = false; // Disappears when closed
      this._closeEmojiPicker();
      if (this.channel) { try { this.channel.presence.leave(); } catch(e) {} }
      const body = document.getElementById("support-widget-body");
      const w = document.getElementById("support-widget-container");
      if (w && body && body.parentNode !== w) {
        w.insertBefore(body, document.getElementById("support-file-input"));
      }
      if (this.isMobile()) {
        const mob = document.getElementById("support-mobile-screen");
        if (mob) { mob.style.transform = "translateY(100%)"; setTimeout(() => { mob.style.display = "none"; }, 300); }
      } else {
        if (w) { w.classList.remove("open-widget"); w.style.pointerEvents = "none"; w.style.transform = "translateY(20px)"; w.style.opacity = "0"; setTimeout(() => { w.style.display = "none"; }, 300); }
      }
      app.updateSupportFloatVisibility();
    },

    forceClose() {
      // Direct close without confirmation - used after conversation ends
      this.isOpen = false;
      this.floatVisible = false; // Disappears when closed
      this._closeEmojiPicker();
      if (this.channel) { try { this.channel.presence.leave(); } catch(e) {} }
      const body = document.getElementById("support-widget-body");
      const w = document.getElementById("support-widget-container");
      if (w && body && body.parentNode !== w) {
        w.insertBefore(body, document.getElementById("support-file-input"));
      }
      if (this.isMobile()) {
        const mob = document.getElementById("support-mobile-screen");
        if (mob) { mob.style.transform = "translateY(100%)"; setTimeout(() => { mob.style.display = "none"; }, 300); }
      } else {
        if (w) { w.classList.remove("open-widget"); w.style.pointerEvents = "none"; w.style.transform = "translateY(20px)"; w.style.opacity = "0"; setTimeout(() => { w.style.display = "none"; }, 300); }
      }
      app.updateSupportFloatVisibility();
    },

    minimize() {
      this.isOpen = false;
      this.floatVisible = true; // Show floating button when minimized
      const body = document.getElementById("support-widget-body");
      const w = document.getElementById("support-widget-container");
      if (w && body && body.parentNode !== w) {
        w.insertBefore(body, document.getElementById("support-file-input"));
      }
      if (this.isMobile()) {
        const mob = document.getElementById("support-mobile-screen");
        if (mob) { mob.style.transform = "translateY(100%)"; setTimeout(() => { mob.style.display = "none"; }, 300); }
      } else {
        if (w) { w.classList.remove("open-widget"); w.style.pointerEvents = "none"; w.style.transform = "translateY(20px)"; w.style.opacity = "0"; setTimeout(() => { w.style.display = "none"; }, 300); }
      }
      app.updateSupportFloatVisibility();
    },

    goBack() {
      if (this.conversation) {
        this.conversation = null;
        this.messages = [];
        this.oldestTs = null;
        if (this.channel) {
          try {
            this.channel.presence.leave();
            this.channel.detach();
          } catch(e) {}
          this.channel = null;
        }
        localStorage.setItem('support_chat_prefer_welcome', 'true');
        this._loadWelcomeScreen();
      } else {
        this.close();
      }
    },

    _showScreen(name) {
      ["support-welcome-screen","support-loading-screen","support-chat-screen","support-ended-screen"].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = (id === name) ? "flex" : "none";
      });
      // Always hide confirmation popup when changing screens
      const popup = document.getElementById("support-end-confirm-popup");
      if (popup) popup.style.display = "none";
      const dbb = document.getElementById("support-desktop-back-btn");
      const mbb = document.getElementById("support-mobile-back-btn");
      if (dbb) {
        dbb.style.display = (name === "support-chat-screen" || name === "support-ended-screen") ? "flex" : "none";
      }
      if (mbb) {
        mbb.style.display = (name === "support-chat-screen" || name === "support-ended-screen") ? "flex" : "none";
      }
      const connBanner = document.getElementById("support-connectivity-banner");
      if (connBanner) {
        connBanner.style.display = (name === "support-chat-screen") ? "flex" : "none";
      }
    },

    async _loadWelcomeScreen() {
      this._showScreen("support-welcome-screen");
      const ws = document.getElementById("support-welcome-screen");
      if (!ws) return;
      
      let listCont = document.getElementById("support-welcome-list");
      const recentCont = document.getElementById("support-recent-chats-container");
      
      if (listCont) {
        listCont.innerHTML = "";
      }
      
      try {
        const res = await fetch("/api/support/conversations", { credentials: "include" });
        if (res.ok) {
          const { conversations } = await res.json();
          if (conversations && conversations.length > 0) {
            if (recentCont) recentCont.style.display = "flex";
            if (listCont) {
              conversations.forEach(c => {
                const item = document.createElement("div");
                item.className = "support-recent-item";
                
                item.onclick = async () => {
                  localStorage.removeItem('support_chat_prefer_welcome');
                  this.conversation = c;
                  await this._openConversation();
                };
                
                const statusColors = { waiting: "#ffc107", assigned: "#00e676", waiting_customer: "#29b6f6", resolved: "#0d9488", closed: "#9e9e9e" };
                const statusLabels = { waiting: "Waiting", assigned: "Active", waiting_customer: "Replied", resolved: "Resolved", closed: "Closed" };
                const dateStr = new Date(c.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                const lastMsgText = c.last_message_text || "No messages yet";
                const categoryStr = c.category || "General";
                
                item.innerHTML = `
                  <div style="display:flex; align-items:center; gap:12px; flex:1; min-width:0;">
                    <div style="position:relative; flex-shrink:0;">
                      <div class="support-avatar-circle" style="width:34px; height:34px; border-radius:50% !important; background:linear-gradient(135deg, #0d9488 0%, #0f766e 100%) !important; color:#ffffff !important; font-size:12px; display:flex !important; align-items:center !important; justify-content:center !important; font-weight:700 !important;">#</div>
                    </div>
                    <div style="display:flex; flex-direction:column; text-align:left; min-width:0; flex:1; gap:3px;">
                      <div style="font-weight:700; font-size:13px; color:var(--text); display:flex; align-items:center; gap:8px;">
                        Ticket #${c.id.substring(0, 8)}
                        ${c.unread_count > 0 ? `<span style="background:#0d9488; color:#fff; font-size:10px; font-weight:700; padding:1px 6px; border-radius:10px;">${c.unread_count}</span>` : ""}
                      </div>
                      <div style="font-size:11.5px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${lastMsgText}
                      </div>
                      <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                        <span style="font-size:10px; font-weight:700; background:rgba(13,148,136,0.08); color:#0d9488; padding:2px 8px; border-radius:12px; text-transform:uppercase;">${categoryStr}</span>
                        <span style="font-size:10.5px; color:var(--text-secondary); opacity:0.8;">${dateStr}</span>
                      </div>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
                    <span style="width:8px; height:8px; border-radius:50%; background:${statusColors[c.status] || "#fff"};"></span>
                    <span style="font-size:11px; font-weight:700; color:var(--text-secondary); text-transform:capitalize;">${statusLabels[c.status] || c.status}</span>
                  </div>
                `;
                listCont.appendChild(item);
              });
            }
          } else {
            if (recentCont) recentCont.style.display = "none";
          }
        } else {
          if (recentCont) recentCont.style.display = "none";
        }
      } catch(e) {
        if (recentCont) recentCont.style.display = "none";
      }
    },

    async _loadOrOpenConversation() {
      await this._loadWelcomeScreen();
    },

    async _openConversation() {
      const closed = this.conversation.status === "closed" || this.conversation.status === "resolved";
      if (closed) {
        this._showScreen("support-ended-screen");
      } else {
        this._showScreen("support-chat-screen");
      }
      this._updateStatusBanner();
      this._subscribeAbly();
      await this._loadMessages(true);
      this._markRead();
      
      this._updateHeaderDetails();
      if (closed) {
        this._populateEndedScreen();
      }
      
      const inputArea = document.getElementById("support-input-area");
      const closedNotice = document.getElementById("support-closed-notice");
      if (inputArea) inputArea.style.display = closed ? "none" : "block";
      if (closedNotice) closedNotice.style.display = closed ? "flex" : "none";
    },

    _updateStatusBanner() {
      const bar = document.getElementById("support-status-bar");
      const banner = document.getElementById("support-conv-banner");
      if (!banner || !this.conversation) return;
      const s = this.conversation.status;
      
      const labels = { 
        waiting: "Waiting for Agent ⏳", 
        assigned: "Agent Connected", 
        waiting_customer: "💬 Support replied", 
        resolved: "✔️ Resolved", 
        closed: "🔒 Closed" 
      };
      const colors = { 
        waiting: "rgba(255,165,0,0.12)", 
        assigned: "rgba(0,255,136,0.08)", 
        waiting_customer: "rgba(0,150,255,0.1)", 
        resolved: "rgba(100,200,100,0.1)", 
        closed: "rgba(150,150,150,0.1)" 
      };
      
      banner.textContent = labels[s] || s;
      banner.style.textAlign = "center";
      
      // Clear any pending timeout to hide the bar
      if (this._hideBarTimeout) {
        clearTimeout(this._hideBarTimeout);
        this._hideBarTimeout = null;
      }
      
      if (s === 'assigned') {
        if (bar) {
          bar.style.background = colors[s] || "var(--bg-body)";
          bar.style.color = "var(--text-secondary)";
          bar.style.display = "flex";
          
          this._hideBarTimeout = setTimeout(() => {
            bar.style.display = "none";
          }, 2500);
        } else {
          banner.style.background = colors[s] || "var(--bg-body)";
          banner.style.color = "var(--text-secondary)";
          banner.style.display = "block";
          
          this._hideBarTimeout = setTimeout(() => {
            banner.style.display = "none";
          }, 2500);
        }
      } else {
        if (bar) {
          bar.style.background = colors[s] || "var(--bg-body)";
          bar.style.color = "var(--text-secondary)";
          bar.style.display = "flex";
        } else {
          banner.style.background = colors[s] || "var(--bg-body)";
          banner.style.color = "var(--text-secondary)";
          banner.style.display = "block";
        }
      }

      const endBtn = document.getElementById("support-end-chat-btn");
      if (endBtn) {
        endBtn.style.display = (s !== "closed" && s !== "resolved" && s !== "waiting" && s !== "assigned") ? "inline-block" : "none";
      }
    },

    _subscribeAbly() {
      if (!this.conversation || typeof Ably === "undefined") return;
      try {
        if (!this.ably) this.ably = new Ably.Realtime({ authUrl: "/api/chat/token", authMethod: "GET" });
        if (this.channel) { try { this.channel.detach(); } catch(e) {} }
        this.channel = this.ably.channels.get("support:conversation:" + this.conversation.id);
        
        this.channel.unsubscribe();
        
        this.channel.subscribe("message", (msg) => {
          const m = msg.data;
          // Filter own messages using both String and Number comparison (handles Supabase type drift)
          if (String(m.sender_id) === String(this._userId)) return;
          // Dedup guard: skip if a real message with same ID already exists (race condition fix)
          if (m.id && !String(m.id).startsWith('tmp_') && this.messages.some(x => String(x.id) === String(m.id))) return;
          this._appendMessage(m);
          if (this.isOpen) { this._markRead(); }
          else { this._setBadge(1); this.playSound("message"); this._browserNotify("Support", m.text || "New attachment"); }
        });
        this.channel.subscribe("typing", (msg) => {
          if (Number(msg.data.userId) === Number(this._userId)) return;
          const ind = document.getElementById("support-typing-indicator");
          if (ind) {
            const txt = document.getElementById("support-typing-text");
            if (txt) {
              txt.textContent = msg.data.isBot ? "AI Assistant is typing" : "Support is typing";
            }
            ind.style.display = "flex";
          }
          clearTimeout(this.staffTypingTimeout);
          this.staffTypingTimeout = setTimeout(() => { if (ind) ind.style.display = "none"; }, 3000);
        });
        this.channel.subscribe("status_update", (msg) => {
          if (this.conversation) this.conversation.status = msg.data.status;
          this._updateStatusBanner();
          const closed = msg.data.status === "closed" || msg.data.status === "resolved";
          const ia = document.getElementById("support-input-area");
          const cn = document.getElementById("support-closed-notice");
          if (ia) ia.style.display = closed ? "none" : "block";
          if (cn) cn.style.display = closed ? "flex" : "none";
        });
        
        if (this.ably.connection.state === "connected") {
          try { this.channel.presence.enter({ userId: this._userId }); } catch(e) {}
        }
      } catch(e) { console.warn("Ably subscribe error", e); }
    },

    async _loadMessages(initial) {
      if (this.isLoadingMessages || !this.conversation) return;
      this.isLoadingMessages = true;
      try {
        let url = "/api/support/conversations/" + this.conversation.id + "/messages";
        if (!initial && this.oldestTs) url += "?before=" + encodeURIComponent(this.oldestTs);
        const res = await fetch(url, { credentials: "include" });
        const data = await res.json();
        if (initial) { this.messages = data.messages || []; this._renderAllMessages(); }
        else { const older = data.messages || []; this.messages = [...older, ...this.messages]; this._prependMessages(older); }
        this.hasMoreMessages = !!data.hasMore;
        if (this.messages.length > 0) this.oldestTs = this.messages[0].created_at;
        const btn = document.getElementById("support-load-more-btn");
        if (btn) btn.style.display = this.hasMoreMessages ? "block" : "none";
        if (initial) this._scrollToBottom();
      } catch(e) {} finally { this.isLoadingMessages = false; }
    },

    loadMoreMessages() { this._loadMessages(false); },

    _renderAllMessages() {
      const list = document.getElementById("support-messages-list");
      if (!list) return;
      list.innerHTML = "";
      this.messages.forEach(m => list.appendChild(this._buildBubble(m)));
      
      this._updateHeaderDetails();
      
      const closed = this.conversation && (this.conversation.status === "closed" || this.conversation.status === "resolved");
      if (closed) {
        this._showScreen("support-ended-screen");
        this._populateEndedScreen();
      } else if (this.messages.length === 0) {
        this._renderQuickReplies();
      }
    },

    _prependMessages(msgs) {
      const list = document.getElementById("support-messages-list");
      const area = document.getElementById("support-messages-area");
      if (!list || !area) return;
      const prev = area.scrollHeight;
      const frag = document.createDocumentFragment();
      msgs.forEach(m => frag.appendChild(this._buildBubble(m)));
      list.insertBefore(frag, list.firstChild);
      area.scrollTop = area.scrollHeight - prev;
    },

    _appendMessage(msg) {
      const list = document.getElementById("support-messages-list");
      if (!list) return;
      
      const oldChips = document.getElementById("support-quick-chips");
      if (oldChips) oldChips.remove();
      
      this.messages.push(msg);
      list.appendChild(this._buildBubble(msg));
      this._scrollToBottom();
      this._updateHeaderDetails();
    },

    _buildBubble(msg) {
      const isMine = msg.sender_id === this._userId;
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex; flex-direction:column; align-items:" + (isMine ? "flex-end" : "flex-start") + ";";
      wrap.dataset.msgId = msg.id;
      if (!isMine) {
        const lbl = document.createElement("div");
        lbl.style.cssText = "font-size:10px; color:var(--text-secondary); margin-bottom:3px; padding-left:4px;";
        if (msg.is_bot || msg.sender_name === "GainEX AI Bot" || msg.username === "GainEX AI Bot") {
          lbl.textContent = "🤖 AI Assistant";
        } else {
          lbl.textContent = msg.is_staff ? "🛡 Support Agent" : "Support";
        }
        wrap.appendChild(lbl);
      }
      const bubble = document.createElement("div");
      bubble.className = "support-msg-bubble " + (isMine ? "support-msg-mine" : "support-msg-theirs");
      if (msg.reply_to_id && msg.reply_text) {
        const q = document.createElement("div");
        q.style.cssText = "font-size:11px; border-left:2px solid " + (isMine ? "rgba(0,0,0,0.35)" : "var(--primary,#00ff88)") + "; padding:3px 8px; margin-bottom:6px; opacity:0.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        q.textContent = msg.reply_text; bubble.appendChild(q);
      }
      if (msg.text) {
        const t = document.createElement("div");
        const escapeHTML = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        let formatted = escapeHTML(msg.text);
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
        formatted = formatted.replace(/\*(.*?)\*/g, "<strong>$1</strong>");
        formatted = formatted.replace(/\n/g, "<br>");
        t.innerHTML = formatted;
        bubble.appendChild(t);
      }
      if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
          if (!att) return;
          const d = document.createElement("div"); d.className = "support-msg-attachment";
          if (att.file_type && att.file_type.startsWith("image/")) {
            const img = document.createElement("img"); img.src = att.file_url; img.alt = att.file_name; img.onclick = () => window.open(att.file_url, "_blank"); d.appendChild(img);
          } else if (att.file_type && att.file_type.startsWith("audio/")) {
            const audio = document.createElement("audio"); audio.controls = true; audio.src = att.file_url; audio.style.cssText = "max-width:200px; margin-top:6px;"; d.appendChild(audio);
          } else {
            const a = document.createElement("a"); a.href = att.file_url; a.target = "_blank";
            a.style.cssText = "font-size:12px; display:flex; align-items:center; gap:4px; margin-top:6px; color:" + (isMine ? "#000" : "var(--primary)") + ";";
            a.innerHTML = "📄 " + att.file_name; d.appendChild(a);
          }
          bubble.appendChild(d);
        });
      }
      const meta = document.createElement("div");
      meta.style.cssText = "display:flex; align-items:center; justify-content:" + (isMine ? "flex-end" : "flex-start") + "; margin-top:3px; gap:3px;";
      const timeEl = document.createElement("span"); timeEl.className = "support-msg-time";
      timeEl.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      meta.appendChild(timeEl);
      if (isMine) { const st = document.createElement("span"); st.className = "support-msg-status"; st.textContent = msg.seen_at ? "✓✓" : msg.delivered_at ? "✓" : "○"; meta.appendChild(st); }
      bubble.appendChild(meta);
      bubble.addEventListener("contextmenu", (e) => { e.preventDefault(); this._showMsgMenu(msg, e); });
      wrap.appendChild(bubble);
      return wrap;
    },

    _showMsgMenu(msg, e) {
      document.querySelectorAll(".support-ctx-menu").forEach(m => m.remove());
      const menu = document.createElement("div");
      menu.className = "support-ctx-menu";
      menu.style.cssText = "position:fixed; background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:6px 0; z-index:10001; min-width:130px; box-shadow:0 4px 20px rgba(0,0,0,0.3); font-size:13px;";
      menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + "px";
      menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + "px";
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 14px; cursor:pointer; display:flex; align-items:center; gap:8px; color:var(--text);";
      row.innerHTML = "<span>↩️</span><span>Reply</span>";
      row.onmouseover = () => row.style.background = "var(--bg-body)";
      row.onmouseout = () => row.style.background = "";
      row.onclick = () => { this._setReply(msg); menu.remove(); };
      menu.appendChild(row);
      document.body.appendChild(menu);
      setTimeout(() => { const outside = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", outside); } }; document.addEventListener("click", outside); }, 0);
    },

    _setReply(msg) {
      this.replyTo = msg;
      const p = document.getElementById("support-reply-preview");
      const t = document.getElementById("support-reply-text");
      if (p) p.style.display = "block";
      if (t) t.textContent = msg.text || "📎 Attachment";
      document.getElementById("support-message-input")?.focus();
    },

    clearReply() {
      this.replyTo = null;
      const p = document.getElementById("support-reply-preview");
      if (p) p.style.display = "none";
    },

    _scrollToBottom() {
      const area = document.getElementById("support-messages-area");
      if (area) setTimeout(() => { area.scrollTop = area.scrollHeight; }, 50);
    },

    _markRead() {
      if (!this.conversation) return;
      fetch("/api/support/conversations/" + this.conversation.id + "/read", { method: "POST", credentials: "include" }).catch(() => {});
      this._setBadge(0);
    },

    async startConversation() {
      const btn = document.getElementById("support-start-btn");
      if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
      try {
        const res = await fetch("/api/support/conversations", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
        if (res.status === 409) {
          const cr = await fetch("/api/support/conversation", { credentials: "include" });
          const cd = await cr.json();
          this.conversation = cd.conversation;
          localStorage.removeItem('support_chat_prefer_welcome');
          if (this.conversation) await this._openConversation();
          return;
        }
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          const errMsg = errorData.error || "Failed to start conversation";
          if (window.app && app.showToast) app.showToast(errMsg, "error");
          return;
        }
        const data = await res.json();
        const cr = await fetch("/api/support/conversations", { credentials: "include" });
        const cd = await cr.json();
        const newConv = cd.conversations ? cd.conversations.find(c => c.id === data.conversationId) : null;
        this.conversation = newConv;
        localStorage.removeItem('support_chat_prefer_welcome');
        if (this.conversation) await this._openConversation();
      } catch(e) {
        if (window.app && app.showToast) app.showToast("Failed to start conversation", "error");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Start New Conversation"; }
      }
    },

    async closeCurrentConversation() {
      if (!this.conversation) return;
      // Hide the confirm popup before proceeding
      const popup = document.getElementById("support-end-confirm-popup");
      if (popup) popup.style.display = "none";
      try {
        const res = await fetch("/api/support/conversations/" + this.conversation.id + "/close", {
          method: "POST",
          credentials: "include"
        });
        if (res.ok) {
          this.conversation.status = "closed";
          await this._openConversation();
        } else {
          throw new Error();
        }
      } catch(e) {
        if (window.app && app.showToast) app.showToast("Failed to close conversation", "error");
      }
    },

    showEndConfirm() {
      const popup = document.getElementById("support-end-confirm-popup");
      if (popup) popup.style.display = "flex";
    },

    hideEndConfirm() {
      const popup = document.getElementById("support-end-confirm-popup");
      if (popup) popup.style.display = "none";
    },

    async startNewFromClosed() {
      this.conversation = null; this.messages = []; this.oldestTs = null;
      if (this.channel) { try { this.channel.detach(); } catch(e) {} this.channel = null; }
      await this.startConversation();
    },

    async sendMessage() {
      if (!this.conversation) return;
      // If currently recording voice, stop and send voice message instead
      if (this.isRecordingVoice) {
        this._stopVoiceRecord();
        return;
      }
      if (this.conversation.status === "closed" || this.conversation.status === "resolved") return;
      const input = document.getElementById("support-message-input");
      const text = input ? input.value.trim() : "";
      if (!text) return;
      const tempId = "tmp_" + Date.now();
      const tempMsg = { id: tempId, conversation_id: this.conversation.id, sender_id: this._userId, text, created_at: new Date().toISOString(), delivered_at: null, seen_at: null, attachments: null, reply_to_id: this.replyTo ? this.replyTo.id : null, reply_text: this.replyTo ? this.replyTo.text : null };
      this._appendMessage(tempMsg);
      if (input) { input.value = ""; input.style.height = "auto"; }
      const replyId = this.replyTo ? this.replyTo.id : undefined;
      this.clearReply();
      this._closeEmojiPicker();
      try {
        const res = await fetch("/api/support/messages", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: this.conversation.id, text, replyToId: replyId }) });
        const data = await res.json();
        if (res.ok && data.message) {
          const el = document.querySelector("[data-msg-id=\"" + tempId + "\"]");
          if (el) {
            el.dataset.msgId = data.message.id;
            const statusEl = el.querySelector(".support-msg-status");
            if (statusEl) {
              statusEl.textContent = data.message.seen_at ? "✓✓" : data.message.delivered_at ? "✓" : "○";
            }
          }
          const idx = this.messages.findIndex(m => m.id === tempId);
          if (idx !== -1) this.messages[idx] = data.message;
        }
      } catch(e) { if (window.app && app.showToast) app.showToast("Failed to send message", "error"); }
    },

    onInput(el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
      if (this.conversation && this.channel) {
        try { this.channel.publish("typing", { userId: this._userId }); } catch(e) {}
      }
    },

    onKeyDown(e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
    },

    toggleEmojiPicker() {
      if (this.emojiPickerOpen) { this._closeEmojiPicker(); } else { this._openEmojiPicker(); }
    },

    _openEmojiPicker() {
      const container = document.getElementById("support-emoji-picker-container");
      if (!container) return;
      if (!this.emojiPicker) { this._initCustomEmojiPicker(container); }
      container.style.display = "flex";
      this.emojiPickerOpen = true;
      setTimeout(() => {
        const outside = (ev) => { if (!container.contains(ev.target) && ev.target.id !== "support-emoji-btn") { this._closeEmojiPicker(); document.removeEventListener("click", outside); } };
        document.addEventListener("click", outside);
      }, 0);
    },

    _initCustomEmojiPicker(container) {
      if (this.emojiPicker) return;
      const emojis = [
        "😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕","🤑","🤠","😈","👿","👹","👺","🤡","💩","👻","💀","☠️","👽","👾","🤖","🎃",
        "😺","😸","😹","😻","😼","😽","🙀","😿","😾",
        "👋","🤚","🖐","✋","🖖","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾",
        "🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❤️","🔥","✨","🌟","⭐","💫","💥","🎉","🎊","🎈","🎂","🎁","🎯","🏆","🥇","🎵","🎶","🎤","📷","🎥",
        "💯","👀","🙈","🙉","🙊","💸","💵","💎","💳","🪙","📱","💻","⌚","📧","✉️","📦","📥","📤","🔒","🔑","⚡","🌈","❄️","🌊","🔔","💡","🚀","🌍","🌙","☀️"
      ];
      container.innerHTML = "";
      container.style.cssText = "position:absolute; bottom:60px; left:8px; z-index:10002; border-radius:14px; box-shadow:0 8px 32px rgba(0,0,0,0.25); width:280px; height:220px; background:var(--bg-card); border:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden;";
      const header = document.createElement("div");
      header.style.cssText = "padding:8px 12px; border-bottom:1px solid var(--border); font-size:11px; font-weight:700; color:var(--text-secondary); background:var(--bg-body); flex-shrink:0; letter-spacing:0.5px; text-transform:uppercase;";
      header.textContent = "Emojis";
      container.appendChild(header);
      const grid = document.createElement("div");
      grid.style.cssText = "flex:1; overflow-y:auto; padding:6px; display:grid; grid-template-columns:repeat(8,1fr); gap:2px;";
      emojis.forEach(emo => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = "background:none; border:none; font-size:17px; cursor:pointer; padding:3px; border-radius:6px; display:flex; align-items:center; justify-content:center; line-height:1; transition:background 0.15s, transform 0.1s;";
        btn.textContent = emo;
        btn.title = emo;
        btn.onmouseover = () => { btn.style.background = "var(--bg-body)"; btn.style.transform = "scale(1.2)"; };
        btn.onmouseout = () => { btn.style.background = "none"; btn.style.transform = "scale(1)"; };
        btn.onclick = (e) => {
          e.stopPropagation();
          const input = document.getElementById("support-message-input");
          if (input) {
            const pos = input.selectionStart || input.value.length;
            input.value = input.value.slice(0, pos) + emo + input.value.slice(pos);
            input.focus();
            input.setSelectionRange(pos + emo.length, pos + emo.length);
          }
          this._closeEmojiPicker();
        };
        grid.appendChild(btn);
      });
      container.appendChild(grid);
      this.emojiPicker = true;
    },

    _closeEmojiPicker() {
      const c = document.getElementById("support-emoji-picker-container");
      if (c) c.style.display = "none";
      this.emojiPickerOpen = false;
    },

    handleFileSelect(input) {
      const file = input.files[0];
      if (!file) return;
      this._uploadFile(file);
      input.value = "";
    },

    async _uploadFile(file) {
      if (!this.conversation) return;
      const progress = document.getElementById("support-upload-progress");
      const bar = document.getElementById("support-upload-bar");
      const label = document.getElementById("support-upload-label");
      if (progress) progress.style.display = "flex";
      if (bar) bar.style.width = "10%";
      if (label) label.textContent = "Sending…";
      try {
        const msgRes = await fetch("/api/support/messages", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: this.conversation.id, text: "" }) });
        const msgData = await msgRes.json();
        if (!msgRes.ok) throw new Error("Message failed");
        if (bar) bar.style.width = "40%";
        if (label) label.textContent = "Uploading " + file.name + "…";
        const fd = new FormData(); fd.append("file", file); fd.append("messageId", msgData.message.id);
        const attRes = await fetch("/api/support/attachments", { method: "POST", credentials: "include", body: fd });
        const attData = await attRes.json();
        if (!attRes.ok) throw new Error("Upload failed");
        if (bar) bar.style.width = "100%";
        this._appendMessage({ ...msgData.message, attachments: [attData.attachment] });
      } catch(e) {
        if (window.app && app.showToast) app.showToast("Upload failed: " + e.message, "error");
      } finally {
        setTimeout(() => { if (progress) progress.style.display = "none"; if (bar) bar.style.width = "0%"; }, 600);
      }
    },

    async toggleVoiceRecord() {
      if (this.isRecordingVoice) { this._stopVoiceRecord(); } else { await this._startVoiceRecord(); }
    },

    async _startVoiceRecord() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audioChunks = [];
        this.mediaRecorder = new MediaRecorder(stream);
        this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data); };
        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.audioChunks, { type: "audio/webm" });
          const file = new File([blob], "voice_" + Date.now() + ".webm", { type: "audio/webm" });
          this._uploadFile(file);
          stream.getTracks().forEach(t => t.stop());
          // Restore mic button visibility after voice sent
          const voiceBtn = document.getElementById("support-voice-btn"); if (voiceBtn) voiceBtn.style.display = "flex";
        };
        this.mediaRecorder.start();
        this.isRecordingVoice = true;
        const bar = document.getElementById("support-voice-recording-bar"); if (bar) bar.style.display = "flex";
        // Hide mic button while recording
        const voiceBtn = document.getElementById("support-voice-btn"); if (voiceBtn) voiceBtn.style.display = "none";
        this.voiceSeconds = 0;
        this.voiceTimerInterval = setInterval(() => {
          this.voiceSeconds++;
          const t = document.getElementById("support-voice-timer");
          if (t) t.textContent = Math.floor(this.voiceSeconds / 60) + ":" + String(this.voiceSeconds % 60).padStart(2, "0");
          if (this.voiceSeconds >= 120) this._stopVoiceRecord();
        }, 1000);
      } catch(e) { if (window.app && app.showToast) app.showToast("Microphone access denied", "error"); }
    },

    _stopVoiceRecord() {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop();
      this.isRecordingVoice = false; clearInterval(this.voiceTimerInterval);
      const bar = document.getElementById("support-voice-recording-bar"); if (bar) bar.style.display = "none";
      // Mic button restored in onstop handler after file is sent
    },

    cancelVoiceRecord() {
      if (this.mediaRecorder) { this.mediaRecorder.ondataavailable = null; this.mediaRecorder.onstop = null; if (this.mediaRecorder.state !== "inactive") this.mediaRecorder.stop(); }
      this.isRecordingVoice = false; clearInterval(this.voiceTimerInterval); this.audioChunks = [];
      const bar = document.getElementById("support-voice-recording-bar"); if (bar) bar.style.display = "none";
      // Restore mic button immediately on cancel
      const voiceBtn = document.getElementById("support-voice-btn"); if (voiceBtn) voiceBtn.style.display = "flex";
    },

    _browserNotify(title, body) {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      try { new Notification(title, { body, icon: "/favicon.ico" }); } catch(e) {}
    },

    // Legacy compat
    syncGlobalUnreadBadge() { this.refreshUnreadBadge(); },

    _getAgentName() {
      // Never leak raw staff usernames (e.g. "admin") to customers —
      // the widget always presents the branded support identity.
      return "Support Agent";
    },

    _updateHeaderDetails() {
      const name = this._getAgentName();
      const statusText = this.conversation && this.conversation.status === "assigned" ? "Connected" : "Online";
      
      const deskAvatar = document.getElementById("support-header-avatar");
      const deskStatus = document.getElementById("support-status-text");
      if (deskAvatar) {
        deskAvatar.textContent = name.substring(0, 2).toUpperCase();
        deskAvatar.style.background = "linear-gradient(135deg, #0d9488 0%, #0f766e 100%)";
        deskAvatar.style.borderRadius = "50%";
        deskAvatar.style.color = "#ffffff";
      }
      if (deskStatus) {
        deskStatus.textContent = `● ${statusText} • ${name}`;
      }
      
      const mobAvatar = document.getElementById("support-mobile-avatar");
      const mobStatus = document.getElementById("support-mobile-status");
      if (mobAvatar) {
        mobAvatar.textContent = name.substring(0, 2).toUpperCase();
        mobAvatar.style.background = "linear-gradient(135deg, #0d9488 0%, #0f766e 100%)";
        mobAvatar.style.borderRadius = "50%";
        mobAvatar.style.color = "#ffffff";
      }
      if (mobStatus) {
        mobStatus.textContent = `● ${statusText} • ${name}`;
      }
    },

    _populateEndedScreen() {
      const name = this._getAgentName();
      const ticketId = this.conversation ? this.conversation.id.substring(0, 8) : "—";
      const closedTime = this.conversation && this.conversation.closed_at 
        ? new Date(this.conversation.closed_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const category = this.conversation && this.conversation.category ? this.conversation.category : "General Inquiry";
      
      const summaryId = document.getElementById("support-summary-id");
      const summaryClosed = document.getElementById("support-summary-closed");
      const summaryAgent = document.getElementById("support-summary-agent");
      const summaryTopic = document.getElementById("support-summary-topic");
      const ratingTitle = document.getElementById("support-rating-title");
      
      if (summaryId) summaryId.textContent = `Ticket ID: #SC-${ticketId}`;
      if (summaryClosed) summaryClosed.textContent = `Closed: ${closedTime}`;
      if (summaryAgent) summaryAgent.textContent = `Agent: ${name}`;
      if (summaryTopic) summaryTopic.textContent = `Topic: ${category}`;
      if (ratingTitle) ratingTitle.textContent = `How would you rate ${name}'s help today?`;
      
      const btns = document.querySelectorAll(".support-rate-btn");
      btns.forEach(b => b.classList.remove("active"));
    },

    async submitRating(stars, btnEl) {
      if (!this.conversation) return;
      const btns = btnEl.parentNode.querySelectorAll(".support-rate-btn");
      btns.forEach(b => b.classList.remove("active"));
      btnEl.classList.add("active");
      
      const labels = [
        "😞 Terrible",
        "😕 Poor",
        "😐 Okay",
        "😊 Good",
        "😄 Excellent"
      ];
      const title = document.getElementById("support-rating-title");
      if (title) {
        title.textContent = "Thank you for your feedback! — " + labels[stars - 1];
        title.style.color = "#0d9488";
        title.style.fontWeight = "700";
      }
      
      const rect = btnEl.getBoundingClientRect();
      this._createParticles(rect.left + rect.width / 2, rect.top + rect.height / 2);
      
      try {
        await fetch("/api/support/conversations/" + this.conversation.id + "/rate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: stars })
        });
        if (window.app && app.showToast) {
          app.showToast("Rating submitted successfully!", "success");
        }
      } catch(e) {
        console.error("Failed to submit rating:", e);
      }
    },
    
    _createParticles(x, y) {
      for (let i = 0; i < 10; i++) {
        const p = document.createElement('div');
        p.style.position = 'fixed';
        p.style.left = x + 'px';
        p.style.top = y + 'px';
        p.style.width = '6px';
        p.style.height = '6px';
        p.style.backgroundColor = '#0d9488';
        p.style.borderRadius = '50%';
        p.style.pointerEvents = 'none';
        p.style.zIndex = '10002';
        document.body.appendChild(p);

        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * 40;
        const destX = x + Math.cos(angle) * dist;
        const destY = y + Math.sin(angle) * dist;

        p.animate([
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${destX - x}px, ${destY - y}px) scale(0)`, opacity: 0 }
        ], {
          duration: 600,
          easing: 'cubic-bezier(0, .9, .57, 1)'
        }).onfinish = () => p.remove();
      }
    },

    downloadTranscript() {
      if (!this.messages || this.messages.length === 0) {
        if (window.app && app.showToast) app.showToast("No messages to download", "info");
        return;
      }
      let txt = "SUPPORT CHAT TRANSCRIPT\n";
      txt += "Ticket ID: " + (this.conversation ? this.conversation.id : "N/A") + "\n";
      txt += "Date: " + new Date().toLocaleDateString() + "\n";
      txt += "--------------------------------------\n\n";
      
      this.messages.forEach(m => {
        const time = new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const sender = Number(m.sender_id) === Number(this._userId) ? "Customer (You)" : "Support Agent";
        txt += `[${time}] ${sender}: ${m.text || ""}\n`;
        if (m.attachments) {
          m.attachments.forEach(att => {
            if (att) txt += `[Attachment] ${att.file_name} (${att.file_url})\n`;
          });
        }
        txt += "\n";
      });
      
      const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "chat_transcript_" + (this.conversation ? this.conversation.id.substring(0, 8) : "support") + ".txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    _renderQuickReplies() {
      const list = document.getElementById("support-messages-list");
      if (!list) return;
      
      const oldChips = document.getElementById("support-quick-chips");
      if (oldChips) oldChips.remove();
      
      const container = document.createElement("div");
      container.id = "support-quick-chips";
      container.className = "support-quick-chips-wrapper";
      
      const chips = [
        "Deposit Help",
        "Withdrawal Status",
        "Verification Problem",
        "General Question"
      ];
      
      chips.forEach(text => {
        const chip = document.createElement("button");
        chip.className = "support-quick-chip";
        chip.textContent = text;
        chip.onclick = () => {
          const input = document.getElementById("support-message-input");
          if (input) {
            input.value = text;
            this.sendMessage();
          }
        };
        container.appendChild(chip);
      });
      
      list.appendChild(container);
    },
  },

  openPairInfoModal(event) {
    if (event) {
      event.stopPropagation();
      if (event.type === 'touchstart') {
        event.preventDefault();
      }
    }
    const backdrop = document.getElementById('pair-info-modal-backdrop');
    if (!backdrop) return;
    
    backdrop.style.display = 'flex';
    this.pairInfoOpenedAt = Date.now();
    this.updatePairInfoContent();
    
    // Start real-time price loop
    this.pairInfoInterval = setInterval(() => {
      this.updatePairInfoLivePrice();
    }, 500);
  },

  closePairInfoModal() {
    if (Date.now() - (this.pairInfoOpenedAt || 0) < 300) return;
    const backdrop = document.getElementById('pair-info-modal-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    if (this.pairInfoInterval) {
      clearInterval(this.pairInfoInterval);
      this.pairInfoInterval = null;
    }
  },

  updatePairInfoContent() {
    const assetLabel = this.selectedCoin ? (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`) : 'BTC/USDT';
    const cleanSym = assetLabel.replace(/\s*\(OTC\)/gi, '').trim();
    
    let payout = 85;
    if (this.assetPayouts && this.assetPayouts[assetLabel] !== undefined) {
      payout = parseInt(this.assetPayouts[assetLabel]);
    } else {
      const payoutMap = {
        BTC:92,ETH:88,SOL:85,BNB:82,DOGE:80,XRP:83,ADA:80,AVAX:82,
        MATIC:79,LINK:81,LTC:84,DOT:80,TRX:79,UNI:81,ATOM:80,
        'EUR/USD':92,'GBP/USD':88,'USD/JPY':86,'USD/CAD':84,'AUD/USD':83,
        'USD/CHF':82,'NZD/USD':81,'EUR/GBP':85,'EUR/JPY':84,'GBP/JPY':83,
        'USD/INR':78,'USD/PKR':76,'USD/BDT':75,'GBP/CHF':82
      };
      payout = payoutMap[cleanSym] || 80;
    }
    
    const iconWrap = document.getElementById('pair-info-icon-wrap');
    if (iconWrap) {
      iconWrap.innerHTML = this.getAssetIcon(assetLabel);
      const svg = iconWrap.querySelector('svg');
      if (svg) {
        svg.style.width = '24px';
        svg.style.height = '24px';
      }
    }
    
    const titleEl = document.getElementById('pair-info-title-text');
    if (titleEl) titleEl.textContent = assetLabel;
    
    const payoutEl = document.getElementById('pair-info-payout-badge');
    if (payoutEl) payoutEl.textContent = `${payout}%`;
    
    const p1mEl = document.getElementById('pair-info-profit-1m');
    if (p1mEl) p1mEl.textContent = `${payout}%`;
    
    const p5mEl = document.getElementById('pair-info-profit-5m');
    if (p5mEl) p5mEl.textContent = `${Math.max(10, payout - 15)}%`;
    
    const minInvestEl = document.getElementById('pair-info-min-invest');
    if (minInvestEl) {
      if (this.user && this.user.currency) {
        const cur = this.user.currency;
        if (cur === 'INR' || cur === 'Rs') minInvestEl.textContent = 'Rs150';
        else if (cur === 'PKR') minInvestEl.textContent = 'Rs300';
        else if (cur === 'BDT') minInvestEl.textContent = '৳100';
        else minInvestEl.textContent = '$1';
      } else {
        minInvestEl.textContent = '$1';
      }
    }

    const scheduleBody = document.getElementById('pair-info-schedule-body');
    if (scheduleBody) {
      const isOtc = assetLabel.toLowerCase().includes('otc');
      const tradingHours = isOtc ? '05:00 - 04:59' : '00:00 - 23:59';
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      let rowsHtml = '';
      const now = new Date();
      for (let i = 0; i < 7; i++) {
        const targetDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        const day = targetDate.getDate();
        const monthName = months[targetDate.getMonth()];
        const weekdayName = weekdays[targetDate.getDay()];
        
        rowsHtml += `
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.03); color: rgba(255,255,255,0.65);">
            <td style="padding: 8px 0; font-weight: 500;">${day} ${monthName}</td>
            <td style="padding: 8px 0; font-weight: 500;">${weekdayName}</td>
            <td style="padding: 8px 0; font-weight: 600; color: rgba(255,255,255,0.85);">${tradingHours}</td>
          </tr>
        `;
      }
      scheduleBody.innerHTML = rowsHtml;
    }
    
    this.activePairInfoTimeframe = '5m';
    this.updatePairInfoSparkline();
  },

  updatePairInfoLivePrice() {
    let currentPrice = '1.0000';
    const assetLabel = this.selectedCoin ? (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`) : 'BTC/USDT';
    const cleanSym = assetLabel.replace(/\s*\(OTC\)/gi, '').trim();
    
    if (window.chart && window.chart.candles && window.chart.candles.length > 0) {
      const candles = window.chart.candles;
      const last = candles[candles.length - 1];
      
      currentPrice = last.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      
      const first = candles[0];
      const changeVal = last.close - first.open;
      const changePct = (changeVal / first.open) * 100;
      
      const changeTextEl = document.getElementById('pair-info-change-text');
      if (changeTextEl) {
        const sign = changePct >= 0 ? '+' : '';
        changeTextEl.textContent = `${sign}${changePct.toFixed(2)}%`;
        changeTextEl.style.color = changePct >= 0 ? '#16c784' : '#ef4444';
      }
      if (last) {
        this.checkPendingTradesTrigger('quote', last.close);
      }
    }
    
    const priceEl = document.getElementById('pair-info-price-text');
    if (priceEl) priceEl.textContent = currentPrice;
    
    let buyPct = 50;
    if (window.chart && window.chart.currentSentiment !== undefined) {
      buyPct = Math.round(window.chart.currentSentiment);
    }
    const sellPct = 100 - buyPct;
    
    const buyLabel = document.getElementById('pair-info-sentiment-buy-label');
    const sellLabel = document.getElementById('pair-info-sentiment-sell-label');
    const fillBar = document.getElementById('pair-info-sentiment-bar-fill');
    const buyTitleEl = document.querySelector('.pair-info-sentiment-buy-title');
    
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      if (buyTitleEl) buyTitleEl.textContent = buyPct >= 50 ? 'Buy' : 'Sell';
      if (buyLabel) buyLabel.textContent = buyPct >= 50 ? `${buyPct}%` : `${sellPct}%`;
      if (sellLabel) sellLabel.textContent = buyPct >= 50 ? `${sellPct}%` : `${buyPct}%`;
      if (fillBar) {
        fillBar.style.width = `${buyPct}%`;
        fillBar.style.marginLeft = buyPct >= 50 ? '0' : 'auto';
      }
    } else {
      if (buyTitleEl) buyTitleEl.textContent = 'Buy';
      if (buyLabel) buyLabel.textContent = `${buyPct}%`;
      if (sellLabel) sellLabel.textContent = `${sellPct}%`;
      if (fillBar) {
        fillBar.style.width = `${buyPct}%`;
        fillBar.style.marginLeft = '0';
      }
    }
  },

  changePairInfoTimeframe(tf) {
    const tabs = ['5m', '60m', '1d'];
    tabs.forEach(t => {
      const btn = document.getElementById(`pair-info-tab-${t}`);
      if (btn) {
        if (t === tf) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });
    this.activePairInfoTimeframe = tf;
    this.updatePairInfoSparkline();
  },

  updatePairInfoSparkline() {
    const canvas = document.getElementById('pair-info-sparkline-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    if (!window.chart || !window.chart.candles || window.chart.candles.length === 0) return;
    const candles = window.chart.candles;
    
    let count = 30;
    if (this.activePairInfoTimeframe === '5m') count = 25;
    else if (this.activePairInfoTimeframe === '60m') count = 50;
    else count = 80;
    
    const sliceCandles = candles.slice(-count);
    if (sliceCandles.length === 0) return;
    
    const prices = sliceCandles.map(c => c.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRange = maxPrice - minPrice || 1;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const firstVal = prices[0];
    const lastVal = prices[prices.length - 1];
    const changeVal = lastVal - firstVal;
    const changePct = (changeVal / firstVal) * 100;
    
    const sparkChangeEl = document.getElementById('pair-info-spark-change');
    if (sparkChangeEl) {
      const sign = changePct >= 0 ? '+' : '';
      sparkChangeEl.textContent = `${sign}${changePct.toFixed(2)}%`;
      sparkChangeEl.style.color = changePct >= 0 ? '#16c784' : '#ef4444';
    }
    
    const lowEl = document.getElementById('pair-info-spark-low');
    const highEl = document.getElementById('pair-info-spark-high');
    if (lowEl) lowEl.textContent = `Low: ${minPrice.toFixed(4)}`;
    if (highEl) highEl.textContent = `High: ${maxPrice.toFixed(4)}`;
    
    ctx.beginPath();
    ctx.strokeStyle = changePct >= 0 ? '#16c784' : '#ef4444';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    const width = canvas.width;
    const height = canvas.height;
    const paddingY = 8;
    
    for (let i = 0; i < prices.length; i++) {
      const x = (i / (prices.length - 1)) * width;
      const y = height - paddingY - ((prices[i] - minPrice) / priceRange) * (height - 2 * paddingY);
      
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    const gradColor = changePct >= 0 ? 'rgba(22, 199, 132, 0.12)' : 'rgba(239, 68, 68, 0.12)';
    grad.addColorStop(0, gradColor);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();

    const val1mo = document.getElementById('pair-info-1mo-val');
    const val1yr = document.getElementById('pair-info-1yr-val');
    const valYtd = document.getElementById('pair-info-ytd-val');
    
    const val1moNum = (changePct * 2.1).toFixed(2);
    const val1yrNum = (changePct * -12.4).toFixed(2);
    const valYtdNum = (changePct * 1.5).toFixed(2);

    if (val1mo) {
      val1mo.textContent = `${val1moNum >= 0 ? '+' : ''}${val1moNum}%`;
      val1mo.style.color = val1moNum >= 0 ? '#16c784' : '#ef4444';
    }
    if (val1yr) {
      val1yr.textContent = `${val1yrNum >= 0 ? '+' : ''}${val1yrNum}%`;
      val1yr.style.color = val1yrNum >= 0 ? '#16c784' : '#ef4444';
    }
    if (valYtd) {
      valYtd.textContent = `${valYtdNum >= 0 ? '+' : ''}${valYtdNum}%`;
      valYtd.style.color = valYtdNum >= 0 ? '#16c784' : '#ef4444';
    }
  },

  // ─── Pending Trades Logic ───────────────────────────────────────────
  togglePendingTradeDrawer() {
    const drawer = document.getElementById('pending-trade-drawer');
    if (!drawer) return;

    const isVisible = drawer.style.display === 'flex';
    const toggleBtn = document.getElementById('tc-mobile-pending-toggle-btn');

    if (isVisible) {
      // Hide
      drawer.style.display = 'none';
      if (toggleBtn) toggleBtn.classList.remove('active');
      this.switchRightPanelTab('active');
      return;
    }

    // Position the drawer just to the LEFT of the trade-controls-panel (desktop)
    // On mobile it becomes a bottom sheet via CSS
    const isMobile = window.innerWidth < 768;
    if (!isMobile) {
      const panel = document.getElementById('trade-controls-panel');
      if (panel) {
        const rect = panel.getBoundingClientRect();
        // Anchor right edge of drawer to left edge of panel
        drawer.style.top    = rect.top + 'px';
        drawer.style.height = rect.height + 'px';
        drawer.style.bottom = 'auto';
        drawer.style.right  = (window.innerWidth - rect.left) + 'px';
        drawer.style.left   = 'auto';
        drawer.style.width  = '260px';
      }
    }

    // Show
    drawer.style.display = 'flex';
    if (toggleBtn) toggleBtn.classList.add('active');

    // Sync content
    this.setPendingMode(this.pendingMode || 'quote');
    this.renderPendingTrades();
    this.switchRightPanelTab('pending');
  },

  closePendingTradeDrawer() {
    const drawer = document.getElementById('pending-trade-drawer');
    if (drawer) {
      drawer.style.display = 'none';
      this.switchRightPanelTab('active');
    }
    const toggleBtn = document.getElementById('tc-mobile-pending-toggle-btn');
    if (toggleBtn) toggleBtn.classList.remove('active');
  },

  togglePendingPeriodDropdown(event) {
    if (event) event.stopPropagation();
    const dropdown = document.getElementById('pending-period-dropdown');
    if (dropdown) {
      const isVisible = dropdown.style.display === 'flex';
      dropdown.style.display = isVisible ? 'none' : 'flex';

      if (!isVisible) {
        // Self-cleaning click-away handler
        const closeDropdown = (e) => {
          if (!e.target.closest('.pdc-dropdown-trigger')) {
            dropdown.style.display = 'none';
            window.removeEventListener('click', closeDropdown);
          }
        };
        window.addEventListener('click', closeDropdown);
      }
    }
  },

  showPendingGuideModal() {
    const modal = document.getElementById('pending-guide-modal');
    if (modal) modal.style.display = 'flex';
  },

  closePendingGuideModal() {
    const modal = document.getElementById('pending-guide-modal');
    if (modal) modal.style.display = 'none';
  },

  selectPendingPeriod(value, label, event) {
    if (event) event.stopPropagation();
    const input = document.getElementById('pending-period-val');
    const display = document.getElementById('pending-period-display');
    if (input) input.value = value;
    if (display) display.textContent = label;

    // Set active option class
    const dropdown = document.getElementById('pending-period-dropdown');
    if (dropdown) {
      const options = dropdown.getElementsByClassName('pdc-dropdown-option');
      for (let opt of options) {
        opt.classList.toggle('active', opt.textContent === label);
      }
      dropdown.style.display = 'none';
    }
  },

  setPendingMode(mode) {
    this.pendingMode = mode;
    const btnQuote = document.getElementById('pending-tab-quote');
    const btnTime = document.getElementById('pending-tab-time');
    const secQuote = document.getElementById('pending-section-quote');
    const secTime = document.getElementById('pending-section-time');

    if (btnQuote) btnQuote.classList.toggle('active', mode === 'quote');
    if (btnTime) btnTime.classList.toggle('active', mode === 'time');
    if (secQuote) secQuote.style.display = mode === 'quote' ? 'block' : 'none';
    if (secTime) secTime.style.display = mode === 'time' ? 'block' : 'none';

    // Populate current price/time
    if (mode === 'quote') {
      const quoteInput = document.getElementById('pending-quote-val');
      const currentQuoteEl = document.getElementById('pending-current-quote-text');
      
      let currentPriceVal = 1.0;
      if (window.chart && window.chart.candles && window.chart.candles.length > 0) {
        const last = window.chart.candles[window.chart.candles.length - 1];
        currentPriceVal = last.close;
      }
      // Clean decimal formatting based on magnitude (e.g., BTC/ETH get 2, others get 4 or 5)
      let precision = currentPriceVal >= 100 ? 2 : (currentPriceVal >= 10 ? 4 : 5);
      let currentPrice = currentPriceVal.toFixed(precision);

      if (currentQuoteEl) currentQuoteEl.textContent = `Current quote: ${currentPrice}`;
      if (quoteInput && (!quoteInput.value || quoteInput.value === '1.6234')) {
        quoteInput.value = currentPrice;
      }
    } else {
      const timeInput = document.getElementById('pending-time-val');
      const currentTimeEl = document.getElementById('pending-current-time-text');
      
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      
      if (currentTimeEl) currentTimeEl.textContent = `Current time: ${h}:${m}:${s}`;
      if (timeInput && (!timeInput.value || timeInput.value === '23:45:00')) {
        // Set default to 2 minutes in the future
        const target = new Date(now.getTime() + 120000);
        const th = String(target.getHours()).padStart(2, '0');
        const tm = String(target.getMinutes()).padStart(2, '0');
        const ts = String(target.getSeconds()).padStart(2, '0');
        timeInput.value = `${th}:${tm}:${ts}`;
      }
    }
  },

  adjustPendingInvest(delta) {
    const el = document.getElementById('pending-invest-val');
    if (el) {
      let isPercent = el.value.includes('%') || (this.pendingStakeMode === 'percent');
      let val = parseFloat(el.value.replace('%', '')) || 0;
      val = Math.max(1, val + (isPercent ? (delta > 0 ? 1 : -1) : delta));
      el.value = val.toString() + (isPercent ? '%' : '');
    }
  },

  togglePendingStakeMode() {
    this.pendingStakeMode = this.pendingStakeMode === 'percent' ? 'amount' : 'percent';
    const input = document.getElementById('pending-invest-val');
    if (input) {
      if (this.pendingStakeMode === 'percent') {
        input.value = '1%';
      } else {
        const bal = this.user ? this.user.balance : 1000;
        input.value = Math.max(1, Math.round(bal * 0.01)).toString();
      }
    }
  },

  adjustPendingQuote(deltaMultiplier) {
    const el = document.getElementById('pending-quote-val');
    if (el) {
      const originalString = el.value.trim();
      let val = parseFloat(originalString) || 0;
      
      // Dynamically detect how many decimal places the current input value has:
      let decimals = 4;
      const dotIndex = originalString.indexOf('.');
      if (dotIndex !== -1) {
        decimals = originalString.length - dotIndex - 1;
      } else {
        decimals = 0;
      }
      
      // Determine the step size based on the value magnitude
      let step = 0.0001;
      if (val >= 1000) step = 1;
      else if (val >= 100) step = 0.1;
      else if (val >= 10) step = 0.01;
      else if (val >= 1) step = 0.001;
      
      const change = deltaMultiplier * step;
      val = Math.max(0, val + change);
      
      // Ensure we keep the decimals correct and round exactly to avoid floating point bugs
      decimals = Math.min(6, Math.max(0, decimals));
      el.value = val.toFixed(decimals);
    }
  },

  placePendingTrade(direction) {
    const assetLabel = this.selectedCoin ? (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`) : 'BTC/USDT';
    
    let target = '';
    if (this.pendingMode === 'quote') {
      const qInput = document.getElementById('pending-quote-val');
      if (!qInput || !qInput.value) {
        this.showToast('Please enter a target Quote.', 'error');
        return;
      }
      target = parseFloat(qInput.value);
      if (isNaN(target) || target <= 0) {
        this.showToast('Please enter a valid Quote price.', 'error');
        return;
      }
    } else {
      const tInput = document.getElementById('pending-time-val');
      if (!tInput || !tInput.value) {
        this.showToast('Please enter a target Time.', 'error');
        return;
      }
      target = tInput.value.trim();
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
      if (!timeRegex.test(target)) {
        this.showToast('Please enter time in HH:MM:SS format.', 'error');
        return;
      }
    }

    const periodSelect = document.getElementById('pending-period-val');
    const period = periodSelect ? periodSelect.value : '1m';

    const investInput = document.getElementById('pending-invest-val');
    let amountStr = investInput ? investInput.value : '50';
    let amount = parseFloat(amountStr) || 50;
    if (amountStr.includes('%')) {
      const percent = parseFloat(amountStr.replace('%', '')) || 1;
      const bal = this.user ? this.user.balance : 1000;
      amount = Math.max(1, Math.round(bal * (percent / 100)));
    }

    // Record the current live price at placement time so we can detect true crossover
    let priceAtPlacement = null;
    let sideAtPlacement = null; // 'below' = price was below target when placed, 'above' = price was above target
    if (this.pendingMode === 'quote') {
      // Get current live price from chart
      const livePrice = (window.chart && (window.chart.liveTickPrice || window.chart.currentPrice))
                        ? (window.chart.liveTickPrice || window.chart.currentPrice)
                        : null;
      if (livePrice !== null) {
        priceAtPlacement = parseFloat(livePrice);
        if (priceAtPlacement < target) {
          sideAtPlacement = 'below'; // price needs to rise to hit target
        } else if (priceAtPlacement > target) {
          sideAtPlacement = 'above'; // price needs to fall to hit target
        } else {
          // Price is exactly at target right now — warn user
          this.showToast('Price is already at target level. Use a market trade instead.', 'error');
          return;
        }
      }
    }

    const newPending = {
      id: Date.now(),
      coin: assetLabel,
      mode: this.pendingMode,
      target: target,
      period: period,
      amount: amount,
      direction: direction,
      priceAtPlacement: priceAtPlacement,
      sideAtPlacement: sideAtPlacement,
      createdAt: new Date().toISOString()
    };

    this.pendingTrades.push(newPending);
    localStorage.setItem('pendingTrades', JSON.stringify(this.pendingTrades));
    
    this.showToast(`Pending trade by ${this.pendingMode.toUpperCase()} placed!`, 'success');
    
    // Close drawer
    this.closePendingTradeDrawer();

    // Refresh display
    this.renderPendingTrades();
    this.updateTradesList(); // triggers counts update
  },

  cancelPendingTrade(id) {
    this.pendingTrades = this.pendingTrades.filter(t => t.id !== id);
    localStorage.setItem('pendingTrades', JSON.stringify(this.pendingTrades));
    this.renderPendingTrades();
    this.updateTradesList();
    this.showToast('Pending trade cancelled.', 'info');
  },

  renderPendingTrades() {
    const container = document.getElementById('trade-pending-mini');
    if (!container) return;

    if (this.pendingTrades.length === 0) {
      container.innerHTML = '<div class="no-trades-mini">No pending</div>';
      return;
    }

    container.innerHTML = '';
    
    this.pendingTrades.forEach(trade => {
      const card = document.createElement('div');
      card.className = 'pending-trade-card';
      
      const targetLabel = trade.mode === 'quote' ? `Quote: ${trade.target}` : `Time: ${trade.target}`;
      const dirColor = trade.direction === 'UP' ? 'text-green' : 'text-danger';
      const dirArrow = trade.direction === 'UP' ? '↑' : '↓';
      
      card.innerHTML = `
        <div class="pending-card-header">
          <span class="pending-card-asset">${trade.coin}</span>
          <button class="pending-card-cancel" onclick="app.cancelPendingTrade(${trade.id})" type="button">✖</button>
        </div>
        <div class="pending-card-info">
          <span class="${dirColor}">${trade.direction} ${dirArrow}</span>
          <span>${targetLabel}</span>
        </div>
        <div class="pending-card-info">
          <span>Amt: $${trade.amount}</span>
          <span>Period: ${trade.period}</span>
        </div>
      `;
      container.appendChild(card);
    });
  },

  checkPendingTradesTrigger(type, currentPrice) {
    if (!this.pendingTrades || this.pendingTrades.length === 0) return;

    const now = new Date();
    const currentHms = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    
    let triggeredIds = [];

    this.pendingTrades.forEach(trade => {
      if (trade.mode !== type) return;

      // Ensure we only trigger for the correct coin asset
      const tCoin = trade.coin.replace(/\s*\(OTC\)/gi, '').trim().toUpperCase();
      const sCoin = (this.selectedCoin.includes('/') ? this.selectedCoin : `${this.selectedCoin}/USDT`).replace(/\s*\(OTC\)/gi, '').trim().toUpperCase();
      if (tCoin !== sCoin) return;

      let isTriggered = false;
      if (type === 'time') {
        isTriggered = (currentHms === trade.target);
      } else if (type === 'quote') {
        const price = parseFloat(currentPrice);
        const targetPrice = parseFloat(trade.target);
        if (!isNaN(price) && !isNaN(targetPrice)) {
          if (trade.sideAtPlacement === 'below') {
            // Price was BELOW target when order was placed — trigger when price reaches or crosses ABOVE target
            isTriggered = (price >= targetPrice);
          } else if (trade.sideAtPlacement === 'above') {
            // Price was ABOVE target when order was placed — trigger when price reaches or crosses BELOW target
            isTriggered = (price <= targetPrice);
          } else {
            // Legacy orders without sideAtPlacement: use original 0.05% proximity check
            isTriggered = (Math.abs(price - targetPrice) / targetPrice) <= 0.0005;
          }
        }
      }

      if (isTriggered) {
        triggeredIds.push(trade.id);
        this.executePendingTrade(trade);
      }
    });

    if (triggeredIds.length > 0) {
      this.pendingTrades = this.pendingTrades.filter(t => !triggeredIds.includes(t.id));
      localStorage.setItem('pendingTrades', JSON.stringify(this.pendingTrades));
      this.renderPendingTrades();
      this.updateTradesList();
    }
  },

  updateTradesList() {
    this.loadUserContracts();
  },

  async executePendingTrade(trade) {
    const origCoin = this.selectedCoin;
    const origDuration = this.selectedDuration;
    const origTimeMode = this.timeMode;
    const origStakeMode = this.stakeMode;
    
    const cleanCoin = trade.coin.replace(/\s*\(OTC\)/gi, '').trim().split('/')[0];
    this.selectedCoin = cleanCoin;
    
    const origAmountEl = document.getElementById('trade-amount');
    const origAmountVal = origAmountEl ? origAmountEl.value : '';
    
    if (origAmountEl) origAmountEl.value = trade.amount.toString();
    
    const periodSecs = {
      '1m': 60, '2m': 120, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600
    }[trade.period] || 60;
    
    this.timeMode = 'countdown';
    this.stakeMode = 'amount';
    this.selectedDuration = periodSecs;
    
    try {
      await this.placeTrade(trade.direction);
      this.showToast(`Pending trade for ${trade.coin} triggered successfully!`, 'success');
    } catch (e) {
      console.error("Failed placing pending trade:", e);
    } finally {
      this.selectedCoin = origCoin;
      this.selectedDuration = origDuration;
      this.timeMode = origTimeMode;
      this.stakeMode = origStakeMode;
      if (origAmountEl) origAmountEl.value = origAmountVal;
    }
  },

  // ── i18n: Change Language ─────────────────────────────────────────────────
  changeLanguage(code) {
    if (!window.GainEX_Translations || !window.GainEX_Translations[code]) {
      this.showToast('Language not available.', 'error');
      return;
    }
    this.activeLang = code;
    localStorage.setItem('lang', code);

    // Update checkmarks in UI
    document.querySelectorAll('.lang-item').forEach(item => {
      const check = item.querySelector('.lang-check');
      if (check) {
        check.style.display = item.getAttribute('data-lang') === code ? 'block' : 'none';
      }
    });

    this.translatePage();
    this.showToast('Language updated successfully ✓', 'success');
  },

  // ── i18n: Translate All Page Text ────────────────────────────────────────
  translatePage() {
    const lang = this.activeLang || 'en';
    const translations = window.GainEX_Translations ? window.GainEX_Translations[lang] : null;
    if (!translations) return;

    // Layout direction stays LTR for all languages — only text changes

    // Reverse-lookup map: English text → translation key
    // Used ONLY on the first pass to stamp data-i18n-key on each element
    const translateMap = {
      'Home':                 'home',
      'Trade':                'trade',
      'Wallet':               'wallet',
      'History':              'history',
      'Leaderboard':          'leaderboard',
      'Profile':              'profile',
      'Up':                   'up',
      'Down':                 'down',
      'LIVE':                 'live',
      'DEMO':                 'demo',
      'Support':              'support',
      'FAQ':                  'faq',
      'Terms of service':     'terms_of_service',
      'User policy':          'user_policy',
      'Language':             'language',
      'Edit Profile':         'edit_profile',
      'Log Out':              'logout',
      'Full name':            'full_name',
      'Phone number':         'phone_number',
      'Email':                'email',
      'Username':             'username',
      'Demo Account':         'demo_account',
      'Real Account':         'real_account',
      'Deposit':              'deposit',
      'Withdraw':             'withdraw',
      'Halal':                'halal',
      'Quick Select Avatar':  'quick_select_avatar',
      'Save Changes':         'save_changes',
      'Delete Account':       'delete_account',
      'Settings':             'settings',
      'KYC Verification':     'kyc_verification',
      'Pause notifications':  'pause_notifications',
      'General settings':     'general_settings',
      'Dark mode':            'dark_mode',
      'Convert Balance':      'convert_balance',
      'Support Center':       'support_center',
    };

    // Translate a single element.
    // On first call: if element has no key stamped yet, detect from English text and stamp it.
    // On all calls: read the stamped key and apply the translation.
    const translateEl = (el) => {
      // Skip elements that are inside the language picker list (they show language names, not UI labels)
      if (el.closest && el.closest('.lang-item')) return;

      let key = el.getAttribute('data-i18n-key');

      if (!key) {
        // First pass — try to resolve key from current English text
        const text = el.textContent.trim();
        key = translateMap[text] || null;
        if (key) {
          el.setAttribute('data-i18n-key', key);
        }
      }

      if (key && translations[key]) {
        el.textContent = translations[key];
      }
    };

    // All translatable selector groups
    const selectors = [
      '.nav-label',
      '.settings-menu-item .menu-item-left > span',
      '.profile-header-center-title',
      '.profile-input-label',
      '.profile-submit-btn',
      '.profile-delete-btn',
      '.settings-logout-btn',
      '.tc-btn-title',
    ];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(translateEl);
    });

    // Halal badge — special case: only update the text node to preserve inline styles
    const halalBtn = document.getElementById('halal-label-btn');
    if (halalBtn && translations.halal) {
      // Stamp key if not yet set
      if (!halalBtn.getAttribute('data-i18n-key')) {
        halalBtn.setAttribute('data-i18n-key', 'halal');
      }
      let found = false;
      halalBtn.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          node.textContent = translations.halal;
          found = true;
        }
      });
      if (!found) {
        halalBtn.textContent = translations.halal;
      }
    }
  },

  // ── System Cache Clear Controller ─────────────────────────────────────────
  async clearSystemCache() {
    try {
      this.showToast('🧹 Clearing system cache, stored candles & offline storage...', 'info', 3000);

      // 1. Wipe Cache Storage (Service Worker caches)
      if (typeof caches !== 'undefined' && caches.keys) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        } catch (e) {
          console.warn('Cache storage clear warning:', e);
        }
      }

      // 2. Unregister active Service Workers
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        } catch (e) {
          console.warn('Service worker unregister warning:', e);
        }
      }

      // 3. Purge obsolete, large, and stale localStorage items while preserving essential session tokens
      try {
        const preservedKeys = ['gainex_jwt', 'token', 'user', 'gainex_user', 'accountType', 'lang', 'theme'];
        const preserved = {};
        preservedKeys.forEach(k => {
          const val = localStorage.getItem(k);
          if (val !== null) preserved[k] = val;
        });

        // Clear entire localStorage
        localStorage.clear();

        // Restore auth & primary preference keys
        Object.entries(preserved).forEach(([k, v]) => {
          localStorage.setItem(k, v);
        });
      } catch (e) {
        console.warn('LocalStorage clear warning:', e);
      }

      // 4. Wipe sessionStorage
      try {
        sessionStorage.clear();
      } catch (e) {}

      // 5. Feedback and hard reload with cache-busting timestamp
      this.showToast('✓ System cache cleared successfully! Reloading platform...', 'success', 2000);
      setTimeout(() => {
        const cleanUrl = window.location.origin + window.location.pathname + '?_t=' + Date.now();
        window.location.replace(cleanUrl);
      }, 800);
    } catch (err) {
      console.error('Failed clearing system cache:', err);
      this.showToast('Cache cleared. Reloading...', 'info');
      window.location.reload();
    }
  },

};

// Start application
document.addEventListener('DOMContentLoaded', () => app.init());
window.app = app;
window.closeChartResultPill = function(tradeId) {
  if (window.app && typeof window.app.removeClosedTradeFromChart === 'function') {
    window.app.removeClosedTradeFromChart(tradeId);
  }
};