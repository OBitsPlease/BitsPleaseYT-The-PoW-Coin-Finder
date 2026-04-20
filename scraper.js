const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const DEBUG_LOG = path.join(os.tmpdir(), 'pow-finder-debug.log');

function logDebug(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, msg + '\n');
  } catch (_) {
    // Avoid crashing data loading if logging is not writable.
  }
}

const ANNOUNCEMENT_URL = 'https://bitcointalk.org/index.php?board=159.0';
const MPS_HOME_URL = 'https://miningpoolstats.stream/';
const MPS_DATA_URL_REGEX = /https?:\/\/data\.miningpoolstats\.stream\/data\/coins_data\.js[^"'\s]*/i;
const MPS_CACHE_TTL_MS = 30 * 60 * 1000;
const CG_CACHE_TTL_MS   = 25 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const BT_THREAD_CONCURRENCY = 8;
const BT_MAX_THREADS = 50;
const BT_THREAD_TIMEOUT_MS = 8000;
const BT_OVERALL_TIMEOUT_MS = 60000;

let mpsCache = {
  timestamp: 0,
  data: null
};

let cgCache = {
  timestamp: 0,
  data: null   // Map: symbol.toLowerCase() → { change1h, change24h, change7d }
};

async function fetchTextWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBitcoinUsdPrice() {
  const priceSources = [
    async () => {
      const text = await fetchTextWithTimeout(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
        7000
      );
      const data = JSON.parse(text);
      return Number(data && data.bitcoin && data.bitcoin.usd) || 0;
    },
    async () => {
      const text = await fetchTextWithTimeout('https://api.coinbase.com/v2/prices/BTC-USD/spot', 7000);
      const data = JSON.parse(text);
      return Number(data && data.data && data.data.amount) || 0;
    },
    async () => {
      const text = await fetchTextWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', 7000);
      const data = JSON.parse(text);
      return Number(data && data.price) || 0;
    }
  ];

  for (const loadPrice of priceSources) {
    try {
      const price = await loadPrice();
      if (price > 0) return price;
    } catch (_) {
      // Try the next source.
    }
  }

  return 0;
}

function parseMiningPoolStatsPayload(dataText) {
  if (!dataText) throw new Error('MiningPoolStats returned empty payload');

  try {
    const parsed = JSON.parse(dataText);
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
  } catch (_) {
    // Fall through to JS payload parsing.
  }

  // coins_data.js is often JavaScript, e.g. "coinsData={...}".
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${dataText};this.__coinsData=(typeof coinsData!=="undefined"?coinsData:undefined);`, sandbox, { timeout: 2000 });
  const jsParsed = sandbox.__coinsData;
  if (jsParsed && Array.isArray(jsParsed.data)) return jsParsed.data;

  throw new Error('MiningPoolStats returned invalid coin list data');
}

async function runBatched(items, concurrency, fn) {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(fn));
  }
}

function getDate7DaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

async function extractLinksFromThread(threadUrl, fallbackDate, timeoutMs = BT_THREAD_TIMEOUT_MS) {
  try {
    const html = await fetchTextWithTimeout(threadUrl, timeoutMs);
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const links = { website: '', github: '', explorer: '', firstPostText: '', listingDate: '' };
    // Look for links and text in the first post
    const post = document.querySelector('.post');
    if (!post) return links;
    links.firstPostText = post.textContent || '';
    const anchors = post.querySelectorAll('a[href]');
    anchors.forEach(a => {
      const url = a.href;
      if (!links.website && /(official|project|coin|site)/i.test(url) && !/github|explorer/i.test(url)) links.website = url;
      if (!links.github && /github\.com\//i.test(url)) links.github = url;
      if (!links.explorer && /(explorer|blockchain|blocks)/i.test(url)) links.explorer = url;
    });
    // Use post header / list fallback dates only; avoid first-post body dates
    // because they often include historical references unrelated to listing time.
    const postHeader = post.closest('tr') ? post.closest('tr').querySelector('.smalltext') : null;
    let headerText = postHeader && postHeader.textContent.trim();
    let headerDateMatch = headerText && headerText.match(/(Today|Yesterday)|(\d{4}-\d{2}-\d{2})|((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4})|(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s*\d{4})|(\w+\s+\d{1,2},?\s*\d{4})/i);
    if (headerDateMatch) {
      links.listingDate = headerDateMatch[0];
    } else if (fallbackDate) {
      let fallbackDateMatch = fallbackDate.match(/(Today|Yesterday)|(\d{4}-\d{2}-\d{2})|((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s*\d{4})|(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s*\d{4})|(\w+\s+\d{1,2},?\s*\d{4})/i);
      links.listingDate = fallbackDateMatch ? fallbackDateMatch[0] : '';
    } else {
      links.listingDate = '';
    }
    return links;
  } catch (e) {
    return { website: '', github: '', explorer: '', firstPostText: '', listingDate: '' };
  }
}

const ALGO_PATTERNS = [
  { label: 'RandomX', regex: /\brandomx\b/i },
  { label: 'KawPow', regex: /\bkawpow\b/i },
  { label: 'GhostRider', regex: /\bghostrider\b/i },
  { label: 'VerusHash', regex: /\bverus\s*hash\b|\bverushash\b/i },
  { label: 'Etchash', regex: /\betchash\b/i },
  { label: 'Equihash', regex: /\bequihash\b/i },
  { label: 'Yescrypt', regex: /\byescrypt\b/i },
  { label: 'Yespower', regex: /\byespower\b/i },
  { label: 'Scrypt', regex: /\bscrypt\b/i },
  { label: 'X11', regex: /\bx11\b/i },
  { label: 'X16R', regex: /\bx16r\b/i },
  { label: 'X16Rv2', regex: /\bx16rv2\b/i },
  { label: 'Xevan', regex: /\bxevan\b/i },
  { label: 'Lyra2REv3', regex: /\blyra2\s*rev?3\b|\blyra2rev3\b/i },
  { label: 'Lyra2z', regex: /\blyra2z\b/i },
  { label: 'SHA-256d', regex: /\bsha\s*[- ]?256d\b|\bsha256d\b/i },
  { label: 'SHA-256', regex: /\bsha\s*[- ]?256\b|\bsha256\b/i },
  { label: 'Blake3', regex: /\bblake\s*3\b|\bblake3\b/i },
  { label: 'Blake2s', regex: /\bblake\s*2s\b|\bblake2s\b/i },
  { label: 'CryptoNight', regex: /\bcryptonight\b/i },
  { label: 'Argon2d', regex: /\bargon2d\b/i }
];

const SYMBOL_IGNORE = new Set(['ANN', 'RE', 'POW', 'POS', 'GPU', 'CPU', 'ASIC', 'NEW', 'COIN', 'TESTNET', 'MAINNET']);

function normalizeLookupText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[(re-)?ann\]/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAnnouncementCoinName(title) {
  return String(title || '')
    .replace(/\[(RE-)?ANN\]/ig, ' ')
    .replace(/\([^)]{1,16}\)/g, ' ')
    .replace(/\[[^\]]{1,16}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectAlgorithmFromText(text) {
  const sourceText = String(text || '');
  if (!sourceText) return { algo: '', source: 'unknown' };

  for (const entry of ALGO_PATTERNS) {
    if (entry.regex.test(sourceText)) {
      return { algo: entry.label, source: 'ann-pattern' };
    }
  }

  const explicit = sourceText.match(/\b(?:algo|algorithm)\s*[:\-]\s*([a-z0-9+\/-][a-z0-9+\/-\s]{1,38})/i);
  if (explicit && explicit[1]) {
    const cleaned = explicit[1]
      .split(/[\r\n|;,]/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) {
      for (const entry of ALGO_PATTERNS) {
        if (entry.regex.test(cleaned)) {
          return { algo: entry.label, source: 'ann-explicit' };
        }
      }

      // Keep explicit values only when they look like a short algorithm label.
      const looksLikeLabel = /^[a-z0-9+\/-]+(?:\s+[a-z0-9+\/-]+){0,2}$/i.test(cleaned);
      if (looksLikeLabel) {
        return { algo: cleaned, source: 'ann-explicit' };
      }
    }
  }

  return { algo: '', source: 'unknown' };
}

function extractTickerCandidates(title, firstPostText) {
  const candidates = [];
  const titleText = String(title || '');
  const postText = String(firstPostText || '');

  const pushCandidate = (value) => {
    const ticker = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
    if (!ticker || ticker.length < 2 || ticker.length > 10) return;
    if (SYMBOL_IGNORE.has(ticker)) return;
    if (!candidates.includes(ticker)) candidates.push(ticker);
  };

  const parenMatches = [...titleText.matchAll(/\(([A-Za-z0-9]{2,10})\)/g)];
  parenMatches.forEach(match => pushCandidate(match[1]));

  const bracketMatches = [...titleText.matchAll(/\[([A-Za-z0-9]{2,10})\]/g)];
  bracketMatches.forEach(match => pushCandidate(match[1]));

  const explicitSymbol = postText.match(/\b(?:ticker|symbol)\s*[:\-]\s*([A-Za-z0-9]{2,10})\b/i);
  if (explicitSymbol && explicitSymbol[1]) {
    pushCandidate(explicitSymbol[1]);
  }

  return candidates;
}

function buildMpsAlgoLookup(rows) {
  const nameMap = new Map();
  const symbolMap = new Map();

  (rows || []).forEach(row => {
    const algo = String(row && row.algo ? row.algo : '').trim();
    if (!algo) return;

    const normalizedName = normalizeLookupText(row.name || '');
    if (normalizedName && !nameMap.has(normalizedName)) {
      nameMap.set(normalizedName, algo);
    }

    const symbol = String(row.symbol || '').toUpperCase().trim();
    if (symbol && !symbolMap.has(symbol)) {
      symbolMap.set(symbol, algo);
    }
  });

  return { nameMap, symbolMap };
}

function resolveCoinAlgorithm(coin, algoLookup) {
  const lookup = algoLookup || { nameMap: new Map(), symbolMap: new Map() };

  const titleAndPost = `${coin && coin.name ? coin.name : ''}\n${coin && coin.firstPostText ? coin.firstPostText : ''}`;
  const fromAnnouncement = detectAlgorithmFromText(titleAndPost);
  if (fromAnnouncement.algo) {
    return fromAnnouncement;
  }

  const tickerCandidates = extractTickerCandidates(coin && coin.name, coin && coin.firstPostText);
  for (const ticker of tickerCandidates) {
    if (lookup.symbolMap.has(ticker)) {
      return { algo: lookup.symbolMap.get(ticker), source: 'mps-symbol' };
    }
  }

  const cleanedName = cleanAnnouncementCoinName(coin && coin.name);
  const normalizedName = normalizeLookupText(cleanedName);
  if (normalizedName && lookup.nameMap.has(normalizedName)) {
    return { algo: lookup.nameMap.get(normalizedName), source: 'mps-name' };
  }

  return { algo: '', source: 'unknown' };
}

async function fetchNewPOWCoins() {
    // Clear log at start when possible.
    try {
      fs.writeFileSync(DEBUG_LOG, '[DEBUG] fetchNewPOWCoins called\n');
    } catch (_) {
      // Ignore logging failures.
    }
  try {
    const html = await fetchTextWithTimeout(ANNOUNCEMENT_URL, 15000);
    logDebug('[DEBUG] First 20000 HTML chars: ' + html.slice(0, 20000));
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const coins = [];
    // Select all thread rows by looking for <tr> with a <span id^="msg_"> (any td class)
    const rows = Array.from(document.querySelectorAll('tr')).filter(row => {
      return row.querySelector('span[id^="msg_"] a');
    }).slice(0, BT_MAX_THREADS);
    const threadTasks = [];
    const includeKeywordRegex = /(\bpow\b|proof\s*of\s*work|mineable|mining|miner|\bcpu\b|\bgpu\b|\basic\b|phone|\[(RE-)?ANN\]|\bann\b)/i;
    const excludeKeywordRegex = /(\bpos\b|proof\s*of\s*stake|staking|staked|stake\s*coin)/i;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let foundAny = false;
    rows.forEach(row => {
      // Only include threads with [ANN] or [RE-ANN] in the title
      const subjectA = row.querySelector('span[id^="msg_"] a');
      const title = subjectA ? subjectA.textContent.trim() : '';
      if (!/\[(RE-)?ANN\]/i.test(title)) return;
      // Filter out sticky/announcement threads (look for sticky/lock icons)
      const hasSticky = row.querySelector('img[id^="stickyicon"]');
      const hasLock = row.querySelector('img[id^="lockicon"]');
      if (hasSticky || hasLock) return;

      const link = subjectA ? subjectA.getAttribute('href') : '';
      // Last post date
      const dateCell = row.querySelector('td.lastpostcol span.smalltext');
      let dateText = dateCell ? dateCell.textContent.trim() : '';
      // Debug log for every row
      if (title || dateText) {
        logDebug(`[DEBUG] Thread: '${title}' | Date: '${dateText}'`);
      }
      let isRecent = false;
      // Looser date check: 'Today', 'Yesterday', or any string with a month/day or year
      if (/today|yesterday|\d{1,2}\s+\w+|\w+\s+\d{1,2}|\d{4}/i.test(dateText)) {
        isRecent = true;
      }
      // Try to parse date as fallback
      let parsed = Date.parse(dateText.replace(/\s+at\s+/, ' '));
      if (!isNaN(parsed)) {
        const postDate = new Date(parsed);
        if (postDate >= weekAgo) isRecent = true;
      }
      // Check keywords in title or first post, while excluding PoS/staking terms.
      let hasKeyword = false;
      const titleText = title || '';
      if (excludeKeywordRegex.test(titleText)) return;
      if (titleText && includeKeywordRegex.test(titleText)) {
        hasKeyword = true;
      }
      // If not in title, try first post content
      if (!hasKeyword && link) {
        const threadUrl = link;
        threadTasks.push(async () => {
          const links = await extractLinksFromThread(threadUrl, dateText);
          let found = false;
          const firstPostText = links && links.firstPostText ? links.firstPostText : '';
          if (excludeKeywordRegex.test(firstPostText)) return null;
          if (firstPostText && includeKeywordRegex.test(firstPostText)) found = true;
          if (isRecent && found) {
            foundAny = true;
            return {
              name: title,
              bitcointalk: threadUrl,
              date: links.listingDate || dateText,
              ...links
            };
          }
          return null;
        });
        return;
      }
      if (hasKeyword && isRecent) {
        const threadUrl = link;
        foundAny = true;
        threadTasks.push(async () => {
          const links = await extractLinksFromThread(threadUrl, dateText);
          return {
            name: title,
            bitcointalk: threadUrl,
            date: links.listingDate || dateText,
            ...links
          };
        });
      }
    });

    const results = [];
    const batchPromise = runBatched(threadTasks, BT_THREAD_CONCURRENCY, async (task) => {
      try {
        const value = await task();
        if (value) results.push(value);
      } catch (_) {
        // Skip individual thread failures.
      }
    });
    // Cap total scan time so the UI never appears frozen.
    const overallTimeout = new Promise(resolve => setTimeout(resolve, BT_OVERALL_TIMEOUT_MS));
    await Promise.race([batchPromise, overallTimeout]);

    const normalizedResults = results.filter(Boolean);
    if (!normalizedResults.length) {
      return normalizedResults;
    }

    let algoLookup = { nameMap: new Map(), symbolMap: new Map() };
    try {
      const mpsRows = await fetchMiningPoolStatsCoinRows();
      algoLookup = buildMpsAlgoLookup(mpsRows);
    } catch (_) {
      // Keep loading new listings even if MiningPoolStats is unavailable.
    }

    return normalizedResults.map(coin => {
      const algoInfo = resolveCoinAlgorithm(coin, algoLookup);
      return {
        ...coin,
        algo: algoInfo.algo || '',
        algoSource: algoInfo.source || 'unknown'
      };
    });
  } catch (err) {
    return { error: err.message };
  }
}

function cleanLabelText(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
}

function dedupeLinks(linkItems) {
  const seen = new Set();
  return linkItems.filter(item => {
    const key = `${item.label}|${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractMiningPoolStatsLinks(pageUrl, symbol) {
  try {
    const html = await fetchTextWithTimeout(pageUrl, 12000);
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const allBoxes = Array.from(document.querySelectorAll('.box'));
    const linksBox = allBoxes.find(box => {
      const title = cleanLabelText(box.querySelector('.box-title') ? box.querySelector('.box-title').textContent : '');
      if (!title) return false;
      if (/links$/i.test(title)) return true;
      if (symbol && new RegExp(`^${symbol}\\s+Links$`, 'i').test(title)) return true;
      return false;
    });

    const sourceBox = allBoxes.find(box => {
      const title = cleanLabelText(box.querySelector('.box-title') ? box.querySelector('.box-title').textContent : '');
      if (!title) return false;
      if (/source$/i.test(title)) return true;
      if (symbol && new RegExp(`^${symbol}\\s+Source$`, 'i').test(title)) return true;
      return false;
    });

    const linkItems = [];

    if (linksBox) {
      const rows = Array.from(linksBox.querySelectorAll('tr'));
      rows.forEach(row => {
        const tds = row.querySelectorAll('td');
        if (tds.length < 2) return;
        const label = cleanLabelText(tds[0].textContent || 'Link');
        const anchors = Array.from(tds[1].querySelectorAll('a[href^="http"]'));
        anchors.forEach(anchor => {
          linkItems.push({
            label,
            text: cleanLabelText(anchor.textContent || label || 'Open'),
            url: anchor.href
          });
        });
      });
    }

    if (sourceBox) {
      const sourceAnchors = Array.from(sourceBox.querySelectorAll('a[href^="http"]'));
      sourceAnchors.forEach(anchor => {
        linkItems.push({
          label: 'Source',
          text: cleanLabelText(anchor.textContent || 'Source'),
          url: anchor.href
        });
      });
    }

    return dedupeLinks(linkItems);
  } catch (e) {
    return [];
  }
}

async function fetchCoinGeckoChanges() {
  const now = Date.now();
  if (cgCache.data && now - cgCache.timestamp < CG_CACHE_TTL_MS) {
    return cgCache.data;
  }
  const lookup = new Map();
  try {
    for (let page = 1; page <= 2; page++) {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&price_change_percentage=1h,24h,7d`;
      const text = await fetchTextWithTimeout(url, 12000);
      const coins = JSON.parse(text);
      if (Array.isArray(coins)) {
        for (const c of coins) {
          if (!c.symbol) continue;
          const key = c.symbol.toLowerCase();
          if (!lookup.has(key)) {
            lookup.set(key, {
              change1h:  typeof c.price_change_percentage_1h_in_currency  === 'number' ? c.price_change_percentage_1h_in_currency  : null,
              change24h: typeof c.price_change_percentage_24h_in_currency === 'number' ? c.price_change_percentage_24h_in_currency : null,
              change7d:  typeof c.price_change_percentage_7d_in_currency  === 'number' ? c.price_change_percentage_7d_in_currency  : null,
            });
          }
        }
      }
    }
  } catch (_) {
    // Return whatever we have; on total failure return empty map
  }
  cgCache = { timestamp: Date.now(), data: lookup };
  return lookup;
}

async function fetchMiningPoolStatsCoinRows() {
  // Try the direct data URL first (pattern is stable; timestamp just busts cache).
  const directUrl = `https://data.miningpoolstats.stream/data/coins_data.js?t=${Math.floor(Date.now() / 1000)}`;
  try {
    const dataText = await fetchTextWithTimeout(directUrl, 15000);
    return parseMiningPoolStatsPayload(dataText);
  } catch (_) {
    // Direct fetch failed — fall back to scraping the homepage for the URL.
  }

  const homeHtml = await fetchTextWithTimeout(MPS_HOME_URL, 15000);
  const dataUrlMatch = homeHtml.match(MPS_DATA_URL_REGEX);
  if (!dataUrlMatch) {
    throw new Error('MiningPoolStats data feed URL not found');
  }

  const dataText = await fetchTextWithTimeout(dataUrlMatch[0], 15000);
  return parseMiningPoolStatsPayload(dataText);
}

async function fetchMiningPoolStatsPOWCoins(options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : Number.MAX_SAFE_INTEGER;
  const now = Date.now();
  if (mpsCache.data && now - mpsCache.timestamp < MPS_CACHE_TTL_MS) {
    return mpsCache.data;
  }

  try {
    const rows = await fetchMiningPoolStatsCoinRows();
    const cgData = await fetchCoinGeckoChanges();
    const sorted = rows
      .filter(row => row && row.name && row.page)
      .sort((a, b) => {
        const mca = Number(a.mc) || 0;
        const mcb = Number(b.mc) || 0;
        return mcb - mca;
      })
      .slice(0, limit)
      .map(row => {
        // Compute difficulty 7-day % change from the diff7 array (oldest→newest).
        let diff7dChange = null;
        if (Array.isArray(row.diff7) && row.diff7.length >= 2) {
          const first = Number(row.diff7[0]);
          const last  = Number(row.diff7[row.diff7.length - 1]);
          if (first > 0) diff7dChange = ((last - first) / first) * 100;
        }
        const cgEntry = cgData.get((row.symbol || '').toLowerCase()) || {};
        return {
          name: row.name,
          symbol: row.symbol || '',
          algo: row.algo || '',
          page: row.page,
          pageUrl: `${MPS_HOME_URL}${row.page}`,
          price: row.pr,
          change1h:  cgEntry.change1h  != null ? cgEntry.change1h  : null,
          change24h: cgEntry.change24h != null ? cgEntry.change24h : null,
          change7d:  row.c7d          != null ? row.c7d           : (cgEntry.change7d != null ? cgEntry.change7d : null),
          marketCap: row.mc,
          volume24h: row.v24 || 0,
          emissions24h: (row.e24 || 0) * (row.pr || 0),
          networkHashrate: row.hashrate || 0,
          poolHashrate: row.ph || 0,
          diff7dChange,
          links: []
        };
      });

    const concurrency = 8;
    for (let i = 0; i < sorted.length; i += concurrency) {
      const batch = sorted.slice(i, i + concurrency);
      await Promise.all(batch.map(async coin => {
        coin.links = await extractMiningPoolStatsLinks(coin.pageUrl, coin.symbol);
      }));
    }

    mpsCache = {
      timestamp: Date.now(),
      data: sorted
    };
    return sorted;
  } catch (err) {
    return { error: err.message };
  }
}

const WTM_ALGO_MATCHERS = {
  kawpow: [ /\bkawpow\b/i ],
  eth: [ /\bethash\b/i ],
  etc: [ /\betchash\b/i ],
  erg: [ /\bautolykos\b/i ],
  firo: [ /\bfiropow\b/i ],
  cfx: [ /\boctopus\b/i ],
  zec: [ /\bzhash\b/i, /\bequihash\b/i ],
  alph: [ /\bblake3\b/i ],
  xmr: [ /\brandomx\b/i ],
  rtm: [ /\bghostrider\b/i ],
  sha256: [ /\bsha[- ]?256\b/i ],
  ltc: [ /\bscrypt\b/i ]
};

const WTM_QUERY_CONFIG = {
  kawpow: { endpoint: 'coins', toggle: 'kpw', hrField: 'kpw_hr', powerField: 'kpw_p' },
  eth: { endpoint: 'coins', toggle: 'eth', hrField: 'eth_hr', powerField: 'eth_p' },
  etc: { endpoint: 'coins', toggle: 'e4g', hrField: 'e4g_hr', powerField: 'e4g_p' },
  erg: { endpoint: 'coins', toggle: 'al', hrField: 'al_hr', powerField: 'al_p' },
  firo: { endpoint: 'coins', toggle: 'fpw', hrField: 'fpw_hr', powerField: 'fpw_p' },
  zec: { endpoint: 'coins', toggle: 'zh', hrField: 'zh_hr', powerField: 'zh_p' },
  alph: { endpoint: 'coins', toggle: 'b3', hrField: 'b3_hr', powerField: 'b3_p' },
  xmr: { endpoint: 'cpu', toggle: 'rmx', hrField: 'rmx_hr', powerField: 'rmx_p' },
  rtm: { endpoint: 'cpu', toggle: 'gr', hrField: 'gr_hr', powerField: 'gr_p' },
  sha256: { endpoint: 'asic', toggle: 'sha256f', hrField: 'sha256_hr', powerField: 'sha256_p' },
  ltc: { endpoint: 'asic', toggle: 'scryptf', hrField: 'scrypt_hash_rate', powerField: 'scrypt_power' }
};

// Fallback data when WhatToMine blocks parameterized requests.
const DEMO_COINS = {
  kawpow: [
    { name: 'Ravencoin', tag: 'RVN', algorithm: 'KawPow', estimatedRewards: 1256, estimatedRewards24: 1256, btcRevenue: 0.00000012, btcRevenue24: 0.00000012, blockReward: 2500, blockTime: 60 },
    { name: 'Neoxa', tag: 'NEOX', algorithm: 'KawPow', estimatedRewards: 485, estimatedRewards24: 485, btcRevenue: 0.00000008, btcRevenue24: 0.00000008, blockReward: 1024, blockTime: 64 }
  ],
  eth: [
    { name: 'Ethereumpow', tag: 'ETHW', algorithm: 'Ethash', estimatedRewards: 0.42, estimatedRewards24: 0.42, btcRevenue: 0.00000156, btcRevenue24: 0.00000156, blockReward: 2, blockTime: 12 }
  ],
  etc: [
    { name: 'Ethereum Classic', tag: 'ETC', algorithm: 'Etchash', estimatedRewards: 0.063, estimatedRewards24: 0.063, btcRevenue: 0.00000072, btcRevenue24: 0.00000072, blockReward: 2.048, blockTime: 13 }
  ],
  erg: [
    { name: 'Ergo', tag: 'ERG', algorithm: 'Autolykos', estimatedRewards: 0.89, estimatedRewards24: 0.89, btcRevenue: 0.00000057, btcRevenue24: 0.00000057, blockReward: 18, blockTime: 120 }
  ],
  firo: [
    { name: 'Firo', tag: 'FIRO', algorithm: 'FiroPow', estimatedRewards: 0.31, estimatedRewards24: 0.31, btcRevenue: 0.00000082, btcRevenue24: 0.00000082, blockReward: 6.25, blockTime: 300 }
  ],
  cfx: [
    { name: 'Conflux', tag: 'CFX', algorithm: 'Octopus', estimatedRewards: 2.45, estimatedRewards24: 2.45, btcRevenue: 0.00000064, btcRevenue24: 0.00000064, blockReward: 2, blockTime: 30 }
  ],
  zec: [
    { name: 'Zcash', tag: 'ZEC', algorithm: 'Equihash', estimatedRewards: 0.014, estimatedRewards24: 0.014, btcRevenue: 0.00000041, btcRevenue24: 0.00000041, blockReward: 1.5625, blockTime: 75 }
  ],
  alph: [
    { name: 'Alephium', tag: 'ALPH', algorithm: 'Blake3', estimatedRewards: 0.56, estimatedRewards24: 0.56, btcRevenue: 0.00000020, btcRevenue24: 0.00000020, blockReward: 0.5, blockTime: 64 }
  ],
  xmr: [
    { name: 'Monero', tag: 'XMR', algorithm: 'RandomX', estimatedRewards: 0.0018, estimatedRewards24: 0.0018, btcRevenue: 0.00000004, btcRevenue24: 0.00000004, blockReward: 0.6, blockTime: 120 }
  ],
  rtm: [
    { name: 'Raptoreum', tag: 'RTM', algorithm: 'GhostRider', estimatedRewards: 3.1, estimatedRewards24: 3.1, btcRevenue: 0.00000005, btcRevenue24: 0.00000005, blockReward: 1250, blockTime: 60 }
  ],
  sha256: [
    { name: 'Bitcoin Cash', tag: 'BCH', algorithm: 'SHA-256', estimatedRewards: 0.00001, estimatedRewards24: 0.00001, btcRevenue: 0.00000210, btcRevenue24: 0.00000210, blockReward: 3.125, blockTime: 600 }
  ],
  ltc: [
    { name: 'Litecoin', tag: 'LTC', algorithm: 'Scrypt', estimatedRewards: 0.025, estimatedRewards24: 0.025, btcRevenue: 0.00000014, btcRevenue24: 0.00000014, blockReward: 6.25, blockTime: 600 }
  ]
};

function mapWtmCoin(name, c) {
  return {
    name,
    tag: c.tag || '',
    algorithm: c.algorithm || '',
    estimatedRewards: parseFloat(c.estimated_rewards) || 0,
    estimatedRewards24: parseFloat(c.estimated_rewards24) || 0,
    btcRevenue: parseFloat(c.btc_revenue) || 0,
    btcRevenue24: parseFloat(c.btc_revenue24) || 0,
    exchangeRate: parseFloat(c.exchange_rate) || 0,
    profitability: parseFloat(c.profitability) || 0,
    blockReward: parseFloat(c.block_reward) || 0,
    blockTime: parseFloat(c.block_time) || 0,
    nethash: c.nethash || 0,
    status: c.status || '',
    listed: !!c.listed
  };
}

function filterCoinsByAlgo(coins, algoKey) {
  const matchers = WTM_ALGO_MATCHERS[algoKey] || [];
  if (!matchers.length) return [];
  return coins.filter((coin) => {
    const haystack = `${coin.algorithm || ''} ${coin.name || ''} ${coin.tag || ''}`;
    return matchers.some((matcher) => matcher.test(haystack));
  });
}

async function fetchWhatToMineProfitability(algoInputs) {
  // algoInputs: [{ key: string, hrValue: number, powerWatts: number }]
  // hrValue must already be in the unit WhatToMine expects for that algo key.
  const enabled = (algoInputs || []).filter(a => a && a.hrValue > 0);
  if (!enabled.length) return { coins: [], btcPrice: 0 };

  let coinsData = [];
  let btcPrice = 0;
  const endpointQueryParts = { coins: [], cpu: [], asic: [] };
  const selectedKeys = enabled.map((item) => String(item.key || '').toLowerCase());

  enabled.forEach(({ key, hrValue, powerWatts }) => {
    const normalizedKey = String(key || '').toLowerCase();
    const cfg = WTM_QUERY_CONFIG[normalizedKey];
    if (!cfg || !endpointQueryParts[cfg.endpoint]) return;
    endpointQueryParts[cfg.endpoint].push(`${encodeURIComponent(cfg.toggle)}=true`);
    endpointQueryParts[cfg.endpoint].push(`factor%5B${cfg.hrField}%5D=${encodeURIComponent(hrValue)}`);
    endpointQueryParts[cfg.endpoint].push(`factor%5B${cfg.powerField}%5D=${encodeURIComponent(powerWatts || 0)}`);
  });

  const rawCoinsByKey = new Map();

  async function fetchEndpoint(endpointName, baseUrl, keysForEndpoint) {
    if (!keysForEndpoint.length) return;
    const parts = endpointQueryParts[endpointName];
    if (!parts.length) return;
    const text = await fetchTextWithTimeout(`${baseUrl}?${parts.join('&')}`, 15000);
    const parsed = JSON.parse(text);
    const mapped = parsed && parsed.coins
      ? Object.entries(parsed.coins)
          .filter(([, c]) => c && !c.lagging && (parseFloat(c.btc_revenue24 || c.btc_revenue) || 0) > 0)
          .map(([name, c]) => mapWtmCoin(name, c))
      : [];

    keysForEndpoint.forEach((key) => {
      rawCoinsByKey.set(key, filterCoinsByAlgo(mapped, key));
    });
  }

  try {
    await fetchEndpoint('coins', 'https://whattomine.com/coins.json', selectedKeys.filter((key) => WTM_QUERY_CONFIG[key] && WTM_QUERY_CONFIG[key].endpoint === 'coins'));
    await fetchEndpoint('cpu', 'https://whattomine.com/cpu.json', selectedKeys.filter((key) => WTM_QUERY_CONFIG[key] && WTM_QUERY_CONFIG[key].endpoint === 'cpu'));
    await fetchEndpoint('asic', 'https://whattomine.com/asic.json', selectedKeys.filter((key) => WTM_QUERY_CONFIG[key] && WTM_QUERY_CONFIG[key].endpoint === 'asic'));
  } catch (_) {
    // Any endpoint failure will fall back per algorithm below.
  }

  selectedKeys.forEach((key) => {
    const matchedCoins = rawCoinsByKey.get(key) || [];
    if (matchedCoins.length) {
      coinsData = coinsData.concat(matchedCoins);
      return;
    }
    if (DEMO_COINS[key]) {
      coinsData = coinsData.concat(DEMO_COINS[key]);
    }
  });

  const seen = new Set();
  coinsData = coinsData.filter((coin) => {
    const id = `${String(coin.name || '').toLowerCase()}|${String(coin.algorithm || '').toLowerCase()}|${String(coin.tag || '').toLowerCase()}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => (b.btcRevenue24 || b.btcRevenue || 0) - (a.btcRevenue24 || a.btcRevenue || 0));

  btcPrice = await fetchBitcoinUsdPrice();

  return { coins: coinsData, btcPrice };
}

// Cache for calendar data (15 min TTL)
let calendarCache = { timestamp: 0, data: null };
const CAL_CACHE_TTL_MS = 15 * 60 * 1000;

function parseCalendarEvents(boxBody) {
  const events = [];
  if (!boxBody) return events;
  const items = boxBody.querySelectorAll('.box-event');
  items.forEach(item => {
    try {
      // Days countdown / days-ago number
      const iconSpan = item.querySelector('.info-box-icon');
      const daysSpan = iconSpan ? iconSpan.querySelector('span') : null;
      const daysText = daysSpan ? daysSpan.textContent.replace(/Days?/i, '').trim() : '';
      const days = parseInt(daysText, 10);

      // Date string (e.g. "2026-04-26")
      const dateEl = iconSpan ? iconSpan.querySelector('.info-box-text') : null;
      const date = dateEl ? dateEl.textContent.trim() : '';

      // Event type label
      const labelEl = item.querySelector('small.label');
      const eventType = labelEl ? labelEl.textContent.trim() : '';

      // Coin icon
      const imgEl = item.querySelector('img');
      const iconSrc = imgEl ? (imgEl.getAttribute('data-src') || '') : '';
      const iconUrl = iconSrc ? `https://miningpoolstats.stream/${iconSrc}` : '';
      const coinAlt = imgEl ? (imgEl.getAttribute('alt') || '') : '';

      // Coin link
      const linkEl = item.querySelector('a[href]');
      const coinHref = linkEl ? (linkEl.getAttribute('href') || '') : '';
      const coinUrl = coinHref ? `https://miningpoolstats.stream/${coinHref}` : '';
      const fullName = linkEl ? linkEl.textContent.trim() : coinAlt;
      // Parse "CoinName (SYMBOL)"
      const nameMatch = fullName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      const name = nameMatch ? nameMatch[1].trim() : fullName;
      const symbol = nameMatch ? nameMatch[2].trim() : '';
      const page = coinHref.replace(/^\//, '');

      // Block line
      const blockDivs = item.querySelectorAll('div');
      let blockInfo = '';
      blockDivs.forEach(d => {
        if (/block\s*:/i.test(d.textContent) && d.children.length === 0) {
          blockInfo = d.textContent.trim();
        }
      });

      // Description (last span in info-box-content that is a direct child)
      const contentEl = item.querySelector('.info-box-content');
      let description = '';
      if (contentEl) {
        const spans = contentEl.querySelectorAll(':scope > span:not(.pull-right-container)');
        if (spans.length) description = spans[spans.length - 1].textContent.trim();
      }

      events.push({ days, date, eventType, name, symbol, iconUrl, coinUrl, page, blockInfo, description });
    } catch (_) {
      // Skip malformed items
    }
  });
  return events;
}

async function fetchCalendarEvents() {
  const now = Date.now();
  if (calendarCache.data && now - calendarCache.timestamp < CAL_CACHE_TTL_MS) {
    return calendarCache.data;
  }

  try {
    const html = await fetchTextWithTimeout('https://miningpoolstats.stream/calendar', 15000);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const boxBodies = doc.querySelectorAll('.box-body');
    const upcoming = parseCalendarEvents(boxBodies[0] || null);
    const past = parseCalendarEvents(boxBodies[1] || null);

    const result = { upcoming, past };
    calendarCache = { timestamp: Date.now(), data: result };
    return result;
  } catch (err) {
    return { error: err.message, upcoming: [], past: [] };
  }
}

module.exports = { fetchNewPOWCoins, fetchMiningPoolStatsPOWCoins, fetchWhatToMineProfitability, fetchCalendarEvents };
