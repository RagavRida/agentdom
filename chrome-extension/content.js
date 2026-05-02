/**
 * AgentDOM Chrome Extension — Content Script
 * Injects AgentDOM runtime into every page and listens for commands.
 */

// Inject agentdom.js into page context
const script = document.createElement('script');
script.src = chrome.runtime.getURL('agentdom.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Bridge: extension ↔ page context
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'agentdom-page') return;
  chrome.runtime.sendMessage(event.data);
});

// Listen for commands from popup/background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'scan' || msg.type === 'scanWithTools') {
    // Execute in page context via injected script
    const id = 'agentdom-' + msg.type + '-' + Date.now();
    const handler = (event) => {
      if (event.data?.id === id) {
        window.removeEventListener('message', handler);
        sendResponse(event.data.result);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({ source: 'agentdom-ext', type: msg.type, id }, '*');
    return true; // async response
  }

  if (msg.type === 'click') {
    window.postMessage({ source: 'agentdom-ext', type: 'click', selector: msg.selector }, '*');
    sendResponse({ ok: true });
  }

  if (msg.type === 'type') {
    window.postMessage({ source: 'agentdom-ext', type: 'type', selector: msg.selector, text: msg.text }, '*');
    sendResponse({ ok: true });
  }

  if (msg.type === 'exec') {
    window.postMessage({ source: 'agentdom-ext', type: 'exec', command: msg.command }, '*');
    sendResponse({ ok: true });
  }
});

// Inject bridge script into page context to handle extension messages
const bridge = document.createElement('script');
bridge.textContent = `
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'agentdom-ext') return;
    const msg = event.data;
    
    if (typeof AgentDOM === 'undefined') return;
    
    try {
      let result;
      switch (msg.type) {
        case 'scan':
          result = AgentDOM.scan();
          window.postMessage({ source: 'agentdom-page', id: msg.id, result }, '*');
          break;
        case 'scanWithTools':
          result = typeof AgentDOM.scanWithTools === 'function' ? AgentDOM.scanWithTools() : AgentDOM.scan();
          window.postMessage({ source: 'agentdom-page', id: msg.id, result }, '*');
          break;
        case 'click':
          await AgentDOM.click(msg.selector);
          break;
        case 'type':
          await AgentDOM.type(msg.selector, msg.text);
          break;
      }
    } catch (e) {
      window.postMessage({ source: 'agentdom-page', id: msg.id, error: e.message }, '*');
    }
  });
`;
(document.head || document.documentElement).appendChild(bridge);
bridge.remove();

console.log('[AgentDOM] Extension loaded');
