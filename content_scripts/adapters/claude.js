/**
 * claude.js — Adapter for Claude Web (claude.ai).
 * The editor is ProseMirror (contenteditable).
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
 
  class ClaudeAdapter extends WMB.BaseAdapter {
    constructor() {
      super({
        id: 'claude',
        name: 'Claude',
        selectors: {
          composer: [
            'div[contenteditable="true"].ProseMirror',
            '[data-testid="chat-input"]',
            'fieldset div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
          ],
          sendButton: [
            'button[aria-label="Send message"]',
            'button[aria-label="Enviar mensaje"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: [
            '.font-claude-response',
            '.font-claude-message',
            '[data-testid="assistant-message"]',
            'div[data-is-streaming]',
          ],
          // The user's own turns: hide.js reads this list so the two can never drift apart.
          userMessages: [
            '[data-testid="user-message"]',
            '.font-user-message',
          ],
          stopButton: [
            'button[aria-label="Stop response"]',
            'button[aria-label="Detener respuesta"]',
            'button[aria-label*="Stop" i]',
            'div[data-is-streaming="true"]',
          ],
        },
      });
    }

    matches(hostname) {
      return hostname === 'claude.ai';
    }

    /**
     * Claude opens a new chat at `/new` and moves to `/chat/<id>` once the first reply starts. Without this,
     * that URL change was read as "another conversation" and the first reply's result was dropped.
     */
    isNewChatPath(path) {
      const p = String(path ?? '');
      return p === '' || p === '/' || p === '/new' || p === '/new/';
    }
  }

  WMB.registerAdapter(new ClaudeAdapter());
})();
