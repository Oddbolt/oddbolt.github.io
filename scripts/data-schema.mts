/**
 * Shapes of the data files the app downloads, plus the helpers the scripts share.
 *
 * data/catalogue.json and data/links.json in this repo are the source of truth.
 * Edit them directly (or merge a pull request from the weekly AmiiboAPI sync).
 * The Publish workflow validates them, stamps generatedAt, and publishes them to the
 * `published` branch, which GitHub Pages and the jsDelivr backup both serve.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bump only when the app would misread the new format; the app ignores newer versions. */
export const SCHEMA_VERSION = 1;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGUE_PATH = join(ROOT, 'data', 'catalogue.json');
export const LINKS_PATH = join(ROOT, 'data', 'links.json');
export const IMAGE_DIR = join(ROOT, 'images', 'amiibo');

export const AMIIBOAPI_DATABASE_URL =
  'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json';
export const AMIIBOAPI_IMAGE_BASE =
  'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images';

export type Region = 'na' | 'eu' | 'jp' | 'au';
export const REGIONS: Region[] = ['na', 'eu', 'jp', 'au'];

export type CatalogueEntry = {
  /** AmiiboAPI id (16 hex chars: head + tail), or a temporary "ob-..." id for amiibo we add. */
  id: string;
  head: string;
  tail: string;
  name: string;
  character: string;
  gameSeries: string;
  amiiboSeries: string;
  type: string;
  /** Path on the site, e.g. "images/amiibo/00000000-00000002.webp". */
  image: string;
  /** Full URL tried if our copy can't load (AmiiboAPI's original), or null. */
  imageFallback: string | null;
  release: Record<Region, string | null>;
  /** "amiiboapi" entries came from the weekly sync; "oddbolt" entries were added by hand. */
  source: 'amiiboapi' | 'oddbolt';
};

export type CatalogueFile = {
  schemaVersion: number;
  /** Set automatically when published. */
  generatedAt: string;
  count: number;
  amiibo: CatalogueEntry[];
};

export type LinkStatus = 'ok' | 'broken' | 'unverified';

export type StoreLink = {
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

export type LinksFile = {
  schemaVersion: number;
  /** Set automatically when published. */
  generatedAt: string;
  retailers: { id: string; name: string; domain: string; region: string; currency: string }[];
  links: StoreLink[];
};

export function imagePath(head: string, tail: string): string {
  return `images/amiibo/${head}-${tail}.webp`;
}

export function amiiboApiImageUrl(head: string, tail: string): string {
  return `${AMIIBOAPI_IMAGE_BASE}/icon_${head}-${tail}.png`;
}

/** Pretty JSON with a trailing newline, so diffs stay readable. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
