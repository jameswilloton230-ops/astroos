import { describe, expect, it } from 'vitest';

const connectivity = await import('../../../js/core/services/connectivity.js');

describe('connectivity parsing and validation', () => {
  it('parses escaped NetworkManager fields and keeps the strongest AP per SSID', () => {
    expect(connectivity.parseWifiRows([
      'Cafe\\: Guest:42:WPA2',
      'Cafe\\: Guest:81:WPA2',
      'Guest\\\\Mesh:67:WPA3',
      'Guest:35:--',
    ].join('\n'))).toEqual([
      { ssid: 'Cafe: Guest', signal: 81, security: 'WPA2' },
      { ssid: 'Guest\\Mesh', signal: 67, security: 'WPA3' },
      { ssid: 'Guest', signal: 35, security: 'Open' },
    ]);
  });

  it('parses Bluetooth device addresses and names', () => {
    expect(connectivity.parseBluetoothDevices([
      'Device 10:20:30:40:50:60 Living Room Speaker',
      'not a device line',
    ].join('\n'))).toEqual([
      { address: '10:20:30:40:50:60', name: 'Living Room Speaker' },
    ]);
  });

  it('validates Bluetooth addresses before passing them to the system tool', () => {
    expect(connectivity.validateBluetoothAddress('10:20:30:40:50:60')).toBe('10:20:30:40:50:60');
    expect(connectivity.validateBluetoothAddress('connect; reboot')).toBeNull();
  });
});
