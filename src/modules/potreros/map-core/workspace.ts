export type MapViewport = Readonly<{
  center: readonly [number, number];
  zoom: number;
}>;

export type MapLayerKind =
  | "canonical"
  | "draft"
  | "suggestion"
  | "operational"
  | "external-context";

export type MapLayerStatus = "loading" | "available" | "stale" | "error" | "unavailable";

export type MapLayerDescriptor = Readonly<{
  id: string;
  kind: MapLayerKind;
  label: string;
  source: string;
  status: MapLayerStatus;
  visible: boolean;
  observedAt: string | null;
  version: string | null;
  attribution: string | null;
  error: string | null;
}>;

export type MapWorkspace = Readonly<{
  fieldId: string;
  selectedPaddockIds: readonly string[];
  focusedPaddockId: string | null;
  viewport: MapViewport;
  search: string;
  filters: Readonly<Record<string, readonly string[]>>;
  layers: Readonly<Record<string, MapLayerDescriptor>>;
  activeTransactionId: string | null;
}>;

export type MapWorkspaceCommand =
  | Readonly<{ type: "select-paddocks"; ids: readonly string[] }>
  | Readonly<{ type: "focus-paddock"; id: string | null }>
  | Readonly<{ type: "set-viewport"; viewport: MapViewport }>
  | Readonly<{ type: "set-search"; search: string }>
  | Readonly<{ type: "set-filter"; key: string; values: readonly string[] }>
  | Readonly<{ type: "register-layer"; layer: MapLayerDescriptor }>
  | Readonly<{
      type: "set-layer-status";
      id: string;
      status: MapLayerStatus;
      observedAt?: string | null;
      version?: string | null;
      error?: string | null;
    }>
  | Readonly<{ type: "set-layer-visibility"; id: string; visible: boolean }>
  | Readonly<{ type: "begin-edit"; transactionId: string; fieldId: string }>
  | Readonly<{ type: "finish-edit"; transactionId: string }>;

export type MapWorkspaceTransition =
  | Readonly<{ ok: true; workspace: MapWorkspace }>
  | Readonly<{
      ok: false;
      workspace: MapWorkspace;
      error: Readonly<{ code: "invalid-command" | "transaction-active"; message: string }>;
    }>;

export function createMapWorkspace(input: Readonly<{
  fieldId: string;
  viewport: MapViewport;
}>): MapWorkspace {
  if (!input.fieldId.trim()) throw new TypeError("El workspace necesita un fundo.");
  return freezeWorkspace({
    fieldId: input.fieldId,
    selectedPaddockIds: [],
    focusedPaddockId: null,
    viewport: cloneViewport(input.viewport),
    search: "",
    filters: {},
    layers: {},
    activeTransactionId: null,
  });
}

export function transitionMapWorkspace(
  workspace: MapWorkspace,
  command: MapWorkspaceCommand,
): MapWorkspaceTransition {
  switch (command.type) {
    case "select-paddocks":
      return accepted({ ...workspace, selectedPaddockIds: [...new Set(command.ids)] });
    case "focus-paddock":
      return accepted({ ...workspace, focusedPaddockId: command.id });
    case "set-viewport":
      return accepted({ ...workspace, viewport: cloneViewport(command.viewport) });
    case "set-search":
      return accepted({ ...workspace, search: command.search });
    case "set-filter":
      return accepted({
        ...workspace,
        filters: { ...workspace.filters, [command.key]: [...new Set(command.values)] },
      });
    case "register-layer": {
      const attributionMissing = (
        command.layer.kind === "external-context" || command.layer.kind === "suggestion"
      ) && !command.layer.attribution?.trim();
      if (
        !command.layer.id.trim()
        || !command.layer.source.trim()
        || attributionMissing
        || !layerStatusIsCoherent(command.layer.status, command.layer.error)
      ) {
        return rejected(workspace, "invalid-command", "La capa no declara identidad, fuente y atribución requeridas.");
      }
      if (workspace.layers[command.layer.id]) {
        return rejected(workspace, "invalid-command", "La capa ya está registrada.");
      }
      return accepted({
        ...workspace,
        layers: {
          ...workspace.layers,
          [command.layer.id]: cloneLayer(command.layer),
        },
      });
    }
    case "set-layer-status": {
      const layer = workspace.layers[command.id];
      if (!layer) return rejected(workspace, "invalid-command", "La capa solicitada no está registrada.");
      const error = command.error === undefined
        ? (command.status === "error" ? layer.error : null)
        : command.error;
      if (!layerStatusIsCoherent(command.status, error)) {
        return rejected(workspace, "invalid-command", "El estado de la capa y su error son incoherentes.");
      }
      return accepted({
        ...workspace,
        layers: {
          ...workspace.layers,
          [command.id]: {
            ...layer,
            status: command.status,
            observedAt: command.observedAt === undefined ? layer.observedAt : command.observedAt,
            version: command.version === undefined ? layer.version : command.version,
            error,
          },
        },
      });
    }
    case "set-layer-visibility": {
      const layer = workspace.layers[command.id];
      if (!layer) return rejected(workspace, "invalid-command", "La capa solicitada no está registrada.");
      return accepted({
        ...workspace,
        layers: {
          ...workspace.layers,
          [command.id]: { ...layer, visible: command.visible },
        },
      });
    }
    case "begin-edit":
      if (!command.transactionId.trim() || command.fieldId !== workspace.fieldId) {
        return rejected(workspace, "invalid-command", "La transacción no pertenece al fundo del workspace.");
      }
      if (workspace.activeTransactionId && workspace.activeTransactionId !== command.transactionId) {
        return rejected(workspace, "transaction-active", "Ya existe una edición estructural activa.");
      }
      return accepted({ ...workspace, activeTransactionId: command.transactionId });
    case "finish-edit":
      if (!command.transactionId.trim() || workspace.activeTransactionId !== command.transactionId) {
        return rejected(workspace, "invalid-command", "La transacción no pertenece a este workspace.");
      }
      return accepted({ ...workspace, activeTransactionId: null });
  }
}

function accepted(workspace: MapWorkspace): MapWorkspaceTransition {
  return { ok: true, workspace: freezeWorkspace(workspace) };
}

function rejected(
  workspace: MapWorkspace,
  code: "invalid-command" | "transaction-active",
  message: string,
): MapWorkspaceTransition {
  return { ok: false, workspace, error: { code, message } };
}

function cloneViewport(viewport: MapViewport): MapViewport {
  return Object.freeze({
    center: Object.freeze([viewport.center[0], viewport.center[1]]) as readonly [number, number],
    zoom: viewport.zoom,
  });
}

function cloneLayer(layer: MapLayerDescriptor): MapLayerDescriptor {
  return Object.freeze({ ...layer });
}

function layerStatusIsCoherent(status: MapLayerStatus, error: string | null): boolean {
  return status === "error" ? Boolean(error?.trim()) : error === null;
}

function freezeWorkspace(workspace: MapWorkspace): MapWorkspace {
  if (Object.isFrozen(workspace)) return workspace;
  Object.freeze(workspace.selectedPaddockIds);
  if (!Object.isFrozen(workspace.viewport.center)) Object.freeze(workspace.viewport.center);
  if (!Object.isFrozen(workspace.viewport)) Object.freeze(workspace.viewport);
  Object.values(workspace.filters).forEach((values) => Object.freeze(values));
  Object.freeze(workspace.filters);
  Object.values(workspace.layers).forEach((layer) => Object.freeze(layer));
  Object.freeze(workspace.layers);
  return Object.freeze(workspace);
}
