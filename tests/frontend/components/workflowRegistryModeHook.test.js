import { beforeEach, describe, expect, it, vi } from "vitest";

const { APP_MODULE, API_MODULE, REGISTRY_MODULE, registeredExtensions } =
  vi.hoisted(() => ({
    APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
    API_MODULE: new URL("../../../scripts/api.js", import.meta.url).pathname,
    REGISTRY_MODULE: new URL(
      "../../../web/comfyui/workflow_registry.js",
      import.meta.url
    ).pathname,
    registeredExtensions: new Map(),
  }));

vi.mock(APP_MODULE, () => ({
  app: {
    graph: {},
    registerExtension: vi.fn((extension) =>
      registeredExtensions.set(extension.name, extension)
    ),
    ui: {
      settings: {
        getSettingValue: vi.fn(),
      },
    },
  },
}));

vi.mock(API_MODULE, () => ({
  api: {
    addEventListener: vi.fn(),
    fetchApi: vi.fn(),
    clientId: "test-client",
    initialClientId: "test-client",
  },
}));

/** Node whose `mode` lives behind a prototype accessor (frontend 1.53+). */
function createTrackedNode(id) {
  class ShellNode {
    constructor() {
      this._state = { mode: 0 };
      this.id = id;
      this.widgets = [];
    }

    get mode() {
      return this._state.mode;
    }

    set mode(value) {
      this._state.mode = value;
    }
  }

  return new ShellNode();
}

/** Graph event bus that records subscriptions and replays CustomEvents. */
function createGraph() {
  const listeners = new Map();
  const addEventListener = vi.fn((type, listener) => {
    const registered = listeners.get(type) ?? [];
    registered.push(listener);
    listeners.set(type, registered);
  });

  return {
    events: { addEventListener },
    addEventListener,
    emit(type, detail) {
      for (const listener of listeners.get(type) ?? []) {
        listener(new CustomEvent(type, { detail }));
      }
    },
  };
}

describe("WorkflowRegistry mode observation", () => {
  let registry;

  beforeEach(async () => {
    vi.resetModules();
    registeredExtensions.clear();
    await import(REGISTRY_MODULE);
    registry = registeredExtensions.get("LoraManager.WorkflowRegistry");
    registry._scheduleRefresh = vi.fn();
  });

  it("does not install a mode accessor on tracked (1.53+) nodes", () => {
    const graph = createGraph();
    const node = createTrackedNode("12");
    node.graph = graph;

    registry._ensureModeHook(node);

    expect(Object.getOwnPropertyDescriptor(node, "mode")).toBeUndefined();
  });

  it("refreshes the registry when the tracked node's mode changes", () => {
    const graph = createGraph();
    const node = createTrackedNode("12");
    node.graph = graph;
    registry._ensureModeHook(node);

    node.mode = 4;
    graph.emit("node:property:changed", {
      nodeId: "12",
      property: "mode",
      oldValue: 0,
      newValue: 4,
    });

    expect(registry._scheduleRefresh).toHaveBeenCalledTimes(1);
    expect(registry._scheduleRefresh).toHaveBeenCalledWith("mode");
  });

  it("ignores other nodes and other properties", () => {
    const graph = createGraph();
    const node = createTrackedNode("12");
    node.graph = graph;
    registry._ensureModeHook(node);

    graph.emit("node:property:changed", {
      nodeId: "99",
      property: "mode",
      oldValue: 0,
      newValue: 4,
    });
    graph.emit("node:property:changed", {
      nodeId: "12",
      property: "title",
      oldValue: "Load Image",
      newValue: "Load Image 2",
    });

    expect(registry._scheduleRefresh).not.toHaveBeenCalled();
  });

  it("subscribes once per graph for several observed nodes", () => {
    const graph = createGraph();
    const first = createTrackedNode("1");
    const second = createTrackedNode("2");
    first.graph = graph;
    second.graph = graph;

    registry._ensureModeHook(first);
    registry._ensureModeHook(second);
    registry._ensureModeHook(first);

    expect(graph.addEventListener).toHaveBeenCalledTimes(1);

    second.mode = 2;
    graph.emit("node:property:changed", {
      nodeId: "2",
      property: "mode",
      oldValue: 0,
      newValue: 2,
    });
    expect(registry._scheduleRefresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to interceptModeChange on legacy frontends", () => {
    const node = { id: "9", mode: 0, widgets: [] };

    registry._ensureModeHook(node);

    expect(typeof Object.getOwnPropertyDescriptor(node, "mode")?.set).toBe(
      "function"
    );

    node.mode = 4;
    expect(registry._scheduleRefresh).toHaveBeenCalledWith("mode");
  });
});
