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
const DEFAULT_TIMEOUT_MS = 15000;
const BT_THREAD_CONCURRENCY = 8;
const BT_MAX_THREADS = 50;
const BT_THREAD_TIMEOUT_MS = 8000;
const BT_OVERALL_TIMEOUT_MS = 60000;

let mpsCache = {
  timestamp: 0,
  data: null
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
  if (!sourceText) return '';

  const explicit = sourceText.match(/\b(?:algo|algorithm)\s*[:\-]\s*([a-z0-9+\/-][a-z0-9+\/-\s]{1,38})/i);
  if (explicit && explicit[1]) {
    const cleaned = explicit[1]
      .split(/[\r\n|;,]/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }

  for (const entry of ALGO_PATTERNS) {
    if (entry.regex.test(sourceText)) {
      return entry.label;
    }
  }

  return '';
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

  const tickerCandidates = extractTickerCandidates(coin && coin.name, coin && coin.firstPostText);
  for (const ticker of tickerCandidates) {
    if (lookup.symbolMap.has(ticker)) {
      return lookup.symbolMap.get(ticker);
    }
  }

  const cleanedName = cleanAnnouncementCoinName(coin && coin.name);
  const normalizedName = normalizeLookupText(cleanedName);
  if (normalizedName && lookup.nameMap.has(normalizedName)) {
    return lookup.nameMap.get(normalizedName);
  }

  return detectAlgorithmFromText(`${coin && coin.name ? coin.name : ''}\n${coin && coin.firstPostText ? coin.firstPostText : ''}`);
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

    return normalizedResults.map(coin => ({
      ...coin,
      algo: resolveCoinAlgorithm(coin, algoLookup)
    }));
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
    const sorted = rows
      .filter(row => row && row.name && row.page)
      .sort((a, b) => {
        const mca = Number(a.mc) || 0;
        const mcb = Number(b.mc) || 0;
        return mcb - mca;
      })
      .slice(0, limit)
      .map(row => ({
        name: row.name,
        symbol: row.symbol || '',
        algo: row.algo || '',
        page: row.page,
        pageUrl: `${MPS_HOME_URL}${row.page}`,
        price: row.pr,
        change7d: row.c7d,
        marketCap: row.mc,
        links: []
      }));

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

module.exports = { fetchNewPOWCoins, fetchMiningPoolStatsPOWCoins };
