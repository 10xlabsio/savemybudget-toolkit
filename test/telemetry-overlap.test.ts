// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SMB_DATA_DIR = mkdtempSync(join(tmpdir(), 'smb-telemetry-overlap-'));
delete process.env.SMB_TELEMETRY; // telemetry on

// The first send stays in flight until released; nothing leaves the machine.
let calls = 0;
let release: () => void = () => {};
globalThis.fetch = ((_url: unknown) => {
  calls++;
  return new Promise<Response>((resolve) => { release = () => resolve(new Response('{}')); });
}) as typeof fetch;

const { openMemoryDb } = await import('../src/db.js');
const { track } = await import('../src/telemetry/index.js');

describe('telemetry overlap guard', () => {
  it('a refused payload does not clear the in-flight flag', async () => {
    openMemoryDb();
    track('first_beacon', { hours_since_install: '1-24h' });
    assert.equal(calls, 1);
    track('heartbeat', {}); // skipped: a send is in flight
    assert.equal(calls, 1);
    track('heartbeat', { sites: 16909060 }); // refused, must not reset the flag
    assert.equal(calls, 1);
    track('heartbeat', {}); // still skipped
    assert.equal(calls, 1);
    release();
    await new Promise((r) => setTimeout(r, 10));
    track('heartbeat', {}); // flag cleared by the finished send
    assert.equal(calls, 2);
    release();
  });
});
