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
const MPS_DATA_URL_REGEX = /https:\/\/data\.miningpoolstats\.stream\/data\/coins_data\.js\?t=\d+/i;
const MPS_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const BT_THREAD_CONCURRENCY = 6;
const BT_MAX_THREADS = 90;

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

async function extractLinksFromThread(threadUrl, fallbackDate) {
  try {
    const html = await fetchTextWithTimeout(threadUrl, 12000);
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
    await runBatched(threadTasks, BT_THREAD_CONCURRENCY, async (task) => {
      try {
        const value = await task();
        if (value) results.push(value);
      } catch (_) {
        // Skip individual thread failures.
      }
    });

    // Remove nulls (from threads that didn't match in first post)
    return results.filter(Boolean);
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
