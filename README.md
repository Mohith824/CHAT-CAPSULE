# 💊 Chat Capsule (Chrome Extension - Manifest V3)

> **Seal any AI chat into a portable capsule and resume it seamlessly on any other AI.**

Chat Capsule is a private, client-side browser extension that lets you snapshot an active conversation on **Claude**, **ChatGPT**, or **Gemini** and open that context in any other AI assistant without ever auto-submitting.

---

## 🚀 How to Load the Extension in Chrome

1. Open Google Chrome and enter `chrome://extensions` in the address bar.
2. In the top-right corner, toggle **Developer mode** to **ON**.
3. In the top-left corner, click **Load unpacked**.
4. Select the directory:
   ```
   D:\CHAT CAPSULE
   ```
   *(Or `C:\Users\LENOVO\.gemini\antigravity-ide\scratch\chat-capsule`)*
5. The **Chat Capsule** icon (💊 tilted two-tone capsule on a dark square) will appear in your extension toolbar. Pin it for quick access!

---

## 📖 How to Use

### 1. Sealing a Conversation
1. Open an active conversation on **Claude.ai**, **ChatGPT**, or **Gemini**.
2. Click the floating round capsule button at the bottom-right of the page (or click **Seal current chat** in the extension popup).
3. Select **"Seal this chat"**.
4. **Animation & Feedback**:
   - The two halves of the capsule icon will slide together smoothly with a glow pulse.
   - A toast notification confirms: *"Capsule sealed. 24 messages, about 3.2k tokens."*
   - The sealed conversation is saved directly into `chrome.storage.local`, and the formatted prompt is automatically copied to your clipboard.

### 2. Opening a Capsule in Another AI
1. Navigate to the AI where you want to continue the conversation (e.g., switch from Claude to ChatGPT or Gemini).
2. Click the floating round launcher button at the bottom-right (or open the popup).
3. Toggle between **Compact** or **Full** mode as desired:
   - **Compact Mode**: Packs your core goal, prompt journey (last 15 user requests), extracted code blocks (budgeted to ~12k characters, in chronological order), and latest conversational turns (last 6 messages).
   - **Full Mode**: Preserves the complete verbatim transcript.
4. Click on any capsule from the **Recent Capsules** list (or click **Open here** in the popup).
5. **Safety Guarantee**: The extension safely places the context at the end of the site's input composer. **It will NEVER auto-send.** You review the prompt and press Enter/Send yourself.

---

## 🛠️ How to Fix Broken Selectors

AI chat platforms update their internal DOM structures frequently. All selector definitions are centralized in `content.js` under `SITE_ADAPTERS`:

```javascript
const SITE_ADAPTERS = {
  claude: {
    userSelectors: ['[data-testid="user-message"]', '.font-user-message'],
    assistantSelectors: ['.font-claude-response', '[data-testid="assistant-message"]'],
    inputSelectors: ['div.ProseMirror[contenteditable="true"]', 'textarea']
  },
  chatgpt: {
    userSelectors: ['[data-message-author-role="user"]', 'article [data-message-author-role="user"]'],
    assistantSelectors: ['[data-message-author-role="assistant"]', '.agent-turn'],
    inputSelectors: ['#prompt-textarea', 'textarea[data-id="root"]']
  },
  gemini: {
    userSelectors: ['user-query .query-text', 'user-query'],
    assistantSelectors: ['model-response message-content', 'model-response'],
    inputSelectors: ['rich-textarea .ql-editor', 'div[contenteditable="true"].ql-editor']
  }
};
```

### Steps to update selectors when a site changes:
1. Open the AI chat page where extraction failed.
2. Right-click any user message or assistant response and select **Inspect** (or press <kbd>F12</kbd>).
3. Look for a stable attribute (such as `data-testid`, `data-message-author-role`, class names, or custom tags like `<user-query>`).
4. Add the selector to the top of the corresponding array in `SITE_ADAPTERS` inside `content.js`.
5. Go to `chrome://extensions` and click the **🔄 Reload** icon on the Chat Capsule card.

---

## ⚠️ Known Limitations & Quirks

1. **Gemini Lazy-Loaded History**:
   - Google Gemini virtualizes its chat history and only keeps recent messages rendered in the DOM.
   - **Remedy:** For long conversations on Gemini, scroll up to the top of the chat before sealing so older messages mount into the DOM.
2. **Very Long Chats & Token Budgets**:
   - When conversations grow extremely large, use **Compact Mode**. It automatically prioritizes the initial goal, key user requests, the most recent code blocks (~12,000 char budget), and the last 6 turns to keep token costs manageable.
3. **Sites Changing Their HTML**:
   - Web applications frequently change classes and internal markup. Chat Capsule uses redundant fallback selectors and drops nested elements to maximize resilience. If fewer than 2 messages are detected, an in-page warning will alert you immediately.
4. **Long Pastes as Attachments**:
   - On Claude and ChatGPT, very large pasted text blocks (e.g. over 15,000 characters) may automatically be converted by the site into a text file attachment (e.g., `pasted.txt`) in the composer. This is standard site behavior and the AI can read it as full context.
5. **Draft Preservation & Clipboard Fallback**:
   - If you already have an unsent draft in the message box, the capsule is appended at the cursor position without overwriting your text.
   - If browser security or site restrictions block synthetic paste, Chat Capsule automatically copies the capsule to your clipboard and notifies you: *"Couldn't find the message box. Capsule copied, paste it in."*

---

## 🧪 Final Manual Test Checklist

| Area | Test Case | Expected Result |
| :--- | :--- | :--- |
| **Claude** (`claude.ai`) | **1. Seal with Code Blocks** | Click launcher $\rightarrow$ "Seal this chat". Halves slide together with pulse glow; toast indicates count and tokens; code blocks extracted with language tags. |
| **Claude** (`claude.ai`) | **2. Open & Draft Preservation** | Type "Draft note: " in Claude's composer, then click Open on a capsule. Prompt is appended at the end without erasing draft or auto-sending. |
| **ChatGPT** (`chatgpt.com`) | **3. Seal Formatted Chat** | Seal chat with markdown tables & math formulas. Confirm tables (`\| ... \|`) and math annotations survive cleanly. |
| **ChatGPT** (`chatgpt.com`) | **4. Open & React Composer** | Click Open. Prompt fills `#prompt-textarea`, triggers React state, and enables the submit button without pressing enter. |
| **Gemini** (`gemini.google.com`) | **5. Code-block Extraction** | Seal chat with code. Confirm language is detected from decoration and button text ("Copy code") does **not** leak into the code block. |
| **Gemini** (`gemini.google.com`) | **6. Scroll Up & Lazy History** | On a long chat, scroll up to top, seal. Confirm messages from the beginning are included. |
| **Dual Modes** | **7. Compact vs Full Mode** | Switch between Compact and Full in in-page UI or popup. Verify token estimate updates dynamically (~characters / 4). |
| **Library Management** | **8. Export / Import .json** | Export a capsule via `.json`, delete it (`🗑️`), then import via "Import .json". Verify file validates and appears back in the feed. |
| **Transcript Export** | **9. Download .md** | Click `.md` action. Standalone markdown file downloads with user and assistant turns separated cleanly. |
| **Safety & Fallback** | **10. Clipboard Fallback** | Focus outside the browser or on an unsupported page and trigger open. Toast warns: *"Capsule copied to clipboard"*, and clipboard contains prompt. |
