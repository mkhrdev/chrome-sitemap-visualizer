/*
 * Sitemap Screenshot Visualizer - Report Page
 *
 * D3.js tree visualization with zoom, pan, and screenshot preview.
 * V2: Dynamic tree expansion with on-demand screenshots.
 */

// V2: Global state for dynamic expansion
let currentReportData = null;
let currentTreeData = null;  // The collapsed tree being displayed
let svg = null;
let g = null;
let zoom = null;
let isExpanding = false;
let pendingExpand = null;

// Node dimensions (shared)
const NODE_WIDTH = 160;
const NODE_HEIGHT = 110;
const H_SPACING = 200;
const V_SPACING = 160;

document.addEventListener('DOMContentLoaded', async () => {
  const loading = document.getElementById('loading');
  const noData = document.getElementById('no-data');

  // Load data from storage
  const { reportData } = await chrome.storage.local.get('reportData');

  if (!reportData || !reportData.tree) {
    loading.style.display = 'none';
    noData.style.display = 'block';
    return;
  }

  currentReportData = reportData;
  loading.style.display = 'none';

  // Update header
  document.getElementById('report-title').textContent = `Site Structure - ${reportData.baseUrl}`;
  document.getElementById('meta-total').textContent = `Total URLs: ${reportData.totalUrls}`;
  document.getElementById('meta-captured').textContent = `Captured: ${reportData.capturedUrls}`;
  document.getElementById('meta-time').textContent = `Generated: ${new Date(reportData.timestamp).toLocaleString()}`;

  // Render tree
  renderTree(reportData.tree);

  // Setup export buttons
  setupExport(reportData);

  // Setup modal
  setupModal();

  // V2: Listen for messages from service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'captureMoreProgress') {
      updateExpandProgress(message.current, message.total, message.url);
    } else if (message.type === 'captureMoreComplete') {
      handleExpandComplete(message.screenshots, message.parentPath);
    } else if (message.type === 'captureMoreError') {
      handleExpandError(message.error);
    }
  });
});

// Collapse children if more than maxChildren, keep first few and add "..." node
function collapseTree(node, maxChildren = 5) {
  if (!node.children || node.children.length === 0) return node;

  // Recursively process children first
  node.children = node.children.map(child => collapseTree(child, maxChildren));

  // If too many children, collapse
  if (node.children.length > maxChildren) {
    const visibleCount = maxChildren - 1;
    const visibleChildren = node.children.slice(0, visibleCount);
    const hiddenChildren = node.children.slice(visibleCount);

    // Add ellipsis node with reference to hidden children
    visibleChildren.push({
      name: `... +${hiddenChildren.length} more`,
      path: node.path + '_more/',
      url: null,
      children: [],
      screenshot: null,
      isEllipsis: true,
      // V2: Store hidden children for dynamic expansion
      hiddenChildren: hiddenChildren,
      parentPath: node.path,
      expandBatchSize: 5
    });

    node.children = visibleChildren;
  }

  return node;
}

function renderTree(data) {
  const width = window.innerWidth;
  const height = window.innerHeight - 80;

  // Collapse tree before rendering (store for updates)
  currentTreeData = collapseTree(JSON.parse(JSON.stringify(data)), 5);

  // Create SVG (use global)
  svg = d3.select('#visualization')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  // Create main group for zoom/pan (use global)
  g = svg.append('g');

  // Create sub-groups for layering: links below nodes
  g.append('g').attr('class', 'links-group');
  g.append('g').attr('class', 'nodes-group');

  // Create tooltip (once)
  const tooltip = d3.select('body')
    .append('div')
    .attr('class', 'tooltip')
    .style('display', 'none');

  // Zoom and pan (use global)
  zoom = d3.zoom()
    .scaleExtent([0.1, 3])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });

  svg.call(zoom);

  // Initial render
  updateTree(false);

  // Calculate initial transform
  const bounds = g.node().getBBox();
  const scale = Math.min(0.9, Math.min(width / bounds.width, height / bounds.height) * 0.8);
  const initialTransform = d3.zoomIdentity
    .translate(width / 2 - bounds.x * scale - bounds.width * scale / 2, 100)
    .scale(scale);
  svg.call(zoom.transform, initialTransform);

  window._initialTransform = initialTransform;

  // Reset view button
  document.getElementById('reset-view').addEventListener('click', () => {
    svg.transition()
      .duration(500)
      .call(zoom.transform, initialTransform);
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    const newWidth = window.innerWidth;
    const newHeight = window.innerHeight - 80;
    svg.attr('width', newWidth).attr('height', newHeight);
  });

  // Store tooltip for event handlers
  window._tooltip = tooltip;
}

// Render or update the tree visualization
function updateTree(animate = true) {
  const root = d3.hierarchy(currentTreeData);

  const treeLayout = d3.tree()
    .nodeSize([H_SPACING, V_SPACING])
    .separation((a, b) => a.parent === b.parent ? 1 : 1.3);

  treeLayout(root);

  const duration = animate ? 500 : 0;

  // Get layer groups
  const linksGroup = g.select('.links-group');
  const nodesGroup = g.select('.nodes-group');

  // Update links (in links-group, below nodes)
  const links = linksGroup.selectAll('.link')
    .data(root.links(), d => d.source.data.path + '-' + d.target.data.path);

  links.exit()
    .transition()
    .duration(duration)
    .style('opacity', 0)
    .remove();

  const linksEnter = links.enter()
    .append('path')
    .attr('class', 'link')
    .style('opacity', animate ? 0 : 1)
    .attr('d', d3.linkVertical().x(d => d.x).y(d => d.y));

  if (animate) {
    linksEnter.transition()
      .duration(duration)
      .style('opacity', 1);
  }

  links.transition()
    .duration(duration)
    .attr('d', d3.linkVertical().x(d => d.x).y(d => d.y));

  // Update nodes (in nodes-group, above links)
  const nodes = nodesGroup.selectAll('.node')
    .data(root.descendants(), d => d.data.path);

  nodes.exit()
    .transition()
    .duration(duration)
    .style('opacity', 0)
    .remove();

  const nodesEnter = nodes.enter()
    .append('g')
    .attr('class', d => 'node' + (d.data.isEllipsis ? ' node-ellipsis' : ''))
    .attr('transform', d => `translate(${d.x - NODE_WIDTH/2}, ${d.y - NODE_HEIGHT/2})`)
    .style('opacity', animate ? 0 : 1);

  // Render content for new nodes
  nodesEnter.each(function(d) {
    renderNodeContent(d3.select(this), d);
  });

  if (animate) {
    nodesEnter.transition()
      .duration(duration)
      .delay(200)
      .style('opacity', 1);
  }

  // Update existing nodes - move and refresh content if needed
  nodes.each(function(d) {
    const nodeEl = d3.select(this);
    const hasScreenshot = !!d.data.screenshot;
    const hadScreenshot = nodeEl.select('.node-image').size() > 0;

    // If screenshot status changed, re-render content
    if (hasScreenshot !== hadScreenshot) {
      nodeEl.selectAll('*').remove();
      renderNodeContent(nodeEl, d);
    }
  });

  nodes.transition()
    .duration(duration)
    .attr('transform', d => `translate(${d.x - NODE_WIDTH/2}, ${d.y - NODE_HEIGHT/2})`);

  // Rebind events to all nodes
  g.selectAll('.node')
    .on('click', handleNodeClick)
    .on('mouseenter', handleNodeMouseEnter)
    .on('mousemove', handleNodeMouseMove)
    .on('mouseleave', handleNodeMouseLeave);
}

// Render content for a single node
function renderNodeContent(node, d) {
  if (d.data.isEllipsis) {
    node.append('rect')
      .attr('class', 'node-rect node-ellipsis-rect')
      .attr('width', NODE_WIDTH)
      .attr('height', 40)
      .attr('y', (NODE_HEIGHT - 40) / 2)
      .attr('rx', 20);

    node.append('text')
      .attr('x', NODE_WIDTH / 2)
      .attr('y', NODE_HEIGHT / 2)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('fill', '#fff')
      .attr('font-size', '13px')
      .text(d.data.name);

  } else if (d.data.screenshot) {
    node.append('rect')
      .attr('class', 'node-rect')
      .attr('width', NODE_WIDTH)
      .attr('height', NODE_HEIGHT);

    node.append('image')
      .attr('class', 'node-image')
      .attr('href', d.data.screenshot)
      .attr('width', NODE_WIDTH - 6)
      .attr('height', NODE_HEIGHT - 28)
      .attr('x', 3)
      .attr('y', 3)
      .attr('preserveAspectRatio', 'xMidYMin slice');

    node.append('rect')
      .attr('class', 'node-label-bg')
      .attr('width', NODE_WIDTH)
      .attr('height', 24)
      .attr('y', NODE_HEIGHT - 24);

    node.append('text')
      .attr('class', 'node-label')
      .attr('x', NODE_WIDTH / 2)
      .attr('y', NODE_HEIGHT - 8)
      .text(truncateText(d.data.name, 20));

  } else {
    node.append('rect')
      .attr('class', 'node-rect node-placeholder')
      .attr('width', NODE_WIDTH)
      .attr('height', NODE_HEIGHT);

    node.append('text')
      .attr('x', NODE_WIDTH / 2)
      .attr('y', NODE_HEIGHT / 2 - 8)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('fill', '#666')
      .attr('font-size', '12px')
      .text(truncateText(d.data.name, 20));

    node.append('text')
      .attr('x', NODE_WIDTH / 2)
      .attr('y', NODE_HEIGHT / 2 + 12)
      .attr('text-anchor', 'middle')
      .attr('fill', '#555')
      .attr('font-size', '10px')
      .text('(no screenshot)');
  }
}

// Event handlers
function handleNodeClick(event, d) {
  if (d.data.isEllipsis) {
    handleExpandClick(d);
  } else if (d.data.screenshot) {
    showModal(d.data.screenshot, d.data.url);
  } else if (d.data.url && !d.data.screenshot) {
    // V2: Click on placeholder node to capture screenshot
    handleSingleNodeCapture(d);
  }
}

// V2: Capture screenshot for a single node without screenshot
function handleSingleNodeCapture(d3Node) {
  if (isExpanding) return;

  const nodeData = d3Node.data;
  if (!nodeData.url || nodeData.screenshot) return;

  // Check if already captured
  const capturedSet = new Set(currentReportData.capturedUrlSet || []);
  if (capturedSet.has(nodeData.url)) {
    // Already have screenshot in storage, just update the node
    const screenshot = currentReportData.screenshotMap?.[nodeData.url];
    if (screenshot) {
      nodeData.screenshot = screenshot;
      updateTree(true);
      return;
    }
  }

  isExpanding = true;
  showExpandLoading();
  document.getElementById('expand-loading-text').textContent = 'Capturing screenshot...';

  pendingExpand = {
    type: 'single',
    d3Node,
    nodePath: nodeData.path
  };

  chrome.runtime.sendMessage({
    type: 'captureMore',
    urls: [nodeData.url],
    parentPath: nodeData.path,  // Use node's own path as identifier
    options: currentReportData.options || { loadTimeout: 5000, captureDelay: 1000 }
  });
}

function handleNodeMouseEnter(event, d) {
  if (d.data.url && !d.data.isEllipsis) {
    window._tooltip
      .style('display', 'block')
      .style('left', (event.pageX + 10) + 'px')
      .style('top', (event.pageY + 10) + 'px')
      .text(d.data.url);
  }
}

function handleNodeMouseMove(event) {
  window._tooltip
    .style('left', (event.pageX + 10) + 'px')
    .style('top', (event.pageY + 10) + 'px');
}

function handleNodeMouseLeave() {
  window._tooltip.style('display', 'none');
}

// V2: Handle click on ellipsis node to expand
async function handleExpandClick(ellipsisD3Node) {
  if (isExpanding) return;

  const ellipsisData = ellipsisD3Node.data;
  const hiddenChildren = ellipsisData.hiddenChildren || [];

  if (hiddenChildren.length === 0) return;

  isExpanding = true;

  // Determine how many nodes to expand (batch size)
  const batchSize = ellipsisData.expandBatchSize || 5;
  const nodesToExpand = hiddenChildren.slice(0, batchSize);
  const remainingNodes = hiddenChildren.slice(batchSize);

  // Collect URLs to capture (max 10, including children up to depth 2)
  const urlsToCapture = collectUrlsForCapture(nodesToExpand, 10);

  // Filter out already captured URLs
  const capturedSet = new Set(currentReportData.capturedUrlSet || []);
  const newUrls = urlsToCapture.filter(url => !capturedSet.has(url));

  if (newUrls.length === 0) {
    // No new screenshots needed, just expand
    performExpand(ellipsisD3Node, nodesToExpand, remainingNodes, {});
    isExpanding = false;
    return;
  }

  // Show loading and request screenshots
  showExpandLoading();

  pendingExpand = {
    ellipsisD3Node,
    nodesToExpand,
    remainingNodes,
    parentPath: ellipsisData.parentPath
  };

  chrome.runtime.sendMessage({
    type: 'captureMore',
    urls: newUrls,
    parentPath: ellipsisData.parentPath,
    options: currentReportData.options || { loadTimeout: 5000, captureDelay: 1000 }
  });
}

// Collect URLs from nodes and their children (limited depth)
function collectUrlsForCapture(nodes, maxCount, depth = 0, maxDepth = 2) {
  const urls = [];

  function collect(nodeList, currentDepth) {
    if (currentDepth > maxDepth || urls.length >= maxCount) return;

    for (const node of nodeList) {
      if (urls.length >= maxCount) break;

      if (node.url && !node.isEllipsis) {
        urls.push(node.url);
      }

      if (node.children && node.children.length > 0) {
        collect(node.children, currentDepth + 1);
      }
    }
  }

  collect(nodes, depth);
  return urls;
}

// Perform the tree expansion after screenshots are ready
function performExpand(ellipsisD3Node, newNodes, remainingNodes, screenshotMap) {
  // Find parent in the collapsed tree data
  const parentPath = ellipsisD3Node.data.parentPath;
  const parentNode = findNodeByPath(currentTreeData, parentPath);

  if (!parentNode) {
    console.error('Parent node not found:', parentPath);
    return;
  }

  // Remove ellipsis node from parent's children
  const ellipsisIndex = parentNode.children.findIndex(c => c.isEllipsis);
  if (ellipsisIndex !== -1) {
    parentNode.children.splice(ellipsisIndex, 1);
  }

  // Attach screenshots to new nodes
  attachScreenshotsToNodes(newNodes, screenshotMap);

  // Add new nodes (collapse their children)
  newNodes.forEach(node => {
    const collapsedNode = collapseTree(JSON.parse(JSON.stringify(node)), 5);
    parentNode.children.push(collapsedNode);
  });

  // If there are remaining nodes, add new ellipsis
  if (remainingNodes.length > 0) {
    parentNode.children.push({
      name: `... +${remainingNodes.length} more`,
      path: parentPath + '_more/',
      url: null,
      children: [],
      screenshot: null,
      isEllipsis: true,
      hiddenChildren: remainingNodes,
      parentPath: parentPath,
      expandBatchSize: 5
    });
  }

  // Update the tree visualization with animation
  updateTree(true);

  // Update meta info
  updateMetaInfo();
}

// Find a node by its path in the tree
function findNodeByPath(node, targetPath) {
  if (node.path === targetPath) return node;

  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }

  return null;
}

// Attach screenshots to nodes recursively
function attachScreenshotsToNodes(nodes, screenshotMap) {
  nodes.forEach(node => {
    if (node.url && screenshotMap[node.url]) {
      node.screenshot = screenshotMap[node.url];
    }
    if (node.children) {
      attachScreenshotsToNodes(node.children, screenshotMap);
    }
  });
}

// Loading overlay controls
function showExpandLoading() {
  document.getElementById('expand-loading').style.display = 'flex';
  document.getElementById('expand-progress-fill').style.width = '0%';
  document.getElementById('expand-progress-text').textContent = 'Preparing...';
  document.getElementById('expand-loading-text').textContent = 'Capturing screenshots...';
}

function hideExpandLoading() {
  document.getElementById('expand-loading').style.display = 'none';
}

function updateExpandProgress(current, total, url) {
  const percentage = total > 0 ? (current / total) * 100 : 0;
  document.getElementById('expand-progress-fill').style.width = `${percentage}%`;
  document.getElementById('expand-progress-text').textContent = `${current} / ${total}`;
  document.getElementById('expand-loading-text').textContent = `Capturing: ${truncateText(url, 35)}`;
}

// Handle completion from service worker
function handleExpandComplete(screenshots, parentPath) {
  hideExpandLoading();

  if (!pendingExpand) {
    isExpanding = false;
    return;
  }

  // Build screenshot map
  const screenshotMap = {};
  screenshots.forEach(({ url, screenshot }) => {
    screenshotMap[url] = screenshot;
  });

  // Update currentReportData with new screenshots
  if (!currentReportData.capturedUrlSet) currentReportData.capturedUrlSet = [];
  if (!currentReportData.screenshotMap) currentReportData.screenshotMap = {};
  screenshots.forEach(({ url, screenshot }) => {
    if (!currentReportData.capturedUrlSet.includes(url)) {
      currentReportData.capturedUrlSet.push(url);
    }
    if (screenshot) {
      currentReportData.screenshotMap[url] = screenshot;
    }
  });

  // Handle based on pending type
  if (pendingExpand.type === 'single') {
    // Single node capture
    handleSingleNodeComplete(screenshotMap);
  } else {
    // Expand more nodes
    if (pendingExpand.parentPath !== parentPath) {
      isExpanding = false;
      pendingExpand = null;
      return;
    }
    performExpand(
      pendingExpand.ellipsisD3Node,
      pendingExpand.nodesToExpand,
      pendingExpand.remainingNodes,
      screenshotMap
    );
  }

  pendingExpand = null;
  isExpanding = false;
}

// Handle single node screenshot completion
function handleSingleNodeComplete(screenshotMap) {
  if (!pendingExpand || pendingExpand.type !== 'single') return;

  const nodePath = pendingExpand.nodePath;
  const nodeInTree = findNodeByPath(currentTreeData, nodePath);

  if (nodeInTree && nodeInTree.url) {
    const screenshot = screenshotMap[nodeInTree.url];
    if (screenshot) {
      nodeInTree.screenshot = screenshot;
    }
  }

  // Update tree visualization
  updateTree(true);
  updateMetaInfo();
}

// Handle error from service worker
function handleExpandError(error) {
  hideExpandLoading();
  pendingExpand = null;
  isExpanding = false;
  alert(`Failed to capture screenshots: ${error}`);
}

// Update the captured count in header
function updateMetaInfo() {
  if (currentReportData) {
    const count = currentReportData.capturedUrlSet?.length || currentReportData.capturedUrls;
    document.getElementById('meta-captured').textContent = `Captured: ${count}`;
  }
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 2) + '...';
}

function setupModal() {
  const modal = document.getElementById('image-modal');
  const closeBtn = modal.querySelector('.modal-close');

  closeBtn.addEventListener('click', hideModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      hideModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideModal();
    }
  });
}

function showModal(imageSrc, url) {
  const modal = document.getElementById('image-modal');
  const modalImage = document.getElementById('modal-image');
  const modalLink = document.getElementById('modal-link');

  modalImage.src = imageSrc;
  modalLink.href = url || '#';
  modalLink.style.display = url ? 'inline' : 'none';

  modal.style.display = 'flex';
}

function hideModal() {
  document.getElementById('image-modal').style.display = 'none';
}

function setupExport(reportData) {
  document.getElementById('export-json').addEventListener('click', () => {
    exportJSON(reportData);
  });

  document.getElementById('export-html').addEventListener('click', () => {
    exportHTML(reportData);
  });
}

function exportJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitemap-report-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportHTML(data) {
  const htmlContent = generateHTMLReport(data);
  const blob = new Blob([htmlContent], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitemap-report-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function generateHTMLReport(data) {
  const screenshots = [];
  collectScreenshots(data.tree, screenshots);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Site Structure Report - ${data.baseUrl}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; padding: 20px; }
    h1 { color: #333; margin-bottom: 10px; }
    .meta { color: #666; margin-bottom: 30px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
    .card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .card img { width: 100%; height: 200px; object-fit: cover; object-position: top; }
    .card-body { padding: 12px; }
    .card-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; word-break: break-all; }
    .card-url { font-size: 12px; color: #666; word-break: break-all; }
    .card-url a { color: #1a73e8; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Site Structure Report</h1>
  <div class="meta">
    <p><strong>Website:</strong> ${data.baseUrl}</p>
    <p><strong>Total URLs:</strong> ${data.totalUrls} | <strong>Captured:</strong> ${data.capturedUrls}</p>
    <p><strong>Generated:</strong> ${new Date(data.timestamp).toLocaleString()}</p>
  </div>
  <div class="grid">
    ${screenshots.map(s => `
    <div class="card">
      <img src="${s.screenshot}" alt="${s.name}">
      <div class="card-body">
        <div class="card-title">${s.path}</div>
        <div class="card-url"><a href="${s.url}" target="_blank">${s.url}</a></div>
      </div>
    </div>
    `).join('')}
  </div>
</body>
</html>`;
}

function collectScreenshots(node, result) {
  if (node.screenshot && node.url) {
    result.push({
      name: node.name,
      path: node.path,
      url: node.url,
      screenshot: node.screenshot
    });
  }
  if (node.children) {
    node.children.forEach(child => collectScreenshots(child, result));
  }
}
