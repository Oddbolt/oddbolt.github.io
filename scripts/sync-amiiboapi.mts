/**
 * Compares our catalogue with AmiiboAPI and brings in amiibo we don't have yet.
 *
 *   node scripts/sync-amiiboapi.mts
 *
 * Our data/catalogue.json is the source of truth, so this never overwrites it:
 *   - amiibo AmiiboAPI has and we don't are added (source "amiiboapi"), with images
 *   - differences in amiibo we already have are only listed, for you to review
 *   - amiibo AmiiboAPI dropped are only listed; we keep them
 * Writes a summary to sync-report.md. The weekly workflow opens a pull request with
 * the additions, or an issue when there are only differences to review.
 * Needs `npm ci` first (uses sharp for images).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AMIIBOAPI_DATABASE_URL,
  CATALOGUE_PATH,
  REGIONS,
  ROOT,
  amiiboApiImageUrl,
  imagePath,
  toJson,
  type CatalogueEntry,
  type CatalogueFile,
  type Region,
} from './data-schema.mts';
import { mirrorMissingImages } from './mirror-images.mts';

type SourceDatabase = {
  amiibos: Record<string, { name: string; release: Partial<Record<Region, string | null>> }>;
  amiibo_series: Record<string, string>;
  game_series: Record<string, string>;
  types: Record<string, string>;
  characters: Record<string, string>;
};

const COMPARED = ['name', 'character', 'gameSeries', 'amiiboSeries', 'type'] as const;

function lookup(map: Record<string, string>, key: string): string {
  return map[key] ?? 'Unknown';
}

function normalize(db: SourceDatabase): CatalogueEntry[] {
  return Object.entries(db.amiibos).map(([rawId, amiibo]) => {
    const hex = rawId.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error(`Unexpected amiibo id: ${rawId}`);
    const head = hex.slice(0, 8);
    const tail = hex.slice(8);
    return {
      id: hex,
      head,
      tail,
      name: amiibo.name.trim(),
      character: lookup(db.characters, `0x${hex.slice(0, 4)}`),
      gameSeries: lookup(db.game_series, `0x${hex.slice(0, 3)}`),
      amiiboSeries: lookup(db.amiibo_series, `0x${hex.slice(12, 14)}`),
      type: lookup(db.types, `0x${hex.slice(6, 8)}`),
      image: imagePath(head, tail),
      imageFallback: amiiboApiImageUrl(head, tail),
      release: Object.fromEntries(
        REGIONS.map((region) => [region, amiibo.release?.[region] || null]),
      ) as Record<Region, string | null>,
      source: 'amiiboapi',
    };
  });
}

function differences(ours: CatalogueEntry, theirs: CatalogueEntry): string[] {
  const changes: string[] = [];
  for (const field of COMPARED) {
    if (ours[field] !== theirs[field])
      changes.push(`${field}: "${ours[field]}" → "${theirs[field]}"`);
  }
  for (const region of REGIONS) {
    if (ours.release[region] !== theirs.release[region]) {
      changes.push(`release.${region}: ${ours.release[region]} → ${theirs.release[region]}`);
    }
  }
  return changes;
}

function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

console.log(`Fetching ${AMIIBOAPI_DATABASE_URL}`);
const response = await fetch(AMIIBOAPI_DATABASE_URL);
if (!response.ok) throw new Error(`AmiiboAPI download failed: HTTP ${response.status}`);
const upstream = normalize((await response.json()) as SourceDatabase);
const upstreamIds = new Set(upstream.map((entry) => entry.id));

const file = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as CatalogueFile;
const ours = new Map(file.amiibo.map((entry) => [entry.id, entry]));

const added = upstream.filter((entry) => !ours.has(entry.id));
const changed = upstream
  .filter((entry) => ours.has(entry.id))
  .map((entry) => ({ entry, changes: differences(ours.get(entry.id)!, entry) }))
  .filter((item) => item.changes.length > 0);
const dropped = file.amiibo.filter(
  (entry) => entry.source === 'amiiboapi' && !upstreamIds.has(entry.id),
);

if (added.length > 0) {
  file.amiibo = [...file.amiibo, ...added].sort((a, b) => a.id.localeCompare(b.id));
  file.count = file.amiibo.length;
}
// Also heals any image that went missing from images/amiibo.
const imageFailures = await mirrorMissingImages(file);
if (added.length > 0) writeFileSync(CATALOGUE_PATH, toJson(file));

const lines = [
  `AmiiboAPI has ${upstream.length} amiibo; our catalogue has ${file.amiibo.length}.`,
  '',
];
if (added.length > 0) {
  lines.push(`### Added (${added.length})`, '');
  for (const entry of added) lines.push(`- ${entry.name} (${entry.amiiboSeries}) \`${entry.id}\``);
  lines.push('');
}
if (changed.length > 0) {
  lines.push(
    `### AmiiboAPI differs from our data (${changed.length}), not applied`,
    '',
    'Edit data/catalogue.json by hand if any of these should change.',
    '',
  );
  for (const { entry, changes } of changed) {
    lines.push(`- ${entry.name} \`${entry.id}\`: ${changes.join('; ')}`);
  }
  lines.push('');
}
if (dropped.length > 0) {
  lines.push(`### No longer in AmiiboAPI (${dropped.length}), kept`, '');
  for (const entry of dropped) lines.push(`- ${entry.name} \`${entry.id}\``);
  lines.push('');
}
if (imageFailures.length > 0) {
  lines.push(`### Images that couldn't be downloaded (${imageFailures.length})`, '');
  for (const id of imageFailures) lines.push(`- \`${id}\``);
  lines.push('');
}
writeFileSync(join(ROOT, 'sync-report.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));

setOutput('review', changed.length > 0 || dropped.length > 0 ? 'true' : 'false');
