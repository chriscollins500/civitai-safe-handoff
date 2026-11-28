# Contributing

Use a small synthetic file to reproduce an issue. Record the app version, browser, Civitai domain and which part of the pickup or receipt flow you were using. Use `npm run check`, `npm test`, `npm run build:civitai` and the applicable browser test before opening a change. Preserve both Civitai parent origins, zero end-user installs, and the browser-only transfer path.

Keep credentials, private files and pickup codes out of sample data and screenshots. The website lives in `docs/` and the GitHub Wiki source in `wiki-source/`.

Use `npm run test:site` for changes to the site. It checks the release receipt against the staged package and runs the browser test under the Pages project prefix. To refresh the current receipt, verify the submitted version with `node --use-system-ca scripts/verify-civitai-live.mjs --staged --version <version>`. Record that output in `docs/evidence/current-release.json` with the approved source commit and the package ZIP digest. Run `npm run check:site -- --write` to regenerate the release block in the review kit.

After Pages deploys, `node --use-system-ca scripts/verify-pages.mjs` compares every public site file with the checked-out source and `node --use-system-ca scripts/verify-civitai-live.mjs --current` rechecks both live App Block catalogs, the pinned source and the served HTML. See the [Pages comparison](validation/SITE-REVIEW.md) for the tested reader journeys and the [GitHub rollout plan](validation/GITHUB-ADOPTION.md) for pull request checks and settings.
