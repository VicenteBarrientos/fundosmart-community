"use client";

import {
  ArrowRight,
  Check,
  LoaderCircle,
  MessageCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import {
  resolveAssistantConfirmation,
  sendAssistantTurn,
} from "./api/assistant-client";
import type {
  AssistantConfirmationAction,
  AssistantContext,
  AssistantLink,
  AssistantProposedAction,
  AssistantReply,
} from "./domain/types";

type AsistenteFundoSmartProps = {
  context: AssistantContext;
};

type ConversationMessage = {
  id: number;
  role: "assistant" | "user";
  content: string;
  links?: AssistantLink[];
  proposedAction?: AssistantProposedAction;
  suggestions?: string[];
};

type ConfirmationState = {
  action?: AssistantConfirmationAction;
  pending: boolean;
};

const QUICK_PROMPTS = [
  "¿Qué requiere atención hoy?",
  "Resume la producción de leche",
  "Ver próximos vencimientos PABCO",
];

const INITIAL_MESSAGE: ConversationMessage = {
  content:
    "Hola, soy el asistente de FundoSmart. Puedo responder preguntas sobre el campo y preparar tareas para que las confirmes antes de ejecutarlas.",
  id: 0,
  role: "assistant",
  suggestions: QUICK_PROMPTS,
};

export function AsistenteFundoSmart({
  context,
}: AsistenteFundoSmartProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([
    INITIAL_MESSAGE,
  ]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<
    Record<string, ConfirmationState>
  >({});
  const nextMessageId = useRef(1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const sendingRef = useRef(sending);
  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  const closePanel = useCallback(() => {
    if (sendingRef.current) return;
    setOpen(false);
  }, []);
  useDialogA11y(panelRef, closePanel, open);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() =>
      composerRef.current?.focus(),
    );

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    logRef.current?.scrollTo({
      behavior: "smooth",
      top: logRef.current.scrollHeight,
    });
  }, [messages, open, sending]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  function nextId() {
    const id = nextMessageId.current;
    nextMessageId.current += 1;
    return id;
  }

  function appendReply(reply: AssistantReply) {
    setMessages((current) => [
      ...current,
      {
        content: reply.message,
        id: nextId(),
        links: reply.links,
        proposedAction: reply.proposedAction,
        role: "assistant",
        suggestions: reply.suggestions,
      },
    ]);
  }

  function openPanel() {
    setOpen(true);
  }

  async function submitMessage(message: string) {
    const normalizedMessage = message.trim();
    if (!normalizedMessage || sending) return;

    const userMessage: ConversationMessage = {
      content: normalizedMessage,
      id: nextId(),
      role: "user",
    };
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError(null);
    setSending(true);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      appendReply(
        await sendAssistantTurn(
          { context, message: normalizedMessage },
          controller.signal,
        ),
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : "No fue posible consultar al asistente.",
        );
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
      }
      setSending(false);
    }
  }

  async function decideAction(
    proposedAction: AssistantProposedAction,
    action: AssistantConfirmationAction,
  ) {
    if (sending || confirmations[proposedAction.confirmationId]?.action) return;
    if (action === "cancel") {
      setConfirmations((current) => ({
        ...current,
        [proposedAction.confirmationId]: { action, pending: false },
      }));
      appendReply({
        message: "Tarea cancelada. No guardé ningún cambio.",
        suggestions: ["¿Qué requiere atención hoy?"],
      });
      return;
    }
    setError(null);
    setSending(true);
    setConfirmations((current) => ({
      ...current,
      [proposedAction.confirmationId]: { pending: true },
    }));
    const controller = new AbortController();
    requestController.current = controller;
    try {
      appendReply(
        await resolveAssistantConfirmation(
          { confirmationId: proposedAction.confirmationId },
          controller.signal,
        ),
      );
      setConfirmations((current) => ({
        ...current,
        [proposedAction.confirmationId]: { action, pending: false },
      }));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error
            ? cause.message
            : "No fue posible procesar la confirmación.",
        );
      }
      setConfirmations((current) => ({
        ...current,
        [proposedAction.confirmationId]: { pending: false },
      }));
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
      }
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    void submitMessage(draft);
  }

  return (
    <>
      <button
        aria-controls="fundosmart-assistant-panel"
        aria-expanded={open}
        aria-label="Abrir asistente"
        className={`fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-[2000] grid size-12 place-items-center rounded-2xl bg-ink text-white shadow-[0_14px_38px_rgba(20,59,43,0.28)] transition hover:-translate-y-0.5 hover:bg-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent lg:bottom-5 lg:right-6 ${open ? "pointer-events-none opacity-0" : "opacity-100"}`}
        onClick={openPanel}
        ref={triggerRef}
        tabIndex={open ? -1 : 0}
        type="button"
      >
        <MessageCircle size={21} strokeWidth={2.2} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[2100] flex justify-end bg-chrome/45 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closePanel();
          }}
          role="presentation"
        >
          <div
            aria-describedby="fundosmart-assistant-description"
            aria-labelledby="fundosmart-assistant-title"
            aria-modal="true"
            className="flex h-full w-full flex-col bg-bg-steel shadow-[-20px_0_55px_rgba(11,31,23,0.22)] sm:max-w-md"
            id="fundosmart-assistant-panel"
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
          >
            <header className="flex items-start gap-3 border-b border-line-steel bg-ink px-4 py-4 text-white sm:px-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-ink">
                <Sparkles size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-black uppercase tracking-[0.16em] text-white/50">
                  Ayuda dentro del producto
                </p>
                <h2
                  className="mt-1 text-base font-black tracking-[-0.03em]"
                  id="fundosmart-assistant-title"
                >
                  Asistente FundoSmart
                </h2>
                <p
                  className="mt-0.5 truncate text-[12px] font-semibold text-white/55"
                  id="fundosmart-assistant-description"
                >
                  {context.fieldName ?? "Todos los fundos"}
                  {context.isDemo ? " · Cuenta demo" : ""}
                </p>
              </div>
              <button
                aria-label="Cerrar asistente"
                className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/15 disabled:cursor-wait disabled:opacity-45"
                disabled={sending}
                onClick={closePanel}
                type="button"
              >
                <X size={18} />
              </button>
            </header>

            <div
              aria-live="polite"
              aria-relevant="additions"
              className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5"
              ref={logRef}
              role="log"
            >
              {messages.map((message) => (
                <MessageBubble
                  confirmation={
                    message.proposedAction
                      ? confirmations[message.proposedAction.confirmationId]
                      : undefined
                  }
                  disabled={sending}
                  key={message.id}
                  message={message}
                  onDecision={decideAction}
                  onSuggestion={submitMessage}
                />
              ))}

              {sending && (
                <div
                  className="flex items-center gap-2 text-xs font-bold text-ink-muted"
                  role="status"
                >
                  <LoaderCircle
                    aria-hidden="true"
                    className="animate-spin text-accent"
                    size={16}
                  />
                  Procesando…
                </div>
              )}
            </div>

            <div className="border-t border-line-steel bg-white p-3 sm:p-4">
              {error && (
                <div
                  className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-bold text-red-700"
                  role="alert"
                >
                  <span>{error}</span>
                  <button
                    aria-label="Descartar error"
                    className="grid size-7 shrink-0 place-items-center rounded-lg hover:bg-red-100"
                    onClick={() => setError(null)}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
              <form className="flex items-end gap-2" onSubmit={submit}>
                <label className="min-w-0 flex-1">
                  <span className="sr-only">Escribe tu pregunta o tarea</span>
                  <textarea
                    className="max-h-32 min-h-11 w-full resize-none rounded-xl border border-line-steel bg-surface-alt px-3 py-3 text-xs font-medium text-ink outline-none transition placeholder:text-ink-subtle focus:border-accent focus:bg-white focus:ring-3 focus:ring-accent/10 disabled:opacity-55"
                    disabled={sending}
                    maxLength={600}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Pregunta o prepara una tarea…"
                    ref={composerRef}
                    rows={1}
                    value={draft}
                  />
                </label>
                <button
                  aria-label="Enviar mensaje"
                  className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-white shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={sending || draft.trim().length === 0}
                  type="submit"
                >
                  {sending ? (
                    <LoaderCircle className="animate-spin" size={17} />
                  ) : (
                    <Send size={17} />
                  )}
                </button>
              </form>
              <p className="mt-2 text-center text-[12px] font-semibold text-ink-subtle">
                Enter envía · Shift+Enter agrega una línea
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({
  confirmation,
  disabled,
  message,
  onDecision,
  onSuggestion,
}: {
  confirmation?: ConfirmationState;
  disabled: boolean;
  message: ConversationMessage;
  onDecision: (
    proposedAction: AssistantProposedAction,
    action: AssistantConfirmationAction,
  ) => Promise<void>;
  onSuggestion: (suggestion: string) => Promise<void>;
}) {
  const assistant = message.role === "assistant";
  return (
    <article
      aria-label={assistant ? "Respuesta del asistente" : "Tu mensaje"}
      className={`max-w-[92%] ${assistant ? "mr-auto" : "ml-auto"}`}
    >
      <div
        className={`rounded-2xl px-3.5 py-3 text-xs font-medium leading-5 shadow-sm ${
          assistant
            ? "rounded-tl-md border border-line-steel bg-white text-ink-muted"
            : "rounded-tr-md bg-ink text-white"
        }`}
      >
        {message.content}
      </div>

      {message.links && message.links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.links.filter(isProductLink).map((link) => (
            <a
              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line-steel bg-white px-3 text-[12px] font-black text-ink hover:bg-surface-alt"
              href={link.href}
              key={`${link.href}-${link.label}`}
            >
              {link.label} <ArrowRight size={12} />
            </a>
          ))}
        </div>
      )}

      {message.proposedAction && (
        <ActionConfirmation
          confirmation={confirmation}
          disabled={disabled}
          onDecision={onDecision}
          proposedAction={message.proposedAction}
        />
      )}

      {message.suggestions && message.suggestions.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {message.suggestions.slice(0, 4).map((suggestion) => (
            <button
              className="min-h-10 rounded-xl border border-line-steel bg-white px-3 py-2 text-left text-[12px] font-black leading-4 text-ink-muted transition hover:border-accent hover:bg-surface-alt disabled:opacity-45"
              disabled={disabled}
              key={suggestion}
              onClick={() => void onSuggestion(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function ActionConfirmation({
  confirmation,
  disabled,
  onDecision,
  proposedAction,
}: {
  confirmation?: ConfirmationState;
  disabled: boolean;
  onDecision: (
    proposedAction: AssistantProposedAction,
    action: AssistantConfirmationAction,
  ) => Promise<void>;
  proposedAction: AssistantProposedAction;
}) {
  const decided = confirmation?.action;
  return (
    <section
      aria-label="Confirmación requerida"
      className="mt-3 rounded-2xl border border-line-steel bg-surface-alt p-3"
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-accent">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-black uppercase tracking-[0.13em] text-accent">
            Confirmación requerida
          </p>
          <h3 className="mt-1 text-xs font-black text-ink">
            {proposedAction.title}
          </h3>
          {proposedAction.description && (
            <p className="mt-1 text-[12px] leading-4 text-ink-muted">
              {proposedAction.description}
            </p>
          )}
        </div>
      </div>

      {proposedAction.details && proposedAction.details.length > 0 && (
        <dl className="mt-3 divide-y divide-line-steel rounded-xl border border-line-steel bg-white px-3">
          {proposedAction.details.map((detail) => (
            <div
              className="flex items-start justify-between gap-3 py-2 text-[12px]"
              key={`${detail.label}-${detail.value}`}
            >
              <dt className="font-bold text-ink-subtle">{detail.label}</dt>
              <dd className="text-right font-black text-ink-muted">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {decided ? (
        <p
          className="mt-3 flex min-h-10 items-center gap-2 rounded-xl bg-white px-3 text-[12px] font-black text-accent"
          role="status"
        >
          <Check size={14} />
          {decided === "confirm" ? "Tarea confirmada" : "Tarea cancelada"}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            className="min-h-11 rounded-xl border border-line-steel bg-white px-3 text-[12px] font-black text-ink-muted disabled:cursor-wait disabled:opacity-45"
            disabled={disabled || confirmation?.pending}
            onClick={() => void onDecision(proposedAction, "cancel")}
            type="button"
          >
            {proposedAction.cancelLabel ?? "Cancelar"}
          </button>
          <button
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-3 text-[12px] font-black text-white disabled:cursor-wait disabled:opacity-45"
            disabled={disabled || confirmation?.pending}
            onClick={() => void onDecision(proposedAction, "confirm")}
            type="button"
          >
            {confirmation?.pending ? (
              <LoaderCircle className="animate-spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            {proposedAction.confirmLabel ?? "Confirmar"}
          </button>
        </div>
      )}
    </section>
  );
}

function isProductLink(link: AssistantLink): boolean {
  return link.href === "/app" || link.href.startsWith("/app/");
}
