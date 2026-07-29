const puppeteer = require('puppeteer');
const path = require('path');

/**
 * Checks Blackboard assignments using a Persistent User Data Directory.
 * This completely bypasses SSO and 2FA because the user already authenticated manually.
 */
async function checkBlackboardAssignments() {
  let browser;
  try {
    const userDataDir = path.join(__dirname, '.browser_data');
    
    // Launch completely headlessly using the hijacked session with bot-evasion flags
    browser = await puppeteer.launch({ 
      headless: 'new',
      userDataDir: userDataDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ] 
    });
    const page = await browser.newPage();

    // 1. Navigate directly to the Phoenix Portal
    await page.goto('https://my.phoenix.edu', { waitUntil: 'networkidle2' });

    console.log('Scanning Phoenix Portal for class links...');
    
    // 2. Click the 'Go to class' button
    const classHref = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a, button'));
      const goBtn = elements.find(el => el.innerText && el.innerText.trim() === 'Go to class');
      // If it's a link, return the href. If it's a button with an onclick, we fallback.
      return goBtn ? (goBtn.href || goBtn.getAttribute('href')) : null;
    });

    let classPage = page;

    if (classHref) {
      console.log('Found class link! Navigating to: ' + classHref);
      await classPage.goto(classHref, { waitUntil: 'networkidle2' });
    } else {
      console.log('Could not find the href for "Go to class", attempting manual click...');
      const clicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        const goBtn = elements.find(el => el.innerText && el.innerText.trim() === 'Go to class');
        if (goBtn) {
          goBtn.click();
          return true;
        }
        return false;
      });
      
      if (!clicked) return "Could not find any active classes on the dashboard.";
      
      await new Promise(r => setTimeout(r, 5000));
      const pages = await browser.pages();
      classPage = pages[pages.length - 1];
    }

    if (classPage) {
      // 4. Click the 'Calendar' tab to see all assignments as requested by user
      console.log('Clicking Calendar tab...');
      await classPage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('a, span, div, li'));
        const calendarTab = tabs.find(el => el.innerText && el.innerText.trim() === 'Calendar');
        if (calendarTab) calendarTab.click();
      });
      
      // Wait for the calendar to render
      console.log('Waiting 10 seconds for Calendar to render...');
      await new Promise(r => setTimeout(r, 10000));
      
      // 5. Scrape the raw text of the Gradebook and let AURA's LLM parse it!
      const gradebookData = await classPage.evaluate(() => {
        return document.body.innerText;
      });
      
      require('fs').writeFileSync('scraped_blackboard.txt', gradebookData);
      
      console.log('Successfully scraped Gradebook data!');
      return gradebookData.substring(0, 4000); // Truncate to save tokens, usually the top assignments are first
    }
    
    return "Failed to load the Blackboard class page.";

  } catch (error) {
    console.error('Error in checkBlackboardAssignments:', error);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function searchWeb(query) {
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: `q=${encodeURIComponent(query)}`
    });
    
    if (!res.ok) throw new Error('Search failed');
    
    const text = await res.text();
    const snippetRegex = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;
    
    let match;
    let results = [];
    while ((match = snippetRegex.exec(text)) !== null) {
      let snippet = match[1].replace(/<[^>]+>/g, '').trim();
      snippet = snippet.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      results.push(snippet);
    }
    
    if (results.length === 0) return "No results found.";
    
    return results.slice(0, 3).join('\n\n');
  } catch (error) {
    console.error('Error in searchWeb:', error);
    return "Error searching the web.";
  }
}

module.exports = { checkBlackboardAssignments, searchWeb };
