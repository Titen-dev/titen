// Deterministic URL / domain heuristics for Scam Check. No network here.

// Common two-level public suffixes, enough to find the "registrable" domain without a full PSL.
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.id', 'or.id', 'go.id',
  'ac.id', 'web.id', 'my.id', 'co.in', 'net.in', 'org.in', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'com.ar',
  'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.tr', 'com.cn', 'com.hk', 'com.tw', 'co.kr', 'co.za', 'com.ng',
  'com.pk', 'com.bd', 'com.eg', 'com.sa', 'co.th', 'in.th',
]);

export const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rebrand.ly', 'ow.ly', 's.id', 'shorturl.at',
  'rb.gy', 'tiny.cc', 'buff.ly', 'lnkd.in', 'v.gd', 't.ly', 'bl.ink', 'short.io', 'qrco.de', 'linktr.ee', 'wa.link',
]);

export const RISKY_TLDS = new Set([
  'zip', 'mov', 'xyz', 'top', 'click', 'icu', 'buzz', 'rest', 'support', 'live', 'cam', 'quest', 'cfd', 'sbs',
  'lol', 'monster', 'shop', 'online', 'site', 'website', 'store', 'fun', 'loan', 'win', 'work', 'gq', 'tk', 'ml',
  'cf', 'ga', 'country', 'kim', 'men', 'bid', 'review', 'party', 'trade', 'date', 'racing', 'stream',
]);

// Brands often impersonated, with their real registrable domains.
export const BRANDS = {
  paypal: ['paypal.com', 'paypal.me'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.in', 'amazon.co.jp', 'amazon.ca', 'amazon.com.au', 'amazon.fr', 'amazon.es', 'amazon.it', 'amazon.com.br', 'amazon.sg'],
  apple: ['apple.com', 'icloud.com'],
  icloud: ['icloud.com'],
  google: ['google.com', 'gmail.com', 'youtube.com', 'goo.gl'],
  microsoft: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'microsoftonline.com'],
  outlook: ['outlook.com', 'live.com'],
  netflix: ['netflix.com'],
  facebook: ['facebook.com', 'fb.com', 'meta.com'],
  instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net', 'wa.me'],
  telegram: ['telegram.org', 't.me'],
  binance: ['binance.com'],
  coinbase: ['coinbase.com'],
  metamask: ['metamask.io'],
  dhl: ['dhl.com', 'dhl.de'],
  fedex: ['fedex.com'],
  ups: ['ups.com'],
  usps: ['usps.com'],
  royalmail: ['royalmail.com'],
  chase: ['chase.com'],
  wellsfargo: ['wellsfargo.com'],
  bankofamerica: ['bankofamerica.com'],
  hsbc: ['hsbc.com', 'hsbc.co.uk'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  roblox: ['roblox.com'],
  discord: ['discord.com', 'discord.gg'],
  spotify: ['spotify.com'],
  shopee: ['shopee.com', 'shopee.co.id', 'shopee.sg', 'shopee.ph', 'shopee.com.my', 'shopee.vn', 'shopee.co.th'],
  tokopedia: ['tokopedia.com'],
  irs: ['irs.gov'],
};

const BAIT_WORDS = ['login', 'secure', 'verify', 'account', 'support', 'help', 'service', 'update', 'wallet', 'pay', 'bonus', 'gift', 'official', 'online', 'center', 'app', 'id', 'auth', 'signin', 'billing', 'refund', 'delivery', 'track'];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'`)\]]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>"'`)\]]*)?)/gi;
const PHONE_RE = /(?:\+|00)\d[\d\s().-]{7,17}\d|\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g;
const FILE_EXT = /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|txt|zip|exe|apk)$/i;

/** Find URLs/bare domains in free text. Returns normalized absolute URLs (deduped). */
export function extractUrls(text = '') {
  const out = new Set();
  const src = String(text);
  for (const m of src.matchAll(URL_RE)) {
    if (/[@\w.-]/.test(src[m.index - 1] || '')) continue; // part of an email address or a longer token
    let raw = m[1].replace(/[.,;:!?]+$/, '');
    if (/^[^/]*@/.test(raw)) continue; // email address, not a link
    const looksBare = !/^https?:\/\//i.test(raw);
    if (looksBare && FILE_EXT.test(raw) && !raw.includes('/')) continue; // "photo.png"
    if (looksBare) raw = `https://${raw}`; // bare domains: don't invent an "http" red flag
    try {
      const u = new URL(raw);
      if (!u.hostname.includes('.')) continue;
      out.add(u.toString());
    } catch {
      /* skip */
    }
  }
  return [...out];
}

export function extractPhones(text = '') {
  return [...new Set((String(text).match(PHONE_RE) || []).map((p) => p.replace(/[\s().-]/g, '')))].filter((p) => p.replace(/\D/g, '').length >= 8);
}

export function registrableDomain(hostname = '') {
  const parts = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// Undo common character tricks: paypa1 → paypal, amaz0n → amazon, rn → m, vv → w.
function deconfuse(s) {
  return s
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1|!]/g, 'l')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a');
}

/** Which brand (if any) a domain pretends to be. Returns { brand, reason } or null. */
export function detectImpersonation(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const reg = registrableDomain(host);
  const label = reg.split('.')[0];
  const isOfficial = (brand) => BRANDS[brand].some((d) => reg === d);

  for (const brand of Object.keys(BRANDS)) {
    if (isOfficial(brand)) return null; // real brand domain
  }
  const tokens = label.split('-').map(deconfuse);
  const joined = deconfuse(label.replace(/-/g, ''));
  for (const brand of Object.keys(BRANDS)) {
    if (label !== brand && deconfuse(label) === brand) return { brand, reason: `"${reg}" imitates ${brand} with look-alike characters` };
    // Brand as a whole word (paypal-login.com, dhl-delivery.net) or glued to a bait word (paypalsecure.com).
    const glued = BAIT_WORDS.some((w) => joined === brand + w || joined === w + brand);
    if (tokens.includes(brand) || glued) return { brand, reason: `"${reg}" uses the name ${brand} but is not an official ${brand} domain` };
    if (brand.length >= 5 && Math.abs(label.length - brand.length) <= 2 && levenshtein(deconfuse(label), brand) <= 1) {
      return { brand, reason: `"${reg}" is one letter away from ${brand}` };
    }
    // Brand used as a subdomain of something else: paypal.com.secure-login.xyz
    if (host !== reg && host.split('.').slice(0, -reg.split('.').length).some((p) => deconfuse(p) === brand)) {
      return { brand, reason: `"${host}" puts ${brand} in a subdomain of an unrelated site (${reg})` };
    }
  }
  return null;
}

/** All offline red flags for one URL. */
export function analyzeUrl(urlString) {
  const flags = [];
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return { url: urlString, domain: null, flags: ['Malformed link'] };
  }
  const host = u.hostname.toLowerCase();
  const domain = registrableDomain(host);
  const tld = domain.split('.').pop();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) flags.push('Uses a raw IP address instead of a domain name');
  if (host.split('.').some((p) => p.startsWith('xn--'))) flags.push('Uses punycode (international characters that can mimic other letters)');
  if (SHORTENERS.has(domain) || SHORTENERS.has(host)) flags.push('Link shortener hides the real destination');
  if (RISKY_TLDS.has(tld)) flags.push(`Ending ".${tld}" is cheap and often used for scams`);
  if (u.username || u.password || urlString.includes('@')) flags.push('Contains "@", which can hide the real destination');
  if (host.split('.').length >= 5) flags.push('Unusually many subdomains');
  if (u.protocol === 'http:') flags.push('Not using HTTPS');
  if ((host.match(/-/g) || []).length >= 3) flags.push('Many hyphens in the domain name');
  if (/(login|verify|secure|account|update|wallet|claim|bonus|gift|prize|refund|support|unlock|suspend)/i.test(host) && !Object.values(BRANDS).flat().includes(domain)) {
    flags.push('Domain uses bait words like login / verify / claim');
  }
  const imp = detectImpersonation(host);
  if (imp) flags.push(`Possible impersonation: ${imp.reason}`);

  return { url: urlString, domain, impersonates: imp?.brand || null, flags };
}
