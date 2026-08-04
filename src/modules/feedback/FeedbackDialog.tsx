"use client";

import {
  AlertCircle,
  Bug,
  CheckCircle2,
  Lightbulb,
  LoaderCircle,
  MessageSquareHeart,
  MessageSquarePlus,
  Send,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_IMPACT_LABELS,
  type FeedbackCategory,
  type FeedbackImpact,
} from "./domain/types";

type FeedbackDialogProps = {
  isDemo?: boolean;
  onAfterClose?: () => void;
  onBeforeOpen?: () => void;
  variant?: "header" | "menu" | "onboarding";
};

const CATEGORY_OPTIONS: Array<{
  value: FeedbackCategory;
  icon: typeof Bug;
  description: string;
}> = [
  {
    value: "bug",
    icon: Bug,
    description: "Algo no funcionó como esperabas.",
  },
  {
    value: "improvement",
    icon: Lightbulb,
    description: "Una tarea podría ser más simple o rápida.",
  },
  {
    value: "recommendation",
    icon: MessageSquareHeart,
    description: "Quieres proponernos una capacidad nueva.",
  },
];

const IMPACT_OPTIONS = Object.entries(FEEDBACK_IMPACT_LABELS) as Array<[FeedbackImpact, string]>;

export function FeedbackDialog({
  isDemo = false,
  onAfterClose,
  onBeforeOpen,
  variant = "header",
}: FeedbackDialogProps) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory | null>(null);
  const [impact, setImpact] = useState<FeedbackImpact | null>(null);
  const [message, setMessage] = useState("");
  const [contactAllowed, setContactAllowed] = useState(false);
  const [online, setOnline] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; createdAt: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const submissionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const updateConnection = () => setOnline(window.navigator.onLine);
    updateConnection();
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (receipt) {
      successHeadingRef.current?.focus();
    } else {
      firstCategoryRef.current?.focus();
    }
  }, [open, receipt]);

  if (isDemo) return null;

  function openDialog() {
    onBeforeOpen?.();
    setError(null);
    setOpen(true);
  }

  function closeDialog() {
    if (sending) return;
    setOpen(false);
    window.setTimeout(() => {
      onAfterClose?.();
      triggerRef.current?.focus();
    }, 0);
  }

  function resetDialog() {
    setCategory(null);
    setImpact(null);
    setMessage("");
    setContactAllowed(false);
    setError(null);
    setReceipt(null);
    submissionKeyRef.current = null;
    window.setTimeout(() => firstCategoryRef.current?.focus(), 0);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!category) {
      setError("Selecciona el tipo de comentario.");
      firstCategoryRef.current?.focus();
      return;
    }
    if (!impact) {
      setError("Indica cuánto afecta esto a tu trabajo.");
      return;
    }
    if (message.trim().length < 10) {
      setError("Cuéntanos un poco más: escribe al menos 10 caracteres.");
      return;
    }
    if (!window.navigator.onLine) {
      setError("No tienes conexión. Mantendremos el texto aquí para que vuelvas a intentarlo.");
      return;
    }

    setSending(true);
    setError(null);
    submissionKeyRef.current ??= crypto.randomUUID();
    const url = new URL(window.location.href);
    const rawFieldId = url.searchParams.get("fieldId");
    const fieldId = rawFieldId && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/u.test(rawFieldId)
      ? rawFieldId
      : null;

    try {
      const response = await fetch("/app/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          category,
          impact,
          message,
          contactAllowed,
          submissionKey: submissionKeyRef.current,
          pagePath: window.location.pathname,
          fieldId,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          online: window.navigator.onLine,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: string;
        feedback?: { id?: string; createdAt?: string };
      } | null;
      if (!response.ok || !payload?.feedback?.id || !payload.feedback.createdAt) {
        throw new Error(payload?.error ?? "No fue posible enviar el comentario.");
      }
      setReceipt({
        id: payload.feedback.id,
        createdAt: payload.feedback.createdAt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible enviar el comentario.");
    } finally {
      setSending(false);
    }
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]',
    )].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <FeedbackTrigger
        onClick={openDialog}
        ref={triggerRef}
        variant={variant}
      />

      {open && createPortal(
        <div
          className="fixed inset-0 z-[2200] flex items-end justify-center bg-chrome/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeDialog();
          }}
          role="presentation"
        >
          <div
            aria-describedby="feedback-dialog-description"
            aria-labelledby="feedback-dialog-title"
            aria-modal="true"
            className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-bg-steel shadow-[0_24px_80px_rgba(11,31,23,0.28)] sm:max-h-[min(860px,calc(100dvh-2.5rem))] sm:max-w-2xl sm:rounded-[28px]"
            onKeyDown={handlePanelKeyDown}
            ref={panelRef}
            role="dialog"
          >
            <header className="flex items-start gap-3 border-b border-line-steel bg-ink px-5 py-4 text-white sm:px-6">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-white">
                <MessageSquarePlus size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-black uppercase tracking-[0.16em] text-white/50">
                  Tu experiencia importa
                </p>
                <h2 className="mt-1 text-lg font-black tracking-[-0.03em]" id="feedback-dialog-title">
                  Ayúdanos a mejorar FundoSmart
                </h2>
                <p className="mt-1 text-xs font-semibold leading-5 text-white/60" id="feedback-dialog-description">
                  Cuéntanos si encontraste un error, una mejora posible o una recomendación.
                </p>
              </div>
              <button
                aria-label="Cerrar comentarios"
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-white transition hover:bg-white/15 disabled:opacity-45"
                disabled={sending}
                onClick={closeDialog}
                type="button"
              >
                <X size={18} />
              </button>
            </header>

            {receipt ? (
              <div className="grid flex-1 place-items-center overflow-y-auto px-6 py-12 text-center">
                <div className="max-w-md">
                  <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-emerald/10 text-emerald">
                    <CheckCircle2 size={28} />
                  </span>
                  <h3
                    className="mt-5 text-2xl font-black tracking-[-0.04em] text-ink outline-none"
                    ref={successHeadingRef}
                    tabIndex={-1}
                  >
                    Gracias por ayudarnos
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-ink-muted">
                    Tu comentario quedó guardado y aparecerá en la bandeja de revisión de FundoSmart.
                    {contactAllowed ? " Si necesitamos más detalles, podremos escribirte." : ""}
                  </p>
                  <p className="mt-3 font-mono text-[11px] text-ink-subtle">
                    Referencia {receipt.id.slice(-12)}
                  </p>
                  <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">
                    <button
                      className="min-h-11 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-ink transition hover:bg-surface-alt"
                      onClick={resetDialog}
                      type="button"
                    >
                      Enviar otro comentario
                    </button>
                    <button
                      className="min-h-11 rounded-xl bg-ink px-5 text-xs font-black text-white transition hover:bg-chrome"
                      onClick={closeDialog}
                      type="button"
                    >
                      Listo
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <form className="flex-1 overflow-y-auto px-5 py-5 sm:px-6" onSubmit={submit}>
                <fieldset>
                  <legend className="text-sm font-black text-ink">¿Qué quieres contarnos?</legend>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {CATEGORY_OPTIONS.map((option, index) => {
                      const Icon = option.icon;
                      const selected = category === option.value;
                      return (
                        <button
                          aria-pressed={selected}
                          className={`min-h-[108px] rounded-2xl border p-3 text-left transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                            selected
                              ? "border-accent bg-accent/8 shadow-[0_0_0_1px_rgba(82,156,78,0.18)]"
                              : "border-line-steel bg-white hover:border-accent/40 hover:bg-surface-alt"
                          }`}
                          key={option.value}
                          onClick={() => setCategory(option.value)}
                          ref={index === 0 ? firstCategoryRef : undefined}
                          type="button"
                        >
                          <Icon className={selected ? "text-accent" : "text-ink-subtle"} size={19} />
                          <span className="mt-2 block text-xs font-black text-ink">
                            {FEEDBACK_CATEGORY_LABELS[option.value]}
                          </span>
                          <span className="mt-1 block text-[11px] font-semibold leading-4 text-ink-subtle">
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <fieldset className="mt-5">
                  <legend className="text-sm font-black text-ink">¿Cuánto te afecta?</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {IMPACT_OPTIONS.map(([value, label]) => (
                      <label
                        className={`cursor-pointer rounded-full border px-3 py-2 text-xs font-bold transition ${
                          impact === value
                            ? "border-ink bg-ink text-white"
                            : "border-line-steel bg-white text-ink-muted hover:border-ink/30"
                        }`}
                        key={value}
                      >
                        <input
                          checked={impact === value}
                          className="sr-only"
                          name="feedback-impact"
                          onChange={() => setImpact(value)}
                          type="radio"
                          value={value}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="mt-5 block">
                  <span className="text-sm font-black text-ink">
                    Cuéntanos qué pasó o qué te gustaría mejorar
                  </span>
                  <textarea
                    className="mt-2 min-h-32 w-full resize-y rounded-2xl border border-line-steel bg-white px-4 py-3 text-sm font-medium leading-6 text-ink outline-none transition placeholder:text-ink-subtle focus:border-accent focus:ring-3 focus:ring-accent/10"
                    maxLength={4000}
                    minLength={10}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder={
                      category === "bug"
                        ? "¿Qué estabas haciendo, qué esperabas y qué ocurrió?"
                        : "Describe la situación y cómo podría ayudarte el cambio."
                    }
                    required
                    value={message}
                  />
                  <span className="mt-1 block text-right text-[11px] font-semibold text-ink-subtle">
                    {message.length.toLocaleString("es-CL")} / 4.000
                  </span>
                </label>

                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-line-steel bg-white p-3.5">
                  <input
                    checked={contactAllowed}
                    className="mt-0.5 size-4 accent-emerald"
                    onChange={(event) => setContactAllowed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <span className="block text-xs font-black text-ink">
                      Pueden escribirme para pedir más detalles
                    </span>
                    <span className="mt-0.5 block text-[11px] font-semibold leading-4 text-ink-subtle">
                      Esta autorización es opcional y solo se usará para este comentario.
                    </span>
                  </span>
                </label>

                <div className="mt-4 flex items-start gap-2 rounded-2xl bg-band px-3.5 py-3 text-[11px] font-semibold leading-5 text-ink-muted">
                  <AlertCircle className="mt-0.5 shrink-0 text-accent" size={16} />
                  <p>
                    Incluiremos tu correo, organización, pantalla, dispositivo y versión de FundoSmart.
                    No capturaremos formularios, datos productivos ni imágenes.
                  </p>
                </div>

                {error && (
                  <div className="mt-4 rounded-xl border border-alert-bar/25 bg-alert-bar/8 px-3.5 py-3 text-xs font-bold text-alert-ink" role="alert">
                    {error}
                  </div>
                )}

                <div className="sticky bottom-0 -mx-5 mt-5 flex items-center justify-between gap-3 border-t border-line-steel bg-bg-steel/95 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 backdrop-blur sm:-mx-6 sm:px-6 sm:pb-4">
                  <span className={`text-[11px] font-bold ${online ? "text-ink-subtle" : "text-alert-ink"}`}>
                    {online ? "Conexión disponible" : "Sin conexión · tu texto sigue aquí"}
                  </span>
                  <button
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-xs font-black text-white shadow-sm transition hover:bg-emerald disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={sending || !online || !category || !impact || message.trim().length < 10}
                    type="submit"
                  >
                    {sending ? <LoaderCircle className="animate-spin" size={16} /> : <Send size={16} />}
                    {sending ? "Enviando…" : "Enviar comentario"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

type FeedbackTriggerProps = {
  onClick: () => void;
  variant: "header" | "menu" | "onboarding";
};

const FeedbackTrigger = function FeedbackTrigger({
  onClick,
  variant,
  ref,
}: FeedbackTriggerProps & { ref: React.Ref<HTMLButtonElement> }) {
  if (variant === "menu") {
    return (
      <button
        className="flex w-full items-center gap-3 rounded px-3 py-2.5 text-left text-sm text-white/70 transition hover:bg-white/[0.06] hover:text-white"
        onClick={onClick}
        ref={ref}
        type="button"
      >
        <MessageSquarePlus size={17} /> Enviar comentarios
      </button>
    );
  }
  if (variant === "onboarding") {
    return (
      <button
        className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-[11px] font-black text-ink-muted transition hover:border-accent hover:text-accent"
        onClick={onClick}
        ref={ref}
        type="button"
      >
        <MessageSquarePlus size={13} /> Pedir ayuda
      </button>
    );
  }
  return (
    <button
      aria-label="Enviar comentarios"
      className="hidden h-8 items-center gap-2 rounded px-2.5 text-xs font-bold text-white/75 transition hover:bg-white/10 hover:text-white sm:flex"
      data-hint="Informa un error, propón una mejora o déjanos una recomendación."
      data-hint-side="bottom"
      onClick={onClick}
      ref={ref}
      type="button"
    >
      <MessageSquarePlus size={17} />
      <span className="hidden xl:inline">Enviar comentarios</span>
    </button>
  );
};
