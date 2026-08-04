"use client";

import { Info } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HELP, type HelpKey } from "./help-copy";
import { HINT_BUBBLE_WIDTH, positionHintBubble } from "./hint-position.mjs";

/* Globos de ayuda de FundoSmart.
 *
 * Tres formas de uso, según lo que ya exista en pantalla:
 *
 *   <HelpTip help="ndvi" />                 marcador ⓘ junto a un título o etiqueta
 *   <Hint help="navGanado">…</Hint>         envuelve un elemento que ya existe
 *   <button data-hint="…">                  solo CSS, ver app/globals.css
 *
 * `HelpTip` y `Hint` dibujan el globo en un portal sobre `document.body`, así que
 * no se recortan dentro de barras con scroll horizontal ni de tarjetas con
 * `overflow` oculto. El atributo `data-hint` es más barato pero sí se recorta:
 * úsalo solo donde el contenedor no corte.
 *
 * `HelpTip` además abre con clic, que es la única forma de consultarlo en un
 * teléfono; `Hint` responde a cursor y foco de teclado, y deja el texto
 * disponible para lectores de pantalla. */

type BubblePosition = { top: number; left: number; side: "top" | "bottom" };

function measureAnchor(node: HTMLElement): BubblePosition {
  return positionHintBubble(node.getBoundingClientRect(), document.documentElement.clientWidth);
}

/** Estado compartido por `Hint` y `HelpTip`: mide el anclaje al abrir y cierra
 *  solo con Escape, scroll o cambio de tamaño de la ventana. */
function useBubble() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<BubblePosition | null>(null);

  const open = useCallback(() => {
    if (anchorRef.current) setPosition(measureAnchor(anchorRef.current));
  }, []);
  const close = useCallback(() => setPosition(null), []);
  const toggle = useCallback(() => {
    setPosition((current) => (current ? null : anchorRef.current ? measureAnchor(anchorRef.current) : null));
  }, []);

  useEffect(() => {
    if (!position) return;
    const dismiss = () => setPosition(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPosition(null);
    };
    const reposition = () => {
      if (anchorRef.current) setPosition(measureAnchor(anchorRef.current));
    };
    /* El scroll se escucha en captura para enterarse también de contenedores
       internos, como las barras de pestañas con desplazamiento horizontal. */
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [position]);

  return { anchorRef, position, open, close, toggle };
}

function Bubble({ id, position, text }: { id?: string; position: BubblePosition; text: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <span
      className="pointer-events-none fixed z-[2000] block rounded-card border border-white/15 bg-chrome px-3 py-2 text-[12px] font-semibold leading-[1.35] text-white shadow-[0_10px_30px_rgba(9,20,15,0.34)]"
      id={id}
      role="tooltip"
      style={{
        top: position.top,
        left: position.left,
        maxWidth: `min(${HINT_BUBBLE_WIDTH}px, calc(100vw - 20px))`,
        transform: position.side === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      }}
    >
      {text}
    </span>,
    document.body,
  );
}

function resolve(help: HelpKey | undefined, text: string | undefined): string | undefined {
  return text ?? (help ? HELP[help] : undefined);
}

type HelpTipProps = {
  /** Clave del glosario en `src/ui/help-copy.ts`. */
  help?: HelpKey;
  /** Texto libre, cuando la descripción depende de datos y no cabe en el glosario. */
  text?: string;
  /** Qué se está explicando; entra en la etiqueta accesible del botón. */
  label: string;
  /** `inverse` para fondos oscuros. */
  tone?: "default" | "muted" | "inverse";
  className?: string;
};

/** Marcador ⓘ para poner junto a un título, una etiqueta o el nombre de un
 *  indicador. Se abre con cursor, con foco de teclado y con clic (necesario en
 *  pantallas táctiles). */
export function HelpTip({ help, text, label, tone = "default", className }: HelpTipProps) {
  const content = resolve(help, text);
  const bubbleId = useId();
  const { anchorRef, position, open, close, toggle } = useBubble();
  if (!content) return null;

  const toneClass =
    tone === "inverse"
      ? "text-white/55 hover:text-white"
      : tone === "muted"
        ? "text-ink-subtle hover:text-accent"
        : "text-ink-subtle hover:text-accent";

  return (
    <button
      aria-describedby={position ? bubbleId : undefined}
      aria-expanded={Boolean(position)}
      aria-label={`Qué significa ${label}`}
      className={`inline-grid size-5 shrink-0 place-items-center rounded-tag align-middle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${toneClass} ${className ?? ""}`}
      onBlur={close}
      onClick={(event) => {
        /* Dentro de un <label> que envuelve su control, un clic aquí activaría
           también ese control. El botón no navega ni envía, así que cancelarlo
           no cuesta nada. */
        event.preventDefault();
        toggle();
      }}
      onFocus={open}
      onPointerEnter={open}
      onPointerLeave={close}
      ref={anchorRef as React.RefObject<HTMLButtonElement>}
      type="button"
    >
      <Info aria-hidden="true" size={14} />
      {position ? <Bubble id={bubbleId} position={position} text={content} /> : null}
    </button>
  );
}

type HintProps = {
  help?: HelpKey;
  text?: string;
  children: ReactNode;
  /** Clases del envoltorio. Debe reproducir el papel que el hijo tenía en el
   *  layout (`flex`, `shrink-0`, `contents` no sirve porque no se puede medir). */
  className?: string;
};

/** Envuelve un elemento que ya existe —un enlace de menú, una pestaña, un botón
 *  de barra de herramientas— y le añade la descripción al pasar el cursor o al
 *  llegar con el teclado. El texto queda además accesible para lectores de
 *  pantalla, sin ocupar espacio visible. */
export function Hint({ help, text, children, className }: HintProps) {
  const content = resolve(help, text);
  const { anchorRef, position, open, close } = useBubble();
  if (!content) return <>{children}</>;

  return (
    <span
      className={className ?? "inline-flex"}
      onBlur={close}
      onFocus={open}
      onPointerEnter={open}
      onPointerLeave={close}
      ref={anchorRef as React.RefObject<HTMLSpanElement>}
    >
      {children}
      <span className="sr-only">{content}</span>
      {position ? <Bubble position={position} text={content} /> : null}
    </span>
  );
}

/** Descripción visible bajo un título. Se usa donde el globo no basta: pantallas
 *  táctiles, menús largos y la primera visita a un módulo. */
export function HelpNote({ help, text, className }: { help?: HelpKey; text?: string; className?: string }) {
  const content = resolve(help, text);
  if (!content) return null;
  return <p className={`text-[12px] leading-[1.45] text-ink-subtle ${className ?? ""}`}>{content}</p>;
}
