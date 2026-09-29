#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { startJobs, stopJobs, log } from './jobs/index.js';
import * as telemetry from './telemetry/index.js';

db();
telemetry.instanceId();

if (telemetry.enabled()) {
  console.log('Anonymous usage counts are on — see TELEMETRY.md. Set SMB_TELEMETRY=off to disable.');
}

const deployMethod = process.env.SMB_TRUST_PROXY === '1' && process.env.SMB_BIND === '0.0.0.0' ? 'compose' : existsSync('/.dockerenv') ? 'docker' : 'npm';
const firstBoot = Date.now() - Date.parse(telemetry.firstBootAt()) < 60_000;
telemetry.track('instance_started', {
  version: config.version,
  node: process.version,
  os: process.platform,
  arch: process.arch,
  deploy_method: deployMethod,
  first_boot: firstBoot,
});

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
