'use strict';

const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { getRuntimeDataDir } = require('../../scripts/runtime-data-dir');

const DATA_DIR         = path.join(getRuntimeDataDir(path.resolve(__dirname, '..', '..')), 'data');
const ADMIN_STATE_PATH = path.join(DATA_DIR, 'admin-state.json');

const DEFAULT_STATE = {
  adminEnabled: false,
};

// In-memory cache to eliminate synchronous disk reads on every HTTP request
let cachedState = null;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function readState() {
  if (cachedState !== null) {
    return cachedState;
  }

  try {
    ensureDataDir();
    const raw    = fs.readFileSync(ADMIN_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cachedState = {
      adminEnabled: typeof parsed.adminEnabled === 'boolean' ? parsed.adminEnabled : DEFAULT_STATE.adminEnabled,
    };
  } catch (_) {
    cachedState = { ...DEFAULT_STATE };
  }

  return cachedState;
}

function writeState(state) {
  ensureDataDir();

  const next = {
    adminEnabled: Boolean(state.adminEnabled),
  };

  const rand     = crypto.randomBytes(4).toString('hex');
  const tempPath = `${ADMIN_STATE_PATH}.${process.pid}.${Date.now()}.${rand}.tmp`;

  try {
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tempPath, ADMIN_STATE_PATH);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    console.error('[AdminState] Atomic state write failed:', err.message);
  }

  cachedState = next;
  return cachedState;
}

function isAdminEnabled() {
  return readState().adminEnabled;
}

function setAdminEnabled(enabled) {
  return writeState({ adminEnabled: enabled });
}

module.exports = {
  isAdminEnabled,
  setAdminEnabled,
  readState,
  writeState,
};