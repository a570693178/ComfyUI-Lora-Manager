import { describe, it, beforeEach, expect, vi } from 'vitest';

const {
  SIDEBAR_MANAGER_MODULE,
  STORAGE_HELPERS_MODULE,
  MODEL_API_FACTORY_MODULE,
  I18N_MODULE,
  BULK_MANAGER_MODULE,
  UI_HELPERS_MODULE,
  UPDATE_CHECK_MODULE,
} = vi.hoisted(() => ({
  SIDEBAR_MANAGER_MODULE: new URL('../../../static/js/components/SidebarManager.js', import.meta.url).pathname,
  STORAGE_HELPERS_MODULE: new URL('../../../static/js/utils/storageHelpers.js', import.meta.url).pathname,
  MODEL_API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
  I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  BULK_MANAGER_MODULE: new URL('../../../static/js/managers/BulkManager.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  UPDATE_CHECK_MODULE: new URL('../../../static/js/utils/updateCheckHelpers.js', import.meta.url).pathname,
}));

vi.mock(MODEL_API_FACTORY_MODULE, () => ({ getModelApiClient: vi.fn() }));
vi.mock(I18N_MODULE, () => ({ translate: (key, _args, fallback) => fallback || key }));
vi.mock(BULK_MANAGER_MODULE, () => ({ bulkManager: {} }));
vi.mock(UI_HELPERS_MODULE, () => ({ showToast: vi.fn() }));
vi.mock(UPDATE_CHECK_MODULE, () => ({ performFolderUpdateCheck: vi.fn() }));

const { SidebarManager } = await import(SIDEBAR_MANAGER_MODULE);
const { setStorageItem, getStorageItem } = await import(STORAGE_HELPERS_MODULE);

function createManager(pageType) {
  const manager = new SidebarManager();
  manager.pageType = pageType;
  manager.pageControls = { pageState: { searchOptions: {} } };
  return manager;
}

describe('SidebarManager user-view favorites persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('writes the favorited usernames to storage', () => {
    const manager = createManager('loras');

    manager.favoriteUsers.add('alice');
    manager.favoriteUsers.add('bob');
    manager.saveFavoriteUsers();

    expect(getStorageItem('loras_favoriteUsers')).toEqual({ alice: true, bob: true });
  });

  it('restores the favorites on the next page load', () => {
    const first = createManager('loras');
    first.favoriteUsers.add('alice');
    first.saveFavoriteUsers();

    // A fresh manager stands in for the next page load.
    const second = createManager('loras');
    second.restoreUserViewState();

    expect(second.favoriteUsers.has('alice')).toBe(true);
  });

  it('keeps the favorites per page type', () => {
    const loras = createManager('loras');
    loras.favoriteUsers.add('alice');
    loras.saveFavoriteUsers();

    const checkpoints = createManager('checkpoints');
    checkpoints.restoreUserViewState();

    expect(checkpoints.favoriteUsers.has('alice')).toBe(false);
  });

  it('restores favorites stored in the legacy array format', () => {
    setStorageItem('loras_favoriteUsers', ['alice', 'bob']);

    const manager = createManager('loras');
    manager.restoreUserViewState();

    expect(manager.favoriteUsers.has('alice')).toBe(true);
    expect(manager.favoriteUsers.has('bob')).toBe(true);
  });
});
