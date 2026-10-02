# Source

TypeScript source for the extensions published from this repository. The `0.8/` and
`0.9/` directories at the repo root hold the **built** output that Paperback consumes;
this directory holds the code that produces it.

## Layout

```
src/
├── 0.9/                    # Paperback 0.9 (@paperback/types 1.0.0-alpha.92)
│   ├── <Source>/
│   │   ├── main.ts         # extension implementation
│   │   ├── pbconfig.ts     # manifest: id, name, capabilities, content rating
│   │   └── static/icon.png
│   ├── package.json
│   └── tsconfig.json
└── 0.8/                    # Paperback 0.8 (legacy API)
    └── <Source>/
        ├── <Source>.ts
        └── includes/icon.png
```

## What these are

Each source is an adapter: it fetches a third-party website and normalizes whatever it
gets back into the typed schema Paperback expects (`SourceManga`, `Chapter`,
`ChapterDetails`, `SearchResultItem`, `DiscoverSection`). The site is the input, a stable
typed contract is the output — the adapter absorbs the difference.

Nine sources for 0.9, ~3,800 lines of TypeScript. Two parsing strategies depending on
what the site actually exposes:

| Source | Strategy |
|---|---|
| AsuraScans, ManhwaWeb, Olympus | JSON API |
| HiveToons, MangaOni, NyxScans, Topcur, VortexScans, Webtoons, ZonaTMO | HTML parsing with `cheerio` |

Every source implements the same shape:

- A `PaperbackInterceptor` subclass for request/response middleware (headers, referer,
  image rewriting).
- A `BasicRateLimiter` so a discover screen that fans out does not hammer the origin.
- An `Extension` implementation composing the capability interfaces the source actually
  supports — declared in `pbconfig.ts` so the app never calls into something unimplemented.

## Why 0.8 and 0.9 both exist

Paperback 0.9 changed the extension API in ways that are not backward compatible: a
different module shape, a different manifest format (`pbconfig.ts` replacing the old
metadata block), and different capability interfaces. The 0.8 sources are kept building
so users who have not migrated keep working, rather than being dropped on the version bump.

## Authorship and licence

Everything in this directory is my own work.

Deliberately **not** included: `src/Paperback/` from the upstream
[Paperback-iOS/extensions-default](https://github.com/Paperback-iOS/extensions-default)
repository. That code is Faizan Durrani's, not mine, and the 0.8 sources here are the
four I wrote against it.

This project is licensed **GPL-3.0-or-later**, inherited from upstream — see
[`LICENSE`](../LICENSE) at the repo root.

## Building

```bash
cd src/0.9
npm install
npx @paperback/toolchain bundle
```

Output goes to the `0.9/` directory at the repo root, which is what GitHub Pages serves.
