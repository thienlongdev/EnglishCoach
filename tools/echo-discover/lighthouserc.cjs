const base = new URL(process.env.DISCOVER_LH_BASE || process.env.DISCOVER_BASE || 'http://127.0.0.1:18492');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Use a loopback frontend.');
module.exports = {
  ci: {
    collect: {
      url: (process.env.DISCOVER_PATHS || '/,/echo-anywhere,/huong-dan,/huong-dan/nghe-chep-chinh-ta,/huong-dan/hoc-tu-trong-ngu-canh').split(',').map(path => new URL(path, base).href),
      numberOfRuns: 3,
      chromePath: process.env.CHROME_PATH,
      settings: {
        chromeFlags: '--headless --disable-dev-shm-usage',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    },
    assert: { assertions: {
      'http-status-code': 'error',
      'document-title': 'error',
      'html-has-lang': 'error',
      'resource-summary:script:size': ['error', { maxNumericValue: 750000, aggregationMethod: 'median' }],
      'cumulative-layout-shift': ['error', { maxNumericValue: 0.1, aggregationMethod: 'median' }],
      'largest-contentful-paint': ['warn', { maxNumericValue: 2500, aggregationMethod: 'median' }],
      'total-blocking-time': ['warn', { maxNumericValue: 300, aggregationMethod: 'median' }],
    } },
    upload: { target: 'filesystem', outputDir: process.env.DISCOVER_LH_OUTPUT || '.lighthouseci/report' },
  },
};
