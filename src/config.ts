// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const config = {
  version: pkg.version as string,
  publicUrl: env('SMB_PUBLIC_URL', ''),
  tz: env('SMB_TZ', 'UTC'),
  port: Number(env('SMB_PORT', '8080')),
  bind: env('SMB_BIND', '127.0.0.1'),
  dataDir: env('SMB_DATA_DIR', join(process.cwd(), 'data')),
  trustProxy: env('SMB_TRUST_PROXY', '0') === '1',
  /** Addresses whose X-Forwarded-For is believed (with SMB_TRUST_PROXY=1). Default: loopback and private ranges. */
  trustedProxies: env('SMB_TRUSTED_PROXIES', 'private'),
  retentionDays: Math.max(60, Number(env('SMB_RETENTION_DAYS', '90'))),
  maxUploadMb: Number(env('SMB_MAX_UPLOAD_MB', '100')),
  storeWarnMb: Number(env('SMB_STORE_WARN_MB', '2048')),
  telemetry: env('SMB_TELEMETRY', 'on') !== 'off',
  updateCheck: env('SMB_UPDATE_CHECK', 'on') !== 'off',
  logLevel: env('SMB_LOG_LEVEL', 'info'),
  posthogHost: 'https://eu.i.posthog.com',
  posthogKey: env('SMB_POSTHOG_KEY', 'phc_toolkit_placeholder'),
  hostedUrl: 'https://savemybudget.io/?utm_source=toolkit',
  googleFormUrl: 'https://support.google.com/google-ads/contact/click_quality',
  claimWindowDays: 60,
};

export const CREDIT = 'Built by Ivo Kostadinov, founder of SaveMyBudget.io, part of 10xlabs.';
export const TERMS_SENTENCE =
  'When Google confirms a credit, they keep 25%. If Google confirms nothing, there is no charge.';
