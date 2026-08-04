import type {
  MapEditCommand,
  MapInteractionAdapter,
  MapInteractionAdapterLease,
} from "./interaction-contract";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { mapAdapterSnapshot, transitionMapEdit } from "./edit-transaction.ts";
import type { MapEditTransaction, MapEditTransition } from "./edit-transaction";

export type MapEditCommandFacade = Readonly<{
  read: () => MapEditTransaction;
  dispatch: (command: MapEditCommand) => MapEditTransition;
  connectAdapter: (adapter: MapInteractionAdapter) => MapAdapterConnection;
}>;

export type MapAdapterConnection =
  | Readonly<{ ok: true; lease: MapInteractionAdapterLease }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "adapter-mismatch" | "adapter-active" | "adapter-connect-failed";
        message: string;
      }>;
    }>;

/**
 * Thin command boundary used by UI, keyboard, GPS and interaction adapters.
 * Persistence remains a caller-owned effect after an accepted lifecycle step.
 */
export function createMapEditCommandFacade(
  initial: MapEditTransaction,
  publish: (transaction: MapEditTransaction) => void,
): MapEditCommandFacade {
  let current = initial;
  let connectedAdapterId: string | null = null;

  function dispatch(command: MapEditCommand): MapEditTransition {
    const transition = transitionMapEdit(current, command);
    if (transition.ok) {
      current = transition.transaction;
      publish(current);
    }
    return transition;
  }

  function connectAdapter(adapter: MapInteractionAdapter): MapAdapterConnection {
    if (adapter.id !== current.adapterId) {
      return {
        ok: false,
        error: {
          code: "adapter-mismatch",
          message: `La transacción está fijada al adapter ${current.adapterId}.`,
        },
      };
    }
    if (connectedAdapterId) {
      return {
        ok: false,
        error: {
          code: "adapter-active",
          message: `El adapter ${connectedAdapterId} ya está conectado.`,
        },
      };
    }

    let active = true;
    let adapterLease: MapInteractionAdapterLease;
    try {
      adapterLease = adapter.connect({
        read: () => mapAdapterSnapshot(current),
        dispatch: (command) => {
          if (!active) {
            return {
              ok: false,
              snapshot: mapAdapterSnapshot(current),
              error: { code: "adapter-disconnected", message: "El adapter ya fue desconectado." },
            };
          }
          const transition = dispatch(command);
          if (transition.ok) {
            return { ok: true, snapshot: mapAdapterSnapshot(transition.transaction) };
          }
          return {
            ok: false,
            snapshot: mapAdapterSnapshot(transition.transaction),
            error: transition.error,
          };
        },
      });
    } catch {
      return {
        ok: false,
        error: {
          code: "adapter-connect-failed",
          message: `El adapter ${adapter.id} no pudo conectarse.`,
        },
      };
    }
    connectedAdapterId = adapter.id;

    return {
      ok: true,
      lease: {
        disconnect: () => {
          if (!active) return;
          active = false;
          connectedAdapterId = null;
          adapterLease.disconnect();
        },
      },
    };
  }

  return {
    read: () => current,
    dispatch,
    connectAdapter,
  };
}
