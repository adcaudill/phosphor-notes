import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('menuHelpers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls openVaultPath when user selects a folder', async () => {
    const fakeWindow = {} as any;

    // Mock electron dialog (use doMock to avoid hoisting issues)
    const showMock = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/my-vault'] });
    vi.doMock('electron', () => ({ dialog: { showOpenDialog: showMock } }));

    // Mock openVaultPath from ipc (runtime mock)
    const openVaultMock = vi.fn();
    vi.doMock('../ipc', () => ({ openVaultPath: openVaultMock }));

    const mod = await import('../menuHelpers');
    await mod.openVaultFromMenu(fakeWindow as any);

    expect(showMock).toHaveBeenCalled();
    expect(openVaultMock).toHaveBeenCalledWith('/tmp/my-vault', fakeWindow);
  });

  it('does not call openVaultPath when dialog is canceled', async () => {
    const fakeWindow = {} as any;

    const showMock = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] });
    vi.doMock('electron', () => ({ dialog: { showOpenDialog: showMock } }));

    const openVaultMock = vi.fn();
    vi.doMock('../ipc', () => ({ openVaultPath: openVaultMock }));

    const mod = await import('../menuHelpers');
    await mod.openVaultFromMenu(fakeWindow as any);

    expect(showMock).toHaveBeenCalled();
    expect(openVaultMock).not.toHaveBeenCalled();
  });
});
