import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const brokerSource = readFileSync(
  fileURLToPath(new URL('../../../js/platform/security/root-broker.js', import.meta.url)),
  'utf8',
);

describe('NovaRoot broker', () => {
  it('detects sudo using the imported child_process module', () => {
    const execFileSync = vi.fn();
    const window = {};
    const context = {
      window,
      console: { info() {} },
      require: name => {
        if (name === 'child_process') return { execFileSync };
        if (name === 'fs' || name === 'path') return {};
        throw new Error(`Unexpected module: ${name}`);
      },
    };

    runInNewContext(brokerSource, context);

    expect(window.NovaRoot.status().available).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'sudo',
      ['--version'],
      { stdio: 'ignore', timeout: 5000 },
    );
  });

  it('attributes calls from the focused, granted root app when async callbacks lack a stack marker', () => {
    const window = {};
    const appId = 'com.tools.debloat';
    const context = {
      window,
      console: { info() {} },
      OS: {
        focusedWindowId: 'debloat-window',
        windows: new Map([['debloat-window', { appId }]]),
        settings: { get: key => key === 'devMode' || key === 'rootAccessEnabled' },
      },
      AppPermissionManager: { isGranted: permission => permission === 'system:root' },
      AppSandbox: { isRootExecutionApp: id => id === appId },
      require: name => {
        if (name === 'child_process') return { execFileSync: vi.fn() };
        if (name === 'fs' || name === 'path') return {};
        throw new Error(`Unexpected module: ${name}`);
      },
    };

    runInNewContext(brokerSource, context);

    expect(window.NovaRoot.status().appId).toBe(appId);
  });

  it('does not use the focused window as a caller without the live root grant', () => {
    const window = {};
    const context = {
      window,
      console: { info() {} },
      OS: {
        focusedWindowId: 'debloat-window',
        windows: new Map([['debloat-window', { appId: 'com.tools.debloat' }]]),
        settings: { get: key => key === 'devMode' || key === 'rootAccessEnabled' },
      },
      AppPermissionManager: { isGranted: () => false },
      AppSandbox: { isRootExecutionApp: () => true },
      require: name => {
        if (name === 'child_process') return { execFileSync: vi.fn() };
        if (name === 'fs' || name === 'path') return {};
        throw new Error(`Unexpected module: ${name}`);
      },
    };

    runInNewContext(brokerSource, context);

    expect(window.NovaRoot.status().appId).toBeNull();
  });

  it('does not let a caller override the focused root app id', async () => {
    const window = {};
    const appId = 'com.tools.debloat';
    const context = {
      window,
      console: { info() {} },
      OS: {
        focusedWindowId: 'debloat-window',
        windows: new Map([['debloat-window', { appId }]]),
        settings: { get: key => key === 'devMode' || key === 'rootAccessEnabled' },
      },
      AppPermissionManager: { isGranted: permission => permission === 'system:root' },
      AppSandbox: { isRootExecutionApp: id => id === appId },
      require: name => {
        if (name === 'child_process') return { execFileSync: vi.fn() };
        if (name === 'fs' || name === 'path') return {};
        throw new Error(`Unexpected module: ${name}`);
      },
    };

    runInNewContext(brokerSource, context);

    await expect(window.NovaRoot.requestSession({ appId: 'com.attacker.app' })).resolves.toMatchObject({
      granted: false,
      reason: expect.stringContaining('caller could not be identified'),
    });
  });
});
