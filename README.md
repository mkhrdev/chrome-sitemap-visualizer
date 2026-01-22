# Sitemap Visualizer

A Chrome extension that analyzes websites by fetching their sitemap, capturing screenshots of key pages, and generating an interactive tree visualization.

## Features

- **Automatic Sitemap Discovery**: Fetches and parses `sitemap.xml` from any website
- **Smart URL Selection**: Uses breadth-first traversal with branch coverage to capture representative pages
- **Silent Screenshot Capture**: Uses Chrome Debugger API for background screenshot capture without disrupting user workflow
- **Interactive Tree Visualization**: D3.js-powered vertical tree layout with:
  - Collapsible nodes (shows "... +N more" for branches with many children)
  - Click-to-expand functionality with on-demand screenshot capture
  - Smooth animations for tree updates
  - Click nodes to view full-size screenshots
- **Current Page Analysis**: One-click analysis starting from the current browser tab

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right corner)
4. Click "Load unpacked" and select the `sitemap-visualizer` folder
5. The extension icon will appear in your toolbar

## Usage

### Analyze Current Page
1. Navigate to any website you want to analyze
2. Click the extension icon
3. Click "Analyze Current Page" button
4. Wait for the analysis to complete
5. View the interactive sitemap visualization

### Analyze Custom URL
1. Click the extension icon
2. Enter a website URL in the input field
3. Click "Analyze" button
4. Wait for the analysis to complete

### Settings
- **Max pages**: Maximum number of pages to capture (10-50)
- **Load timeout**: How long to wait for each page to load (3-15 seconds)
- **Capture delay**: Delay before capturing screenshot after page load (0.5-3 seconds)

### Interacting with the Visualization
- **Click a node with screenshot**: View full-size screenshot in modal
- **Click a placeholder node**: Capture screenshot for that specific page
- **Click "... +N more"**: Expand hidden children and capture their screenshots
- **Scroll/Pan**: Navigate around the tree
- **Zoom**: Use mouse wheel to zoom in/out

## Technical Details

### Permissions Required
- `tabs`: Access current tab information
- `activeTab`: Interact with the active tab
- `scripting`: Execute scripts for page analysis
- `storage`: Store analysis results
- `unlimitedStorage`: Handle large screenshot data
- `debugger`: Silent screenshot capture via Chrome DevTools Protocol

### Architecture
```
sitemap-visualizer/
├── manifest.json           # Extension configuration
├── background/
│   └── service-worker.js   # Core logic: sitemap fetching, screenshot capture
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Popup styles
│   └── popup.js            # Popup interaction logic
├── report/
│   ├── report.html         # Visualization page
│   ├── report.css          # Visualization styles
│   └── report.js           # D3.js tree rendering and interaction
└── icons/                  # Extension icons
```

### Screenshot Capture Method
The extension uses Chrome's Debugger API (`chrome.debugger`) to capture screenshots silently in a background window. This approach:
- Doesn't interrupt user's current browsing
- Captures pages at consistent viewport size (1280x800)
- Falls back to `chrome.tabs.captureVisibleTab` if debugger fails

## Testing

For testing sitemap functionality, you can use these websites that are designed for web scraping practice:
- [Books to Scrape](https://books.toscrape.com) - Fake bookstore with multiple categories
- [Quotes to Scrape](https://quotes.toscrape.com) - Simple site with pagination

## Troubleshooting

### "No sitemap found"
The website may not have a sitemap.xml file. The extension will attempt to discover links from the homepage instead.

### Screenshots not loading
- Check if the website blocks iframe embedding or has strict CSP
- Try increasing the load timeout in settings

### Extension not working
1. Check `chrome://extensions/` for any error messages
2. Click "Reload" on the extension
3. Check the service worker console for errors (click "Inspect views: service worker")

## Changelog

### v0.1.0 (2026-01-22)

Initial release.

#### Core Features
- **Sitemap Fetching**: Auto-discovery of `sitemap.xml`, supports sitemap index (nested sitemaps)
- **Smart URL Selection**: Breadth-first traversal with branch coverage for representative page selection
- **Silent Screenshot Capture**: Chrome Debugger API (`chrome.debugger`) for background capture without interrupting browsing
- **Fallback Capture**: Falls back to `chrome.tabs.captureVisibleTab` if debugger fails
- **Interactive Tree Visualization**: D3.js vertical tree with collapsible nodes, zoom/pan, click-to-view screenshots

#### Popup UI
- "Analyze Current Page" one-click button
- Manual URL input with Enter key support
- Settings: max pages (10-50), load timeout (3-15s), capture delay (0.5-3s)
- Progress bar with current URL display
- Cancel button to abort running analysis
- **State recovery**: Popup reopening restores running state (progress bar, cancel button)

#### Report Page
- Full-size screenshot modal on node click
- Dynamic expansion: click placeholder nodes to capture on-demand
- "... +N more" nodes for branches with many children
- Smooth animations for tree updates

#### Links
- GitHub icon button in popup header
- Privacy Policy link in popup footer

## License

MIT
