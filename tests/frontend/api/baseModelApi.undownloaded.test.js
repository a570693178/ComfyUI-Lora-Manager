import { describe, it, afterEach, expect, vi } from 'vitest';

const {
  BASE_MODEL_API_MODULE,
  STATE_MODULE,
  UI_HELPERS_MODULE,
  I18N_MODULE,
  STORAGE_MODULE,
  API_CONFIG_MODULE,
  API_FACTORY_MODULE,
  SIDEBAR_MANAGER_MODULE,
  SCAN_ETA_MODULE,
} = vi.hoisted(() => ({
  BASE_MODEL_API_MODULE: new URL('../../../static/js/api/baseModelApi.js', import.meta.url).pathname,
  STATE_MODULE: new URL('../../../static/js/state/index.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  I18N_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
  STORAGE_MODULE: new URL('../../../static/js/utils/storageHelpers.js', import.meta.url).pathname,
  API_CONFIG_MODULE: new URL('../../../static/js/api/apiConfig.js', import.meta.url).pathname,
  API_FACTORY_MODULE: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
  SIDEBAR_MANAGER_MODULE: new URL('../../../static/js/components/SidebarManager.js', import.meta.url).pathname,
  SCAN_ETA_MODULE: new URL('../../../static/js/utils/scanEtaUtils.js', import.meta.url).pathname,
}));

// The page state is swapped per test to drive the tree filters.
const pageState = {
  pageSize: 100,
  sortBy: 'name:asc',
  viewMode: 'active',
  searchOptions: { recursive: true },
  activeFolder: null,
  activeCreator: null,
  activeCreatorBaseModel: null,
  activeCreatorTag: null,
  undownloadedView: false,
};

vi.mock(STATE_MODULE, () => ({
  // _buildQueryParams reads the group-by-model preference off the global
  // settings; the undownloaded path never reaches it, but the regular-list
  // assertion does.
  state: { global: { settings: { group_by_model: false } } },
  getCurrentPageState: vi.fn(() => pageState),
}));
vi.mock(UI_HELPERS_MODULE, () => ({ showToast: vi.fn() }));
vi.mock(I18N_MODULE, () => ({ translate: vi.fn((key) => key) }));
vi.mock(STORAGE_MODULE, () => ({
  getStorageItem: vi.fn(),
  getSessionItem: vi.fn(),
  removeSessionItem: vi.fn(),
  saveMapToStorage: vi.fn(),
}));
vi.mock(API_CONFIG_MODULE, () => ({
  getCompleteApiConfig: vi.fn(() => ({
    endpoints: {
      list: '/api/lm/loras/list',
      excluded: '/api/lm/loras/excluded',
      undownloadedVersions: '/api/lm/loras/undownloaded-versions',
    },
    config: { displayName: 'LoRA', singularName: 'LoRA', defaultPageSize: 100 },
  })),
  getCurrentModelType: vi.fn(() => 'loras'),
  isValidModelType: vi.fn(() => true),
  DOWNLOAD_ENDPOINTS: {},
  HF_ENDPOINTS: {},
  WS_ENDPOINTS: {},
}));
vi.mock(API_FACTORY_MODULE, () => ({ resetAndReload: vi.fn() }));
vi.mock(SIDEBAR_MANAGER_MODULE, () => ({ sidebarManager: { refresh: vi.fn() } }));
vi.mock(SCAN_ETA_MODULE, () => ({
  createScanEtaTracker: vi.fn(),
  formatScanRemainingTime: vi.fn(),
}));

function resetPageState() {
  pageState.activeFolder = null;
  pageState.activeCreator = null;
  pageState.activeCreatorBaseModel = null;
  pageState.activeCreatorTag = null;
  pageState.undownloadedView = false;
}

async function createClient() {
  const { BaseModelApiClient } = await import(BASE_MODEL_API_MODULE);
  class TestClient extends BaseModelApiClient {}
  return new TestClient('loras');
}

function mockFetch(payload) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
}

/** The query string of the single fetch the client just made. */
function calledQuery() {
  const url = global.fetch.mock.calls[0][0];
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
}

describe('BaseModelApiClient undownloaded versions', () => {
  afterEach(() => {
    delete global.fetch;
    resetPageState();
  });

  describe('fetchUndownloadedVersions', () => {
    it('requests page 1 with the configured page size by default', async () => {
      mockFetch({ items: [], total: 0, total_pages: 0, page: 1 });

      const client = await createClient();
      const result = await client.fetchUndownloadedVersions();

      expect(calledQuery().get('page')).toBe('1');
      expect(calledQuery().get('page_size')).toBe('100');
      expect(result.totalItems).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('forwards the user-view tree selection', async () => {
      mockFetch({ items: [], total: 0, total_pages: 1, page: 1 });
      pageState.activeCreator = 'alice';
      pageState.activeCreatorBaseModel = 'Illustrious';
      pageState.activeCreatorTag = 'anime';

      const client = await createClient();
      await client.fetchUndownloadedVersions();

      const query = calledQuery();
      expect(query.get('creator')).toBe('alice');
      expect(query.get('base_model')).toBe('Illustrious');
      expect(query.get('creator_tag')).toBe('anime');
    });

    it('forwards the folder tree selection', async () => {
      mockFetch({ items: [], total: 0, total_pages: 1, page: 1 });
      pageState.activeFolder = 'Pony/character';

      const client = await createClient();
      await client.fetchUndownloadedVersions();

      expect(calledQuery().get('folder')).toBe('Pony/character');
    });

    it('omits tree params when nothing is selected', async () => {
      mockFetch({ items: [], total: 0, total_pages: 1, page: 1 });

      const client = await createClient();
      await client.fetchUndownloadedVersions();

      const query = calledQuery();
      expect(query.has('creator')).toBe(false);
      expect(query.has('folder')).toBe(false);
      expect(query.has('base_model')).toBe(false);
      expect(query.has('creator_tag')).toBe(false);
    });

    it('reports hasMore while pages remain', async () => {
      mockFetch({ items: [{ modelId: 1, versionId: 2 }], total: 250, total_pages: 3, page: 1 });

      const client = await createClient();
      const result = await client.fetchUndownloadedVersions(1, 100);

      expect(result.hasMore).toBe(true);
      expect(result.totalItems).toBe(250);
      expect(result.totalPages).toBe(3);
    });
  });

  describe('fetchModelsPage delegation', () => {
    it('serves pending versions when the view is active', async () => {
      mockFetch({ items: [{ modelId: 7, versionId: 2 }], total: 1, total_pages: 1, page: 1 });
      pageState.undownloadedView = true;

      const client = await createClient();
      const result = await client.fetchModelsPage(1, 100);

      expect(global.fetch.mock.calls[0][0]).toContain('/undownloaded-versions?');
      expect(result.items).toEqual([{ modelId: 7, versionId: 2 }]);
      expect(result.totalItems).toBe(1);
    });

    it('uses the regular list endpoint when the view is off', async () => {
      mockFetch({ items: [], total: 0, total_pages: 0 });

      const client = await createClient();
      await client.fetchModelsPage(1, 100);

      expect(global.fetch.mock.calls[0][0]).toContain('/api/lm/loras/list?');
    });
  });
});
