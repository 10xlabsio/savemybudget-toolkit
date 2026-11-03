# Contributing

Thanks for looking. This is a small project maintained part-time; the notes below are what make a contribution easy to accept.

## Before you start

- **Bugs:** open an issue with the template. Include the toolkit version, how it's deployed, and what the upload preview or analysis page showed. Never paste real visitor data — use the template's example rows.
- **Features:** open a discussion first. The roadmap in `docs/roadmap.md` says what's planned and what's deliberately out of scope.
- **Rule defaults:** changing a threshold in `src/rules/defaults.json` is a product decision, not a code change. Open a discussion with the data that supports the change. Pull requests that touch defaults without one will be labelled `needs-discussion` and parked.
- **Hosting networks:** additions to `data/hosting-asns.txt` are welcome. Include the ASN, the operator name, and a link showing it's a hosting provider.
- **Security:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Development

```bash
git clone https://github.com/10xlabsio/savemybudget-toolkit
cd savemybudget-toolkit
npm install
npm run dev          # UI on http://127.0.0.1:8080, data in ./data
npm test             # unit + integration on a temp database
npm run test:contract # beacon schema against the SDK
npm run fixtures     # generate a synthetic 30-day window into ./data
```

Node 20 or newer. The fixture generator produces synthetic traffic in which each rule fires on a known set of clicks; the rule tests assert against it. If you add a rule, add its fixture and test.

## Pull requests

- One change per PR. Describe what it does and why in the description; the template asks for both.
- Tests pass, `npm run lint` is clean, and the image still builds.
- Sign off every commit (`git commit -s`). We use the [Developer Certificate of Origin](https://developercertificate.org/) rather than a CLA.
- Keep dependencies out unless there's no reasonable alternative; the runtime dependency list is short on purpose and every addition is reviewed for licence and supply-chain risk.
- User-facing text follows the tone of the existing docs: describe, quantify, hedge. The toolkit flags clicks; Google decides what is invalid. Copy that says or implies "Google missed", "we recover", or "guaranteed" won't be merged.
- Don't add any code path in which the tag or the toolkit contacts SaveMyBudget beyond the documented telemetry and version-check modules.

## The detection core is generated

`src/detection/` (the scorer, its rules file and the parity corpus) is generated from the maintainer's source and exported here in one piece, a few weeks after each rules version ships. Don't edit it by hand: every export writes `src/detection/PROVENANCE.json` with a sha256 for each file, and CI fails on any file that differs from it, is missing, or isn't listed.

To change detection, open an issue: describe the clicks it gets wrong and, if you can, a synthetic example (documentation IP ranges such as `192.0.2.0/24`, `example.com` hosts, made-up click ids; never real visitor data). Fixes land in the maintainer's source and reach this repository with the next export. Pull requests that edit `src/detection/` directly can't pass CI and will be closed with a pointer to the issue. `src/detection/` and `.github/boundary/` are listed in `.github/CODEOWNERS`.

## Boundary checks

`.github/workflows/boundary.yml` runs on every pull request and on pushes to `main` and `v2`:

- **gitleaks** (8.30.1, the repository's `.gitleaks.toml`, output redacted) over the tree and the new commits.
- **Keyed-term scan** (`scripts/boundary-scan.mjs`). The maintainer keeps a short list of terms that must never appear in this repository, such as names that aren't ours to publish. The list is committed only as keyed hashes in `.github/boundary/keyed.json`: each entry is an HMAC-SHA256 of a normalised term under a key held as a repository secret, padded with decoys to 256 entries, so the file names nothing. The scan hashes every run of 1 to 6 words in every text file, in the commit messages, and in the pull request title, body and branch name, and fails on a match. It reports where, never what.
- **Provenance** (`scripts/check-provenance.mjs`): the detection core matches its `PROVENANCE.json`.
- **Tests** of these checks, and the parity corpus test once the corpus is in the tree.

The keyed-term scan needs the secret, and GitHub doesn't give secrets to pull requests from forks, so on a fork that check fails. That's on purpose: a check that can't run fails rather than passes. If your pull request is otherwise ready, a maintainer re-runs it from a branch in this repository, with you as the commit author. If the scan flags your change, it names the file and line; rewording that line is enough, and you don't need to know what matched.

Run the checks locally with `node scripts/check-provenance.mjs`, `gitleaks dir . --config .gitleaks.toml --redact`, and `node --test --import tsx test/boundary.test.ts`.

## Review cadence

Issues and PRs are triaged weekly. A first response within a week is the aim; complex changes can take longer.

## Licence

By contributing you agree that your contributions are licensed under the Apache License 2.0, the same as the project.

## File headers

Every source file starts with an SPDX header:

```
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
```

Keep it on new files. Contributions are licensed under Apache-2.0 with copyright retained by the contributor; the header names the project, not the author of each line.
