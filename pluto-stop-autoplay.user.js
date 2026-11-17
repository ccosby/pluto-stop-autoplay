// ==UserScript==
// @name         Pluto TV – Stop Autoplay
// @namespace    pluto-tv-stop-autoplay
// @version      0.4.1
// @description  Stops Pluto TV's web player from auto-playing the next episode: dismisses the "Starts in N seconds" end card, and pauses the next episode if it starts anyway.
// @homepageURL  https://github.com/ccosby/pluto-stop-autoplay
// @supportURL   https://github.com/ccosby/pluto-stop-autoplay/issues
// @updateURL    https://raw.githubusercontent.com/ccosby/pluto-stop-autoplay/main/pluto-stop-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/ccosby/pluto-stop-autoplay/main/pluto-stop-autoplay.user.js
// @match        https://pluto.tv/*
// @match        https://*.pluto.tv/*
// @run-at       document-start
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * How Pluto's autoplay works (observed Nov 2026):
 *   ~29s before the video's reported end, the player skin un-hides
 *   `div.base-container` and inserts <endcard-web-component> ("Starts in N
 *   SECONDS", with an X). ~5s later the card is removed and the app navigates
 *   to the next episode's URL; the remaining credits never play and the
 *   video's `ended` event never fires. The end card uses a *closed* shadow
 *   root, which Firefox lets content scripts read via
 *   `element.openOrClosedShadowRoot` (hence `@inject-into content`).
 *
 * Layer 1: when the end card appears, find its close (X) button and click it.
 * Layer 2 (safety net): if the URL changes to another episode shortly after the
 *   end card / end of video without the user clicking or pressing a key,
 *   pause the new video until the user interacts.
 */

(function () {
  'use strict';

  const VERSION = '0.4.1';
  const TAG = '[pluto-stop-autoplay]';

  const ENDCARD_TAG = 'endcard-web-component';
  const CLOSE_RE = /\b(close|dismiss|cancel|exit|no thanks)\b|^\s*[×✕✖x]\s*$/i;
  const CLOSE_SEARCH_MS = 3000; // keep looking for the X this long after the card appears
  const GUARD_MS = 15000; // block a URL change this long after the card / end of video
  const MAX_DIAG = 8;

  // ---- Storage ---------------------------------------------------------------
  const store = {
    get(k, d) {
      try {
        return GM_getValue(k, d);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        GM_setValue(k, v);
      } catch (e) {
        console.warn(TAG, 'save failed', k, e);
      }
    },
  };
  // Remove storage left behind by the v0.1–v0.3 capture builds.
  for (const k of ['captures', 'tailLog', 'tailNoise', 'freeze']) {
    try {
      GM_deleteValue(k);
    } catch (e) {
      /* ignore */
    }
  }

  let enabled = store.get('enabled', true);
  let diag = store.get('diag', []);
  const saveDiag = () => {
    if (diag.length > MAX_DIAG) diag.splice(0, diag.length - MAX_DIAG);
    store.set('diag', diag);
  };
  const logDiag = (rec) => {
    diag.push(rec);
    saveDiag();
    console.log(TAG, rec.event, rec);
  };

  // ---- Helpers ---------------------------------------------------------------
  const nowIso = () => new Date().toISOString();
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);
  const squish = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const attrsOf = (el) => Object.fromEntries(Array.from(el.attributes || [], (a) => [a.name, a.value]));

  function getShadow(el) {
    try {
      return el.shadowRoot || el.openOrClosedShadowRoot || null;
    } catch (e) {
      return null;
    }
  }

  function shadowMode(el) {
    try {
      if (el.shadowRoot) return 'open';
      if (el.openOrClosedShadowRoot) return 'closed (readable via openOrClosedShadowRoot)';
      return 'openOrClosedShadowRoot' in el ? 'none yet' : 'closed or none (openOrClosedShadowRoot unavailable)';
    } catch (e) {
      return 'error: ' + e;
    }
  }

  function selectorish(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim();
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 4).join('.');
    for (const a of ['aria-label', 'title', 'data-testid']) {
      const v = el.getAttribute(a);
      if (v) s += `[${a}="${v}"]`;
    }
    return s;
  }

  function isVisible(el) {
    try {
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  function activeVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    return vids.find((v) => !v.paused) || vids.sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] || null;
  }

  function videoState(v = activeVideo()) {
    if (!v) return null;
    const d = v.duration;
    return {
      currentTime: +v.currentTime.toFixed(2),
      duration: isFinite(d) ? +d.toFixed(2) : String(d),
      remaining: isFinite(d) ? +(d - v.currentTime).toFixed(2) : null,
      paused: v.paused,
    };
  }

  // querySelectorAll that also descends into (open or closed) shadow roots.
  function deepAll(root, sel) {
    const out = Array.from(root.querySelectorAll(sel));
    for (const el of root.querySelectorAll('*')) {
      const sh = getShadow(el);
      if (sh) out.push(...deepAll(sh, sel));
    }
    return out;
  }

  // ---- Toast -----------------------------------------------------------------
  let toastTimer = 0;
  function toast(text, ms = 6000) {
    if (!document.body) return;
    let t = document.getElementById('psa-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'psa-toast';
      t.setAttribute('data-psa-ours', '');
      t.style.cssText =
        'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;' +
        'border-radius:8px;background:rgba(0,0,0,.88);color:#fff;font:14px/1.4 system-ui,sans-serif;' +
        'pointer-events:none;max-width:80vw;text-align:center;transition:opacity .3s;';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = '0'), ms);
  }

  // ---- Layer 2: guard against the next episode starting --------------------------
  const guard = { armedAt: 0, reason: '', url: '', userActed: false };
  const block = { active: false };

  function arm(reason) {
    guard.armedAt = Date.now();
    guard.reason = reason;
    guard.url = location.href;
    guard.userActed = false;
  }

  function onUserInput(e) {
    if (!e.isTrusted) return;
    if (guard.armedAt) guard.userActed = true;
    if (block.active) {
      block.active = false;
      console.log(TAG, 'user interacted, autoplay block lifted');
    }
  }
  document.addEventListener('pointerdown', onUserInput, true);
  document.addEventListener('keydown', onUserInput, true);

  function pauseIfBlocked(v) {
    if (block.active && v && !v.paused) {
      v.pause();
      toast('⏸ Next episode paused (autoplay blocked). Press play to watch.');
    }
  }

  function onMedia(e) {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    if (e.type === 'ended') arm('ended');
    if (e.type === 'play' || e.type === 'playing' || e.type === 'timeupdate') pauseIfBlocked(v);
  }
  ['ended', 'play', 'playing', 'timeupdate'].forEach((t) => document.addEventListener(t, onMedia, true));

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    const from = lastUrl;
    lastUrl = location.href;
    const armed = guard.armedAt && Date.now() - guard.armedAt < GUARD_MS;
    if (enabled && armed && !guard.userActed) {
      block.active = true;
      logDiag({ event: 'blocked-navigation', at: nowIso(), reason: guard.reason, from, to: location.href, msSinceArmed: Date.now() - guard.armedAt });
      pauseIfBlocked(activeVideo());
      toast('⏸ Autoplay blocked. Press play to watch the next episode.');
    }
    guard.armedAt = 0;
  }, 200);

  // ---- Layer 1: dismiss the end card ---------------------------------------------
  const handled = new WeakSet();

  function findClose(scope) {
    const cands = deepAll(scope, 'button, [role="button"], [aria-label], [title], [class*="close" i], [id*="close" i]').filter(
      (el) => !el.closest('[data-psa-ours]')
    );
    // 1) Labelled close control.
    for (const el of cands) {
      const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.getAttribute('class'), el.getAttribute('data-testid')]
        .filter(Boolean)
        .join(' ');
      const text = squish(el.textContent);
      if (CLOSE_RE.test(label) || (text.length <= 12 && CLOSE_RE.test(text))) {
        const target = el.closest('button, [role="button"]') || el;
        if (isVisible(target)) return { el: target, how: 'label' };
      }
    }
    // 2) Fallback: the small visible button nearest the top-right corner.
    const buttons = deepAll(scope, 'button, [role="button"]')
      .filter(isVisible)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width <= 80 && r.height <= 80)
      .sort((a, b) => a.r.top - b.r.top || b.r.right - a.r.right);
    return buttons.length ? { el: buttons[0].el, how: 'top-right-heuristic' } : null;
  }

  function handleEndcard(card) {
    if (handled.has(card)) return;
    handled.add(card);
    arm('endcard');

    const rec = {
      event: 'endcard',
      at: nowIso(),
      url: location.href,
      video: videoState(),
      attrs: attrsOf(card),
      shadowMode: shadowMode(card),
      steps: [],
    };
    if (!enabled) {
      rec.steps.push('script disabled; not dismissing');
      return logDiag(rec);
    }

    const t0 = performance.now();
    const attempt = () => {
      const elapsed = Math.round(performance.now() - t0);
      if (!card.isConnected) {
        rec.steps.push(`card removed after ${elapsed}ms before a close button was found`);
        return logDiag(rec);
      }
      const sh = getShadow(card);
      const found = findClose(sh || card);
      if (found) {
        rec.shadowMode = shadowMode(card);
        rec.shadowHtml = sh ? clip(sh.innerHTML, 20000) : null;
        rec.closeButton = { how: found.how, selector: selectorish(found.el), html: clip(found.el.outerHTML, 1500) };
        found.el.click();
        rec.steps.push(`clicked close (${found.how}) after ${elapsed}ms`);
        toast('⏹ Autoplay cancelled');
        setTimeout(() => {
          rec.cardConnectedAfterClick = card.isConnected;
          rec.videoAfterClick = videoState();
          logDiag(rec);
        }, 600);
        return;
      }
      if (elapsed > CLOSE_SEARCH_MS) {
        rec.shadowMode = shadowMode(card);
        rec.shadowHtml = sh ? clip(sh.innerHTML, 20000) : null;
        rec.lightHtml = clip(card.outerHTML, 5000);
        rec.steps.push('no close button found; relying on navigation guard');
        return logDiag(rec);
      }
      setTimeout(attempt, 50);
    };
    attempt();
  }

  function scanNode(n) {
    if (n.nodeType !== 1) return;
    if (n.localName === ENDCARD_TAG) return handleEndcard(n);
    const inner = n.getElementsByTagName(ENDCARD_TAG);
    for (let i = 0; i < inner.length; i++) handleEndcard(inner[i]);
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(scanNode);
  });
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scanNode(document.documentElement);
  };
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  // ---- Menu ------------------------------------------------------------------------
  GM_registerMenuCommand(`${enabled ? '✅' : '⛔️'} Autoplay blocking: ${enabled ? 'ON' : 'OFF'} (toggle)`, () => {
    enabled = !enabled;
    store.set('enabled', enabled);
    alert(`Autoplay blocking is now ${enabled ? 'ON' : 'OFF'}. Reload the page to update this menu label.`);
  });
  GM_registerMenuCommand('📋 Copy diagnostics', () => {
    GM_setClipboard(JSON.stringify({ script: VERSION, generatedAt: nowIso(), userAgent: navigator.userAgent, diag }, null, 2), 'text');
    alert(`Copied ${diag.length} diagnostic record(s).`);
  });
  GM_registerMenuCommand('🗑 Clear diagnostics', () => {
    diag = [];
    store.set('diag', diag);
    alert('Diagnostics cleared.');
  });

  console.info(TAG, `v${VERSION} active. Blocking: ${enabled ? 'ON' : 'OFF'}.`);
})();
