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

## Review cadence

Issues and PRs are triaged weekly. A first response within a week is the aim; complex changes can take longer.

## Licence

By contributing you agree that your contributions are licensed under the Apache License 2.0, the same as the project.
