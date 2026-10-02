// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { Layout } from './layout.js';
import type { Notification } from '../jobs/index.js';
import type { Site } from '../types.js';

export const DOC_PAGES: { slug: string; title: string }[] = [
  { slug: 'getting-started', title: 'Getting started' },
  { slug: 'install-the-tag', title: 'Install the tag' },
  { slug: 'inputs', title: 'Inputs' },
  { slug: 'rules', title: 'Rules' },
  { slug: 'filing-a-claim', title: 'Filing a claim' },
  { slug: 'ai-assistants', title: 'AI assistants' },
  { slug: 'configuration', title: 'Configuration' },
  { slug: 'privacy', title: 'Privacy' },
  { slug: 'faq', title: 'FAQ' },
  { slug: 'roadmap', title: 'Roadmap' },
  { slug: 'telemetry', title: 'Telemetry' },
];

export function DocsPage(p: { nonce: string; sites: Site[]; notifications: Notification[]; slug: string; title: string; html: string }) {
  return (
    <Layout title={p.title} nonce={p.nonce} sites={p.sites} notifications={p.notifications} section="docs">
      <p class="hint" style="margin:0 0 14px">
        {DOC_PAGES.map((d, i) => <>{i ? ' · ' : ''}{d.slug === p.slug ? <b>{d.title}</b> : <a href={`/docs/${d.slug}`}>{d.title}</a>}</>)}
      </p>
      <div class="card md" dangerouslySetInnerHTML={{ __html: p.html }} />
    </Layout>
  );
}
