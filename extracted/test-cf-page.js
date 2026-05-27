const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  console.log('Starting...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.goto('https://hc.support-259bets10.com/hc/tr', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  
  // Sayfa içeriğini kontrol et
  const html = await page.content();
  
  console.log('\n=== PAGE CHECK ===');
  console.log('Has Turnstile:', html.includes('turnstile') || html.includes('cf-turnstile'));
  console.log('Has Challenge:', html.includes('challenge'));
  console.log('Has cf_clearance form:', html.includes('cf_clearance'));
  console.log('Page title:', await page.title());
  
  // Sitekey bul
  const sitekey = html.match(/sitekey['":\s]+['"]([^'"]+)['"]/i);
  if (sitekey) {
    console.log('Turnstile Sitekey:', sitekey[1]);
  }
  
  // Ray ID bul
  const ray = html.match(/ray[_-]?id['":\s]+['"]([^'"]+)['"]/i);
  if (ray) {
    console.log('CF Ray ID:', ray[1]);
  }
  
  await browser.close();
  console.log('\nDone');
})();
