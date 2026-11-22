/**
 * Builds the amiibo catalogue from the AmiiboAPI database.
 *
 *   node scripts/snapshot-catalogue.mts
 *
 * Reads AmiiboAPI's source database (the same data amiiboapi.com serves),
 * applies data/overrides.json, and writes data/catalogue.json, which the app
 * downloads from https://oddbolt.github.io/data/catalogue.json.
 * generatedAt only changes when the catalogue itself changes, so the app
 * doesn't re-download identical data.
 *
 * Needs Node.js 22.18+ (runs TypeScript directly).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json';
const IMAGE_BASE = 'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OVERRIDES_PATH = join(root, 'data', 'overrides.json');
const OUTPUT = join(root, 'data', 'catalogue.json');

type Region = 'na' | 'eu' | 'jp' | 'au';
const REGIONS: Region[] = ['na', 'eu', 'jp', 'au'];

type SourceDatabase = {
  amiibos: Record<string, { name: string; release: Partial<Record<Region, string | null>> }>;
  amiibo_series: Record<string, string>;
  game_series: Record<string, string>;
  types: Record<string, string>;
  characters: Record<string, string>;
};

export type CatalogueEntry = {
  /** 16 lowercase hex chars: head + tail. Stable and unique. */
  id: string;
  head: string;
  tail: string;
  name: string;
  character: string;
  gameSeries: string;
  amiiboSeries: string;
  type: string;
  image: string;
  release: Record<Region, string | null>;
};

type Overrides = {
  /** Field changes for existing entries, keyed by id. */
  patch?: Record<string, Partial<Omit<CatalogueEntry, 'id'>>>;
  /** Ids to drop from the catalogue. */
  remove?: string[];
  /** Complete entries missing from AmiiboAPI. */
  add?: CatalogueEntry[];
};

function lookup(map: Record<string, string>, key: string, what: string, id: string): string {
  const value = map[key];
  if (value === undefined) {
    console.warn(`  ! no ${what} for key ${key} (amiibo ${id})`);
    return 'Unknown';
  }
  return value;
}

function normalize(db: SourceDatabase): CatalogueEntry[] {
  return Object.entries(db.amiibos).map(([rawId, amiibo]) => {
    const hex = rawId.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error(`Unexpected amiibo id: ${rawId}`);
    const head = hex.slice(0, 8);
    const tail = hex.slice(8);
    const release = Object.fromEntries(
      REGIONS.map((region) => [region, amiibo.release?.[region] || null])
    ) as Record<Region, string | null>;

    return {
      id: hex,
      head,
      tail,
      name: amiibo.name.trim(),
      character: lookup(db.characters, `0x${hex.slice(0, 4)}`, 'character', hex),
      gameSeries: lookup(db.game_series, `0x${hex.slice(0, 3)}`, 'game series', hex),
      amiiboSeries: lookup(db.amiibo_series, `0x${hex.slice(12, 14)}`, 'amiibo series', hex),
      type: lookup(db.types, `0x${hex.slice(6, 8)}`, 'type', hex),
      image: `${IMAGE_BASE}/icon_${head}-${tail}.png`,
      release,
    };
  });
}

function applyOverrides(entries: CatalogueEntry[], overrides: Overrides): CatalogueEntry[] {
  const removed = new Set(overrides.remove ?? []);
  const result = entries
    .filter((entry) => !removed.has(entry.id))
    .map((entry) => ({ ...entry, ...(overrides.patch?.[entry.id] ?? {}), id: entry.id }));

  const ids = new Set(result.map((entry) => entry.id));
  for (const added of overrides.add ?? []) {
    if (ids.has(added.id)) {
      console.warn(`  ! override adds ${added.id}, which AmiiboAPI now has; skipping the override`);
      continue;
    }
    result.push(added);
  }
  for (const id of Object.keys(overrides.patch ?? {})) {
    if (!ids.has(id)) console.warn(`  ! override patches ${id}, which isn't in the catalogue`);
  }
  return result;
}

async function main() {
  console.log(`Fetching ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const db = (await response.json()) as SourceDatabase;

  const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Overrides;
  const entries = applyOverrides(normalize(db), overrides).sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  const previous = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, 'utf8')) : null;
  if (previous && JSON.stringify(previous.amiibo) === JSON.stringify(entries)) {
    console.log(`No catalogue changes (${entries.length} amiibo).`);
    return;
  }

  const output = {
    generatedAt: new Date().toISOString().slice(0, 10),
    source: SOURCE_URL,
    count: entries.length,
    amiibo: entries,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${entries.length} amiibo to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
