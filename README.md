# oddbolt.github.io

Public site for Oddbolt apps, served at https://oddbolt.github.io.

| Path | What it is |
| --- | --- |
| `index.html` | Oddbolt landing page |
| `amiibo-companion/` | Amiibo Companion page and privacy policy (linked from Google Play and the app) |
| `data/catalogue.json` | amiibo catalogue the app downloads (built from AmiiboAPI) |
| `data/links.json` | Store links the app shows under "Where to buy" |
| `data/overrides.json` | Fixes applied on top of AmiiboAPI |
| `app-ads.txt` | AdMob authorized sellers file (added at launch) |

## Data updates

`.github/workflows/update-data.yml` runs every Monday (and on demand from the Actions tab):

1. `node scripts/snapshot-catalogue.mts` rebuilds `data/catalogue.json` from AmiiboAPI plus `data/overrides.json`.
2. `node scripts/check-links.mts` re-checks every link in `data/links.json`.

The app checks for newer files at most once a day and uses them the next time it opens.

## Store links

Each entry in `data/links.json`:

```json
{
  "amiiboId": "0000000000000002",
  "retailerId": "amazon",
  "productId": "B00N4ABMG4",
  "directUrl": "https://www.amazon.com/dp/B00N4ABMG4",
  "affiliateUrl": null,
  "directStatus": "ok",
  "affiliateStatus": "unverified",
  "verifiedAt": "2026-11-22",
  "method": "manual"
}
```

The app shows a store only if `verifiedAt` is within the last 30 days: the affiliate URL if its status is `ok`, otherwise the direct URL if its status is `ok`. When a store blocks the automatic check, open the link yourself, then set `verifiedAt` to today and `method` to `"manual"`.
