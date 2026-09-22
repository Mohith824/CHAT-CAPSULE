/**
 * Chat Capsule - Shared Logic Module (CapsuleLib)
 * Zero external dependencies. Works in browser contexts (window.CapsuleLib) and Node.js.
 */

(function () {
  'use strict';

  const DIRECTIVE =
    'This is a capsule: a packed snapshot of an earlier conversation between me and another AI. Read it fully, treat it as shared context, and continue from where it stopped. If the last message left a task unfinished, continue it. Otherwise confirm in 2-3 lines what you understood and wait for my next instruction.';

  const END_MARKER = '[END OF CAPSULE]';

  /**
   * Approximate token count: characters / 4.
   * @param {string} text
   * @returns {number}
   */
  function approxTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Safe string trimmer and clipper.
   */
  function clip(str, maxLen) {
    if (!str) return '';
    const trimmed = String(str).trim();
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen - 3).trimEnd() + '...';
  }

  /**
   * Extract fenced code blocks from assistant messages up to a character budget (~12,000 chars),
   * retaining the most recent blocks in chronological order.
   * @param {Array<{role: string, content: string}>} messages
   * @param {number} budgetChars
   * @returns {Array<{language: string, code: string}>}
   */
  function extractCodeBlocks(messages, budgetChars = 12000) {
    const rawBlocks = [];

    // Scan backwards from the most recent assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.content) continue;

      const codeBlockRegex = /```([a-zA-Z0-9_.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
      let match;
      const foundInMsg = [];
      while ((match = codeBlockRegex.exec(msg.content)) !== null) {
        const lang = (match[1] || '').trim();
        const code = (match[2] || '').trim();
        if (code) {
          foundInMsg.push({ language: lang, code });
        }
      }

      // Add in reverse order of message appearance
      for (let j = foundInMsg.length - 1; j >= 0; j--) {
        rawBlocks.push(foundInMsg[j]);
      }
    }

    // Budget up to budgetChars
    let currentLength = 0;
    const budgeted = [];
    for (const item of rawBlocks) {
      const blockLength = item.code.length + item.language.length + 8;
      if (currentLength + blockLength <= budgetChars || budgeted.length === 0) {
        budgeted.push(item);
        currentLength += blockLength;
      } else {
        break;
      }
    }

    // Return in chronological order
    return budgeted.reverse();
  }

  /**
   * DOM-to-Markdown converter.
   * Converts HTML or DOM Node into clean Markdown.
   * Preserves: Headings, bold/italic, inline code, fenced code blocks with language,
   * lists (including nested), links, blockquotes, simple tables, and KaTeX math (TeX annotation).
   * Skips: buttons, scripts, svg, nav, styling/copy widgets.
   * @param {Node|string} input
   * @returns {string}
   */
  function domToMarkdown(input) {
    if (!input) return '';

    let rootNode;
    if (typeof input === 'string') {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(input, 'text/html');
        rootNode = doc.body;
      } else {
        return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } else if (typeof Node !== 'undefined' && input instanceof Node) {
      rootNode = input;
    } else {
      return String(input);
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

    function isIgnored(node) {
      if (!node) return true;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (IGNORED_TAGS.has(node.tagName)) return true;
        const className = (node.className && typeof node.className === 'string') ? node.className.toLowerCase() : '';
        const ariaLabel = (node.getAttribute && node.getAttribute('aria-label')) ? node.getAttribute('aria-label').toLowerCase() : '';
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

    function extractMath(element) {
      const annotation = element.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="LaTeX"]');
      if (annotation && annotation.textContent.trim()) {
        const tex = annotation.textContent.trim();
        const isDisplay =
          element.classList.contains('katex-display') ||
          element.tagName === 'DIV' ||
          element.closest('.katex-display');
        return isDisplay ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
      }
      if (element.getAttribute('data-tex')) {
        return `$${element.getAttribute('data-tex').trim()}$`;
      }
      return null;
    }

    function extractCodeLang(codeEl, preEl) {
      const candidates = [
        codeEl?.className || '',
        codeEl?.getAttribute('data-language') || '',
        preEl?.className || '',
        preEl?.getAttribute('data-language') || '',
      ];

      for (const str of candidates) {
        if (typeof str !== 'string') continue;
        const match = str.match(/(?:language|lang)-([a-zA-Z0-9_-]+)/i);
        if (match && match[1]) return match[1].toLowerCase();
      }
      return '';
    }

    function parseTable(tableEl) {
      const rows = Array.from(tableEl.querySelectorAll('tr'));
      if (rows.length === 0) return '';

      const tableData = [];
      let maxCols = 0;

      rows.forEach((row) => {
        const cells = Array.from(row.querySelectorAll('th, td')).map((cell) => {
          return processChildren(cell).replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
        });
        if (cells.length > maxCols) maxCols = cells.length;
        tableData.push(cells);
      });

      if (tableData.length === 0 || maxCols === 0) return '';

      const lines = [];
      const headerRow = tableData[0];
      while (headerRow.length < maxCols) headerRow.push('');
      lines.push(`| ${headerRow.join(' | ')} |`);

      const separatorRow = new Array(maxCols).fill('---');
      lines.push(`| ${separatorRow.join(' | ')} |`);

      for (let i = 1; i < tableData.length; i++) {
        const row = tableData[i];
        while (row.length < maxCols) row.push('');
        lines.push(`| ${row.join(' | ')} |`);
      }

      return '\n\n' + lines.join('\n') + '\n\n';
    }

    function walk(node, depth = 0, listContext = null) {
      if (!node || isIgnored(node)) return '';

      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toUpperCase();

        if (
          node.classList.contains('katex') ||
          tag === 'MATH' ||
          node.classList.contains('katex-display') ||
          node.querySelector('annotation[encoding="application/x-tex"]')
        ) {
          const math = extractMath(node);
          if (math) return math;
        }

        // Gemini & custom code-block web component
        if (tag === 'CODE-BLOCK' || (node.classList && (node.classList.contains('code-block') || node.classList.contains('code-block-wrapper')))) {
          let lang = '';
          const langEl = node.querySelector('.code-block-language, [class*="language"], [class*="lang"]');
          if (langEl && !langEl.closest('pre')) {
            lang = langEl.textContent.trim().toLowerCase();
          }
          const preEl = node.querySelector('pre');
          const codeEl = node.querySelector('code') || preEl || node;
          if (!lang) {
            lang = extractCodeLang(codeEl, preEl);
          }
          lang = lang.replace(/[^a-zA-Z0-9_-]/g, '');
          const codeText = (codeEl ? codeEl.textContent : node.textContent).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return `\n\`\`\`${lang}\n${codeText.trimEnd()}\n\`\`\`\n`;
        }

        if (tag === 'PRE') {
          const codeEl = node.querySelector('code') || node;
          const lang = extractCodeLang(codeEl, node);
          const codeText = codeEl.textContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          return `\n\`\`\`${lang}\n${codeText.trimEnd()}\n\`\`\`\n`;
        }

        if (tag === 'CODE') {
          const codeText = node.textContent.replace(/\r?\n/g, ' ');
          if (codeText.includes('`')) {
            return `\`\` ${codeText} \`\``;
          }
          return `\`${codeText}\``;
        }

        if (tag === 'TABLE') {
          return parseTable(node);
        }

        if (/^H[1-6]$/.test(tag)) {
          const level = parseInt(tag.charAt(1), 10);
          const prefix = '#'.repeat(level);
          const content = processChildren(node, depth).trim();
          return `\n\n${prefix} ${content}\n\n`;
        }

        if (tag === 'STRONG' || tag === 'B') {
          const content = processChildren(node, depth).trim();
          return content ? `**${content}**` : '';
        }

        if (tag === 'EM' || tag === 'I') {
          const content = processChildren(node, depth).trim();
          return content ? `*${content}*` : '';
        }

        if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
          const content = processChildren(node, depth).trim();
          return content ? `~~${content}~~` : '';
        }

        if (tag === 'A') {
          const href = node.getAttribute('href');
          const content = processChildren(node, depth).trim();
          if (!href || href.startsWith('javascript:') || href === '#') {
            return content;
          }
          return `[${content || href}](${href})`;
        }

        if (tag === 'BLOCKQUOTE') {
          const inner = processChildren(node, depth).trim();
          const quoted = inner
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n');
          return `\n\n${quoted}\n\n`;
        }

        if (tag === 'UL' || tag === 'OL') {
          const isOrdered = tag === 'OL';
          let itemIndex = 1;
          let output = '\n';
          for (const child of node.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'LI') {
              const marker = isOrdered ? `${itemIndex}. ` : '- ';
              const indent = '  '.repeat(depth);
              const liContent = walk(child, depth + 1, { isOrdered, itemIndex }).trim();
              output += `${indent}${marker}${liContent}\n`;
              itemIndex++;
            }
          }
          return output + '\n';
        }

        if (tag === 'LI') {
          return processChildren(node, depth);
        }

        if (tag === 'P' || tag === 'DIV') {
          const inner = processChildren(node, depth);
          return `\n${inner}\n`;
        }

        if (tag === 'BR') {
          return '\n';
        }

        if (tag === 'HR') {
          return '\n\n---\n\n';
        }

        return processChildren(node, depth, listContext);
      }

      return '';
    }

    function processChildren(parent, depth = 0, listContext = null) {
      let result = '';
      for (const child of parent.childNodes) {
        result += walk(child, depth, listContext);
      }
      return result;
    }

    const raw = walk(rootNode);
    return raw
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Builds a structured capsule object from messages.
   * @param {Array<{role: 'user'|'assistant', content: string}>} messages
   * @param {Object} [meta]
   * @returns {Object} Capsule
   */
  function build(messages, meta = {}) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error('Cannot build capsule: messages array is empty.');
    }

    const timestamp = Date.now();
    const id = meta.id || `cap_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
    const createdAt = meta.createdAt || new Date(timestamp).toISOString();
    const source = meta.source || 'claude.ai';
    const url = meta.url || '';

    // First user message
    const firstUserMsg = messages.find((m) => m.role === 'user') || messages[0];
    const firstUserContent = (firstUserMsg?.content || '').trim();

    // Title: first 60 chars of user's first message
    const title = meta.title || clip(firstUserContent.replace(/\r?\n+/g, ' '), 60) || 'Conversation Snapshot';

    // Goal: user's first message clipped to ~800 chars
    const goal = clip(firstUserContent, 800);

    // Requests: user messages along the way (last 15, each clipped to ~200 chars)
    const userMessages = messages.filter((m) => m.role === 'user');
    const recentRequests = userMessages.slice(-15).map((m) => clip(m.content.replace(/\r?\n+/g, ' '), 200));

    // Code blocks from assistant messages (budget ~12,000 chars, chronological)
    const codeBlocks = extractCodeBlocks(messages, 12000);

    // Last 6 messages verbatim (each clipped to ~1,800 chars)
    const last6 = messages.slice(-6).map((m) => ({
      role: m.role,
      content: clip(m.content, 1800),
    }));

    // Full transcript
    const fullTranscript = messages.map((m) => ({
      role: m.role,
      content: (m.content || '').trim(),
    }));

    return {
      id,
      title,
      source,
      url,
      createdAt,
      goal,
      requests: recentRequests,
      codeBlocks,
      lastMessages: last6,
      messages: fullTranscript,
    };
  }

  /**
   * Formats a capsule into an actionable prompt for continuation.
   * @param {Object} capsule
   * @param {'compact'|'full'} [mode='compact']
   * @returns {string}
   */
  function toPrompt(capsule, mode = 'compact') {
    if (!capsule) return '';

    const lines = [];
    lines.push(DIRECTIVE);
    lines.push('');
    lines.push('---');
    lines.push(`SOURCE: ${capsule.source || 'AI Chat'}`);
    lines.push(`CREATED: ${capsule.createdAt || 'Recent'}`);
    lines.push(`TITLE: ${capsule.title || 'Untitled Capsule'}`);
    lines.push('---');
    lines.push('');

    if (mode === 'compact') {
      // 1. Primary Goal
      lines.push('### GOAL');
      lines.push(capsule.goal || '(No initial goal recorded)');
      lines.push('');

      // 2. Requests Along The Way
      if (capsule.requests && capsule.requests.length > 0) {
        lines.push('### REQUESTS ALONG THE WAY');
        capsule.requests.forEach((req, idx) => {
          lines.push(`${idx + 1}. ${req}`);
        });
        lines.push('');
      }

      // 3. Relevant Code Blocks
      if (capsule.codeBlocks && capsule.codeBlocks.length > 0) {
        lines.push('### KEY CODE BLOCKS');
        capsule.codeBlocks.forEach((block) => {
          const lang = block.language || '';
          lines.push(`\`\`\`${lang}\n${block.code}\n\`\`\``);
          lines.push('');
        });
      }

      // 4. Last Messages (latest turns)
      if (capsule.lastMessages && capsule.lastMessages.length > 0) {
        lines.push('### LAST MESSAGES');
        capsule.lastMessages.forEach((msg) => {
          const role = msg.role === 'user' ? 'User' : 'Assistant';
          lines.push(`**${role}:**\n${msg.content}`);
          lines.push('');
        });
      }
    } else {
      // Full Mode: Entire transcript
      lines.push('### FULL TRANSCRIPT');
      const transcript = capsule.messages || [];
      transcript.forEach((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        lines.push(`**${role}:**\n${msg.content}`);
        lines.push('');
      });
    }

    lines.push(END_MARKER);
    return lines.join('\n').trim();
  }

  /**
   * Generates a readable standalone markdown document of the full conversation.
   * @param {Object} capsule
   * @returns {string}
   */
  function toMarkdown(capsule) {
    if (!capsule) return '';

    const lines = [];
    lines.push(`# ${capsule.title || 'Conversation Transcript'}`);
    lines.push('');
    lines.push(`- **Source:** ${capsule.source || 'claude.ai'}`);
    if (capsule.url) lines.push(`- **URL:** ${capsule.url}`);
    lines.push(`- **Date:** ${capsule.createdAt || new Date().toISOString()}`);
    lines.push(`- **Total Messages:** ${(capsule.messages || []).length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    const transcript = capsule.messages || [];
    transcript.forEach((msg, idx) => {
      const speaker = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
      lines.push(`### Message ${idx + 1} (${speaker})`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    return lines.join('\n').trim();
  }

  /**
   * Helper to check if the extension runtime context is currently active.
   */
  function isExtensionValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome?.runtime?.id && chrome.storage?.local);
    } catch {
      return false;
    }
  }

  /**
   * Helper to determine if an error was caused by extension reload or context invalidation.
   */
  function isInvalidatedError(err) {
    if (!isExtensionValid()) return true;
    const str = String(err?.message || err || '').toLowerCase();
    return (
      str.includes('context invalidated') ||
      str.includes('context_invalidated') ||
      str.includes('extension context') ||
      str.includes('not available') ||
      str.includes('reloaded')
    );
  }

  /**
   * Storage helpers using chrome.storage.local
   */
  const store = {
    async list() {
      try {
        if (!isExtensionValid()) return [];
        const res = await chrome.storage.local.get(['capsules']);
        return Array.isArray(res.capsules) ? res.capsules : [];
      } catch (err) {
        if (isInvalidatedError(err)) return [];
        console.warn('[CapsuleLib.store.list] Warning:', err?.message || err);
        return [];
      }
    },

    async get(id) {
      try {
        if (!isExtensionValid()) return null;
        const capsules = await this.list();
        return capsules.find((c) => c.id === id) || null;
      } catch (err) {
        if (isInvalidatedError(err)) return null;
        console.warn('[CapsuleLib.store.get] Warning:', err?.message || err);
        return null;
      }
    },

    async save(capsule) {
      if (!isExtensionValid()) {
        throw new Error('Extension was reloaded. Please refresh the page (F5) to seal.');
      }
      try {
        const capsules = await this.list();
        const index = capsules.findIndex((c) => c.id === capsule.id);
        if (index >= 0) {
          capsules[index] = capsule;
        } else {
          capsules.unshift(capsule);
        }
        // Cap list at 50 capsules to avoid storage overflow
        if (capsules.length > 50) {
          capsules.length = 50;
        }
        await chrome.storage.local.set({ capsules });
        return capsule;
      } catch (err) {
        if (isInvalidatedError(err)) {
          throw new Error('Extension was reloaded. Please refresh the page (F5) to seal.');
        }
        console.warn('[CapsuleLib.store.save] Warning:', err?.message || err);
        throw err;
      }
    },

    async remove(id) {
      try {
        if (!isExtensionValid()) return false;
        const capsules = await this.list();
        const filtered = capsules.filter((c) => c.id !== id);
        await chrome.storage.local.set({ capsules: filtered });
        return true;
      } catch (err) {
        if (isInvalidatedError(err)) return false;
        console.warn('[CapsuleLib.store.remove] Warning:', err?.message || err);
        return false;
      }
    },
  };

  const CapsuleLib = {
    build,
    toPrompt,
    toMarkdown,
    domToMarkdown,
    approxTokens,
    isExtensionValid,
    isInvalidatedError,
    store,
  };

  // Expose as global CapsuleLib
  if (typeof globalThis !== 'undefined') {
    globalThis.CapsuleLib = CapsuleLib;
  } else if (typeof window !== 'undefined') {
    window.CapsuleLib = CapsuleLib;
  }

  // Node.js module export guard
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CapsuleLib;
  }
})();
