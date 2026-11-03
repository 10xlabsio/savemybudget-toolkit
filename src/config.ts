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
  /** Optional address the web UI is reached at (a reverse proxy name). Only ever read from the environment. */
  uiUrl: env('SMB_UI_URL', ''),
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
  /** Google OAuth client for owner sign-in. With a client id set, every UI request needs the owner's Google sign-in. */
  googleClientId: env('SMB_GOOGLE_CLIENT_ID', ''),
  googleClientSecret: env('SMB_GOOGLE_CLIENT_SECRET', ''),
  /** The one Google account that may sign in. Compared case-insensitively. */
  ownerEmail: env('SMB_OWNER_EMAIL', '').trim(),
  /** Base64 of exactly 32 random bytes. Environment only; never written to the data directory. */
  secretKey: env('SMB_SECRET_KEY', ''),
};

/**
 * SMB_SECRET_KEY as bytes, or null when unset. Throws on anything but base64 of exactly 32 bytes, so a typo
 * stops the start-up instead of quietly weakening what the key protects.
 */
export function secretKeyBytes(raw = config.secretKey): Buffer | null {
  if (!raw) return null;
  const s = raw.trim();
  const buf = /^[A-Za-z0-9+/_-]+={0,2}$/.test(s) ? Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : Buffer.alloc(0);
  if (buf.length !== 32) {
    throw new Error('SMB_SECRET_KEY must be base64 of exactly 32 random bytes. Generate one with: openssl rand -base64 32');
  }
  return buf;
}

export const CREDIT = 'Built by Ivo Kostadinov, founder of SaveMyBudget.io, part of 10xlabs.';
export const TERMS_SENTENCE =
  'When Google confirms a credit, they keep 25%. If Google confirms nothing, there is no charge.';
