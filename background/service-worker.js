/*
 * Sitemap Screenshot Visualizer - Service Worker
 *
 * Handles sitemap fetching, URL tree building, and screenshot capture.
 */

let isRunning = false;
let shouldCancel = false;

// Running state for popup recovery
let runningState = {
  active: false,
  current: 0,
  total: 0,
  url: '',
  targetUrl: ''
};

// Listen for messages from popup and report page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'start') {
    startAnalysis(message.options);
  } else if (message.type === 'cancel') {
    shouldCancel = true;
    runningState.active = false;
  } else if (message.type === 'getStatus') {
    sendResponse(runningState);
    return true; // async response
  } else if (message.type === 'captureMore') {
    // V2: Handle dynamic expansion requests from report page
    captureMoreScreenshots(message.urls, message.parentPath, message.options, sender.tab?.id);
  }
  // No async response needed, return false/undefined
});

async function startAnalysis(options) {
  if (isRunning) return;

  isRunning = true;
  shouldCancel = false;
  runningState = {
    active: true,
    current: 0,
    total: 0,
    url: 'Starting...',
    targetUrl: options.url
  };

  try {
    // Step 1: Fetch sitemap or crawl
    let urls = [];
    let usedCrawler = false;

    sendProgress(0, 0, 'Fetching sitemap...');
    try {
      urls = await fetchSitemap(options.url);
    } catch (sitemapError) {
      // Fallback: crawl from homepage
      console.log('No sitemap found, falling back to crawler:', sitemapError.message);
      sendProgress(0, 0, 'No sitemap found, crawling pages...');
      usedCrawler = true;
      urls = await crawlFromHomepage(options.url, options.maxPages, options.loadTimeout);
    }

    if (urls.length === 0) {
      throw new Error(usedCrawler
        ? 'No pages found while crawling. The website may block automated access.'
        : 'No URLs found in sitemap.');
    }

    // Step 2: Build URL tree
    sendProgress(0, 0, 'Building URL tree...');
    const tree = buildUrlTree(urls, options.url);

    // Step 3: Select representative URLs (breadth-first + branch coverage)
    const selectedUrls = selectRepresentativeUrls(urls, options.maxPages, options.url);
    const screenshots = await captureScreenshots(selectedUrls, options);

    if (shouldCancel) {
      throw new Error('Analysis cancelled');
    }

    // Step 4: Merge screenshots into tree
    const screenshotMap = new Map(screenshots.map(s => [s.url, s.screenshot]));
    attachScreenshotsToTree(tree, screenshotMap);

    // Build screenshot data for storage
    const screenshotMapObj = {};
    const capturedUrlSet = [];
    screenshots.forEach(({ url, screenshot }) => {
      if (screenshot) {
        screenshotMapObj[url] = screenshot;
        capturedUrlSet.push(url);
      }
    });

    // Send complete with extra fields for dynamic expansion
    sendComplete({
      tree,
      baseUrl: options.url,
      totalUrls: urls.length,
      capturedUrls: capturedUrlSet.length,
      timestamp: new Date().toISOString(),
      // V2: Additional fields for dynamic expansion
      capturedUrlSet,
      screenshotMap: screenshotMapObj,
      options: {
        loadTimeout: options.loadTimeout,
        captureDelay: options.captureDelay
      }
    });

  } catch (error) {
    sendError(error.message);
  } finally {
    isRunning = false;
    runningState.active = false;
  }
}

// Fetch and parse sitemap
async function fetchSitemap(baseUrl) {
  const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;

  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: ${response.status}`);
    }

    const xml = await response.text();
    return parseSitemap(xml, baseUrl);
  } catch (error) {
    // Try common alternative paths
    const alternatives = ['/sitemap_index.xml', '/sitemap-index.xml', '/sitemaps.xml'];

    for (const alt of alternatives) {
      try {
        const altUrl = new URL(alt, baseUrl).href;
        const response = await fetch(altUrl);
        if (response.ok) {
          const xml = await response.text();
          return parseSitemap(xml, baseUrl);
        }
      } catch (e) {
        continue;
      }
    }

    throw new Error('Could not find sitemap.xml at common locations');
  }
}

// Parse sitemap XML using regex (Service Worker has no DOMParser)
async function parseSitemap(xml, baseUrl) {
  // Check if it's a sitemap index (nested sitemaps)
  // Look for <sitemap>...<loc>URL</loc>...</sitemap> pattern
  const sitemapPattern = /<sitemap[^>]*>[\s\S]*?<loc[^>]*>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi;
  const sitemapMatches = [...xml.matchAll(sitemapPattern)];

  if (sitemapMatches.length > 0) {
    const allUrls = [];
    for (const match of sitemapMatches) {
      if (shouldCancel) break;
      try {
        const nestedUrl = match[1].trim();
        const response = await fetch(nestedUrl);
        if (response.ok) {
          const nestedXml = await response.text();
          const nestedUrls = await parseSitemap(nestedXml, baseUrl);
          allUrls.push(...nestedUrls);
        }
      } catch (e) {
        console.warn('Failed to fetch nested sitemap:', e);
      }
    }
    return allUrls;
  }

  // Extract URLs from regular sitemap
  // Look for <url>...<loc>URL</loc>...</url> pattern
  const urlPattern = /<url[^>]*>[\s\S]*?<loc[^>]*>([\s\S]*?)<\/loc>[\s\S]*?<\/url>/gi;
  const urlMatches = [...xml.matchAll(urlPattern)];

  return urlMatches.map(match => match[1].trim());
}

// Select representative URLs using breadth-first + branch coverage strategy
function selectRepresentativeUrls(urls, maxPages, baseUrl) {
  // Parse and categorize URLs by depth and branch
  const parsed = urls.map(url => {
    try {
      const u = new URL(url);
      const path = u.pathname;
      const segments = path.split('/').filter(Boolean);
      return {
        url,
        path,
        depth: segments.length,
        branch: segments[0] || '_root_', // first-level directory as branch
        segments
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  // Always include homepage if exists
  const selected = [];
  const homepage = parsed.find(p => p.depth === 0 || p.path === '/');
  if (homepage) {
    selected.push(homepage.url);
  }

  // Also try to add the baseUrl itself
  if (!selected.includes(baseUrl)) {
    selected.push(baseUrl);
  }

  // Group by depth
  const byDepth = new Map();
  parsed.forEach(p => {
    if (!byDepth.has(p.depth)) byDepth.set(p.depth, []);
    byDepth.get(p.depth).push(p);
  });

  // Sort depths (shallow first)
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  // Allocate quota per depth level (more for shallow, less for deep)
  // e.g., depth 1 gets 40%, depth 2 gets 30%, depth 3+ shares 30%
  const remaining = maxPages - selected.length;
  const quotas = new Map();

  if (depths.length > 0) {
    const weights = depths.map(d => Math.max(1, 5 - d)); // depth 0->5, 1->4, 2->3, 3->2, 4+->1
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    depths.forEach((depth, i) => {
      const quota = Math.ceil((weights[i] / totalWeight) * remaining);
      quotas.set(depth, quota);
    });
  }

  // For each depth level, select URLs with branch coverage
  for (const depth of depths) {
    if (selected.length >= maxPages) break;

    const urlsAtDepth = byDepth.get(depth);
    const quota = quotas.get(depth);

    // Group by branch
    const byBranch = new Map();
    urlsAtDepth.forEach(p => {
      if (!byBranch.has(p.branch)) byBranch.set(p.branch, []);
      byBranch.get(p.branch).push(p);
    });

    // Round-robin selection across branches
    const branches = [...byBranch.keys()];
    let added = 0;
    let branchIndex = 0;
    const branchPointers = new Map(branches.map(b => [b, 0]));

    while (added < quota && selected.length < maxPages) {
      const branch = branches[branchIndex % branches.length];
      const branchUrls = byBranch.get(branch);
      const pointer = branchPointers.get(branch);

      if (pointer < branchUrls.length) {
        const candidate = branchUrls[pointer].url;
        if (!selected.includes(candidate)) {
          selected.push(candidate);
          added++;
        }
        branchPointers.set(branch, pointer + 1);
      }

      branchIndex++;

      // Check if all branches exhausted
      const allExhausted = branches.every(b =>
        branchPointers.get(b) >= byBranch.get(b).length
      );
      if (allExhausted) break;
    }
  }

  return selected.slice(0, maxPages);
}

// Build hierarchical tree from URLs
function buildUrlTree(urls, baseUrl) {
  const root = {
    name: new URL(baseUrl).hostname,
    url: baseUrl,
    path: '/',
    children: [],
    screenshot: null
  };

  const nodeMap = new Map();
  nodeMap.set('/', root);

  // Sort URLs by path depth
  const sortedUrls = urls
    .map(url => {
      try {
        const parsed = new URL(url);
        const path = parsed.pathname;
        return { url, path, depth: path.split('/').filter(Boolean).length };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.depth - b.depth);

  sortedUrls.forEach(({ url, path }) => {
    const segments = path.split('/').filter(Boolean);
    let currentPath = '/';
    let parent = root;

    segments.forEach((segment, i) => {
      const newPath = currentPath + segment + '/';

      if (!nodeMap.has(newPath)) {
        const isLeaf = i === segments.length - 1;
        const node = {
          name: segment,
          url: isLeaf ? url : null,
          path: newPath,
          children: [],
          screenshot: null
        };
        parent.children.push(node);
        nodeMap.set(newPath, node);
      }

      currentPath = newPath;
      parent = nodeMap.get(newPath);
    });

    // Update URL for existing node if this is the exact match
    const exactNode = nodeMap.get(currentPath);
    if (exactNode && !exactNode.url) {
      exactNode.url = url;
    }
  });

  return root;
}

// Attach screenshots to tree nodes
function attachScreenshotsToTree(node, screenshotMap) {
  if (node.url && screenshotMap.has(node.url)) {
    node.screenshot = screenshotMap.get(node.url);
  }

  if (node.children) {
    node.children.forEach(child => attachScreenshotsToTree(child, screenshotMap));
  }
}

// Main entry: try debugger API first (silent), fallback to window method
async function captureScreenshots(urls, options) {
  try {
    return await captureScreenshotsDebugger(urls, options);
  } catch (error) {
    console.warn('Debugger API failed, falling back to window method:', error);
    return await captureScreenshotsWindow(urls, options);
  }
}

// V2: Capture more screenshots for dynamic tree expansion
async function captureMoreScreenshots(urls, parentPath, options, sourceTabId) {
  if (isRunning) {
    sendToTab(sourceTabId, {
      type: 'captureMoreError',
      error: 'Another capture is in progress',
      parentPath
    });
    return;
  }

  isRunning = true;
  shouldCancel = false;

  try {
    // Progress callback that sends to the report tab
    const onProgress = (current, total, url) => {
      sendToTab(sourceTabId, {
        type: 'captureMoreProgress',
        current,
        total,
        url,
        parentPath
      });
    };

    // Capture screenshots with progress callback
    const screenshots = await captureScreenshotsDebugger(urls, options, onProgress);

    // Update storage with new screenshots
    const { reportData } = await chrome.storage.local.get('reportData');
    if (reportData) {
      // Initialize if not exists
      if (!reportData.screenshotMap) reportData.screenshotMap = {};
      if (!reportData.capturedUrlSet) reportData.capturedUrlSet = [];

      // Add new screenshots
      screenshots.forEach(({ url, screenshot }) => {
        if (screenshot) {
          reportData.screenshotMap[url] = screenshot;
          if (!reportData.capturedUrlSet.includes(url)) {
            reportData.capturedUrlSet.push(url);
          }
        }
      });

      // Update tree with new screenshots
      const allScreenshots = new Map(Object.entries(reportData.screenshotMap));
      attachScreenshotsToTree(reportData.tree, allScreenshots);

      reportData.capturedUrls = reportData.capturedUrlSet.length;
      await chrome.storage.local.set({ reportData });
    }

    // Send completion to report page
    sendToTab(sourceTabId, {
      type: 'captureMoreComplete',
      screenshots: screenshots.filter(s => s.screenshot),
      parentPath
    });

  } catch (error) {
    sendToTab(sourceTabId, {
      type: 'captureMoreError',
      error: error.message,
      parentPath
    });
  } finally {
    isRunning = false;
  }
}

// Send message to a specific tab
function sendToTab(tabId, message) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  } else {
    // Broadcast if no specific tab
    chrome.runtime.sendMessage(message).catch(() => {});
  }
}

// Method 1: Debugger API - completely silent, no visible window
// onProgress: optional callback (current, total, url) for progress updates
async function captureScreenshotsDebugger(urls, options, onProgress = null) {
  const results = [];
  const { loadTimeout, captureDelay } = options;

  // Create a hidden tab
  const tab = await chrome.tabs.create({
    url: 'about:blank',
    active: false
  });

  // Attach debugger
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');

  try {
    // Set viewport size
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    for (let i = 0; i < urls.length; i++) {
      if (shouldCancel) break;

      const url = urls[i];
      // Use callback if provided, otherwise use default sendProgress
      if (onProgress) {
        onProgress(i + 1, urls.length, url);
      } else {
        sendProgress(i + 1, urls.length, url);
      }

      try {
        // Navigate to URL
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url });

        // Wait for page load
        await waitForPageLoad(tab.id, loadTimeout);

        // Additional delay for rendering
        await sleep(captureDelay);

        // Capture screenshot via debugger (works without tab being visible!)
        const result = await chrome.debugger.sendCommand(
          { tabId: tab.id },
          'Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: false }
        );

        const screenshot = 'data:image/png;base64,' + result.data;
        results.push({ url, screenshot });

      } catch (error) {
        console.warn(`Failed to capture ${url}:`, error);
        results.push({ url, screenshot: null, error: error.message });
      }
    }
  } finally {
    // Detach debugger and close tab
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch (e) {}
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {}
  }

  return results;
}

// Wait for page load using debugger events
function waitForPageLoad(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeout);

    const listener = (source, method) => {
      if (source.tabId === tabId && method === 'Page.loadEventFired') {
        clearTimeout(timer);
        chrome.debugger.onEvent.removeListener(listener);
        resolve();
      }
    };

    chrome.debugger.onEvent.addListener(listener);

    // Enable page events
    chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
  });
}

// Method 2: Window method - fallback, creates a visible window
async function captureScreenshotsWindow(urls, options) {
  const results = [];
  const { loadTimeout, captureDelay } = options;

  // Create a separate window for screenshots (user can ignore it)
  const captureWindow = await chrome.windows.create({
    url: 'about:blank',
    type: 'normal',
    width: 1280,
    height: 900,
    left: 100,
    top: 100,
    focused: false
  });

  const blankTab = captureWindow.tabs[0];

  try {
    for (let i = 0; i < urls.length; i++) {
      if (shouldCancel) break;

      const url = urls[i];
      sendProgress(i + 1, urls.length, url);

      try {
        await chrome.tabs.update(blankTab.id, { url });
        await waitForTabLoad(blankTab.id, loadTimeout);
        await sleep(captureDelay);

        const screenshot = await chrome.tabs.captureVisibleTab(captureWindow.id, {
          format: 'png'
        });

        results.push({ url, screenshot });

      } catch (error) {
        console.warn(`Failed to capture ${url}:`, error);
        results.push({ url, screenshot: null, error: error.message });
      }
    }
  } finally {
    try {
      await chrome.windows.remove(captureWindow.id);
    } catch (e) {}
  }

  return results;
}

// Wait for tab to complete loading
function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check if URL is same domain (or subdomain) as base
function isSameDomain(url, baseUrl) {
  try {
    const urlHost = new URL(url).hostname;
    const baseHost = new URL(baseUrl).hostname;
    // Exact match or subdomain match
    return urlHost === baseHost || urlHost.endsWith('.' + baseHost);
  } catch (e) {
    return false;
  }
}

// Extract links from page using debugger Runtime.evaluate
async function extractLinks(tabId, baseUrl) {
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(href => href.startsWith('http'))
      `,
      returnByValue: true
    });

    if (result.result && result.result.value) {
      // Filter to same domain only
      return result.result.value.filter(url => isSameDomain(url, baseUrl));
    }
    return [];
  } catch (e) {
    console.warn('Failed to extract links:', e);
    return [];
  }
}

// Crawl from homepage when no sitemap is available (BFS)
async function crawlFromHomepage(baseUrl, maxPages, loadTimeout) {
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];
  const maxDepth = 3;
  const urls = [];

  // Create a hidden tab with debugger
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');

    while (queue.length > 0 && urls.length < maxPages) {
      if (shouldCancel) break;

      const { url, depth } = queue.shift();

      // Skip if already visited or too deep
      if (visited.has(url) || depth > maxDepth) continue;
      visited.add(url);

      // Normalize URL (remove hash, trailing slash variations)
      let normalizedUrl;
      try {
        const parsed = new URL(url);
        parsed.hash = '';
        normalizedUrl = parsed.href.replace(/\/$/, '');
      } catch (e) {
        continue;
      }

      if (urls.includes(normalizedUrl)) continue;
      urls.push(normalizedUrl);

      sendProgress(urls.length, maxPages, `Crawling: ${normalizedUrl}`);

      // Navigate and extract links
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.navigate', { url: normalizedUrl });
        await waitForPageLoad(tab.id, loadTimeout);
        await sleep(500); // Brief delay for JS rendering

        // Extract links from this page
        const links = await extractLinks(tab.id, baseUrl);

        // Add new links to queue
        for (const link of links) {
          if (!visited.has(link) && depth + 1 <= maxDepth) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      } catch (e) {
        console.warn(`Failed to crawl ${normalizedUrl}:`, e);
      }
    }
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch (e) {}
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }

  return urls;
}

// Send progress to popup
function sendProgress(current, total, url) {
  // Update running state for popup recovery
  runningState.current = current;
  runningState.total = total;
  runningState.url = url;

  chrome.runtime.sendMessage({
    type: 'progress',
    current,
    total,
    url
  }).catch(() => {});
}

// Save data and open report page directly from service worker
async function sendComplete(data) {
  // Store data first
  await chrome.storage.local.set({ reportData: data });

  // Open report page
  chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') });

  // Also notify popup if it's still open
  chrome.runtime.sendMessage({
    type: 'complete',
    data
  }).catch(() => {});
}

// Send error to popup
function sendError(error) {
  chrome.runtime.sendMessage({
    type: 'error',
    error
  }).catch(() => {});
}
