(function() {
  const ONESIGNAL_APP_ID = "9585c884-001d-42f2-8c59-31205c199ec8";
  let shownVerificationDialog = false;

  try {
    // Read dialog preference
    shownVerificationDialog = localStorage.getItem('gxm_os_verified') === 'true';
  } catch(e) {}

  const OneSignalWrapper = {
    init() {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async function(OneSignal) {
        await OneSignal.init({
          appId: ONESIGNAL_APP_ID,
          allowLocalhostAsSecureOrigin: true // Allows localhost testing easily
        });
        
        // Sync & bind the "Pause notifications" toggle switch in the UI
        function syncNotificationToggle() {
          const toggle = document.getElementById('settings-toggle-notifications');
          if (toggle) {
            // "Pause notifications" checkbox is checked if the user is NOT opted in
            toggle.checked = !OneSignal.User.PushSubscription.optedIn;
          }
        }

        // Initialize toggle switch state on load
        syncNotificationToggle();

        const toggle = document.getElementById('settings-toggle-notifications');
        if (toggle) {
          // Listen to manual checkbox toggles
          toggle.addEventListener('change', async function() {
            if (toggle.checked) {
              // Paused -> Opt out
              await OneSignal.User.PushSubscription.optOut();
            } else {
              // Unpaused -> Opt in & request permission if needed
              await OneSignal.User.PushSubscription.optIn();
              if (OneSignal.Notifications.permission !== "granted") {
                await OneSignal.Notifications.requestPermission();
              }
            }
          });
        }

        function checkAndShowDialog() {
          if (shownVerificationDialog) return;
          const subId = OneSignal.User.PushSubscription.id;
          // Treat as registered only when it is a server-assigned value
          if (subId && !subId.startsWith("local-")) {
            shownVerificationDialog = true;
            try {
              localStorage.setItem('gxm_os_verified', 'true');
            } catch(e) {}
            OneSignalWrapper.showVerificationDialog(OneSignal);
          }
        }

        // Register Push Subscription Observer (listening to subscription and opt-in updates)
        OneSignal.User.PushSubscription.addEventListener("change", () => {
          syncNotificationToggle();
          checkAndShowDialog();
        });

        // Robust check interval: Wait/poll for the subscription ID to resolve from the server
        let checkAttempts = 0;
        const checkInterval = setInterval(() => {
          checkAttempts++;
          syncNotificationToggle(); // keep checking in case state initializes later
          const subId = OneSignal.User.PushSubscription.id;
          if (subId && !subId.startsWith("local-")) {
            clearInterval(checkInterval);
            checkAndShowDialog();
          } else if (checkAttempts >= 30) { // check for 30 seconds
            clearInterval(checkInterval);
          }
        }, 1000);

        // Run checking logic immediately in case device is already registered
        checkAndShowDialog();
      });
    },

    login(userId) {
      if (!userId) return;
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.login(String(userId));
        OneSignal.User.addTag("userId", String(userId));
      });
    },

    logout() {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.logout();
      });
    },

    addTag(key, val) {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.User.addTag(key, String(val));
      });
    },

    removeTag(key) {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(function(OneSignal) {
        OneSignal.User.removeTag(key);
      });
    },

    showVerificationDialog(OneSignal) {
      const isLight = document.body.classList.contains('light-theme');
      
      const overlay = document.createElement('div');
      overlay.id = 'onesignal-verification-modal';
      overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 9999999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, ${isLight ? '0.35' : '0.65'});
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      `;

      const card = document.createElement('div');
      card.style.cssText = `
        background: ${isLight ? '#ffffff' : '#1a1f33'} !important;
        border: 1px solid ${isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)'} !important;
        border-radius: 20px !important;
        width: min(380px, 92vw) !important;
        overflow: hidden !important;
        box-shadow: 0 24px 80px rgba(0, 0, 0, ${isLight ? '0.15' : '0.8'}) !important;
        font-family: 'Outfit', sans-serif;
        position: relative !important;
      `;

      const accent = document.createElement('div');
      accent.style.cssText = 'height: 4px; background: linear-gradient(90deg, #3861fb, #16c784); width: 100%;';

      const body = document.createElement('div');
      body.style.cssText = 'padding: 28px 24px 24px; text-align: center;';

      const icon = document.createElement('div');
      icon.innerHTML = '🔔';
      icon.style.cssText = 'font-size: 40px; margin-bottom: 16px;';

      const title = document.createElement('div');
      title.textContent = 'Your OneSignal SDK integration is complete!';
      title.style.cssText = `
        font-size: 18px;
        font-weight: 700;
        color: ${isLight ? '#111827' : '#ffffff'};
        margin-bottom: 12px;
        line-height: 1.4;
      `;

      const desc = document.createElement('div');
      desc.textContent = 'You can now send Push Notifications & In-App Messages through OneSignal. Tap below to enable push notifications.';
      desc.style.cssText = `
        font-size: 13.5px;
        line-height: 1.6;
        color: ${isLight ? '#4b5563' : 'rgba(255,255,255,0.65)'};
        margin-bottom: 24px;
      `;

      const btn = document.createElement('button');
      btn.textContent = 'Got it';
      btn.style.cssText = `
        width: 100% !important;
        padding: 12px 24px !important;
        border-radius: 12px !important;
        border: none !important;
        background: linear-gradient(135deg, #3861fb, #2962ff) !important;
        color: #ffffff !important;
        font-size: 14px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        transition: opacity 0.2s !important;
      `;

      btn.addEventListener('click', async () => {
        overlay.remove();
        try {
          await OneSignal.Notifications.requestPermission();
        } catch (e) {
          console.error('Permission request failed:', e);
        }
      });

      body.appendChild(icon);
      body.appendChild(title);
      body.appendChild(desc);
      body.appendChild(btn);
      card.appendChild(accent);
      card.appendChild(body);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
    }
  };

  window.OneSignalWrapper = OneSignalWrapper;
  OneSignalWrapper.init();
})();
