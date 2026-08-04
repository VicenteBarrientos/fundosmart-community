import assert from "node:assert/strict";
import test from "node:test";
import {
  HINT_BUBBLE_WIDTH,
  HINT_FLIP_THRESHOLD,
  positionHintBubble,
} from "../src/ui/hint-position.mjs";

const VIEWPORT = 1280;
const half = HINT_BUBBLE_WIDTH / 2;

function anchorAt({ top = 400, left = 600, width = 80, height = 32 } = {}) {
  return { top, bottom: top + height, left, width };
}

test("el globo se centra sobre su anclaje cuando hay espacio de sobra", () => {
  const position = positionHintBubble(anchorAt({ left: 600, width: 80 }), VIEWPORT);
  assert.equal(position.left, 640);
  assert.equal(position.side, "top");
  assert.equal(position.top, 392);
});

test("un anclaje pegado al borde superior dibuja el globo hacia abajo", () => {
  const barraFija = anchorAt({ top: 10, height: 44 });
  const position = positionHintBubble(barraFija, VIEWPORT);
  assert.equal(position.side, "bottom");
  assert.equal(position.top, 62);

  const justoBajoElUmbral = positionHintBubble(anchorAt({ top: HINT_FLIP_THRESHOLD - 1 }), VIEWPORT);
  assert.equal(justoBajoElUmbral.side, "bottom");
  const justoEnElUmbral = positionHintBubble(anchorAt({ top: HINT_FLIP_THRESHOLD }), VIEWPORT);
  assert.equal(justoEnElUmbral.side, "top");
});

test("el globo nunca se sale por el borde derecho ni por el izquierdo", () => {
  const alaDerecha = positionHintBubble(anchorAt({ left: VIEWPORT - 40, width: 36 }), VIEWPORT);
  assert.ok(alaDerecha.left + half <= VIEWPORT, "el borde derecho del globo entra en la ventana");
  assert.equal(alaDerecha.left, VIEWPORT - half - 10);

  const alaIzquierda = positionHintBubble(anchorAt({ left: 2, width: 36 }), VIEWPORT);
  assert.ok(alaIzquierda.left - half >= 0, "el borde izquierdo del globo entra en la ventana");
  assert.equal(alaIzquierda.left, half + 10);
});

test("en ventanas angostas el globo se encoge y sigue cabiendo", () => {
  /* El globo se estrecha con la ventana, así que en un teléfono angosto los dos
     extremos convergen al centro disponible en vez de salirse de la pantalla. */
  for (const ancho of [320, 280, 240, 180]) {
    const mitad = Math.min(HINT_BUBBLE_WIDTH, ancho - 20) / 2;
    const izquierda = positionHintBubble(anchorAt({ left: 0, width: 20 }), ancho);
    const derecha = positionHintBubble(anchorAt({ left: ancho - 20, width: 20 }), ancho);
    for (const position of [izquierda, derecha]) {
      assert.ok(position.left - mitad >= 0, `cabe por la izquierda en ${ancho} px`);
      assert.ok(position.left + mitad <= ancho, `cabe por la derecha en ${ancho} px`);
    }
    assert.ok(izquierda.left <= derecha.left, `el rango no se invierte en ${ancho} px`);
  }
});

test("el ancho declarado coincide con el que usa la hoja de estilos", () => {
  assert.equal(HINT_BUBBLE_WIDTH, 264);
});
