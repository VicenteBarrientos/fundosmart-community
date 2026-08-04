/* Geometría de los globos de ayuda, separada del componente para poder probarla
   sin DOM (mismo criterio que table-explorer.mjs junto a TableExplorer.tsx). */

export const HINT_BUBBLE_WIDTH = 264;
/* Bajo este margen superior el globo no cabe arriba y se dibuja hacia abajo.
   Cubre el caso de la barra de navegación fija, que vive pegada al borde. */
export const HINT_FLIP_THRESHOLD = 140;
const EDGE_MARGIN = 10;
const ANCHOR_GAP = 8;

/**
 * Sitúa el globo respecto de su anclaje, en coordenadas de ventana.
 *
 * @param {{ top: number, bottom: number, left: number, width: number }} anchor
 *   Rectángulo del elemento que dispara la ayuda.
 * @param {number} viewportWidth Ancho visible, sin barra de desplazamiento.
 * @returns {{ top: number, left: number, side: "top" | "bottom" }}
 *   `left` es el centro del globo: el componente lo compensa con translateX(-50%).
 */
export function positionHintBubble(anchor, viewportWidth) {
  const side = anchor.top < HINT_FLIP_THRESHOLD ? "bottom" : "top";
  const half = Math.min(HINT_BUBBLE_WIDTH, viewportWidth - 2 * EDGE_MARGIN) / 2;
  const minLeft = half + EDGE_MARGIN;
  /* En ventanas más angostas que el globo, `maxLeft` caería por debajo de
     `minLeft`; conservar el mínimo evita un rango invertido. */
  const maxLeft = Math.max(minLeft, viewportWidth - half - EDGE_MARGIN);
  const centre = anchor.left + anchor.width / 2;
  return {
    top: side === "bottom" ? anchor.bottom + ANCHOR_GAP : anchor.top - ANCHOR_GAP,
    left: Math.min(Math.max(centre, minLeft), maxLeft),
    side,
  };
}
