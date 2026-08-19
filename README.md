# thoughtslibrary

A fork of [topstersorg](https://github.com/camdendotlol/topstersorg) for creating charts with books, music, and games — wrapped in a desktop app (Electron + a .NET launcher).

## Fork notice

This repository is a **modified fork** of [topstersorg](https://github.com/camdendotlol/topstersorg) (AGPL-3.0).

- **Upstream:** <https://github.com/camdendotlol/topstersorg>
- **License:** the [GNU AGPL-3.0](LICENSE) license applies to the whole work, including this fork's changes. Copyright details are in [NOTICE](NOTICE).
- **Modified:** 2026, by rob126 (robertocantore126).
- **Not affiliated:** this project is not affiliated with or endorsed by topsters.org, camdendotlol, or the data providers it uses (Last.fm, OpenLibrary, IGDB, The Movie DB).

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

Please make sure your changes pass the linter before opening a PR.

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
