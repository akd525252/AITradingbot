/* =====================================================
   CARD LIVE EDITOR v4 — Fixed rows, visible scrollbar
   ===================================================== */
(function () {
  'use strict';

  const SEL = {
    balCard:    '.dashboard-balance-card',
    balContent: '.balance-card-content',
    balLabel:   '.balance-card-label',
    balAmount:  '.balance-card-amount',
    balActions: '.balance-card-actions',
    balBtnDep:  '.bal-btn-deposit',
    balBtnWdr:  '.bal-btn-withdraw',
    balCoins:   '.balance-card-bg-img',
    visaCard:   '#visa-card-mockup',
    visaLabel:  '#visa-card-status-label',
    visaNum:    '#visa-card-num-display',
    visaName:   '#visa-card-holder-display',
    visaExp:    '#visa-card-exp-display',
  };

  const S = {};
  Object.keys(SEL).forEach(k => S[k] = {});

  function getEl(k) { return document.querySelector(SEL[k]); }

  function set(key, prop, val) {
    const n = getEl(key);
    if (n) n.style[prop] = val;
    S[key][prop] = val;
    syncJSON();
    document.getElementById('cle-badge').classList.add('on');
  }

  function toCss(c) { return c.replace(/([A-Z])/g, m => '-' + m.toLowerCase()); }

  function nonEmpty() {
    const out = {};
    for (const [k, v] of Object.entries(S)) {
      const inner = Object.fromEntries(Object.entries(v).filter(([,x]) => x !== '' && x != null));
      if (Object.keys(inner).length) out[k] = inner;
    }
    return out;
  }

  function syncJSON() {
    const ta = document.getElementById('cle-json');
    if (ta) ta.value = JSON.stringify(nonEmpty(), null, 2) || '{}';
  }

  /* ══ CSS ══ */
  const CSS = `
#cle-fab {
  position:fixed; bottom:84px; left:16px; z-index:999999;
  width:46px; height:46px; border-radius:50%;
  background:linear-gradient(135deg,#1ab76d,#0e9155);
  border:none; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  box-shadow:0 4px 20px rgba(26,183,109,.55); font-size:20px;
  transition:transform .2s;
}
#cle-fab:hover { transform:scale(1.12); }
#cle-badge {
  position:absolute; top:-3px; right:-3px; width:11px; height:11px;
  border-radius:50%; background:#f59e0b; border:2px solid #060911; display:none;
}
#cle-badge.on { display:block; }

#cle-panel {
  position:fixed; top:0; right:-385px; width:365px; height:100vh;
  z-index:999998; background:#0c0f1a;
  border-left:2px solid rgba(26,183,109,.2);
  box-shadow:-8px 0 40px rgba(0,0,0,.85);
  display:flex; flex-direction:column;
  font-family:system-ui,sans-serif;
  transition:right .28s cubic-bezier(.4,0,.2,1);
}
#cle-panel.open { right:0; }

/* --- Header --- */
#cle-hdr {
  padding:13px 16px; background:#080b12;
  border-bottom:1px solid rgba(255,255,255,.08);
  display:flex; align-items:center; justify-content:space-between;
  flex-shrink:0;
}
.cle-hdr-info h3 { font-size:14px; font-weight:700; color:#f0f4ff; margin:0 0 2px; }
.cle-hdr-info p  { font-size:10px; color:#6b7a99; margin:0; }
#cle-close {
  width:28px; height:28px; border-radius:7px; cursor:pointer;
  background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1);
  color:#9aa3b8; font-size:15px;
  display:flex; align-items:center; justify-content:center; transition:all .15s;
}
#cle-close:hover { background:rgba(255,255,255,.14); color:#fff; }

/* --- Tabs --- */
#cle-tabs {
  display:flex; flex-shrink:0;
  border-bottom:1px solid rgba(255,255,255,.08); background:#080b12;
}
.cle-tab {
  flex:1; padding:10px 4px; text-align:center; cursor:pointer;
  font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.6px;
  color:#6b7a99; border-bottom:2px solid transparent; transition:all .15s;
}
.cle-tab.on { color:#1ab76d; border-bottom-color:#1ab76d; }
.cle-tab:hover:not(.on) { color:#c0c8de; background:rgba(255,255,255,.03); }

/* ===== SCROLL BODY ===== */
#cle-body {
  flex:1;
  overflow-y:scroll !important;
  overflow-x:hidden;
  padding:14px 12px;
  display:block;           /* block, not flex — avoids flex clipping */
  /* Always-visible scrollbar */
  scrollbar-width:thin;
  scrollbar-color:#1ab76d55 #0a0e1a;
}
#cle-body::-webkit-scrollbar        { width:7px; }
#cle-body::-webkit-scrollbar-track  { background:#0a0e1a; }
#cle-body::-webkit-scrollbar-thumb  { background:#1ab76d55; border-radius:4px; }
#cle-body::-webkit-scrollbar-thumb:hover { background:#1ab76daa; }

/* --- Section groups --- */
.cle-grp {
  margin-bottom:12px;
  border:1px solid rgba(255,255,255,.07);
  border-radius:10px;
  background:#111827;
}
.cle-grp-title {
  padding:9px 14px; font-size:9px; font-weight:700; color:#8892a4;
  text-transform:uppercase; letter-spacing:1px;
  background:#161f30; border-radius:10px 10px 0 0;
  border-bottom:1px solid rgba(255,255,255,.06);
  display:flex; align-items:center; gap:7px;
}
.cle-grp-title .dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }

/* --- Each property row: TWO ROWS inside — label row + control row --- */
.cle-prop {
  padding:10px 14px 12px;
  border-bottom:1px solid rgba(255,255,255,.05);
}
.cle-prop:last-child { border-bottom:none; border-radius:0 0 10px 10px; }

.cle-prop-label {
  font-size:12px;
  font-weight:600;
  color:#c8d3e8;
  margin-bottom:9px;
  line-height:1.4;
  display:block;
}
.cle-prop-hint {
  font-size:10px; font-weight:400; color:#4a5568;
}

/* Slider control */
.cle-ctrl-slider {
  display:flex;
  align-items:center;
  gap:10px;
  width:100%;
}
.cle-ctrl-slider input[type=range] {
  flex:1;
  accent-color:#1ab76d;
  cursor:pointer;
  height:5px;
  margin:0;
  display:block;
}
.cle-val {
  font-size:11px; font-family:monospace; font-weight:700;
  color:#1ab76d; background:rgba(26,183,109,.12);
  padding:3px 9px; border-radius:5px; min-width:50px;
  text-align:center; flex-shrink:0;
}

/* Text input + apply button */
.cle-ctrl-input {
  display:flex;
  align-items:center;
  gap:7px;
  width:100%;
}
.cle-inp {
  flex:1;
  background:#080b12;
  border:1px solid rgba(255,255,255,.14);
  color:#f0f4ff;
  border-radius:7px;
  font-family:monospace;
  font-size:12px;
  font-weight:500;
  padding:8px 11px;
  min-width:0;
  display:block;
  transition:border-color .15s;
}
.cle-inp:focus  { outline:none; border-color:#1ab76d; }
.cle-inp::placeholder { color:#3a4555; }
.cle-ok {
  padding:8px 13px;
  background:rgba(26,183,109,.15);
  border:1px solid rgba(26,183,109,.35);
  color:#1ab76d; border-radius:7px;
  font-size:12px; font-weight:700;
  cursor:pointer; flex-shrink:0;
  transition:all .15s; white-space:nowrap;
}
.cle-ok:hover { background:rgba(26,183,109,.28); }

/* --- JSON pane --- */
#cle-json-wrap {
  flex:1; display:none; flex-direction:column;
  padding:14px; gap:10px; overflow:hidden;
}
#cle-json {
  flex:1; background:#080b12;
  border:1px solid rgba(255,255,255,.1); border-radius:8px;
  color:#86efac; font-family:monospace; font-size:11px;
  line-height:1.7; padding:12px; resize:none;
  white-space:pre; overflow:auto;
}
#cle-json:focus { outline:none; border-color:#1ab76d; }

/* --- Bottom bar --- */
#cle-bar {
  padding:12px 14px; border-top:1px solid rgba(255,255,255,.08);
  background:#080b12; display:flex; gap:8px; flex-shrink:0;
}
.cle-btn {
  flex:1; padding:10px; border-radius:8px;
  font-size:12px; font-weight:700; cursor:pointer; border:none;
  font-family:inherit; transition:all .18s;
}
.cle-btn-p { background:#1ab76d; color:#000; }
.cle-btn-p:hover { background:#22d87e; }
.cle-btn-g { background:transparent; color:#8892a4; border:1px solid rgba(255,255,255,.1); }
.cle-btn-g:hover { background:rgba(255,255,255,.07); color:#f0f4ff; }

/* --- Toast --- */
#cle-toast {
  position:fixed; bottom:18px; left:50%;
  transform:translateX(-50%); z-index:1000000;
  background:#111827; border:1px solid rgba(26,183,109,.35);
  border-radius:9px; padding:9px 18px;
  font-size:12px; font-weight:700; color:#f0f4ff;
  box-shadow:0 8px 30px rgba(0,0,0,.6);
  display:none; white-space:nowrap;
  align-items:center; gap:8px;
}
#cle-toast.on { display:flex; animation:cleIn .28s ease; }
@keyframes cleIn {
  from { opacity:0; transform:translateX(-50%) translateY(7px); }
  to   { opacity:1; transform:translateX(-50%) translateY(0); }
}
`;

  /* ══ HTML ══ */
  function row(label, hint, ctrlHTML) {
    const h = hint ? `<span class="cle-prop-hint"> — ${hint}</span>` : '';
    return `
<div class="cle-prop">
  <span class="cle-prop-label">${label}${h}</span>
  ${ctrlHTML}
</div>`;
  }

  function slider(min, max, step, def, key, prop, rvId, applyFn) {
    const fn = applyFn || `cleS('${key}','${prop}',this.value+'px','${rvId}')`;
    return `<div class="cle-ctrl-slider">
  <input type="range" min="${min}" max="${max}" step="${step}" value="${def}" oninput="${fn}">
  <span class="cle-val" id="${rvId}">${def}px</span>
</div>`;
  }

  function inp(id, ph, key, prop) {
    return `<div class="cle-ctrl-input">
  <input class="cle-inp" id="${id}" placeholder="${ph}" oninput="cleI('${key}','${prop}',this.value)">
  <button class="cle-ok" onclick="cleI('${key}','${prop}',document.getElementById('${id}').value)">✓ Apply</button>
</div>`;
  }

  const HTML = `
<style>${CSS}</style>

<button id="cle-fab" title="Card Live Editor  (Ctrl+Shift+E)">✏️<span id="cle-badge"></span></button>

<div id="cle-panel">
  <div id="cle-hdr">
    <div class="cle-hdr-info">
      <h3>🃏 Card Live Editor</h3>
      <p>Changes apply instantly on the dashboard</p>
    </div>
    <button id="cle-close" onclick="cleClose()">✕</button>
  </div>

  <div id="cle-tabs">
    <div class="cle-tab on" id="ct-v" onclick="cleTab('v')">🎨 Visual</div>
    <div class="cle-tab"    id="ct-j" onclick="cleTab('j')">{ } Export JSON</div>
  </div>

  <div id="cle-body">

    <!-- ═══ BALANCE CARD SHAPE ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#1ab76d"></span>Balance Card — Shape &amp; Size</div>
      ${row('Border Radius','0 = square, 40 = pill', slider(0,40,1,20,'balCard','borderRadius','rv_br'))}
      ${row('Aspect Ratio','wider number = shorter card', `<div class="cle-ctrl-slider"><input type="range" min="1.2" max="2.5" step="0.01" value="1.58" oninput="cleAR('balCard',this,'rv_ar')"><span class="cle-val" id="rv_ar">1.58</span></div>`)}
      ${row('Min Height','e.g. 160px, 200px, auto', inp('i_bmh','160px  /  200px  /  auto','balCard','minHeight'))}
    </div>

    <!-- ═══ BALANCE CARD SPACING ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#1ab76d"></span>Balance Card — Padding &amp; Spacing</div>
      ${row('Content Padding','space inside the card', inp('i_bcp','18px 16px','balContent','padding'))}
      ${row('Buttons Gap','space between Deposit &amp; Withdraw', slider(0,30,1,10,'balActions','gap','rv_bag'))}
      ${row('Buttons Margin Top','space above the button row', slider(0,40,1,12,'balActions','marginTop','rv_bmt'))}
    </div>

    <!-- ═══ BALANCE CARD TYPOGRAPHY ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#1ab76d"></span>Balance Card — Typography</div>
      ${row('Label Font Size','e.g. "Total Balance (USD)"', slider(8,18,0.5,11,'balLabel','fontSize','rv_blfs'))}
      ${row('Label Letter Spacing','spacing between letters', slider(0,5,0.1,1.2,'balLabel','letterSpacing','rv_blls'))}
      ${row('Amount Font Size','the big $ number', slider(16,64,0.5,32,'balAmount','fontSize','rv_bafs'))}
      ${row('Amount Margin Bottom','gap below $ number', slider(0,24,1,4,'balAmount','marginBottom','rv_bamb'))}
    </div>

    <!-- ═══ BALANCE CARD BUTTONS ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#22d87e"></span>Balance Card — Deposit &amp; Withdraw Buttons</div>
      ${row('Button Font Size','', slider(10,20,0.5,14,'balBtnDep','fontSize','rv_bbfs', "cleSB('balBtnDep','balBtnWdr','fontSize',this.value+'px','rv_bbfs')"))}
      ${row('Button Border Radius','0 = square, 30 = round', slider(0,30,1,12,'balBtnDep','borderRadius','rv_bbbr', "cleSB('balBtnDep','balBtnWdr','borderRadius',this.value+'px','rv_bbbr')"))}
      ${row('Button Vertical Padding','height of the buttons', slider(4,24,1,12,'balBtnDep','paddingTop','rv_bbpy', 'cleBtnPY(this,"rv_bbpy")'))}
    </div>

    <!-- ═══ BALANCE CARD COINS ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#f59e0b"></span>Balance Card — 3D Coins Image</div>
      ${row('Top Offset','negative moves it higher', slider(-100,40,1,-20,'balCoins','top','rv_bct'))}
      ${row('Right Offset','negative moves it further right', slider(-60,60,1,-6,'balCoins','right','rv_bcr'))}
      ${row('Image Height','percentage of card height', inp('i_bch','65%  /  120px  /  80%','balCoins','height'))}
    </div>

    <!-- ═══ VISA CARD SHAPE ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#4f8ef7"></span>Visa ATM Card — Shape &amp; Size</div>
      ${row('Aspect Ratio','wider = shorter card', `<div class="cle-ctrl-slider"><input type="range" min="1.2" max="2.5" step="0.01" value="1.58" oninput="cleAR('visaCard',this,'rv_var')"><span class="cle-val" id="rv_var">1.58</span></div>`)}
      ${row('Border Radius','corner roundness', slider(0,40,1,16,'visaCard','borderRadius','rv_vbr'))}
      ${row('Inner Padding','space inside the card', inp('i_vcp','20px  /  16px 24px','visaCard','padding'))}
    </div>

    <!-- ═══ VISA STATUS LABEL ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#4f8ef7"></span>Visa Card — Active / Non-Active Label</div>
      ${row('Top Position','distance from top of card', inp('i_vst','5cqw  /  10px','visaLabel','top'))}
      ${row('Right Position','distance from right edge', inp('i_vsr','5cqw  /  12px','visaLabel','right'))}
      ${row('Font Size','label text size', inp('i_vsfs','3cqw  /  11px','visaLabel','fontSize'))}
      ${row('Padding','space inside label pill', inp('i_vsp','1cqw 2.2cqw','visaLabel','padding'))}
      ${row('Border Radius','pill corner roundness', inp('i_vsrx','4cqw  /  8px','visaLabel','borderRadius'))}
    </div>

    <!-- ═══ VISA TEXT SIZES ═══ -->
    <div class="cle-grp">
      <div class="cle-grp-title"><span class="dot" style="background:#4f8ef7"></span>Visa Card — Text Sizes</div>
      ${row('Card Number Font Size','the •••• •••• •••• XXXX', inp('i_vnfs','6cqw  /  18px','visaNum','fontSize'))}
      ${row('Cardholder Name Size','name on card', inp('i_vnmfs','3.8cqw  /  14px','visaName','fontSize'))}
      ${row('Expiry Date Size','MM/YY text', inp('i_vefs','3.2cqw  /  12px','visaExp','fontSize'))}
    </div>

    <div style="height:16px"></div>
  </div><!-- /cle-body -->

  <!-- JSON pane -->
  <div id="cle-json-wrap">
    <p style="font-size:11px;color:#6b7a99;font-weight:600">Only changed values appear here:</p>
    <textarea id="cle-json" readonly placeholder="No changes yet.&#10;Use Visual tab to edit."></textarea>
    <div style="display:flex;gap:8px">
      <button class="cle-btn cle-btn-p" onclick="cleDL()">↓ Download JSON</button>
      <button class="cle-btn cle-btn-g" onclick="cleClip()">⎘ Copy</button>
    </div>
  </div>

  <div id="cle-bar">
    <button class="cle-btn cle-btn-g" onclick="cleReset()">↺ Reset All</button>
    <button class="cle-btn cle-btn-p" onclick="cleDL()">↓ Export JSON</button>
  </div>
</div>

<div id="cle-toast"><span>✓</span><span id="cle-toast-msg">Done</span></div>
`;

  function build() {
    if (document.getElementById('cle-root')) return;
    const root = document.createElement('div');
    root.id = 'cle-root';
    root.innerHTML = HTML;
    document.body.appendChild(root);
    document.getElementById('cle-fab').onclick = function() {
      document.getElementById('cle-panel').classList.toggle('open');
    };
    document.addEventListener('keydown', function(e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        document.getElementById('cle-panel').classList.toggle('open');
      }
    });
  }

  /* ── Global helpers called from HTML ── */
  window.cleClose = function() { document.getElementById('cle-panel').classList.remove('open'); };

  window.cleTab = function(t) {
    document.getElementById('cle-body').style.display      = t === 'v' ? 'block' : 'none';
    document.getElementById('cle-json-wrap').style.display = t === 'j' ? 'flex'  : 'none';
    document.getElementById('cle-bar').style.display       = t === 'v' ? 'flex'  : 'none';
    document.getElementById('ct-v').classList.toggle('on', t === 'v');
    document.getElementById('ct-j').classList.toggle('on', t === 'j');
    if (t === 'j') syncJSON();
  };

  window.cleS = function(key, prop, val, rvId) {
    document.getElementById(rvId).textContent = val;
    set(key, prop, val);
  };
  window.cleSB = function(k1, k2, prop, val, rvId) {
    document.getElementById(rvId).textContent = val;
    set(k1, prop, val); set(k2, prop, val);
  };
  window.cleAR = function(key, el, rvId) {
    const n = parseFloat(el.value).toFixed(2);
    document.getElementById(rvId).textContent = n;
    set(key, 'aspectRatio', n + ' / 1');
  };
  window.cleI = function(key, prop, val) {
    if (!val || !val.trim()) return;
    set(key, prop, val.trim());
  };
  window.cleBtnPY = function(el, rvId) {
    const v = el.value + 'px';
    document.getElementById(rvId).textContent = v;
    ['paddingTop','paddingBottom'].forEach(p => {
      set('balBtnDep', p, v); set('balBtnWdr', p, v);
    });
  };
  window.cleReset = function() {
    for (const [k] of Object.entries(S)) {
      const n = getEl(k); if (!n) continue;
      for (const p of Object.keys(S[k])) n.style.removeProperty(toCss(p));
      S[k] = {};
    }
    document.getElementById('cle-badge').classList.remove('on');
    syncJSON(); toast('All overrides cleared');
  };
  window.cleDL = function() {
    const blob = new Blob([JSON.stringify(nonEmpty(), null, 2) || '{}'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'card-layout.json'; a.click();
    toast('card-layout.json downloaded!');
  };
  window.cleClip = function() {
    navigator.clipboard.writeText(JSON.stringify(nonEmpty(), null, 2) || '{}')
      .then(() => toast('JSON copied!'));
  };

  let _tt;
  function toast(msg) {
    const t = document.getElementById('cle-toast');
    const m = document.getElementById('cle-toast-msg');
    if (!t || !m) return;
    m.textContent = msg; t.className = 'on';
    clearTimeout(_tt); _tt = setTimeout(() => { t.className = ''; }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
