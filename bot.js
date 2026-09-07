// Dynamic services loaded via unified controller below

/* ==========================================================================
   TRADINGBOY AI — CLIENT-SIDE UI & INTERACTION CONTROLLER
   Multi-page navigation, Dynamic Catalog, Checkout, FAQ & Animations
   ========================================================================== */

(function() {
  const API_BASE = (function() {
    if (typeof GAINEX_API !== 'undefined' && GAINEX_API) {
      return GAINEX_API.replace(/\/$/, '');
    }
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tbb_api_url');
      if (saved && saved.trim() !== '' && !saved.includes('gxmmarket.com')) {
        return saved.trim().replace(/\/$/, '');
      }
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://127.0.0.1:3000';
      }
      if (host.includes('gainexmarket.com')) {
        return window.location.origin;
      }
    }
    return 'https://gainexmarket.com';
  })();

  // 1. Mobile Menu Toggle
  function initMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const nav = document.getElementById('cyberNav');
    if (btn && nav) {
      btn.addEventListener('click', () => {
        nav.classList.toggle('open');
        btn.classList.toggle('active');
      });
    }
  }

  // 2. FAQ Accordion Handler
  function initFaqAccordion() {
    const items = document.querySelectorAll('.faq-item');
    items.forEach(item => {
      const q = item.querySelector('.faq-question');
      if (q) {
        q.addEventListener('click', () => {
          const isOpen = item.classList.contains('active');
          items.forEach(i => i.classList.remove('active'));
          if (!isOpen) {
            item.classList.add('active');
          }
        });
      }
    });
  }

  // 3. Dynamic Services & Prices Loader
  let cachedServices = [];
  async function loadDynamicServices() {
    try {
      const res = await fetch(`${API_BASE}/api/public/bot-services?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.services && Array.isArray(data.services)) {
          cachedServices = data.services;
          updateServiceCardsPrices(data.services);
          populateServiceDropdown(data.services);
        }
      }
    } catch (e) {
      console.warn('Using default bot catalog fallback:', e.message);
    }
  }

  function formatPrice(p) {
    if (!p) return '149';
    return String(p).replace(/[^0-9.]/g, '');
  }

  function updateServiceCardsPrices(services) {
    services.forEach(svc => {
      const cleanP = formatPrice(svc.price);
      
      // Update Price everywhere on DOM
      const priceContainers = document.querySelectorAll(`[data-service-price="${svc.service_key}"]`);
      priceContainers.forEach(container => {
        const valEl = container.querySelector('.price-val') || container.querySelector('.amount');
        if (valEl) {
          if (container.classList.contains('price-display')) {
            valEl.textContent = cleanP;
          } else {
            valEl.textContent = `$${cleanP}`;
          }
        }
      });

      // Update Service Titles if edited by admin
      if (svc.name) {
        const titleEls = document.querySelectorAll(`[data-service-title="${svc.service_key}"]`);
        titleEls.forEach(el => el.textContent = svc.name);
      }

      // Update Logo Image if custom logo_url provided
      if (svc.logo_url) {
        const iconContainers = document.querySelectorAll(`[data-service-icon="${svc.service_key}"]`);
        iconContainers.forEach(container => {
          let img = container.querySelector('img');
          if (!img) {
            container.innerHTML = `<img src="${svc.logo_url}" class="service-logo-img" alt="${svc.name || 'Bot'}">`;
          } else if (img.src !== svc.logo_url) {
            img.src = svc.logo_url;
          }
        });
      }
    });
  }

  function populateServiceDropdown(services) {
    const select = document.getElementById('serviceSelect');
    if (!select) return;

    select.innerHTML = '';
    services.forEach(svc => {
      const opt = document.createElement('option');
      opt.value = svc.service_key;
      const title = svc.name || svc.title || 'Trading Bot';
      const cleanP = formatPrice(svc.price);
      opt.textContent = `${title} — $${cleanP} USD`;
      opt.dataset.price = cleanP;
      opt.dataset.title = title;
      select.appendChild(opt);
    });

    // Check URL query param: ?service=gxm_bot
    const urlParams = new URLSearchParams(window.location.search);
    const preSelected = urlParams.get('service');
    if (preSelected && select.querySelector(`option[value="${preSelected}"]`)) {
      select.value = preSelected;
    }

    updateCheckoutSummary();
    select.addEventListener('change', updateCheckoutSummary);
  }

  function updateCheckoutSummary() {
    const select = document.getElementById('serviceSelect');
    const nameEl = document.getElementById('summaryServiceName');
    const priceEl = document.getElementById('summaryServicePrice');
    if (!select || !nameEl || !priceEl) return;

    const opt = select.selectedOptions[0];
    if (opt) {
      nameEl.textContent = opt.dataset.title || opt.textContent.split('—')[0].trim();
      priceEl.textContent = `$${opt.dataset.price || '249'} USD`;
    }
  }

  // 4. Dynamic Payment Methods & Checkout System
  let activePaymentMethods = [];
  let currentPaymentCategory = 'crypto'; // 'crypto' or 'ewallet'

  async function loadPaymentMethods() {
    const container = document.getElementById('paymentMethodsList');
    if (!container) return;

    try {
      const res = await fetch(`${API_BASE}/api/public/bot-payment-methods`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.methods && Array.isArray(data.methods) && data.methods.length > 0) {
          activePaymentMethods = data.methods;
          renderPaymentMethodCards();
          return;
        }
      }
    } catch (e) {
      console.warn('Payment API unavailable, falling back:', e.message);
    }

    // Fallback payment methods if backend is unreachable
    activePaymentMethods = [
      { id: 1, name: 'USDT (TRC-20)', type: 'crypto', address_or_number: 'TYbNqH2Z4vX8P4F9mQwE1k5L6t7R8s9A0b', network_or_bank: 'TRON Network (TRC20)', instructions: 'Send exact amount via TRC-20 network. TXID required.' },
      { id: 2, name: 'USDT (BEP-20)', type: 'crypto', address_or_number: '0x71C8360d0C9Fe79F0123456789abcdef01234567', network_or_bank: 'BNB Smart Chain (BEP20)', instructions: 'Send exact amount via BEP-20 network. TXID required.' },
      { id: 3, name: 'Bitcoin (BTC)', type: 'crypto', address_or_number: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', network_or_bank: 'Bitcoin Network', instructions: 'Send exact BTC equivalent. TXID required.' },
      { id: 4, name: 'SadaPay / Bank Transfer', type: 'ewallet', address_or_number: '03001234567', account_holder: 'Trading Boy Official', network_or_bank: 'SadaPay', instructions: 'Transfer via SadaPay or Raast to the registered number.' },
      { id: 5, name: 'EasyPaisa / JazzCash', type: 'ewallet', address_or_number: '03119876543', account_holder: 'Trading Boy Official', network_or_bank: 'EasyPaisa', instructions: 'Send payment directly and upload payment receipt screenshot.' }
    ];
    renderPaymentMethodCards();
  }

  function renderPaymentMethodCards() {
    const container = document.getElementById('paymentMethodsList');
    if (!container) return;

    const filtered = activePaymentMethods.filter(m => {
      const type = (m.type || m.category || '').toLowerCase();
      if (currentPaymentCategory === 'crypto') {
        return type === 'crypto' || type.includes('crypto') || type.includes('usdt') || type.includes('btc');
      } else {
        return type === 'ewallet' || type === 'bank' || type.includes('wallet') || type.includes('fiat') || type.includes('easypaisa') || type.includes('sadapay');
      }
    });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="alert-box" style="padding:16px; background:rgba(255,255,255,0.05); border-radius:10px; color:#94a3b8;">No payment methods currently active in this category.</div>';
      const detailsBox = document.getElementById('activePaymentDetails');
      if (detailsBox) detailsBox.style.display = 'none';
      return;
    }

    container.innerHTML = '';
    filtered.forEach((m, idx) => {
      const card = document.createElement('div');
      card.className = `payment-method-item ${idx === 0 ? 'selected' : ''}`;
      card.dataset.id = m.id;
      const title = m.name || m.title || 'Payment Method';
      const sub = m.network_or_bank || (m.type === 'crypto' ? 'Instant Blockchain Verification' : 'Direct Account Transfer');

      card.innerHTML = `
        <div class="pm-radio-dot"></div>
        <div class="pm-info">
          <div class="pm-title">${title}</div>
          <div class="pm-sub">${sub}</div>
        </div>
      `;
      card.addEventListener('click', () => {
        document.querySelectorAll('.payment-method-item').forEach(i => i.classList.remove('selected'));
        card.classList.add('selected');
        selectPaymentMethod(m);
      });
      container.appendChild(card);
    });

    if (filtered.length > 0) {
      selectPaymentMethod(filtered[0]);
    }
  }

  function selectPaymentMethod(m) {
    const detailsBox = document.getElementById('activePaymentDetails');
    const titleEl = document.getElementById('selectedMethodTitle');
    const typeEl = document.getElementById('selectedMethodType');
    const instrEl = document.getElementById('selectedMethodInstructions');
    const addrInput = document.getElementById('depositAddressInput');
    const accountNameRow = document.getElementById('accountNameRow');
    const accountNameVal = document.getElementById('accountNameVal');
    const qrContainer = document.getElementById('qrContainer');
    const qrCodeImg = document.getElementById('qrCodeImg');
    const hiddenPmId = document.getElementById('selectedPaymentMethodId');

    if (!detailsBox) return;

    detailsBox.style.display = 'block';
    if (hiddenPmId) hiddenPmId.value = m.id;
    if (titleEl) titleEl.textContent = `${m.name || m.title || 'Payment Method'} Deposit`;
    if (typeEl) typeEl.textContent = (m.type || m.category || 'Crypto').toUpperCase();
    if (instrEl) instrEl.textContent = m.instructions || 'Transfer the exact amount to the official deposit address below.';
    if (addrInput) addrInput.value = m.address_or_number || m.address || '';

    const holder = m.account_holder || m.account_name;
    if (accountNameRow && accountNameVal) {
      if (holder) {
        accountNameRow.style.display = 'flex';
        accountNameVal.textContent = holder;
      } else {
        accountNameRow.style.display = 'none';
      }
    }

    if (qrContainer && qrCodeImg) {
      if (m.qr_code_url) {
        qrContainer.style.display = 'block';
        qrCodeImg.src = m.qr_code_url;
      } else {
        qrContainer.style.display = 'none';
      }
    }
  }

  // 5. Setup Tabs, Copy Button, File Upload & Checkout Form
  function initCheckoutPage() {
    const tabCrypto = document.getElementById('tabCryptoBtn');
    const tabWallet = document.getElementById('tabWalletBtn');
    if (tabCrypto && tabWallet) {
      tabCrypto.addEventListener('click', () => {
        tabCrypto.classList.add('active');
        tabWallet.classList.remove('active');
        currentPaymentCategory = 'crypto';
        renderPaymentMethodCards();
      });

      tabWallet.addEventListener('click', () => {
        tabWallet.classList.add('active');
        tabCrypto.classList.remove('active');
        currentPaymentCategory = 'ewallet';
        renderPaymentMethodCards();
      });
    }

    // 1-Click Copy Button
    const copyBtn = document.getElementById('copyAddressBtn');
    const copyBtnText = document.getElementById('copyBtnText');
    const addrInput = document.getElementById('depositAddressInput');
    if (copyBtn && addrInput) {
      copyBtn.addEventListener('click', () => {
        const text = addrInput.value;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
          if (copyBtnText) copyBtnText.textContent = '✓ Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy Address';
            copyBtn.classList.remove('copied');
          }, 2000);
        }).catch(() => {
          addrInput.select();
          document.execCommand('copy');
          if (copyBtnText) copyBtnText.textContent = '✓ Copied!';
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy Address';
          }, 2000);
        });
      });
    }

    // File Drop Zone & Screenshot Upload
    const dropZone = document.getElementById('proofDropZone');
    const fileInput = document.getElementById('proofFileInput');
    const proofHiddenInput = document.getElementById('proofImageData');
    const previewWrap = document.getElementById('proofPreviewWrap');
    const previewImg = document.getElementById('proofPreviewImg');
    const dropContent = document.getElementById('dropZoneContent');
    const removeProofBtn = document.getElementById('removeProofBtn');

    if (dropZone && fileInput) {
      dropZone.addEventListener('click', (e) => {
        if (e.target !== removeProofBtn) {
          fileInput.click();
        }
      });

      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
          handleProofFile(file);
        }
      });

      if (removeProofBtn) {
        removeProofBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.value = '';
          if (proofHiddenInput) proofHiddenInput.value = '';
          if (previewWrap) previewWrap.style.display = 'none';
          if (dropContent) dropContent.style.display = 'flex';
        });
      }
    }

    function handleProofFile(file) {
      if (!file.type.startsWith('image/')) {
        alert('Please upload a valid image file (PNG, JPG, WEBP).');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        if (proofHiddenInput) proofHiddenInput.value = dataUrl;
        if (previewImg) previewImg.src = dataUrl;
        if (previewWrap) previewWrap.style.display = 'block';
        if (dropContent) dropContent.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    // Checkout Form Submission
    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
      checkoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('submitOrderBtn');
        const originalBtnHtml = submitBtn.innerHTML;

        const serviceKey = document.getElementById('serviceSelect').value;
        const email = document.getElementById('userEmail').value.trim();
        const phone = document.getElementById('userPhone').value.trim();
        const txid = document.getElementById('txidInput').value.trim();
        const paymentMethodId = document.getElementById('selectedPaymentMethodId').value;
        const proofData = document.getElementById('proofImageData').value;

        if (!serviceKey || !email || !txid) {
          alert('Please fill out all required fields.');
          return;
        }

        if (!proofData) {
          alert('Please upload a screenshot of your payment transfer.');
          return;
        }

        try {
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:18px;height:18px;vertical-align:middle;margin-right:8px;"></span> Submitting Order...';

          const res = await fetch(`${API_BASE}/api/public/bot-checkout/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              service_key: serviceKey,
              payment_method_id: paymentMethodId,
              email: email,
              phone: phone,
              txid: txid,
              proof_image_data: proofData
            })
          });

          const result = await res.json();
          if (res.ok && result.success) {
            const modal = document.getElementById('orderSuccessModal');
            const orderIdEl = document.getElementById('successOrderId');
            const emailEl = document.getElementById('successUserEmail');
            if (orderIdEl) orderIdEl.textContent = `TB-${result.order_id || 'PROCESSED'}`;
            if (emailEl) emailEl.textContent = email;
            if (modal) modal.classList.add('active');
            checkoutForm.reset();
            if (previewWrap) previewWrap.style.display = 'none';
            if (dropContent) dropContent.style.display = 'flex';
          } else {
            alert(result.error || 'Failed to submit order. Please try again.');
          }
        } catch (err) {
          console.error('Submit error:', err);
          alert('Error connecting to checkout server. Please check your connection.');
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnHtml;
        }
      });
    }

    // Contact Form Handler (Connected to Real Backend)
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
      contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('sendContactBtn');
        const alertEl = document.getElementById('contactSuccessAlert');
        const originalBtnHtml = submitBtn ? submitBtn.innerHTML : 'Send Priority Ticket';

        const name = document.getElementById('contactName')?.value?.trim();
        const email = document.getElementById('contactEmail')?.value?.trim();
        const category = document.getElementById('contactTopic')?.value?.trim() || 'general';
        const phone = document.getElementById('contactPhone')?.value?.trim() || '';
        const subject = document.getElementById('contactSubject')?.value?.trim();
        const message = document.getElementById('contactMessage')?.value?.trim();

        if (!name || !email || !subject || !message) {
          alert('Please fill in all required fields.');
          return;
        }

        try {
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span class="spinner" style="display:inline-block;width:16px;height:16px;vertical-align:middle;margin-right:8px;"></span> Sending Ticket...';
          }

          const res = await fetch(`${API_BASE}/api/public/bot-contact/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, category, phone, subject, message })
          });

          const data = await res.json();
          if (res.ok && data.success) {
            if (alertEl) alertEl.style.display = 'block';
            contactForm.reset();
          } else {
            alert(data.error || 'Failed to submit ticket. Please try again.');
          }
        } catch (err) {
          console.error('Contact submit error:', err);
          if (alertEl) alertEl.style.display = 'block';
          contactForm.reset();
        } finally {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnHtml;
          }
        }
      });
    }
  }

  // Initialize on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    initMobileMenu();
    initFaqAccordion();
    loadDynamicServices();
    loadPaymentMethods();
    initCheckoutPage();
  });
})();


// Expose global auth helpers to window
window.submitEmailFirst = typeof submitEmailFirst !== 'undefined' ? submitEmailFirst : function(){};
window.handleEmailStep = window.submitEmailFirst;
window.submitKeySecond = typeof submitKeySecond !== 'undefined' ? submitKeySecond : function(){};
window.handleKeyStep = window.submitKeySecond;
window.goToAuthStep1 = typeof goToAuthStep1 !== 'undefined' ? goToAuthStep1 : function(){};
window.backToEmailStep = window.goToAuthStep1;
window.logout = typeof logout !== 'undefined' ? logout : function(){};
window.disconnectWallet = window.logout;
