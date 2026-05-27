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
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  
  console.log('Page loaded:', await page.title());
  
  // TÜM cookie'leri al
  const cookies = await page.cookies();
  
  console.log('\n=== ALL COOKIES ===');
  cookies.forEach(c => {
    console.log(`${c.name}: ${c.value.substring(0, 50)}...`);
  });
  
  // cf_clearance var mı?
  const cf = cookies.find(c => c.name === 'cf_clearance');
  if (cf) {
    console.log('\n✅ CF CLEARANCE FOUND!');
  } else {
    console.log('\n⚠️ No cf_clearance, but page loaded - maybe not needed?');
  }
  
  // Cookie string oluştur
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log('\n=== COOKIE STRING ===');
  console.log(cookieStr.substring(0, 200) + '...');
  
  await browser.close();
})();
