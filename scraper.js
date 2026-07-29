const puppeteer = require('puppeteer');
const path = require('path');

function unfoldIcs(text) {
  return String(text).replace(/\r?\n[ \t]/g, '');
}

function decodeIcsText(value = '') {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function isIcsCalendar(text) {
  return /(?:^|\r?\n)BEGIN:VCALENDAR(?:\r?\n|$)/i.test(String(text));
}

function dateTimeInZone({ year, month, day, hour, minute, second }, timeZone) {
  const desiredTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidateTimestamp = desiredTimestamp;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  // Intl exposes wall-clock parts but not the offset directly. Recalculate the
  // candidate twice so DST-aware zones also settle on the intended instant.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidateTimestamp))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, Number(part.value)])
    );
    const representedTimestamp = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    candidateTimestamp += desiredTimestamp - representedTimestamp;
  }
  return new Date(candidateTimestamp);
}

function parseIcsDate(value, timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix') {
  if (!value) return null;
  const clean = value.trim();
  const match = clean.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
  if (!match) {
    // Only accept a non-ICS fallback when it carries an explicit UTC offset.
    // Otherwise Node would interpret it in the host timezone, producing
    // different deadlines on the Mac and Render's UTC container.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(clean)) {
      return null;
    }
    const parsed = new Date(clean);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  // Date-only and non-Z Blackboard values are intentionally interpreted in
  // AURA's local timezone, matching how deadlines appear to the user.
  if (clean.endsWith('Z')) {
    return new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  }
  try {
    return dateTimeInZone({
      year: +year,
      month: +month,
      day: +day,
      hour: +hour,
      minute: +minute,
      second: +second
    }, String(timeZone || 'America/Phoenix').replace(/^"(.*)"$/, '$1'));
  } catch {
    return dateTimeInZone({
      year: +year,
      month: +month,
      day: +day,
      hour: +hour,
      minute: +minute,
      second: +second
    }, 'America/Phoenix');
  }
}

function parseBlackboardIcs(text) {
  const unfolded = unfoldIcs(text);
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return blocks.map(block => {
    const fields = {};
    const fieldParameters = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const rawKey = line.slice(0, separator);
      const key = rawKey.split(';')[0].toUpperCase();
      if (!fields[key]) {
        fields[key] = line.slice(separator + 1);
        fieldParameters[key] = Object.fromEntries(
          rawKey.split(';').slice(1).map(parameter => {
            const equals = parameter.indexOf('=');
            if (equals < 0) return [parameter.toUpperCase(), ''];
            return [
              parameter.slice(0, equals).toUpperCase(),
              parameter.slice(equals + 1)
            ];
          })
        );
      }
    }
    const dueField = fields.DTSTART
      ? 'DTSTART'
      : fields.DUE
        ? 'DUE'
        : 'DTEND';
    const due = parseIcsDate(
      fields[dueField],
      fieldParameters[dueField]?.TZID || process.env.AURA_TIMEZONE || 'America/Phoenix'
    );
    return {
      title: decodeIcsText(fields.SUMMARY || 'Untitled assignment'),
      due_at: due ? due.toISOString() : null,
      description: decodeIcsText(fields.DESCRIPTION || '').slice(0, 500),
      url: decodeIcsText(fields.URL || '')
    };
  }).filter(event => event.due_at).sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
}

async function checkBlackboardCalendarFeed(feedUrl) {
  const normalizedUrl = String(feedUrl).replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(normalizedUrl)) {
    return 'BLACKBOARD_CALENDAR_ERROR: The configured calendar URL must use HTTPS or webcal.';
  }
  try {
    const response = await fetch(normalizedUrl, {
      headers: { 'User-Agent': 'AURA Blackboard Calendar Monitor/1.0' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) return `BLACKBOARD_CALENDAR_ERROR: Calendar feed returned HTTP ${response.status}.`;
    const calendarText = await response.text();
    if (!isIcsCalendar(calendarText)) {
      return 'BLACKBOARD_CALENDAR_ERROR: Calendar feed did not return iCalendar data.';
    }
    const events = parseBlackboardIcs(calendarText);
    const now = Date.now();
    const relevant = events.filter(event => {
      const due = new Date(event.due_at).getTime();
      return due >= now - 2 * 86400000 && due <= now + 90 * 86400000;
    });
    return JSON.stringify({ source: 'blackboard_ical', assignments: relevant });
  } catch (error) {
    return `BLACKBOARD_CALENDAR_ERROR: ${error.message}`;
  }
}

/**
 * Checks Blackboard assignments using a Persistent User Data Directory.
 * Reuses a session the user authenticated manually; it never stores a password.
 */
async function checkBlackboardAssignments() {
  if (process.env.BLACKBOARD_ICAL_URL) {
    return checkBlackboardCalendarFeed(process.env.BLACKBOARD_ICAL_URL);
  }
  if (process.env.AURA_RUNTIME === 'cloud') {
    return 'BLACKBOARD_CALENDAR_ERROR: Blackboard calendar access is not configured on the cloud service.';
  }

  let browser;
  try {
    const userDataDir = path.join(__dirname, '.browser_data');
    
    // Launch headlessly using the user's persistent, previously authenticated session.
    browser = await puppeteer.launch({ 
      headless: 'new',
      userDataDir: userDataDir,
    });
    const page = await browser.newPage();

    // 1. Navigate directly to the Phoenix Portal
    await page.goto('https://my.phoenix.edu', { waitUntil: 'networkidle2', timeout: 30000 });

    const portalState = await page.evaluate(() => ({
      url: location.href,
      text: document.body?.innerText || ''
    }));
    if (/login|sign.?in/i.test(portalState.url) ||
        (/user name|username/i.test(portalState.text) && /password/i.test(portalState.text))) {
      return 'BLACKBOARD_LOGIN_REQUIRED: Your saved University of Phoenix session expired. Run "node login-blackboard.js" on the Mac, complete login and 2FA, reach the dashboard, then close the browser window.';
    }

    console.log('Scanning Phoenix Portal for class links...');
    
    // 2. Click the 'Go to class' button
    const classHref = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('a, button'));
      const goBtn = elements.find(el => /go to class/i.test(el.innerText || ''));
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
        const goBtn = elements.find(el => /go to class/i.test(el.innerText || ''));
        if (goBtn) {
          goBtn.click();
          return true;
        }
        return false;
      });
      
      if (!clicked) return 'BLACKBOARD_NAVIGATION_ERROR: AURA reached the portal but could not find an active "Go to class" control.';
      
      await new Promise(r => setTimeout(r, 5000));
      const pages = await browser.pages();
      classPage = pages[pages.length - 1];
    }

    if (classPage) {
      // 4. Click the 'Calendar' tab to see all assignments as requested by user
      console.log('Clicking Calendar tab...');
      await classPage.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('a, span, div, li'));
        const calendarTab = tabs.find(el => /^calendar$/i.test((el.innerText || '').trim()));
        if (calendarTab) calendarTab.click();
      });
      
      // Wait for the calendar to render
      console.log('Waiting 10 seconds for Calendar to render...');
      await new Promise(r => setTimeout(r, 10000));
      
      // 5. Scrape the raw text of the Gradebook and let AURA's LLM parse it!
      const gradebookData = await classPage.evaluate(() => {
        return document.body.innerText;
      });
      
      if (process.env.AURA_DEBUG_SCRAPES === 'true') {
        require('fs').writeFileSync('scraped_blackboard.txt', gradebookData);
      }
      
      console.log('Successfully scraped Gradebook data!');
      return gradebookData.substring(0, 12000);
    }
    
    return 'BLACKBOARD_NAVIGATION_ERROR: Failed to load the Blackboard class page.';

  } catch (error) {
    console.error('Error in checkBlackboardAssignments:', error);
    return `BLACKBOARD_ERROR: ${error.message}`;
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

module.exports = {
  checkBlackboardAssignments,
  checkBlackboardCalendarFeed,
  isIcsCalendar,
  parseIcsDate,
  parseBlackboardIcs,
  searchWeb
};
