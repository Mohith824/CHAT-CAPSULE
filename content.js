/**
 * Chat Capsule - Content Script
 * Supports Claude (claude.ai), ChatGPT (chatgpt.com / chat.openai.com), and Gemini (gemini.google.com).
 * Final In-Page Shadow DOM UI: Two-tone SVG capsule launcher, quiet compact menu,
 * sliding seal animation, keyboard accessible (Esc/focus), auto-dismissing toasts.
 */

(function () {
  'use strict';

  // Guard against mounting twice in the same frame/window
  if (window.__CHAT_CAPSULE_CONTENT_LOADED__) return;
  window.__CHAT_CAPSULE_CONTENT_LOADED__ = true;

  /* ==========================================================================
     1. PER-SITE ADAPTER CONFIGURATION
     ========================================================================== */

  /**
   * NOTE ON GEMINI LAZY LOADING:
   * Google Gemini virtualizes its chat history and only mounts recent messages
   * into the DOM. For very long conversations, scroll to the top of the chat
   * before clicking Seal to ensure earlier turns are rendered and captured.
   */
  const SITE_ADAPTERS = {
    claude: {
      name: 'Claude',
      source: 'claude.ai',
      domainRegex: /claude\.ai/i,
      userSelectors: [
        '[data-testid="user-message"]',
        '.font-user-message',
        'div[data-is-streaming="false"]:has(svg.lucide-user)',
        'div.user-turn',
        'div[class*="user-message"]',
      ],
      assistantSelectors: [
        '.font-claude-response',
        '[data-testid="assistant-message"]',
        '.font-claude-message',
        '.standard-markdown',
        'div[class*="claude-response"]',
        'div.assistant-turn',
      ],
      inputSelectors: [
        'div.ProseMirror[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'fieldset div[contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
    },
    chatgpt: {
      name: 'ChatGPT',
      source: 'chatgpt.com',
      domainRegex: /(chatgpt\.com|chat\.openai\.com)/i,
      userSelectors: [
        '[data-message-author-role="user"]',
        'article [data-message-author-role="user"]',
        'div[data-message-id]:has([data-message-author-role="user"])',
        '.user-message',
      ],
      assistantSelectors: [
        '[data-message-author-role="assistant"]',
        'article [data-message-author-role="assistant"]',
        '.agent-turn',
        '.markdown.prose',
        'div.text-message[data-message-author-role="assistant"]',
      ],
      inputSelectors: [
        '#prompt-textarea',
        'div.ProseMirror[contenteditable="true"]',
        'textarea[data-id="root"]',
        'div#prompt-textarea',
        'textarea[placeholder*="message" i]',
        'textarea',
        '[contenteditable="true"]',
      ],
    },
    gemini: {
      name: 'Gemini',
      source: 'gemini.google.com',
      domainRegex: /gemini\.google\.com/i,
      userSelectors: [
        'user-query .query-text',
        'user-query',
        '.user-query-container',
        '.query-content',
        'div.user-query',
      ],
      assistantSelectors: [
        'model-response message-content',
        'model-response .response-container',
        'model-response',
        'message-content',
        '.model-response-text',
      ],
      inputSelectors: [
        'rich-textarea .ql-editor',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"].ql-editor',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"]',
        'textarea',
      ],
    },
  };

  function getCurrentAdapter() {
    const host = window.location.hostname;
    if (SITE_ADAPTERS.claude.domainRegex.test(host)) return SITE_ADAPTERS.claude;
    if (SITE_ADAPTERS.chatgpt.domainRegex.test(host)) return SITE_ADAPTERS.chatgpt;
    if (SITE_ADAPTERS.gemini.domainRegex.test(host)) return SITE_ADAPTERS.gemini;
    return SITE_ADAPTERS.claude;
  }

  /* ==========================================================================
     2. DOM-TO-MARKDOWN CONVERTER
     ========================================================================== */
  function domToMarkdown(node) {
    if (!node) return '';
    if (window.CapsuleLib && typeof window.CapsuleLib.domToMarkdown === 'function') {
      return window.CapsuleLib.domToMarkdown(node);
    }

    const IGNORED_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'SVG',
      'BUTTON',
      'NAV',
      'NOSCRIPT',
      'IFRAME',
      'AUDIO',
      'VIDEO',
      'CANVAS',
    ]);

    function isIgnored(n) {
      if (!n) return true;
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (IGNORED_TAGS.has(n.tagName)) return true;
        const className = (n.className && typeof n.className === 'string') ? n.className.toLowerCase() : '';
        const ariaLabel = (n.getAttribute && n.getAttribute('aria-label')) ? n.getAttribute('aria-label').toLowerCase() : '';
        if (
          className.includes('copy-button') ||
          className.includes('code-block-decoration') ||
          className.includes('code-decoration') ||
          className.includes('feedback') ||
          className.includes('sr-only') ||
          className.includes('screen-reader-only') ||
          ariaLabel.includes('copy code') ||
          ariaLabel.includes('copy to clipboard') ||
          ariaLabel.includes('copy')
        ) {
          return true;
        }
      }
      return false;
    }

    function extractMath(el) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="LaTeX"]');
      if (ann && ann.textContent.trim()) {
        const tex = ann.textContent.trim();
        const isDisplay =
          el.classList.contains('katex-display') ||
          el.tagName === 'DIV' ||
          el.closest('.katex-display');
        return isDisplay ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
      }
      if (el.getAttribute('data-tex')) {
        return `$${el.getAttribute('data-tex').trim()}$`;
      }
      return null;
    }

    function extractLang(codeEl, preEl) {
      const list = [
        codeEl?.className || '',
        codeEl?.getAttribute('data-language') || '',
        preEl?.className || '',
        preEl?.getAttribute('data-language') || '',
      ];
      for (const str of list) {
        if (typeof str !== 'string') continue;
        const match = str.match(/(?:language|lang)-([a-zA-Z0-9_-]+)/i);
        if (match && match[1]) return match[1].toLowerCase();
      }
      return '';
    }

    function parseTable(tbl) {
      const rows = Array.from(tbl.querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const tableData = [];
      let maxCols = 0;
      rows.forEach((r) => {
        const cells = Array.from(r.querySelectorAll('th, td')).map((c) =>
          walkChildren(c).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim()
        );
        if (cells.length > maxCols) maxCols = cells.length;
        tableData.push(cells);
      });
      if (tableData.length === 0 || maxCols === 0) return '';
      const lines = [];
      const headerRow = tableData[0];
      while (headerRow.length < maxCols) headerRow.push('');
      lines.push(`| ${headerRow.join(' | ')} |`);
      lines.push(`| ${new Array(maxCols).fill('---').join(' | ')} |`);
      for (let i = 1; i < tableData.length; i++) {
        const row = tableData[i];
        while (row.length < maxCols) row.push('');
        lines.push(`| ${row.join(' | ')} |`);
      }
      return '\n\n' + lines.join('\n') + '\n\n';
    }

    function walk(n, depth = 0) {
      if (!n || isIgnored(n)) return '';
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue;

      if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toUpperCase();

        if (n.classList.contains('katex') || tag === 'MATH' || n.querySelector('annotation[encoding="application/x-tex"]')) {
          const math = extractMath(n);
          if (math) return math;
        }

        // Gemini & custom code-block web component
        if (tag === 'CODE-BLOCK' || (n.classList && (n.classList.contains('code-block') || n.classList.contains('code-block-wrapper')))) {
          let lang = '';
          const langEl = n.querySelector('.code-block-language, [class*="language"], [class*="lang"]');
          if (langEl && !langEl.closest('pre')) {
            lang = langEl.textContent.trim().toLowerCase();
          }
          const preEl = n.querySelector('pre');
          const codeEl = n.querySelector('code') || preEl || n;
          if (!lang) {
            lang = extractLang(codeEl, preEl);
          }
          lang = lang.replace(/[^a-zA-Z0-9_-]/g, '');
          const rawCode = (codeEl ? codeEl.textContent : n.textContent).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return `\n\`\`\`${lang}\n${rawCode.trimEnd()}\n\`\`\`\n`;
        }

        if (tag === 'PRE') {
          const codeEl = n.querySelector('code') || n;
          const lang = extractLang(codeEl, n);
          const rawCode = codeEl.textContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return `\n\`\`\`${lang}\n${rawCode.trimEnd()}\n\`\`\`\n`;
        }

        if (tag === 'CODE') {
          const text = n.textContent.replace(/\r?\n/g, ' ');
          return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
        }

        if (tag === 'TABLE') return parseTable(n);

        if (/^H[1-6]$/.test(tag)) {
          const level = parseInt(tag.charAt(1), 10);
          return `\n\n${'#'.repeat(level)} ${walkChildren(n, depth).trim()}\n\n`;
        }

        if (tag === 'STRONG' || tag === 'B') {
          const inner = walkChildren(n, depth).trim();
          return inner ? `**${inner}**` : '';
        }

        if (tag === 'EM' || tag === 'I') {
          const inner = walkChildren(n, depth).trim();
          return inner ? `*${inner}*` : '';
        }

        if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
          const inner = walkChildren(n, depth).trim();
          return inner ? `~~${inner}~~` : '';
        }

        if (tag === 'A') {
          const href = n.getAttribute('href');
          const inner = walkChildren(n, depth).trim();
          if (!href || href.startsWith('javascript:') || href === '#') return inner;
          return `[${inner || href}](${href})`;
        }

        if (tag === 'BLOCKQUOTE') {
          const inner = walkChildren(n, depth).trim();
          return `\n\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
        }

        if (tag === 'UL' || tag === 'OL') {
          const isOrdered = tag === 'OL';
          let idx = 1;
          let out = '\n';
          for (const child of n.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
              const marker = isOrdered ? `${idx}. ` : '- ';
              const indent = '  '.repeat(depth);
              out += `${indent}${marker}${walk(child, depth + 1).trim()}\n`;
              idx++;
            }
          }
          return out + '\n';
        }

        if (tag === 'LI') return walkChildren(n, depth);
        if (tag === 'P' || tag === 'DIV') return `\n${walkChildren(n, depth)}\n`;
        if (tag === 'BR') return '\n';
        if (tag === 'HR') return '\n\n---\n\n';

        return walkChildren(n, depth);
      }
      return '';
    }

    function walkChildren(parent, depth = 0) {
      let res = '';
      for (const child of parent.childNodes) {
        res += walk(child, depth);
      }
      return res;
    }

    return walk(node).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ==========================================================================
     3. COLLECT MESSAGES
     ========================================================================== */
  function collectMessages() {
    const adapter = getCurrentAdapter();
    const userNodes = [];
    for (const sel of adapter.userSelectors) {
      try {
        const matches = document.querySelectorAll(sel);
        matches.forEach((el) => userNodes.push(el));
      } catch (err) {}
    }

    const assistantNodes = [];
    for (const sel of adapter.assistantSelectors) {
      try {
        const matches = document.querySelectorAll(sel);
        matches.forEach((el) => assistantNodes.push(el));
      } catch (err) {}
    }

    const tagged = [];
    const seen = new Set();

    userNodes.forEach((node) => {
      if (!seen.has(node)) {
        seen.add(node);
        tagged.push({ element: node, role: 'user' });
      }
    });

    assistantNodes.forEach((node) => {
      if (!seen.has(node)) {
        seen.add(node);
        tagged.push({ element: node, role: 'assistant' });
      }
    });

    tagged.sort((a, b) => {
      if (a.element === b.element) return 0;
      const pos = a.element.compareDocumentPosition(b.element);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const topLevel = [];
    for (let i = 0; i < tagged.length; i++) {
      const current = tagged[i].element;
      let isNested = false;
      for (let j = 0; j < tagged.length; j++) {
        if (i !== j && tagged[j].element.contains(current)) {
          isNested = true;
          break;
        }
      }
      if (!isNested) {
        topLevel.push(tagged[i]);
      }
    }

    const messages = [];
    for (const item of topLevel) {
      const markdown = domToMarkdown(item.element);
      if (markdown && markdown.trim().length > 0) {
        messages.push({
          role: item.role,
          content: markdown.trim(),
        });
      }
    }

    return messages;
  }

  /* ==========================================================================
     4. INPUT DETECTION & SAFE FILL (NEVER AUTO-SENDS)
     ========================================================================== */
  function findMessageInput() {
    const adapter = getCurrentAdapter();
    for (const sel of adapter.inputSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0)) {
          return el;
        }
      } catch (err) {}
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return active;
    }
    return document.querySelector('div.ProseMirror, div.ql-editor, textarea, [contenteditable="true"]');
  }

  /**
   * Safely inserts text into the message box.
   * Never overwrites existing drafts, never auto-sends.
   */
  async function fillInput(text) {
    const inputEl = findMessageInput();

    if (inputEl) {
      inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputEl.focus();

      if (inputEl.tagName === 'TEXTAREA') {
        const currentVal = inputEl.value || '';
        const newVal = currentVal ? `${currentVal}\n\n${text}` : text;

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(inputEl, newVal);
        } else {
          inputEl.value = newVal;
        }

        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
        // Place cursor at the END (never overwrite an existing draft)
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false); // Collapse to end
        sel.removeAllRanges();
        sel.addRange(range);

        // Try synthetic paste event with DataTransfer
        let pasteWorked = false;
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          });
          pasteWorked = inputEl.dispatchEvent(pasteEvent);
        } catch (e) {}

        // Fallback to document.execCommand('insertText') if not landed
        const snippet = text.slice(0, 30);
        if (!pasteWorked || !inputEl.textContent.includes(snippet)) {
          try {
            document.execCommand('insertText', false, text);
          } catch (e) {
            console.warn('[Chat Capsule] execCommand fallback:', e);
          }
        }

        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // After ~200ms verify the text actually landed
    await new Promise((r) => setTimeout(r, 220));

    let landed = false;
    if (inputEl) {
      const content = (inputEl.value || inputEl.textContent || '').trim();
      const snippet = text.slice(0, 30);
      if (content.includes('This is a capsule') || content.includes(snippet)) {
        landed = true;
      }
    }

    if (landed) {
      showPill({
        state: 'success',
        title: 'Capsule loaded',
        detail: 'Review it and press send.',
      });
      return true;
    } else {
      await copyTextToClipboard(text);
      showPill({
        state: 'info',
        title: "Couldn't find the message box",
        detail: 'Capsule copied, paste it in.',
      });
      return false;
    }
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      console.warn('[Chat Capsule] navigator.clipboard.writeText failed:', e);
    }
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
      const success = document.execCommand('copy');
      document.body.removeChild(ta);
      return success;
    } catch (e2) {
      console.error('[Chat Capsule] execCommand fallback failed:', e2);
      return false;
    }
  }

  /* ==========================================================================
     5. CORE ACTIONS: SEAL & OPEN
     ========================================================================== */
  async function sealCurrentChat() {
    const adapter = getCurrentAdapter();

    // Step 1: Initial sealing pill state (halves slightly apart + "Sealing...")
    showPill({
      state: 'sealing',
      title: 'Sealing...',
    });

    const messages = collectMessages();

    if (messages.length === 0) {
      showPill({
        state: 'error',
        title: "Couldn't read this chat",
        detail: 'Selectors may need updating.',
      });
      return null;
    }

    if (messages.length < 2) {
      showPill({
        state: 'error',
        title: "Couldn't read this chat",
        detail: `Found only 1 message on ${adapter.name}.`,
      });
      return null;
    }

    if (!window.CapsuleLib) {
      showPill({
        state: 'error',
        title: 'CapsuleLib not loaded',
        detail: 'Please refresh the page.',
      });
      return null;
    }

    const capsule = window.CapsuleLib.build(messages, {
      source: adapter.source,
      url: window.location.href,
    });

    try {
      await window.CapsuleLib.store.save(capsule);
    } catch (saveErr) {
      if (saveErr?.message?.includes('invalidated') || (typeof chrome !== 'undefined' && !chrome.runtime?.id)) {
        showPill({
          state: 'error',
          title: 'Extension reloaded',
          detail: 'Please refresh this page (F5) to seal.',
        });
        return null;
      }
      throw saveErr;
    }

    const mode = await getPreferredMode();
    const prompt = window.CapsuleLib.toPrompt(capsule, mode);
    const copied = await copyTextToClipboard(prompt);

    const tokens = window.CapsuleLib.approxTokens(prompt);
    const tokenDisplay = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;

    // Brief transition delay (~320ms) so the "Sealing..." animation is perceived
    await new Promise((r) => setTimeout(r, 320));

    // Steps 2, 3 & 4: Halves slide together with tiny bounce, morph to checkmark,
    // text changes to "Sealed", secondary stats line, "Copied" badge, and "Undo" button
    showPill({
      state: 'success',
      title: 'Sealed',
      detail: `${messages.length} messages · ~${tokenDisplay} tokens · ${mode === 'full' ? 'Full' : 'Compact'}`,
      copied: !!copied,
      onUndo: async () => {
        await window.CapsuleLib.store.remove(capsule.id);
        refreshRecentCapsules();
        showPill({
          state: 'info',
          title: 'Removed',
        });
      },
    });

    refreshRecentCapsules();
    return capsule;
  }

  async function openCapsule(id, modeOverride) {
    if (!window.CapsuleLib) return false;
    const capsule = await window.CapsuleLib.store.get(id);
    if (!capsule) {
      showPill({
        state: 'error',
        title: 'Capsule not found in storage.',
      });
      return false;
    }

    const mode = modeOverride || (await getPreferredMode());
    const prompt = window.CapsuleLib.toPrompt(capsule, mode);
    return await fillInput(prompt);
  }

  async function getPreferredMode() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get(['preferredMode']);
        return res.preferredMode === 'full' ? 'full' : 'compact';
      }
    } catch (e) {}
    return 'compact';
  }

  async function setPreferredMode(mode) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ preferredMode: mode === 'full' ? 'full' : 'compact' });
      }
    } catch (e) {}
  }

  /* ==========================================================================
     6. FINAL IN-PAGE SHADOW DOM UI
     Mounted once on document.documentElement, isolated from site CSS.
     - Two-tone SVG capsule icon (Electric Cyan #06b6d4 & Warm Amber #f59e0b).
     - Sliding halves seal animation + glow pulse + toast.
     - Quiet, compact popover menu.
     - Keyboard accessible (Escape closes, visible focus).
     - Respects prefers-reduced-motion.
     ========================================================================== */

  let shadowRoot = null;
  let isSealingState = false;

  function initShadowDOMUI() {
    // Guard against mounting twice
    if (document.getElementById('chat-capsule-host')) return;

    const host = document.createElement('div');
    host.id = 'chat-capsule-host';
    host.style.all = 'initial';
    document.documentElement.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'open' });

    // Styles inside Shadow DOM
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      /* Accessible focus */
      button:focus-visible {
        outline: 2px solid #38bdf8;
        outline-offset: 2px;
      }

      /* Floating round capsule button */
      .cc-launcher {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: #090d16;
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, border-color 0.2s ease;
        user-select: none;
        outline: none;
      }

      .cc-launcher:hover {
        transform: scale(1.08) translateY(-2px);
        border-color: rgba(6, 182, 212, 0.5);
        box-shadow: 0 8px 24px rgba(6, 182, 212, 0.25), 0 2px 6px rgba(0, 0, 0, 0.3);
      }

      .cc-launcher:active {
        transform: scale(0.96);
      }

      /* Distinctive two-tone SVG Capsule:
         Electric Cyan (#06b6d4) & Warm Amber (#f59e0b) */
      .cc-capsule-svg {
        display: block;
        overflow: visible;
      }

      /* The two halves start slightly apart */
      .cc-half {
        transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .cc-half-left {
        transform: translate(-1.5px, 0);
      }

      .cc-half-right {
        transform: translate(1.5px, 0);
      }

      /* Seal Animation: Halves slide together + short glow pulse */
      .cc-launcher.is-sealing .cc-half-left {
        transform: translate(1.5px, 0);
      }

      .cc-launcher.is-sealing .cc-half-right {
        transform: translate(-1.5px, 0);
      }

      .cc-launcher.is-sealing {
        animation: cc-seal-glow 0.65s ease-out;
      }

      @keyframes cc-seal-glow {
        0% {
          box-shadow: 0 0 0 rgba(6, 182, 212, 0);
        }
        50% {
          box-shadow: 0 0 24px rgba(6, 182, 212, 0.8), 0 0 12px rgba(245, 158, 11, 0.6);
        }
        100% {
          box-shadow: 0 0 8px rgba(6, 182, 212, 0.4);
        }
      }

      /* Quiet, compact popover menu */
      .cc-popover {
        position: fixed;
        bottom: 86px;
        right: 24px;
        width: 290px;
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 2147483647;
        display: none;
        flex-direction: column;
        overflow: hidden;
        animation: cc-fade-up 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .cc-popover.is-open {
        display: flex;
      }

      @keyframes cc-fade-up {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.97);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .cc-header {
        padding: 10px 14px;
        background: rgba(30, 41, 59, 0.65);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .cc-title-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .cc-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #f8fafc;
      }

      .cc-site-tag {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(6, 182, 212, 0.15);
        color: #22d3ee;
        border: 1px solid rgba(6, 182, 212, 0.3);
      }

      .cc-close {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 16px;
        cursor: pointer;
        width: 22px;
        height: 22px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .cc-close:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.1);
      }

      .cc-body {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 380px;
        overflow-y: auto;
      }

      /* Quiet menu buttons */
      .cc-action-seal {
        width: 100%;
        background: #1e293b;
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        transition: background 0.15s ease, border-color 0.15s ease;
      }

      .cc-action-seal:hover {
        background: #334155;
        border-color: rgba(6, 182, 212, 0.4);
      }

      /* Mode switcher */
      .cc-mode-group {
        display: flex;
        background: rgba(15, 23, 42, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        padding: 2px;
      }

      .cc-mode-btn {
        flex: 1;
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 11px;
        font-weight: 500;
        font-family: inherit;
        padding: 4px 6px;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.12s ease;
      }

      .cc-mode-btn.active {
        background: #334155;
        color: #f8fafc;
        font-weight: 600;
      }

      .cc-section-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #64748b;
        margin-top: 2px;
      }

      .cc-recent-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .cc-recent-item {
        background: rgba(30, 41, 59, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 6px;
        padding: 7px 9px;
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease;
      }

      .cc-recent-item:hover {
        background: rgba(30, 41, 59, 0.9);
        border-color: rgba(6, 182, 212, 0.35);
      }

      .cc-item-top {
        font-size: 11px;
        font-weight: 600;
        color: #e2e8f0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .cc-item-bottom {
        font-size: 9px;
        color: #64748b;
        display: flex;
        justify-content: space-between;
        margin-top: 2px;
      }

      .cc-empty {
        font-size: 11px;
        color: #64748b;
        text-align: center;
        padding: 10px 0;
      }

      /* =========================================================
         NON-BLOCKING DYNAMIC CAPSULE PILL NOTIFICATION
         ========================================================= */
      .cc-pill-host {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        pointer-events: none;
        display: flex;
        justify-content: center;
      }

      .cc-pill {
        pointer-events: auto;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-height: 44px;
        max-width: 90vw;
        padding: 8px 18px;
        border-radius: 999px;
        background: #111111;
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38), 0 2px 6px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        user-select: none;
        animation: cc-pill-enter 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        transition: max-width 0.28s cubic-bezier(0.34, 1.56, 0.64, 1),
                    padding 0.2s ease,
                    background 0.2s ease,
                    border-color 0.2s ease;
      }

      .cc-pill.is-leaving {
        animation: cc-pill-leave 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
        pointer-events: none;
      }

      .cc-pill.cc-pill-error {
        border-color: rgba(245, 158, 11, 0.55);
        animation: cc-pill-enter 0.38s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
                   cc-pill-shake 0.42s ease-in-out 0.12s 1;
      }

      @keyframes cc-pill-enter {
        from {
          opacity: 0;
          transform: translateY(-22px) scale(0.92);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      @keyframes cc-pill-leave {
        from {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        to {
          opacity: 0;
          transform: translateY(-16px) scale(0.95);
        }
      }

      @keyframes cc-pill-shake {
        0%, 100% { transform: translateX(0); }
        20%, 60% { transform: translateX(-5px); }
        40%, 80% { transform: translateX(5px); }
      }

      /* Pill Light Mode */
      @media (prefers-color-scheme: light) {
        .cc-pill {
          background: #ffffff;
          color: #111827;
          border: 1px solid rgba(0, 0, 0, 0.1);
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.06);
        }
        .cc-pill.cc-pill-error {
          border-color: rgba(217, 119, 6, 0.6);
        }
        .cc-pill-secondary {
          color: rgba(0, 0, 0, 0.6) !important;
        }
      }

      /* Capsule icon in pill */
      .cc-pill-icon-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 22px;
        height: 22px;
      }

      .cc-pill-capsule-svg {
        display: block;
        overflow: visible;
      }

      .cc-pill-half {
        transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .cc-pill-sealing .cc-pill-half-left {
        transform: translate(-1.5px, 0);
      }

      .cc-pill-sealing .cc-pill-half-right {
        transform: translate(1.5px, 0);
      }

      .cc-pill-sealed .cc-pill-half-left {
        transform: translate(1.5px, 0);
      }

      .cc-pill-sealed .cc-pill-half-right {
        transform: translate(-1.5px, 0);
      }

      .cc-pill-check-morph {
        animation: cc-icon-morph 0.32s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }

      @keyframes cc-icon-morph {
        0% { transform: scale(0.6); opacity: 0; }
        70% { transform: scale(1.15); opacity: 1; }
        100% { transform: scale(1); opacity: 1; }
      }

      /* Text structure */
      .cc-pill-content {
        display: flex;
        flex-direction: column;
        justify-content: center;
        text-align: left;
        gap: 1px;
      }

      .cc-pill-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .cc-pill-primary {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.25;
        white-space: nowrap;
      }

      .cc-pill-secondary {
        font-size: 12px;
        font-weight: 400;
        color: rgba(255, 255, 255, 0.6);
        font-feature-settings: "tnum" 1;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        line-height: 1.25;
      }

      /* Copied badge */
      .cc-pill-copied {
        font-size: 11px;
        font-weight: 500;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(6, 182, 212, 0.14);
        color: #06b6d4;
        animation: cc-fade-in 0.25s ease forwards;
      }

      @keyframes cc-fade-in {
        from { opacity: 0; transform: scale(0.9); }
        to { opacity: 1; transform: scale(1); }
      }

      /* Undo button */
      .cc-pill-undo-btn {
        background: transparent;
        border: none;
        color: #06b6d4;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 2px 6px;
        margin-left: 4px;
        text-decoration: underline;
        text-underline-offset: 2px;
        border-radius: 4px;
        transition: opacity 0.15s ease;
      }

      .cc-pill-undo-btn:hover {
        opacity: 0.8;
      }

      /* Reduced motion */
      @media (prefers-reduced-motion: reduce) {
        .cc-launcher,
        .cc-half,
        .cc-popover {
          transition: none !important;
          animation: none !important;
          transform: none !important;
        }
        .cc-pill {
          animation: cc-pill-fade 0.15s ease forwards !important;
          transition: none !important;
        }
        .cc-pill.is-leaving {
          animation: cc-pill-fade-out 0.15s ease forwards !important;
        }
        .cc-pill.cc-pill-error {
          animation: cc-pill-fade 0.15s ease forwards !important;
        }
        .cc-pill-half {
          transition: none !important;
        }
        .cc-pill-check-morph,
        .cc-pill-copied {
          animation: none !important;
        }
      }

      @keyframes cc-pill-fade {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes cc-pill-fade-out {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;

    shadowRoot.appendChild(style);

    const adapter = getCurrentAdapter();

    // Container DOM
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <!-- Launcher with tilted two-tone SVG capsule -->
      <button class="cc-launcher" id="cc-launcher-btn" title="Chat Capsule: Seal or Open Context" aria-label="Open Chat Capsule menu" type="button">
        <svg class="cc-capsule-svg" viewBox="0 0 36 36" width="30" height="30" aria-hidden="true">
          <g transform="rotate(-45 18 18)">
            <!-- Left half (Cyan) -->
            <path class="cc-half cc-half-left" d="M 8 13 A 5 5 0 0 0 8 23 L 16.5 23 L 16.5 13 Z" fill="#06b6d4" />
            <!-- Right half (Amber) -->
            <path class="cc-half cc-half-right" d="M 19.5 13 L 19.5 23 L 28 23 A 5 5 0 0 0 28 13 Z" fill="#f59e0b" />
          </g>
        </svg>
      </button>

      <!-- Compact Popover Menu -->
      <div class="cc-popover" id="cc-popover" role="dialog" aria-label="Chat Capsule Menu">
        <div class="cc-header">
          <div class="cc-title-wrap">
            <span class="cc-title">Chat Capsule</span>
            <span class="cc-site-tag" id="cc-site-tag">${escapeHtml(adapter.name)}</span>
          </div>
          <button class="cc-close" id="cc-close-btn" aria-label="Close menu" type="button">&times;</button>
        </div>

        <div class="cc-body">
          <button class="cc-action-seal" id="cc-seal-btn" type="button">
            <span>💊</span> Seal this chat
          </button>

          <div class="cc-mode-group" role="group" aria-label="Capsule prompt mode">
            <button class="cc-mode-btn active" id="cc-mode-compact" data-mode="compact" type="button">Compact</button>
            <button class="cc-mode-btn" id="cc-mode-full" data-mode="full" type="button">Full</button>
          </div>

          <div class="cc-section-label">Recent Capsules</div>
          <div class="cc-recent-list" id="cc-recent-list">
            <div class="cc-empty">No capsules yet.</div>
          </div>
        </div>
      </div>

      <!-- Non-blocking Dynamic Capsule Pill Container -->
      <div class="cc-pill-host" id="cc-pill-host"></div>
    `;

    shadowRoot.appendChild(wrapper);

    bindShadowEvents();
    refreshRecentCapsules();
  }

  /* ==========================================================================
     NON-BLOCKING DYNAMIC CAPSULE PILL CONTROLLER
     ========================================================================== */
  let activePillTimeout = null;
  let pillTimerStartedAt = 0;
  let pillTimerRemaining = 3500;

  /**
   * Displays or updates the non-blocking dynamic capsule pill notification.
   * Replaces existing pill smoothly without stacking.
   * @param {Object} options
   * @param {'sealing'|'success'|'error'|'info'} options.state
   * @param {string} options.title
   * @param {string} [options.detail]
   * @param {Function} [options.onUndo]
   * @param {boolean} [options.copied]
   */
  function showPill({ state = 'info', title = '', detail = '', onUndo = null, copied = false }) {
    if (!shadowRoot) return;

    let host = shadowRoot.getElementById('cc-pill-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'cc-pill-host';
      host.className = 'cc-pill-host';
      shadowRoot.appendChild(host);
    }

    // Clear any active timer
    if (activePillTimeout) {
      clearTimeout(activePillTimeout);
      activePillTimeout = null;
    }

    let pill = host.querySelector('.cc-pill');

    if (!pill) {
      pill = document.createElement('div');
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      host.appendChild(pill);
    }

    // Apply state classes
    pill.className = `cc-pill cc-pill-${state}`;
    if (state === 'sealing') {
      pill.classList.add('cc-pill-sealing');
    } else if (state === 'success' && title.toLowerCase().includes('sealed')) {
      pill.classList.add('cc-pill-sealed');
    }

    // Clean inline SVG icons
    let iconSvg = '';
    if (state === 'sealing') {
      iconSvg = `
        <svg class="cc-pill-capsule-svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <g transform="rotate(-45 12 12)">
            <path class="cc-pill-half cc-pill-half-left" d="M 5 9 A 3 3 0 0 0 5 15 L 10.5 15 L 10.5 9 Z" fill="#06b6d4" />
            <path class="cc-pill-half cc-pill-half-right" d="M 13.5 9 L 13.5 15 L 19 15 A 3 3 0 0 0 19 9 Z" fill="#f59e0b" />
          </g>
        </svg>`;
    } else if (state === 'success') {
      iconSvg = `
        <svg class="cc-pill-check-morph" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#06b6d4" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 10 8 14 16 6"></polyline>
        </svg>`;
    } else if (state === 'error') {
      iconSvg = `
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="8"></circle>
          <line x1="10" y1="6" x2="10" y2="10"></line>
          <line x1="10" y1="14" x2="10.01" y2="14"></line>
        </svg>`;
    } else {
      iconSvg = `
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="8"></circle>
          <line x1="10" y1="10" x2="10" y2="14"></line>
          <line x1="10" y1="6" x2="10.01" y2="6"></line>
        </svg>`;
    }

    const detailHtml = detail ? `<span class="cc-pill-secondary">${escapeHtml(detail)}</span>` : '';
    const copiedHtml = copied ? `<span class="cc-pill-copied">Copied</span>` : '';
    const undoHtml = onUndo ? `<button type="button" class="cc-pill-undo-btn" id="cc-pill-undo">Undo</button>` : '';

    pill.innerHTML = `
      <div class="cc-pill-icon-wrap">${iconSvg}</div>
      <div class="cc-pill-content">
        <div class="cc-pill-row">
          <span class="cc-pill-primary">${escapeHtml(title)}</span>
          ${copiedHtml}
          ${undoHtml}
        </div>
        ${detailHtml}
      </div>
    `;

    // Dismissal with smooth slide-up and fade-out
    const dismiss = () => {
      if (activePillTimeout) {
        clearTimeout(activePillTimeout);
        activePillTimeout = null;
      }
      if (pill && !pill.classList.contains('is-leaving')) {
        pill.classList.add('is-leaving');
        setTimeout(() => {
          if (pill.parentElement) pill.remove();
        }, 220);
      }
    };

    // Auto-dismiss after 3.5s (except during sealing progress)
    pillTimerRemaining = 3500;
    pillTimerStartedAt = Date.now();

    const startTimer = (duration) => {
      if (state === 'sealing') return;
      activePillTimeout = setTimeout(dismiss, duration);
    };

    startTimer(pillTimerRemaining);

    // Hovering pauses the timer
    pill.onmouseenter = () => {
      if (activePillTimeout) {
        clearTimeout(activePillTimeout);
        activePillTimeout = null;
        pillTimerRemaining -= Date.now() - pillTimerStartedAt;
        if (pillTimerRemaining < 1000) pillTimerRemaining = 1500;
      }
    };

    pill.onmouseleave = () => {
      if (state !== 'sealing') {
        pillTimerStartedAt = Date.now();
        startTimer(pillTimerRemaining);
      }
    };

    // Clicking the pill dismisses immediately
    pill.onclick = (e) => {
      if (e.target && e.target.closest('#cc-pill-undo')) return;
      dismiss();
    };

    // Escape key dismisses immediately
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        dismiss();
        document.removeEventListener('keydown', onKeyDown);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Undo button handler
    if (onUndo) {
      const undoBtn = pill.querySelector('#cc-pill-undo');
      if (undoBtn) {
        undoBtn.onclick = async (e) => {
          e.stopPropagation();
          try {
            await onUndo();
          } catch (err) {
            console.error('[Chat Capsule] Undo failed:', err);
          }
        };
      }
    }
  }

  async function refreshRecentCapsules() {
    if (!shadowRoot || !window.CapsuleLib) return;
    if (typeof chrome !== 'undefined' && !chrome.runtime?.id) return;
    const listEl = shadowRoot.getElementById('cc-recent-list');
    if (!listEl) return;

    try {
      const capsules = await window.CapsuleLib.store.list();
      const mode = await getPreferredMode();
      const recent = capsules.slice(0, 5);

      if (recent.length === 0) {
        listEl.innerHTML = `<div class="cc-empty">No capsules yet.<br>Click "Seal this chat" to save one.</div>`;
        return;
      }

      listEl.innerHTML = '';
      recent.forEach((cap) => {
        const item = document.createElement('div');
        item.className = 'cc-recent-item';
        item.tabIndex = 0;
        item.setAttribute('role', 'button');

        const promptText = window.CapsuleLib.toPrompt(cap, mode);
        const tokens = window.CapsuleLib.approxTokens(promptText);
        const tokenDisplay = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
        const count = (cap.messages || []).length;
        const sourceName = cap.source || 'AI';

        item.innerHTML = `
          <div class="cc-item-top" title="${escapeHtml(cap.title || '')}">${escapeHtml(cap.title || 'Untitled Capsule')}</div>
          <div class="cc-item-bottom">
            <span>${escapeHtml(sourceName)} • ${count} msgs</span>
            <span>~${tokenDisplay} tokens (${mode})</span>
          </div>
        `;

        const onSelect = async () => {
          shadowRoot.getElementById('cc-popover')?.classList.remove('is-open');
          await fillInput(promptText);
        };

        item.addEventListener('click', onSelect);
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        });

        listEl.appendChild(item);
      });
    } catch (e) {
      console.error('[Chat Capsule] Failed to load recent capsules:', e);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function bindShadowEvents() {
    const launcher = shadowRoot.getElementById('cc-launcher-btn');
    const popover = shadowRoot.getElementById('cc-popover');
    const closeBtn = shadowRoot.getElementById('cc-close-btn');
    const sealBtn = shadowRoot.getElementById('cc-seal-btn');
    const compactBtn = shadowRoot.getElementById('cc-mode-compact');
    const fullBtn = shadowRoot.getElementById('cc-mode-full');

    // Toggle popover
    launcher.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = popover.classList.toggle('is-open');
      if (open) {
        refreshRecentCapsules();
        sealBtn.focus();
      }
    });

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.remove('is-open');
      launcher.focus();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      const host = document.getElementById('chat-capsule-host');
      if (host && !e.composedPath().includes(host)) {
        popover.classList.remove('is-open');
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popover.classList.contains('is-open')) {
        popover.classList.remove('is-open');
        launcher.focus();
      }
    });

    // Mode Toggle
    let mode = await getPreferredMode();
    updateModeButtons(mode);

    compactBtn.addEventListener('click', async () => {
      mode = 'compact';
      updateModeButtons(mode);
      await setPreferredMode('compact');
      refreshRecentCapsules();
    });

    fullBtn.addEventListener('click', async () => {
      mode = 'full';
      updateModeButtons(mode);
      await setPreferredMode('full');
      refreshRecentCapsules();
    });

    function updateModeButtons(m) {
      if (m === 'full') {
        fullBtn.classList.add('active');
        compactBtn.classList.remove('active');
      } else {
        compactBtn.classList.add('active');
        fullBtn.classList.remove('active');
      }
    }

    // Seal Chat with Sliding Animation
    sealBtn.addEventListener('click', async () => {
      popover.classList.remove('is-open');

      if (isSealingState) return;
      isSealingState = true;

      // Sliding halves animation + glow pulse on the launcher button
      launcher.classList.add('is-sealing');

      try {
        await sealCurrentChat();
      } catch (err) {
        if (err?.message?.includes('invalidated') || (typeof chrome !== 'undefined' && !chrome.runtime?.id)) {
          showPill({ state: 'error', title: 'Extension reloaded', detail: 'Please refresh this page (F5) to reconnect.' });
        } else {
          showPill({ state: 'error', title: 'Error sealing chat', detail: err?.message || String(err) });
        }
      } finally {
        setTimeout(() => {
          launcher.classList.remove('is-sealing');
          isSealingState = false;
        }, 700);
      }
    });
  }

  /* ==========================================================================
     7. CHROME.RUNTIME.ONMESSAGE LISTENER
     Listens for {type: "SEAL"} and {type: "OPEN", id, mode}.
     Returns true for async responses.
     ========================================================================== */
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return false;

        const isSeal = message.type === 'SEAL' || message.action === 'seal_current_chat';
        const isOpen = message.type === 'OPEN' || message.action === 'inject_capsule';

        if (isSeal) {
          // Trigger the visual slide animation on the button if mounted
          const launcher = shadowRoot?.getElementById('cc-launcher-btn');
          launcher?.classList.add('is-sealing');

          sealCurrentChat()
            .then((capsule) => {
              sendResponse({ success: !!capsule, capsule });
            })
            .catch((err) => {
              sendResponse({ success: false, error: err.message });
            })
            .finally(() => {
              setTimeout(() => launcher?.classList.remove('is-sealing'), 700);
            });
          return true;
        }

        if (isOpen) {
          const capId = message.id || message.capsuleId;
          const mode = message.mode;
          openCapsule(capId, mode)
            .then((success) => {
              sendResponse({ success });
            })
            .catch((err) => {
              sendResponse({ success: false, error: err.message });
            });
          return true;
        }

        return false;
      });
    }
  } catch (err) {
    console.warn('[Chat Capsule] runtime.onMessage setup skipped:', err);
  }

  // Initialize UI once document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShadowDOMUI);
  } else {
    initShadowDOMUI();
  }

  // Handle SPA transitions (Claude, ChatGPT, Gemini history navigation)
  let lastObservedUrl = window.location.href;
  function handleSpaNavigation() {
    if (window.location.href !== lastObservedUrl) {
      lastObservedUrl = window.location.href;
      if (!document.getElementById('chat-capsule-host')) {
        initShadowDOMUI();
      } else if (shadowRoot) {
        const tag = shadowRoot.getElementById('cc-site-tag');
        if (tag) tag.textContent = getCurrentAdapter().name;
        refreshRecentCapsules();
      }
    }
  }

  window.addEventListener('popstate', handleSpaNavigation);
  try {
    const spaObserver = new MutationObserver(() => handleSpaNavigation());
    spaObserver.observe(document.documentElement, { childList: true });
  } catch (e) {}
})();
