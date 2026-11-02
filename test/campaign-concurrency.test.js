'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scheduler = fs.readFileSync(path.join(__dirname, '..', 'src', 'campaign-scheduler.js'), 'utf8');

test('campaign job claiming uses one database-backed global call slot', () => {
    assert.match(scheduler, /pg_advisory_xact_lock\(hashtext\('rescova:campaign-call-slot'\)\)/);
    assert.match(scheduler, /launching_job\.status = 'processing'/);
    assert.match(scheduler, /active_campaign_call\.campaign_id IS NOT NULL/);
    assert.match(scheduler, /active_campaign_call\.ended_at IS NULL/);
});
