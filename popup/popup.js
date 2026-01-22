/*
 * Sitemap Screenshot Visualizer - Popup Script
 *
 * Handles user input, sends messages to service worker,
 * and displays progress updates.
 */

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('url-input');
  const maxPagesSelect = document.getElementById('max-pages');
  const loadTimeoutSelect = document.getElementById('load-timeout');
  const captureDelaySelect = document.getElementById('capture-delay');
  const startBtn = document.getElementById('start-btn');
  const currentPageBtn = document.getElementById('current-page-btn');
  const currentPageUrlEl = document.getElementById('current-page-url');
  const cancelBtn = document.getElementById('cancel-btn');
  const progressSection = document.getElementById('progress-section');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const currentUrlEl = document.getElementById('current-url');
  const errorSection = document.getElementById('error-section');
  const errorMessage = document.getElementById('error-message');

  let isRunning = false;
  let currentTabUrl = null;

  // Check if analysis is running (recover state on popup reopen)
  chrome.runtime.sendMessage({ type: 'getStatus' }, (state) => {
    if (state && state.active) {
      isRunning = true;
      startBtn.disabled = true;
      currentPageBtn.disabled = true;
      cancelBtn.style.display = 'block';
      progressSection.style.display = 'block';
      errorSection.style.display = 'none';
      updateProgress(state.current, state.total, state.url);
    }
  });

  // Get current tab URL on popup load
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) {
      try {
        const url = new URL(tabs[0].url);
        // Only show for http/https URLs
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          currentTabUrl = url.origin;
          currentPageUrlEl.textContent = currentTabUrl;
          currentPageBtn.disabled = false;
        } else {
          currentPageUrlEl.textContent = 'Cannot analyze this page type';
          currentPageBtn.disabled = true;
        }
      } catch (e) {
        currentPageUrlEl.textContent = 'Cannot analyze this page';
        currentPageBtn.disabled = true;
      }
    } else {
      currentPageUrlEl.textContent = 'No active page';
      currentPageBtn.disabled = true;
    }
  });

  // Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'progress') {
      updateProgress(message.current, message.total, message.url);
    } else if (message.type === 'complete') {
      handleComplete(message.data);
    } else if (message.type === 'error') {
      handleError(message.error);
    }
  });

  currentPageBtn.addEventListener('click', startCurrentPageAnalysis);
  startBtn.addEventListener('click', startAnalysis);
  cancelBtn.addEventListener('click', cancelAnalysis);

  // Allow Enter key to start analysis
  urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !isRunning) {
      startAnalysis();
    }
  });

  function startCurrentPageAnalysis() {
    if (!currentTabUrl || isRunning) return;
    doStartAnalysis(currentTabUrl);
  }

  async function startAnalysis() {
    const url = urlInput.value.trim();

    // Validate URL
    if (!url) {
      showError('Please enter a website URL');
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch (e) {
      showError('Invalid URL format');
      return;
    }

    doStartAnalysis(parsedUrl.origin);
  }

  function doStartAnalysis(siteUrl) {
    if (isRunning) return;

    // Get settings
    const options = {
      url: siteUrl,
      maxPages: parseInt(maxPagesSelect.value),
      loadTimeout: parseInt(loadTimeoutSelect.value),
      captureDelay: parseInt(captureDelaySelect.value)
    };

    // Update UI
    isRunning = true;
    startBtn.disabled = true;
    currentPageBtn.disabled = true;
    cancelBtn.style.display = 'block';
    progressSection.style.display = 'block';
    errorSection.style.display = 'none';
    updateProgress(0, 0, 'Fetching sitemap...');

    // Send message to service worker
    try {
      chrome.runtime.sendMessage({ type: 'start', options });
    } catch (e) {
      handleError('Failed to start analysis: ' + e.message);
    }
  }

  function cancelAnalysis() {
    chrome.runtime.sendMessage({ type: 'cancel' });
    resetUI();
  }

  function updateProgress(current, total, url) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    progressFill.style.width = `${percentage}%`;
    progressText.textContent = total > 0 ? `${current} / ${total}` : 'Preparing...';
    currentUrlEl.textContent = url || '';
  }

  function handleComplete(data) {
    // Service worker handles storage and opening report page
    // Just reset UI here
    resetUI();
  }

  function handleError(error) {
    showError(error);
    resetUI();
  }

  function showError(message) {
    errorSection.style.display = 'block';
    errorMessage.textContent = message;
  }

  function resetUI() {
    isRunning = false;
    startBtn.disabled = false;
    // Re-enable current page button only if we have a valid URL
    if (currentTabUrl) {
      currentPageBtn.disabled = false;
    }
    cancelBtn.style.display = 'none';
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 0';
    currentUrlEl.textContent = '';
  }
});
