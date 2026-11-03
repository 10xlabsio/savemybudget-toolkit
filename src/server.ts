#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import './umask.js'; // first: everything this process creates is private to its user
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config, secretKeyBytes } from './config.js';
import { db } from './db.js';
import { InsufficientDiskSpace } from './migrations/index.js';
import { startJobs, stopJobs, log } from './jobs/index.js';
import * as telemetry from './telemetry/index.js';
import { syncInstanceToken } from './mcp/oauth.js';
import { authMode, endSessionsWhileSigninOff, ownerRow } from './auth/owner.js';
import { redirectUri } from './auth/routes.js';

try {
  secretKeyBytes(); // a malformed SMB_SECRET_KEY stops the start, before anything is opened
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

try {
  db(); // opens the store and runs pending migrations before anything listens
} catch (err) {
  if (err instanceof InsufficientDiskSpace) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
telemetry.instanceId();
syncInstanceToken(); // a changed SMB_MCP_TOKEN signs every assistant out
const mode = authMode();
endSessionsWhileSigninOff(); // turning sign-in off ends every session, so turning it on later starts clean
if (mode.kind === 'signin') {
  ownerRow(); // a changed owner email or secret key ends every session now, not at the next request
  log(`Google sign-in is on: only the owner can open the web UI. Redirect URI to register: ${redirectUri()}`);
} else if (mode.kind === 'locked') {
  log(`A Google OAuth client is set, but ${mode.missing.join(' and ')} is not: the web UI shows only a page saying so until it is set.`);
}

if (telemetry.enabled()) {
  console.log('Anonymous usage counts are on — see TELEMETRY.md. Set SMB_TELEMETRY=off to disable.');
}

const deployMethod = process.env.SMB_TRUST_PROXY === '1' && process.env.SMB_BIND === '0.0.0.0' ? 'compose' : existsSync('/.dockerenv') ? 'docker' : 'npm';
const firstBoot = Date.now() - Date.parse(telemetry.firstBootAt()) < 60_000;
telemetry.track('instance_started', telemetry.startupProps(deployMethod, firstBoot));

if (!config.publicUrl) log('SMB_PUBLIC_URL is not set — set it in .env or on the setup page before installing the tag.');

startJobs();

const server = serve({ fetch: app.fetch, hostname: config.bind, port: config.port }, (info) => {
  log(`SaveMyBudget Toolkit ${config.version} listening on http://${info.address}:${info.port} (data: ${config.dataDir})`);
});

let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log(`${signal} received, shutting down`);
  stopJobs();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
