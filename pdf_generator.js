const puppeteer = require('puppeteer');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Renders plain text into a simple, readable one-page-style PDF. Deliberately
// minimal (no templating engine, no external assets) - this exists to let
// AURA attach a quick report to an email to the owner, not to produce
// polished documents.
async function generateSimplePdf(title, bodyText) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 48px; color: #111; }
  h1 { font-size: 20px; margin-bottom: 24px; }
  pre { white-space: pre-wrap; font-family: inherit; font-size: 13px; line-height: 1.5; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(bodyText)}</pre>
</body>
</html>`;

  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.pdf({ format: 'letter', printBackground: true });
  } finally {
    await browser.close();
  }
}

module.exports = { generateSimplePdf };
