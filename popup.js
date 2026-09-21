/**
 * Chat Capsule - Extension Popup Controller
 * Manages capsule library, mode switching, import/export, and messaging active tabs.
 */

(function () {
  'use strict';

  // DOM Elements
  const sealBtn = document.getElementById('seal-chat-btn');
  const tabBadge = document.getElementById('tab-badge');
  const capsuleFeed = document.getElementById('capsule-feed');
  const emptyState = document.getElementById('empty-state');
  const itemCount = document.getElementById('item-count');
  const modeCompactBtn = document.getElementById('mode-compact-btn');
  const modeFullBtn = document.getElementById('mode-full-btn');
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const importFileInput = document.getElementById('import-file');
  const toastBanner = document.getElementById('toast-banner');

  let currentMode = 'compact';
  let capsulesList = [];
  let activeTab = null;

  /* ==========================================================================
     1. INITIALIZATION & ACTIVE TAB DETECTION
     ========================================================================== */
  async function init() {
    try {
      // 1. Load preferred mode from chrome.storage.local
      await loadPreferredMode();

      // 2. Identify the active tab
      await detectActiveTab();

      // 3. Load and render capsules
      await refreshCapsules();

      // 4. Bind live storage changes
      bindStorageListener();

      // 5. Setup UI listeners
      bindUIEvents();
    } catch (err) {
      console.error('[Popup] Initialization error:', err);
      showToast('Error loading popup: ' + err.message, 'error');
    }
  }

  async function loadPreferredMode() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get(['preferredMode']);
        currentMode = res.preferredMode === 'full' ? 'full' : 'compact';
      }
    } catch (e) {
      currentMode = 'compact';
    }
    updateModeSwitchUI(currentMode);
  }

  async function setPreferredMode(mode) {
    currentMode = mode === 'full' ? 'full' : 'compact';
    updateModeSwitchUI(currentMode);
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ preferredMode: currentMode });
      }
    } catch (e) {}
    renderCapsules();
  }

  function updateModeSwitchUI(mode) {
    if (mode === 'full') {
      modeFullBtn.classList.add('active');
      modeFullBtn.setAttribute('aria-pressed', 'true');
      modeCompactBtn.classList.remove('active');
      modeCompactBtn.setAttribute('aria-pressed', 'false');
    } else {
      modeCompactBtn.classList.add('active');
      modeCompactBtn.setAttribute('aria-pressed', 'true');
      modeFullBtn.classList.remove('active');
      modeFullBtn.setAttribute('aria-pressed', 'false');
    }
  }

  async function detectActiveTab() {
    try {
      if (!chrome?.tabs?.query) {
        tabBadge.textContent = 'Ready';
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) {
        tabBadge.textContent = 'No tab';
        return;
      }

      activeTab = tabs[0];
      const url = activeTab.url || '';

      if (/claude\.ai/i.test(url)) {
        tabBadge.textContent = 'Claude';
        tabBadge.className = 'tab-badge badge-claude';
      } else if (/(chatgpt\.com|chat\.openai\.com)/i.test(url)) {
        tabBadge.textContent = 'ChatGPT';
        tabBadge.className = 'tab-badge badge-chatgpt';
      } else if (/gemini\.google\.com/i.test(url)) {
        tabBadge.textContent = 'Gemini';
        tabBadge.className = 'tab-badge badge-gemini';
      } else {
        tabBadge.textContent = 'Other Page';
        tabBadge.className = 'tab-badge';
      }
    } catch (err) {
      tabBadge.textContent = 'Ready';
    }
  }

  /* ==========================================================================
     2. CAPSULE LIBRARY & RENDERING
     ========================================================================== */
  async function refreshCapsules() {
    try {
      if (window.CapsuleLib?.store) {
        capsulesList = await window.CapsuleLib.store.list();
      } else if (chrome?.storage?.local) {
        const res = await chrome.storage.local.get(['capsules']);
        capsulesList = Array.isArray(res.capsules) ? res.capsules : [];
      }
      renderCapsules();
    } catch (err) {
      console.error('[Popup] Failed to fetch capsules:', err);
      showToast('Could not load capsules from storage.', 'error');
    }
  }

  function renderCapsules() {
    const query = (searchInput.value || '').trim().toLowerCase();
    const filtered = capsulesList.filter((cap) => {
      if (!query) return true;
      const title = (cap.title || '').toLowerCase();
      const source = (cap.source || '').toLowerCase();
      const goal = (cap.goal || '').toLowerCase();
      return title.includes(query) || source.includes(query) || goal.includes(query);
    });

    itemCount.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
      capsuleFeed.innerHTML = '';
      emptyState.classList.add('visible');
      return;
    }

    emptyState.classList.remove('visible');
    capsuleFeed.innerHTML = '';

    filtered.forEach((cap) => {
      const card = createCard(cap);
      capsuleFeed.appendChild(card);
    });
  }

  function createCard(cap) {
    const card = document.createElement('article');
    card.className = 'cap-card';

    // Source pill styling
    const src = (cap.source || 'ai').toLowerCase();
    let pillClass = 'generic';
    let label = 'AI';
    if (src.includes('claude')) {
      pillClass = 'claude';
      label = 'Claude';
    } else if (src.includes('chatgpt') || src.includes('openai')) {
      pillClass = 'chatgpt';
      label = 'ChatGPT';
    } else if (src.includes('gemini')) {
      pillClass = 'gemini';
      label = 'Gemini';
    }

    // Date
    let dateStr = 'Recent';
    if (cap.createdAt) {
      try {
        const d = new Date(cap.createdAt);
        dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch (e) {}
    }

    // Token estimate for selected mode
    const promptText = window.CapsuleLib ? window.CapsuleLib.toPrompt(cap, currentMode) : '';
    const tokens = window.CapsuleLib ? window.CapsuleLib.approxTokens(promptText) : 0;
    const tokenDisplay = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
    const msgCount = (cap.messages || []).length;

    card.innerHTML = `
      <div class="cap-meta">
        <span class="site-pill ${pillClass}">${escapeHtml(label)}</span>
        <span class="cap-date">${dateStr}</span>
      </div>
      <div class="cap-title" title="${escapeHtml(cap.title || '')}">${escapeHtml(cap.title || 'Untitled Capsule')}</div>
      <div class="cap-metrics">
        <span>${msgCount} messages</span>
        <span>•</span>
        <span class="tokens-pill">~${tokenDisplay} tokens (${currentMode})</span>
      </div>
      <div class="cap-actions">
        <button class="action-btn btn-open" data-act="open" title="Inject into current tab's message box">
          <span>🚀</span> Open here
        </button>
        <button class="action-btn" data-act="copy" title="Copy capsule prompt to clipboard">
          <span>📋</span> Copy
        </button>
        <button class="action-btn" data-act="md" title="Download formatted markdown transcript">
          <span>📄</span> .md
        </button>
        <button class="action-btn" data-act="json" title="Download capsule JSON">
          <span>💾</span> .json
        </button>
        <button class="action-btn btn-del" data-act="del" title="Delete capsule">
          <span>🗑️</span>
        </button>
      </div>
    `;

    // Actions
    card.querySelector('[data-act="open"]').addEventListener('click', () => handleOpenCapsule(cap));
    card.querySelector('[data-act="copy"]').addEventListener('click', () => handleCopyPrompt(cap));
    card.querySelector('[data-act="md"]').addEventListener('click', () => handleDownloadMarkdown(cap));
    card.querySelector('[data-act="json"]').addEventListener('click', () => handleDownloadJson(cap));
    card.querySelector('[data-act="del"]').addEventListener('click', () => handleDelete(cap.id));

    return card;
  }

  /* ==========================================================================
     3. ACTIONS: SEAL, OPEN, COPY, DOWNLOAD, IMPORT, DELETE
     ========================================================================== */

  async function ensureContentScriptInjected(tabId) {
    if (!chrome?.scripting?.executeScript) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['capsule.js', 'content.js'],
      });
      await new Promise((r) => setTimeout(r, 160));
      return true;
    } catch (err) {
      console.warn('[Popup] Script injection failed:', err);
      return false;
    }
  }

  async function handleSealCurrentChat() {
    if (!activeTab || !activeTab.id) {
      showToast('No active tab found.', 'warning');
      return;
    }

    const url = activeTab.url || activeTab.pendingUrl || '';
    const isSupported =
      /claude\.ai/i.test(url) ||
      /(chatgpt\.com|chat\.openai\.com)/i.test(url) ||
      /gemini\.google\.com/i.test(url);

    if (url && !isSupported) {
      showToast('Please open a chat on Claude, ChatGPT or Gemini first.', 'warning', 4500);
      return;
    }

    sealBtn.disabled = true;
    sealBtn.innerHTML = `<span class="btn-icon">⏳</span><span class="btn-text">Sealing...</span>`;

    let response = null;
    try {
      response = await chrome.tabs.sendMessage(activeTab.id, { type: 'SEAL' });
    } catch (err) {
      // Content script was not present (tab open before reload). Try dynamic injection!
      const injected = await ensureContentScriptInjected(activeTab.id);
      if (injected) {
        try {
          response = await chrome.tabs.sendMessage(activeTab.id, { type: 'SEAL' });
        } catch (retryErr) {
          console.warn('[Popup] Retry failed after injection:', retryErr);
        }
      }
    } finally {
      setTimeout(() => {
        sealBtn.disabled = false;
        sealBtn.innerHTML = `<span class="btn-icon">💊</span><span class="btn-text">Seal current chat</span>`;
      }, 500);
    }

    if (response && response.success) {
      showToast('Capsule sealed successfully!', 'success');
    } else if (response && response.error) {
      showToast(response.error, 'warning', 4500);
    } else {
      showToast('Please refresh this chat tab once (Ctrl+R) to connect Chat Capsule.', 'warning', 5000);
    }
  }

  async function handleOpenCapsule(cap) {
    if (!activeTab || !activeTab.id) {
      showToast('No active tab available.', 'warning');
      return;
    }

    const promptText = window.CapsuleLib ? window.CapsuleLib.toPrompt(cap, currentMode) : '';

    let response = null;
    try {
      response = await chrome.tabs.sendMessage(activeTab.id, {
        type: 'OPEN',
        id: cap.id,
        mode: currentMode,
      });
    } catch (err) {
      const injected = await ensureContentScriptInjected(activeTab.id);
      if (injected) {
        try {
          response = await chrome.tabs.sendMessage(activeTab.id, {
            type: 'OPEN',
            id: cap.id,
            mode: currentMode,
          });
        } catch (retryErr) {}
      }
    }

    if (response && response.success) {
      showToast('Capsule opened into message box!', 'success');
    } else {
      await safeCopyToClipboard(promptText);
      showToast('Could not reach input box. Capsule copied to clipboard!', 'warning');
    }
  }

  async function safeCopyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }

  async function handleCopyPrompt(cap) {
    try {
      const prompt = window.CapsuleLib.toPrompt(cap, currentMode);
      await safeCopyToClipboard(prompt);
      const tokens = window.CapsuleLib.approxTokens(prompt);
      showToast(`Copied capsule prompt (~${tokens} tokens)!`, 'success');
    } catch (err) {
      showToast('Failed to copy to clipboard.', 'error');
    }
  }

  function handleDownloadMarkdown(cap) {
    try {
      const mdContent = window.CapsuleLib.toMarkdown(cap);
      const safeTitle = sanitize(cap.title || 'capsule');
      downloadFile(`${safeTitle}.md`, mdContent, 'text/markdown;charset=utf-8');
      showToast('Transcript downloaded as Markdown.', 'success');
    } catch (err) {
      showToast('Failed to generate Markdown document.', 'error');
    }
  }

  function handleDownloadJson(cap) {
    try {
      const jsonStr = JSON.stringify(cap, null, 2);
      const safeTitle = sanitize(cap.title || 'capsule');
      downloadFile(`${safeTitle}.json`, jsonStr, 'application/json;charset=utf-8');
      showToast('Capsule exported as JSON.', 'success');
    } catch (err) {
      showToast('Failed to export JSON file.', 'error');
    }
  }

  async function handleDelete(id) {
    try {
      if (window.CapsuleLib?.store) {
        await window.CapsuleLib.store.remove(id);
      }
      showToast('Capsule deleted.', 'info');
    } catch (err) {
      showToast('Failed to delete capsule: ' + err.message, 'error');
    }
  }

  function handleImportFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const raw = e.target.result;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (jsonErr) {
          throw new Error('File is not valid JSON.');
        }

        // Validate capsule structure
        const hasMessages = Array.isArray(parsed.messages) && parsed.messages.length > 0;
        const hasGoal = typeof parsed.goal === 'string' && parsed.goal.trim().length > 0;

        if (!hasMessages && !hasGoal) {
          throw new Error('Not a valid capsule: missing messages or goal.');
        }

        // Ensure fields exist
        if (!parsed.id) {
          parsed.id = `cap_${Date.now()}_imported`;
        }
        if (!parsed.createdAt) {
          parsed.createdAt = new Date().toISOString();
        }
        if (!parsed.title) {
          parsed.title = 'Imported Capsule';
        }
        if (!parsed.source) {
          parsed.source = 'imported';
        }

        await window.CapsuleLib.store.save(parsed);
        showToast(`Imported: "${parsed.title.slice(0, 28)}..."`, 'success');
      } catch (err) {
        console.error('[Popup] Import error:', err);
        showToast(err.message || 'Failed to import JSON.', 'error', 4500);
      } finally {
        importFileInput.value = '';
      }
    };
    reader.readAsText(file);
  }

  /* ==========================================================================
     4. EVENT BINDINGS & LIVE STORAGE LISTENER
     ========================================================================== */
  function bindUIEvents() {
    sealBtn.addEventListener('click', handleSealCurrentChat);

    modeCompactBtn.addEventListener('click', () => setPreferredMode('compact'));
    modeFullBtn.addEventListener('click', () => setPreferredMode('full'));

    searchInput.addEventListener('input', () => {
      if (searchInput.value.trim().length > 0) {
        clearSearchBtn.classList.remove('hidden');
      } else {
        clearSearchBtn.classList.add('hidden');
      }
      renderCapsules();
    });

    clearSearchBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      renderCapsules();
      searchInput.focus();
    });

    importFileInput.addEventListener('change', handleImportFile);
  }

  function bindStorageListener() {
    try {
      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
          if (areaName === 'local') {
            if (changes.capsules) {
              capsulesList = Array.isArray(changes.capsules.newValue) ? changes.capsules.newValue : [];
              renderCapsules();
            }
            if (changes.preferredMode) {
              currentMode = changes.preferredMode.newValue === 'full' ? 'full' : 'compact';
              updateModeSwitchUI(currentMode);
              renderCapsules();
            }
          }
        });
      }
    } catch (e) {
      console.warn('[Popup] Storage change listener skipped:', e);
    }
  }

  /* ==========================================================================
     5. UTILITIES
     ========================================================================== */
  function showToast(message, type = 'info', duration = 3200) {
    toastBanner.textContent = message;
    toastBanner.className = `toast visible toast-${type}`;
    setTimeout(() => {
      toastBanner.classList.remove('visible');
    }, duration);
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sanitize(str) {
    return (
      str
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .slice(0, 36)
        .replace(/\s+/g, '_') || 'chat_capsule'
    );
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
