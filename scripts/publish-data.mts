/**
 * Prepares data/*.json for publishing (run by the Publish workflow, after validation).
 *
 *   node scripts/publish-data.mts
 *
 * Sets generatedAt to the time of the last commit that changed each file, so the app
 * notices any edit, and sets count and schemaVersion. Only the working copy is changed;
 * the workflow then pushes it to the `published` branch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  CATALOGUE_PATH,
  LINKS_PATH,
  ROOT,
  SCHEMA_VERSION,
  git,
  toJson,
  type CatalogueFile,
  type LinksFile,
} from './data-schema.mts';

function lastChanged(path: string): string {
  const date = git('log', '-1', '--format=%cI', '--', relative(ROOT, path));
  return new Date(date || Date.now()).toISOString();
}

const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as CatalogueFile;
const { amiibo, ...rest } = catalogue;
writeFileSync(
  CATALOGUE_PATH,
  toJson({
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: lastChanged(CATALOGUE_PATH),
    count: amiibo.length,
    amiibo,
  }),
);

const links = JSON.parse(readFileSync(LINKS_PATH, 'utf8')) as LinksFile;
writeFileSync(
  LINKS_PATH,
  toJson({ ...links, schemaVersion: SCHEMA_VERSION, generatedAt: lastChanged(LINKS_PATH) }),
);

console.log(`catalogue.json ${lastChanged(CATALOGUE_PATH)}, links.json ${lastChanged(LINKS_PATH)}`);
