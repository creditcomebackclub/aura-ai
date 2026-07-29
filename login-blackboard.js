const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const userDataDir = path.join(__dirname, '.browser_data');
  const loginUrl = 'https://login.phoenix.edu/';

  console.log('=================================================');
  console.log('    AURA: INTERACTIVE BLACKBOARD LOGIN SCRIPT    ');
  console.log('=================================================');
  console.log(`Session data will be saved to: ${userDataDir}\n`);
  console.log('INSTRUCTIONS:');
  console.log('1. A Chrome window will open automatically.');
  console.log('2. Log into your University of Phoenix account normally.');
  console.log('3. Complete your Two-Factor Authentication (Email/SMS).');
  console.log('4. Check the "Remember Me" box if you see one.');
  console.log('5. Once you are successfully on the main dashboard, CLOSE the Chrome window.');
  console.log('-------------------------------------------------\n');

  try {
    const browser = await puppeteer.launch({
      headless: false, // Visible to the user!
      userDataDir: userDataDir,
      defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--start-maximized',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const page = await browser.newPage();
    await page.goto(loginUrl);

    // Keep the Node script running until the user manually closes the browser window
    browser.on('disconnected', () => {
      console.log('\n[SUCCESS] Browser closed! Your secure session has been saved.');
      console.log('AURA will now use this session to safely scrape your assignments in the background without needing your password or 2FA codes.');
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to launch browser:', error);
  }
})();
