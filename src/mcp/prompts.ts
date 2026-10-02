// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
/**
 * MCP prompt templates. The verdict policy lives here so every assistant — Claude, ChatGPT, Cursor, an n8n
 * flow — treats flag / watch / no_match the same way, with a person present or not.
 */

export interface PromptArg { name: string; description: string; required: boolean }
export interface PromptDef { name: string; title: string; description: string; arguments: PromptArg[]; render: (args: Record<string, string>) => string }

const clean = (v: string | undefined, max = 120) => (v ?? '').replace(/[\r\n`]/g, ' ').trim().slice(0, max);

export const VERDICT_POLICY = `How to act on match_leads verdicts:

| verdict | A person is present | Unattended (scheduled task, "tag any leads the toolkit flagged") |
|---|---|---|
| flag | Show the list, ask, then tag the lead in the CRM | Tag the lead in the CRM — the task wording is the consent |
| watch | Show them and recommend a quick check before writing the lead off | List them in the run summary only; never tag them automatically |
| allow | Count only | Count only |
| no_match | Explain which key was missing | Mention the fix once per run (e.g. add a hidden gclid field to the form); don't repeat it |

Never tag a "watch" lead as junk without a person saying so. Verdicts come from public rules on recorded clicks; they are evidence, not proof.`;

export const PROMPTS: PromptDef[] = [
  {
    name: 'audit_crm_leads',
    title: 'Check CRM leads for click fraud',
    description: 'Pull recent leads from the connected CRM, match them against the clicks this toolkit recorded, and tag the junk ones — with a person present or unattended.',
    arguments: [
      { name: 'site_id', description: 'Site id or host (from list_sites).', required: true },
      { name: 'days', description: 'How many days of leads to check (default 7, at most 90).', required: false },
      { name: 'mode', description: 'interactive (default) or unattended.', required: false },
    ],
    render: (a) => {
      const site = clean(a.site_id);
      const d = Number(a.days);
      const days = Number.isInteger(d) && d >= 1 && d <= 90 ? d : 7;
      const mode = a.mode === 'unattended' ? 'unattended' : 'interactive';
      return `Check the last ${days} days of leads for site ${site} against the SaveMyBudget Toolkit. Mode: ${mode}.

1. From the CRM, fetch leads created in the last ${days} days that came from paid search / Google Ads where you can tell. For each lead collect ONLY: the CRM's lead id, the created/submitted timestamp, and whichever of these exist — gclid (or gbraid / wbraid), the IP the form was submitted from, the first-touch / landing URL. Do NOT send names, emails, phone numbers or message text to the toolkit.
2. Call match_leads for site ${site} in batches of up to 200 leads. Any one key per lead is enough.
3. Apply the policy below. The toolkit has no feedback tool: record outcomes in the CRM only.
4. Finish with a short summary: "N leads checked · X tagged invalid · Y worth a check · Z couldn't be matched (fix: …)". In unattended mode, post it wherever this task reports.

${VERDICT_POLICY}`;
    },
  },
  {
    name: 'weekly_summary',
    title: 'Weekly click-fraud summary',
    description: "Draft a short weekly note for a site's owner from this toolkit's data (the toolkit sends no email — you draft, a person sends).",
    arguments: [{ name: 'site_id', description: 'Site id or host; omit for every site.', required: false }],
    render: (a) => {
      const site = clean(a.site_id);
      return `Write a short weekly click-fraud summary${site ? ` for site ${site}` : ' for each site on this toolkit'}.

1. Call list_sites${site ? '' : ' and repeat the steps below for each site with clicks in the last 7 days'}.
2. Call get_site_summary for the last 7 days, get_top_offenders (group_by ip), get_notifications, and get_analyses.
3. Write it for the business owner: plain English, short, no jargon. Lead with paid clicks, flagged clicks and the change against the week before; then anything unusual (silent tag, a burst from one network); then the top IPs worth excluding in Google Ads; then any saved analysis whose clicks are close to leaving Google's ~60-day claim window. If you mention claims, say "Google decides every claim" — nothing has been filed unless a person did it. End with at most one suggested action.`;
    },
  },
  {
    name: 'prepare_claim',
    title: 'Prepare an invalid-click claim',
    description: "Check the window is still claimable, save an analysis, build the claim package, and tell the person exactly what to submit. Stops before anything is filed.",
    arguments: [
      { name: 'site_id', description: 'Site id or host.', required: true },
      { name: 'from', description: 'First day, YYYY-MM-DD.', required: true },
      { name: 'to', description: 'Last day, YYYY-MM-DD.', required: true },
    ],
    render: (a) => {
      const site = clean(a.site_id), from = clean(a.from, 10), to = clean(a.to, 10);
      return `Prepare an invalid-click claim for site ${site}, clicks from ${from} to ${to}.

1. Call get_claim_window. If ok is false, explain why and stop. If there is a warning, pass it on and suggest a narrower window.
2. Call run_analysis for the window. Report total clicks, flagged clicks and the flag rate, and the top rules that fired. If nothing was flagged, say so and stop — there is nothing to claim.
3. Call build_claim_package with the analysis_id (exclusions on, watch rows off unless the person asks).
4. Tell the person: the file name, how many clicks are in the evidence, where to download it (the Analyse page on the toolkit UI), and the next step — submit it with Google's invalid-click form for the ad account. Say clearly that nothing has been filed and that Google decides every claim. Offer the IPs from exclusions.txt for Google Ads IP exclusions.`;
    },
  },
];

export const PROMPT_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]));
