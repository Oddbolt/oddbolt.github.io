/**
 * Downloads any amiibo image the site doesn't have yet and stores it as WebP.
 *
 *   node scripts/mirror-images.mts
 *
 * For every catalogue entry whose image file is missing from images/amiibo/, fetches
 * its imageFallback (AmiiboAPI's PNG) and converts it. Existing files are never
 * touched, so replacing an image by hand is safe. Needs `npm ci` first (uses sharp).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import { CATALOGUE_PATH, IMAGE_DIR, ROOT, type CatalogueFile } from './data-schema.mts';

/** Turns a PNG/JPEG into the WebP the app loads (max 512 px, transparency kept). */
export async function toWebp(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90, effort: 5 })
    .toBuffer();
}

/** Mirrors missing images. Returns the ids it couldn't fetch. */
export async function mirrorMissingImages(file: CatalogueFile): Promise<string[]> {
  mkdirSync(IMAGE_DIR, { recursive: true });
  const failed: string[] = [];
  for (const entry of file.amiibo) {
    const target = join(ROOT, entry.image);
    if (existsSync(target) || !entry.imageFallback) continue;
    try {
      const response = await fetch(entry.imageFallback);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(target, await toWebp(Buffer.from(await response.arrayBuffer())));
      console.log(`  + ${entry.image}`);
    } catch (error) {
      console.warn(`  ! ${entry.id} ${entry.name}: ${String(error)}`);
      failed.push(entry.id);
    }
  }
  return failed;
}

if (import.meta.main) {
  const file = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as CatalogueFile;
  const failed = await mirrorMissingImages(file);
  console.log(failed.length ? `${failed.length} images failed.` : 'All images present.');
}
