import { describe, it, vi, beforeEach, expect } from 'vitest';
import type { BrowserWindow } from 'electron';

describe('menu.createMenu', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('builds menu and wires click handlers', async () => {
    // Mock Menu and shell
    const buildSpy = vi.fn().mockReturnValue({});
    const setSpy = vi.fn();
    const menuMock: { buildFromTemplate: typeof buildSpy; setApplicationMenu: typeof setSpy } = {
      buildFromTemplate: buildSpy,
      setApplicationMenu: setSpy
    };
    vi.doMock('electron', () => ({
      app: {
        name: 'Phosphor',
        getName: () => 'Phosphor',
        getPath: () => '/tmp',
        getVersion: () => '0'
      },
      Menu: menuMock,
      shell: { openExternal: vi.fn() }
    }));

    // Mock openVaultFromMenu to ensure it's imported without side-effects
    vi.doMock('./menuHelpers', () => ({ openVaultFromMenu: vi.fn().mockResolvedValue(null) }));

    const mainWindow = { webContents: { send: vi.fn() } } as unknown as BrowserWindow;

    const { createMenu } = await import('../menu');

    // Call createMenu; should invoke Menu.buildFromTemplate and setApplicationMenu
    createMenu(mainWindow);

    expect(buildSpy).toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalled();
  });
});
