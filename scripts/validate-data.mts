/**
 * Checks data/catalogue.json and data/links.json before they're published.
 *
 *   node scripts/validate-data.mts
 *
 * Fails (exit 1) on anything that could break the app: bad JSON, missing fields,
 * duplicate ids, images that don't exist, links to unknown amiibo, non-https URLs,
 * or a catalogue that shrank by more than 2% compared with what's published now.
 * To publish an intentional big removal, run the Publish workflow by hand with
 * "Allow catalogue to shrink" checked (sets ALLOW_SHRINK=1).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATALOGUE_PATH,
  LINKS_PATH,
  REGIONS,
  ROOT,
  SCHEMA_VERSION,
  git,
  type CatalogueFile,
  type LinksFile,
} from './data-schema.mts';

const MAX_SHRINK = 0.02;
const errors: string[] = [];
const fail = (message: string) => errors.push(message);

const isText = (value: unknown) => typeof value === 'string' && value.trim() !== '';
const isHttps = (value: unknown) => typeof value === 'string' && /^https:\/\/\S+$/.test(value);
const isDate = (value: unknown) =>
  value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
const STATUSES = ['ok', 'broken', 'unverified'];

function readJson<T>(path: string, label: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    fail(`${label}: not valid JSON (${String(error)})`);
    return null;
  }
}

export function validateCatalogue(file: CatalogueFile | null): Set<string> {
  const ids = new Set<string>();
  if (!file) return ids;
  if (file.schemaVersion !== SCHEMA_VERSION) {
    fail(`catalogue: schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(file.amiibo) || file.amiibo.length === 0) {
    fail('catalogue: "amiibo" must be a non-empty list');
    return ids;
  }
  file.amiibo.forEach((entry, index) => {
    const where = `catalogue entry ${index} (${entry?.id ?? 'no id'} ${entry?.name ?? ''})`;
    if (typeof entry?.id !== 'string' || !/^([0-9a-f]{16}|ob-[a-z0-9-]+)$/.test(entry.id)) {
      fail(`${where}: id must be 16 lowercase hex chars or start with "ob-"`);
    } else if (ids.has(entry.id)) {
      fail(`${where}: duplicate id`);
    } else {
      ids.add(entry.id);
    }
    for (const field of ['name', 'character', 'gameSeries', 'amiiboSeries', 'type'] as const) {
      if (!isText(entry[field])) fail(`${where}: "${field}" is missing`);
    }
    for (const field of ['head', 'tail'] as const) {
      if (typeof entry[field] !== 'string') fail(`${where}: "${field}" must be text`);
    }
    if (!isText(entry.image)) {
      fail(`${where}: "image" is missing`);
    } else if (!/^https?:\/\//.test(entry.image) && !existsSync(join(ROOT, entry.image))) {
      if (!isHttps(entry.imageFallback)) fail(`${where}: image file ${entry.image} doesn't exist`);
      else console.warn(`  ! ${where}: ${entry.image} missing, app will use imageFallback`);
    }
    if (entry.imageFallback !== null && !isHttps(entry.imageFallback)) {
      fail(`${where}: "imageFallback" must be an https URL or null`);
    }
    if (typeof entry.release !== 'object' || entry.release === null) {
      fail(`${where}: "release" is missing`);
    } else {
      for (const region of REGIONS) {
        if (!isDate(entry.release[region])) {
          fail(`${where}: release.${region} must be YYYY-MM-DD or null`);
        }
      }
    }
    if (entry.source !== 'amiiboapi' && entry.source !== 'oddbolt') {
      fail(`${where}: "source" must be "amiiboapi" or "oddbolt"`);
    }
  });
  return ids;
}

export function validateLinks(file: LinksFile | null, amiiboIds: Set<string>) {
  if (!file) return;
  if (file.schemaVersion !== SCHEMA_VERSION) fail(`links: schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(file.retailers) || !Array.isArray(file.links)) {
    fail('links: "retailers" and "links" must be lists');
    return;
  }
  const retailers = new Set(file.retailers.map((retailer) => retailer.id));
  const seen = new Set<string>();
  file.links.forEach((link, index) => {
    const where = `link ${index} (${link?.retailerId} ${link?.amiiboId})`;
    if (!amiiboIds.has(link.amiiboId))
      fail(`${where}: amiibo ${link.amiiboId} isn't in the catalogue`);
    if (!retailers.has(link.retailerId)) fail(`${where}: unknown retailer ${link.retailerId}`);
    const key = `${link.amiiboId}/${link.retailerId}`;
    if (seen.has(key)) fail(`${where}: duplicate link for this amiibo and store`);
    seen.add(key);
    if (!isText(link.productId)) fail(`${where}: "productId" is missing`);
    if (!isHttps(link.directUrl)) fail(`${where}: "directUrl" must be https`);
    if (link.affiliateUrl !== null && !isHttps(link.affiliateUrl)) {
      fail(`${where}: "affiliateUrl" must be https or null`);
    }
    if (!STATUSES.includes(link.directStatus) || !STATUSES.includes(link.affiliateStatus)) {
      fail(`${where}: statuses must be ok, broken or unverified`);
    }
    if (!isDate(link.verifiedAt)) fail(`${where}: "verifiedAt" must be YYYY-MM-DD or null`);
  });
}

/** Number of amiibo currently published, or null before the first publish. */
function publishedCount(): number | null {
  try {
    git('fetch', '--quiet', '--depth=1', 'origin', 'published');
    const published = JSON.parse(git('show', 'FETCH_HEAD:data/catalogue.json')) as CatalogueFile;
    return published.amiibo.length;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const catalogue = readJson<CatalogueFile>(CATALOGUE_PATH, 'catalogue');
  const ids = validateCatalogue(catalogue);
  validateLinks(readJson<LinksFile>(LINKS_PATH, 'links'), ids);

  const before = publishedCount();
  if (catalogue && before !== null && catalogue.amiibo.length < before * (1 - MAX_SHRINK)) {
    const message = `catalogue: ${catalogue.amiibo.length} amiibo, down from ${before} published`;
    if (process.env.ALLOW_SHRINK === '1') console.warn(`  ! ${message} (allowed)`);
    else
      fail(`${message}. Run Publish by hand with "Allow catalogue to shrink" if that's intended.`);
  }

  if (errors.length > 0) {
    console.error(`${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`Data OK: ${ids.size} amiibo${before !== null ? ` (published: ${before})` : ''}.`);
}
