# AGENTS.md: SaveMyBudget Toolkit

Instructions for coding agents working in this repo (Claude Code reads them through `CLAUDE.md`; Codex and others read this file directly). Human contributors: [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide.

## What this is

Self-hosted evidence collection for Google Ads invalid-click claims: the tag, a collector, ten documented detection rules and a claim package, in one Docker container. Node 22, Hono, SQLite. Apache-2.0.

## Commands

```bash
npm ci
npm run lint       # tsc --noEmit
npm test           # unit + integration on a temp database
npm run build
npm run fixtures   # synthetic 30-day window into ./data
docker build .     # the image must still build
```

CI also runs `npm audit --omit=dev --audit-level=high` and checks that the snippet names no SaveMyBudget host.

## Rules that matter most

- **The maintainer decides** rule defaults, scope, telemetry, licensing, trademarks and releases. Stop and ask; never guess an answer and build on it.
- **Only documented detection.** Everything the toolkit uses to flag a click is published in `docs/rules.md` and `src/rules/defaults.json`.
  - Don't add undocumented logic.
  - Don't bring in rules, weights, thresholds, signal lists or code from the managed SaveMyBudget service unless the maintainer approved that exact change in an issue.
  - Never describe unpublished detection in code, comments, tests, fixtures, docs, commit messages or PR text.
- **Rule defaults are product decisions.** A change to `src/rules/defaults.json` needs a linked discussion (CONTRIBUTING.md) or the maintainer's explicit go-ahead, plus an updated fixture and test.
- **Out of scope** (`docs/roadmap.md`): Google Ads OAuth or API access, automatic claim filing, pushing exclusions to Google Ads, cross-site signals, tuned thresholds, email. Work there needs the maintainer's decision first.
- **Nothing contacts SaveMyBudget** except the telemetry and version-check modules. The tag and snippet never name a SaveMyBudget host.
- **Telemetry matches [TELEMETRY.md](TELEMETRY.md) exactly.**
  - A new event or field updates that page in the same PR.
  - The telemetry module never reads click data, and no field can hold a string longer than 64 characters.
  - `SMB_TELEMETRY=off` turns it off.
- **`/mcp` is never open.** Every call needs a valid token (the instance token or one issued through the OAuth sign-in), on localhost too. With no token set up it answers 404.
- **SDK files are built, not edited.** `src/sdk/smb.js` and `src/sdk/smb.build.json` come from `scripts/build-sdk.sh`, pinned to an SDK commit. `src/sdk/stub.js` stays ES5 (GTM rejects anything newer).
- **Tests are part of the change.** A new rule gets a fixture and a test; a bug fix gets a regression test.
- **No real visitor data** in tests, fixtures, templates, issues or PRs. Use the synthetic fixtures and templates.
- **Secrets never appear** in code, tests, fixtures, logs, issues or PR text, including `SMB_MCP_TOKEN` values and `.env` contents.
- **Every source file starts with the SPDX header** (format in CONTRIBUTING.md).
- **Sign-off is a person's.** Commits are signed off (`git commit -s`, DCO) by the human who submits them. An agent never signs off in its own name; leave it to the contributor or the maintainer.
- **Runtime dependencies stay few.** A new one needs its reason in the PR.
- **Text people read** (UI, docs, README): describe, quantify, hedge.
  - The toolkit flags clicks; Google decides what is invalid.
  - Never "Google missed", "we recover", "guaranteed", or claims filed automatically.
  - Estimates are labelled as estimates.
  - The `$aveMyBudget` wordmark and the `$ave` / `$avings` wordplay are trademarks: never alter them ([TRADEMARK.md](TRADEMARK.md)).
- **Releases** are `v*` tags that publish to GHCR and npm. Only the maintainer cuts them.
- **Security reports** go to the address in [SECURITY.md](SECURITY.md), not to issues.

## Git and parallel sessions

- Work in your own worktree or clone, never in a checkout another session may be using. `.claude/worktrees/` is git-ignored. Run `npm ci` in it before testing.
- Branch from fresh `origin/main`.
- Stage files by name. Never `git add -A`, `git add .`, `git add -u` or `git commit -a`.
- Never stash, reset, clean or check out over files you didn't write. Never force-push a branch someone else created.
- A push counts when `git fetch origin <branch> && git diff --quiet FETCH_HEAD HEAD` succeeds, not when the push exits 0.

## Review guidelines

Review every PR against these. Report only P0/P1.

**P0: must not merge**
- A secret, token or API key in code, tests, fixtures, logs or PR text.
- Detection logic, weights, thresholds or signals not documented in `docs/rules.md` and `src/rules/defaults.json`.
- A code path that contacts SaveMyBudget outside the telemetry and version-check modules, or a SaveMyBudget host in the tag or snippet.
- Telemetry that sends anything TELEMETRY.md doesn't list, reads click data, or can carry a string longer than 64 characters.
- An `/mcp` call that succeeds without a valid token, on localhost or anywhere else.
- Real visitor data (IPs, click ids, user agents from real traffic) in tests, fixtures or templates.
- ES2015+ syntax in `src/sdk/stub.js`, or `src/sdk/smb.js` edited by hand.

**P1: fix before merge unless the maintainer accepts**
- A behaviour change without a test, a new rule without a fixture and test, or a bug fix without a regression test.
- A change to `src/rules/defaults.json` without a linked discussion or the maintainer's go-ahead.
- A new source file without the SPDX header.
- A new runtime dependency without a stated reason.
- User-facing text that says or implies Google missed something, promises recovery or guarantees, or calls claim filing automatic.
- README, `docs/`, TELEMETRY.md or CHANGELOG.md no longer true after the change.
