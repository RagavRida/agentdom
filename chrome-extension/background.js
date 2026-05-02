/**
 * AgentDOM Chrome Extension — Background Service Worker
 * Routes messages between content scripts, popup, and external connections.
 */

// Handle external connections (other extensions, web pages)
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (msg) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { port.postMessage({ error: 'No active tab' }); return; }

    chrome.tabs.sendMessage(tab.id, msg, (response) => {
      port.postMessage(response || { error: 'No response from content script' });
    });
  });
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'background') {
    // Forward to content script in active tab
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { sendResponse({ error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tab.id, msg, sendResponse);
    });
    return true;
  }
});

// Context menu for quick scan
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.create({
    id: 'agentdom-scan',
    title: 'AgentDOM: Scan Page',
    contexts: ['page'],
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'agentdom-scan') {
    chrome.tabs.sendMessage(tab.id, { type: 'scan' }, (result) => {
      console.log('[AgentDOM] Scan result:', result);
    });
  }
});
