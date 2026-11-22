/**
 * Checks every store link in data/links.json and records the result.
 *
 *   node scripts/check-links.mts
 *
 * For each link it loads the direct URL (and the affiliate URL, if any), following
 * redirects, and decides:
 *   ok      the page loaded and is still the same product (product ID in the final URL or page)
 *   broken  404/410, or the store redirected somewhere that isn't this product
 *   unknown the store blocked the check (403/429/503, captcha) or it timed out
 *
 * "ok" refreshes verifiedAt to today. "unknown" changes nothing, so a link only stays
 * visible in the app if a check (or a manual verification, method "manual") succeeded
 * within the last 30 days. generatedAt changes only when something in the file changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type LinkStatus = 'ok' | 'broken' | 'unverified';

type StoreLink = {
  amiiboId: string;
  retailerId: string;
  productId: string;
  directUrl: string;
  affiliateUrl: string | null;
  directStatus: LinkStatus;
  affiliateStatus: LinkStatus;
  verifiedAt: string | null;
  method: 'http' | 'manual';
};

type LinksFile = {
  generatedAt: string;
  retailers: unknown[];
  links: StoreLink[];
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINKS_PATH = join(root, 'data', 'links.json');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};

const BLOCKED_PAGE = /captcha|robot check|are you a human|px-captcha|access denied/i;

type Probe = 'ok' | 'broken' | 'unknown';

async function probe(url: string, productId: string): Promise<Probe> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404 || response.status === 410) return 'broken';
    if (!response.ok) return 'unknown';
    const body = await response.text();
    if (BLOCKED_PAGE.test(body)) return 'unknown';
    if (!response.url.includes(productId) && !body.includes(productId)) return 'broken';
    return 'ok';
  } catch {
    return 'unknown';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const file = JSON.parse(readFileSync(LINKS_PATH, 'utf8')) as LinksFile;
  const before = JSON.stringify(file.links);
  const today = new Date().toISOString().slice(0, 10);
  const tally = { ok: 0, broken: 0, unknown: 0 };

  for (const link of file.links) {
    const direct = await probe(link.directUrl, link.productId);
    tally[direct] += 1;
    if (direct === 'ok') {
      link.directStatus = 'ok';
      link.verifiedAt = today;
      link.method = 'http';
    } else if (direct === 'broken') {
      link.directStatus = 'broken';
    }

    if (link.affiliateUrl) {
      const affiliate = await probe(link.affiliateUrl, link.productId);
      if (affiliate === 'ok') link.affiliateStatus = 'ok';
      else if (affiliate === 'broken') link.affiliateStatus = 'broken';
    }

    console.log(`${direct.padEnd(7)} ${link.retailerId.padEnd(8)} ${link.amiiboId} ${link.directUrl}`);
    await sleep(1500); // be polite to the stores
  }

  console.log(`\n${tally.ok} ok, ${tally.broken} broken, ${tally.unknown} couldn't be checked`);
  if (JSON.stringify(file.links) === before) {
    console.log('No changes.');
    return;
  }
  file.generatedAt = today;
  writeFileSync(LINKS_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`Updated ${LINKS_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
