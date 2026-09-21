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
      showToast('Capsule placed in message box. Review and send when ready.', 'success', 4500);
      return true;
    } else {
      await copyTextToClipboard(text);
      showToast("Couldn't find the message box. Capsule copied, paste it in.", 'warning', 6000);
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
    const messages = collectMessages();

    if (messages.length === 0) {
      showToast(
        `No messages found in this chat yet. Please send a message or open an existing conversation.`,
        'warning',
        6000
      );
      return null;
    }

    if (messages.length < 2) {
      showToast(
        `Found only 1 message on ${adapter.name}. A conversation needs at least 2 turns to seal a capsule.`,
        'warning',
        6000
      );
      return null;
    }

    if (!window.CapsuleLib) {
      throw new Error('CapsuleLib is not loaded.');
    }

    const capsule = window.CapsuleLib.build(messages, {
      source: adapter.source,
      url: window.location.href,
    });

    try {
      await window.CapsuleLib.store.save(capsule);
    } catch (saveErr) {
      if (saveErr?.message?.includes('invalidated') || (typeof chrome !== 'undefined' && !chrome.runtime?.id)) {
        showToast('Extension was reloaded. Please refresh this page (F5) to seal.', 'warning', 6000);
        return null;
      }
      throw saveErr;
    }

    const mode = await getPreferredMode();
    const prompt = window.CapsuleLib.toPrompt(capsule, mode);
    await copyTextToClipboard(prompt);

    const tokens = window.CapsuleLib.approxTokens(prompt);
    const tokenDisplay = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;

    // Pop the cinematic on-screen seal animation!
    playSealPopAnimation({
      count: messages.length,
      tokens: tokenDisplay,
      source: adapter.name,
      mode: mode,
    });

    // Toast: "Capsule sealed. 24 messages, about 3.2k tokens."
    showToast(
      `Capsule sealed. ${messages.length} messages, about ${tokenDisplay} tokens.`,
      'success',
      5000
    );

    refreshRecentCapsules();
    return capsule;
  }

  async function openCapsule(id, modeOverride) {
    if (!window.CapsuleLib) return false;
    const capsule = await window.CapsuleLib.store.get(id);
    if (!capsule) {
      showToast('Capsule not found in storage.', 'error', 4000);
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

      /* Auto-dismissing Toasts container */
      .cc-toast-box {
        position: fixed;
        bottom: 86px;
        right: 24px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        z-index: 2147483647;
        pointer-events: none;
      }

      .cc-toast-msg {
        background: rgba(15, 23, 42, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #f8fafc;
        border-radius: 8px;
        padding: 9px 13px;
        font-size: 12px;
        line-height: 1.4;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
        max-width: 320px;
        pointer-events: auto;
        animation: cc-toast-anim 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .cc-toast-success {
        border-left: 3px solid #10b981;
      }

      .cc-toast-warning {
        border-left: 3px solid #f59e0b;
      }

      .cc-toast-error {
        border-left: 3px solid #ef4444;
      }

      @keyframes cc-toast-anim {
        from {
          opacity: 0;
          transform: translateY(10px) scale(0.96);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* =========================================================
         CINEMATIC SCREEN POP ANIMATION (WHEN SEALED)
         ========================================================= */
      .cc-pop-overlay {
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
        cursor: pointer;
        opacity: 1;
        transition: opacity 0.28s ease;
      }

      .cc-pop-overlay.is-leaving {
        opacity: 0;
        pointer-events: none;
      }

      .cc-pop-backdrop {
        position: absolute;
        inset: 0;
        background: radial-gradient(circle at center, rgba(6, 182, 212, 0.18) 0%, rgba(15, 23, 42, 0.88) 55%, rgba(6, 9, 15, 0.95) 100%);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        animation: cc-pop-bg-in 0.25s ease-out forwards;
      }

      @keyframes cc-pop-bg-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      /* Expanding Shockwave */
      .cc-pop-shockwave {
        position: absolute;
        width: 240px;
        height: 240px;
        border-radius: 50%;
        border: 2px solid rgba(6, 182, 212, 0.8);
        box-shadow: 0 0 30px rgba(6, 182, 212, 0.6), inset 0 0 20px rgba(245, 158, 11, 0.5);
        pointer-events: none;
        animation: cc-shockwave-burst 0.85s cubic-bezier(0.1, 0.9, 0.2, 1) forwards;
      }

      @keyframes cc-shockwave-burst {
        0% {
          transform: scale(0.2);
          opacity: 1;
          border-width: 4px;
        }
        50% {
          opacity: 0.8;
        }
        100% {
          transform: scale(2.8);
          opacity: 0;
          border-width: 1px;
        }
      }

      /* Central Holographic Cyber Card */
      .cc-pop-card {
        position: relative;
        z-index: 2;
        width: 380px;
        max-width: 92vw;
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.94) 0%, rgba(9, 13, 22, 0.98) 100%);
        border: 1px solid rgba(6, 182, 212, 0.35);
        border-radius: 20px;
        padding: 24px 22px 20px;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.08),
          0 20px 50px rgba(0, 0, 0, 0.7),
          0 0 40px rgba(6, 182, 212, 0.2);
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        animation: cc-card-spring 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
        overflow: hidden;
      }

      @keyframes cc-card-spring {
        0% {
          opacity: 0;
          transform: scale(0.55) translateY(30px);
        }
        70% {
          transform: scale(1.04) translateY(-3px);
        }
        100% {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }

      .cc-pop-overlay.is-leaving .cc-pop-card {
        animation: cc-card-leave 0.25s ease forwards;
      }

      @keyframes cc-card-leave {
        to {
          opacity: 0;
          transform: scale(0.9) translateY(-20px);
        }
      }

      .cc-pop-card-glare {
        position: absolute;
        top: -60px;
        left: -60px;
        width: 160px;
        height: 160px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(6, 182, 212, 0.25) 0%, transparent 70%);
        pointer-events: none;
      }

      .cc-pop-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #94a3b8;
        margin-bottom: 12px;
      }

      .cc-pop-pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #06b6d4;
        box-shadow: 0 0 10px #06b6d4;
        animation: cc-pop-pulse 1.2s infinite ease-in-out;
      }

      @keyframes cc-pop-pulse {
        0%, 100% { transform: scale(1); opacity: 0.8; }
        50% { transform: scale(1.4); opacity: 1; }
      }

      .cc-pop-source {
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.3);
        padding: 2px 7px;
        border-radius: 999px;
        font-size: 10px;
      }

      /* Capsule Stage & Animation */
      .cc-pop-stage {
        position: relative;
        width: 140px;
        height: 140px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 6px 0 14px;
      }

      .cc-pop-glow-disc {
        position: absolute;
        width: 110px;
        height: 110px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(6, 182, 212, 0.3) 0%, rgba(245, 158, 11, 0.15) 50%, transparent 75%);
        filter: blur(14px);
        animation: cc-disc-pulse 1.5s infinite alternate ease-in-out;
      }

      @keyframes cc-disc-pulse {
        0% { transform: scale(0.9); opacity: 0.7; }
        100% { transform: scale(1.15); opacity: 1; }
      }

      .cc-pop-svg {
        overflow: visible;
        filter: drop-shadow(0 8px 16px rgba(0,0,0,0.5));
      }

      /* Rotating Orbit Rings */
      .cc-pop-ring-outer {
        transform-origin: 80px 80px;
        animation: cc-rotate-cw 12s linear infinite;
      }

      .cc-pop-ring-inner {
        transform-origin: 80px 80px;
        animation: cc-rotate-ccw 8s linear infinite;
      }

      @keyframes cc-rotate-cw {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      @keyframes cc-rotate-ccw {
        from { transform: rotate(360deg); }
        to { transform: rotate(0deg); }
      }

      /* Capsule Snap Action: Halves fly together and slam into place */
      .cc-pop-half-left {
        animation: cc-snap-left 0.45s cubic-bezier(0.2, 1.2, 0.3, 1) forwards;
      }

      .cc-pop-half-right {
        animation: cc-snap-right 0.45s cubic-bezier(0.2, 1.2, 0.3, 1) forwards;
      }

      @keyframes cc-snap-left {
        0% {
          transform: translate(-30px, 0);
          opacity: 0.5;
        }
        70% {
          transform: translate(3px, 0);
          opacity: 1;
        }
        100% {
          transform: translate(0, 0);
          opacity: 1;
        }
      }

      @keyframes cc-snap-right {
        0% {
          transform: translate(30px, 0);
          opacity: 0.5;
        }
        70% {
          transform: translate(-3px, 0);
          opacity: 1;
        }
        100% {
          transform: translate(0, 0);
          opacity: 1;
        }
      }

      /* Contact Flash Spark */
      .cc-pop-flash {
        position: absolute;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 0 24px 10px #ffffff, 0 0 45px 18px #06b6d4, 0 0 60px 24px #f59e0b;
        pointer-events: none;
        opacity: 0;
        animation: cc-flash-burst 0.55s ease-out 0.32s forwards;
      }

      @keyframes cc-flash-burst {
        0% {
          transform: scale(0.2);
          opacity: 0;
        }
        30% {
          transform: scale(2.4);
          opacity: 1;
        }
        100% {
          transform: scale(3.5);
          opacity: 0;
        }
      }

      /* Starburst Sparks */
      .cc-pop-sparks {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .cc-spark {
        position: absolute;
        font-size: 13px;
        color: #38bdf8;
        text-shadow: 0 0 8px #06b6d4;
        opacity: 0;
        animation: cc-spark-fly 0.65s ease-out 0.34s forwards;
      }

      .cc-spark.s1 { top: 20%; left: 18%; color: #38bdf8; --tx: -24px; --ty: -20px; }
      .cc-spark.s2 { top: 18%; right: 18%; color: #fbbf24; --tx: 24px; --ty: -22px; }
      .cc-spark.s3 { bottom: 22%; left: 22%; color: #22d3ee; --tx: -20px; --ty: 20px; }
      .cc-spark.s4 { bottom: 20%; right: 20%; color: #f59e0b; --tx: 22px; --ty: 22px; }

      @keyframes cc-spark-fly {
        0% {
          transform: translate(0, 0) scale(0.4);
          opacity: 0;
        }
        40% {
          opacity: 1;
          transform: translate(calc(var(--tx) * 0.5), calc(var(--ty) * 0.5)) scale(1.3);
        }
        100% {
          opacity: 0;
          transform: translate(var(--tx), var(--ty)) scale(0.2);
        }
      }

      /* Status Badge */
      .cc-pop-status-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid rgba(16, 185, 129, 0.4);
        color: #34d399;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 5px 14px;
        border-radius: 999px;
        margin-bottom: 12px;
        box-shadow: 0 0 16px rgba(16, 185, 129, 0.25);
        animation: cc-badge-reveal 0.4s ease-out 0.35s both;
      }

      @keyframes cc-badge-reveal {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.9);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* Stats HUD */
      .cc-pop-stats {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(2, 6, 23, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 9px 16px;
        width: 100%;
        margin-bottom: 12px;
        animation: cc-stats-reveal 0.4s ease-out 0.4s both;
      }

      @keyframes cc-stats-reveal {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .cc-pop-stat-item {
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      .cc-pop-stat-val {
        font-size: 14px;
        font-weight: 800;
        color: #f8fafc;
      }

      .cc-pop-stat-lbl {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #94a3b8;
        margin-top: 1px;
      }

      .cc-pop-stat-sep {
        color: rgba(255, 255, 255, 0.15);
        font-size: 16px;
        font-weight: 300;
      }

      .cc-pop-footer-tip {
        font-size: 11px;
        color: #94a3b8;
        display: flex;
        align-items: center;
        gap: 6px;
        animation: cc-tip-reveal 0.35s ease-out 0.45s both;
      }

      @keyframes cc-tip-reveal {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      /* Respect prefers-reduced-motion */
      @media (prefers-reduced-motion: reduce) {
        .cc-launcher,
        .cc-half,
        .cc-popover,
        .cc-toast-msg {
          transition: none !important;
          animation: none !important;
          transform: none !important;
        }
        .cc-pop-shockwave,
        .cc-pop-flash,
        .cc-spark,
        .cc-pop-glow-disc {
          display: none !important;
        }
        .cc-pop-ring-outer,
        .cc-pop-ring-inner {
          animation: none !important;
        }
        .cc-pop-card,
        .cc-pop-half-left,
        .cc-pop-half-right,
        .cc-pop-status-badge,
        .cc-pop-stats,
        .cc-pop-footer-tip {
          animation: none !important;
          transform: none !important;
          opacity: 1 !important;
        }
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

      <!-- Toast Container -->
      <div class="cc-toast-box" id="cc-toast-box"></div>
    `;

    shadowRoot.appendChild(wrapper);

    bindShadowEvents();
    refreshRecentCapsules();
  }

  function showToast(message, type = 'info', duration = 4500) {
    if (!shadowRoot) return;
    const box = shadowRoot.getElementById('cc-toast-box');
    if (!box) return;

    const toast = document.createElement('div');
    toast.className = `cc-toast-msg cc-toast-${type}`;
    toast.textContent = message;

    box.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  /**
   * Plays the cinematic full-screen pop animation when sealing a chat.
   * Features glowing shockwave, snap-together capsule halves, sparks, and stats.
   */
  function playSealPopAnimation(info) {
    if (!shadowRoot) return;

    // Remove any existing pop overlay
    const existing = shadowRoot.getElementById('cc-pop-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'cc-pop-overlay';
    overlay.id = 'cc-pop-overlay';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-live', 'assertive');

    const sourceName = escapeHtml(info.source || 'AI Chat');
    const count = info.count || 0;
    const tokens = info.tokens || '0';
    const mode = (info.mode || 'compact').toUpperCase();

    overlay.innerHTML = `
      <div class="cc-pop-backdrop"></div>
      <div class="cc-pop-shockwave"></div>

      <div class="cc-pop-card">
        <div class="cc-pop-card-glare"></div>

        <div class="cc-pop-header">
          <span class="cc-pop-pulse-dot"></span>
          <span class="cc-pop-protocol">CHAT CAPSULE PROTOCOL</span>
          <span class="cc-pop-source">${sourceName}</span>
        </div>

        <div class="cc-pop-stage">
          <div class="cc-pop-glow-disc"></div>
          <div class="cc-pop-flash"></div>

          <svg class="cc-pop-svg" viewBox="0 0 160 160" width="130" height="130" aria-hidden="true">
            <defs>
              <linearGradient id="ccPopCyan" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#22d3ee" />
                <stop offset="100%" stop-color="#0891b2" />
              </linearGradient>
              <linearGradient id="ccPopAmber" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#fbbf24" />
                <stop offset="100%" stop-color="#d97706" />
              </linearGradient>
              <filter id="ccPopGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#06b6d4" flood-opacity="0.4"/>
              </filter>
            </defs>

            <!-- Orbital tech rings -->
            <circle class="cc-pop-ring-outer" cx="80" cy="80" r="66" fill="none" stroke="rgba(6, 182, 212, 0.4)" stroke-width="1.5" stroke-dasharray="8 6" />
            <circle class="cc-pop-ring-inner" cx="80" cy="80" r="54" fill="none" stroke="rgba(245, 158, 11, 0.45)" stroke-width="1.5" stroke-dasharray="12 8" />

            <!-- Tilted capsule (45 deg) -->
            <g transform="rotate(-45 80 80)">
              <!-- Left Half (Cyan) -->
              <g class="cc-pop-half cc-pop-half-left">
                <path d="M 34 64 A 16 16 0 0 0 34 96 L 76 96 L 76 64 Z" fill="url(#ccPopCyan)" filter="url(#ccPopGlow)" />
                <path d="M 40 68 A 12 12 0 0 0 40 92 L 44 92 A 8 8 0 0 1 44 68 Z" fill="rgba(255,255,255,0.4)" />
                <line x1="76" y1="64" x2="76" y2="96" stroke="#cffafe" stroke-width="1.5" />
              </g>

              <!-- Right Half (Amber) -->
              <g class="cc-pop-half cc-pop-half-right">
                <path d="M 84 64 L 84 96 L 126 96 A 16 16 0 0 0 126 64 Z" fill="url(#ccPopAmber)" />
                <path d="M 120 68 A 12 12 0 0 1 120 92 L 116 92 A 8 8 0 0 0 116 68 Z" fill="rgba(255,255,255,0.4)" />
                <line x1="84" y1="64" x2="84" y2="96" stroke="#fef3c7" stroke-width="1.5" />
              </g>
            </g>
          </svg>

          <!-- Particle sparks -->
          <div class="cc-pop-sparks">
            <span class="cc-spark s1">✦</span>
            <span class="cc-spark s2">✦</span>
            <span class="cc-spark s3">✦</span>
            <span class="cc-spark s4">✦</span>
          </div>
        </div>

        <div class="cc-pop-status-badge">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
          </svg>
          <span>CAPSULE SEALED &amp; LOCKED</span>
        </div>

        <div class="cc-pop-stats">
          <div class="cc-pop-stat-item">
            <span class="cc-pop-stat-val">${count}</span>
            <span class="cc-pop-stat-lbl">Messages</span>
          </div>
          <div class="cc-pop-stat-sep">/</div>
          <div class="cc-pop-stat-item">
            <span class="cc-pop-stat-val">~${tokens}</span>
            <span class="cc-pop-stat-lbl">Tokens</span>
          </div>
          <div class="cc-pop-stat-sep">/</div>
          <div class="cc-pop-stat-item">
            <span class="cc-pop-stat-val">${mode}</span>
            <span class="cc-pop-stat-lbl">Mode</span>
          </div>
        </div>

        <div class="cc-pop-footer-tip">
          <span>📋</span> Prompt auto-copied to clipboard • Click anywhere to dismiss
        </div>
      </div>
    `;

    shadowRoot.appendChild(overlay);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      overlay.classList.add('is-leaving');
      setTimeout(() => overlay.remove(), 280);
      document.removeEventListener('keydown', handleKey);
    };

    const handleKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        dismiss();
      }
    };

    overlay.addEventListener('click', dismiss);
    document.addEventListener('keydown', handleKey);

    // Auto-dismiss after 2.3 seconds
    setTimeout(dismiss, 2300);
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
          showToast('Extension was reloaded. Please refresh this page (F5) to reconnect.', 'warning', 6000);
        } else {
          showToast('Error sealing chat: ' + (err?.message || err), 'error', 5000);
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
