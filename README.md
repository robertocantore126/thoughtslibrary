# thoughtslibrary

A local-first chart builder for music, books, games, movies, and shows — with dedicated **thought tiles** that carry Markdown notes and ratings. Charts are stored entirely in your browser (localStorage + IndexedDB), and the app runs in the browser or as an Electron desktop app.

## Features

- **Tile charts** — build collages up to 60×60 tiles from searchable catalogs (Last.fm, OpenLibrary, IGDB, The Movie DB) or add your own custom entries.
- **Thought tiles** — a dedicated tile type for ideas, each with a rich notes editor (floating popup: bold, italic, underline, headings, lists, quotes, indentation, links, colors) and a star rating.
- **Local-first** — charts are saved to localStorage and images are stored in IndexedDB (no giant base64 blobs in your saved chart data).
- **Import / export** — save and load `.topster` backups (compressed JSON), import from Topsters 2 backups, and export the chart as a PDF.
- **Desktop app** — Electron wrapper (`npm run desktop:dev`) with a Windows portable build (`npm run desktop:dist`).

## Project setup

### Install dependencies

```sh
npm install
```

### Compiles and hot-reloads for development

```sh
npm run dev
```

### Compiles and minifies for production

```sh
npm run build
```

### Lints and fixes files

```sh
npm run lint
```

## Desktop app (Electron)

Run as a desktop app in development:

```sh
npm run desktop:dev
```

Build a Windows portable desktop executable:

```sh
npm run desktop:dist
```

Output will be created in `release/`.

## License

This project is a **modified fork** of [topstersorg](https://github.com/camdendotlol/topstersorg).

- **Upstream:** <https://github.com/camdendotlol/topstersorg>
- **License:** the [GNU AGPL-3.0](LICENSE) license applies to the whole work, including this fork's changes. Copyright details are in [NOTICE](NOTICE).
- **Modified:** 2026, by rob126 (robertocantore126).
- **Not affiliated:** this project is not affiliated with or endorsed by topsters.org, camdendotlol, or the data providers it uses (Last.fm, OpenLibrary, IGDB, The Movie DB).
