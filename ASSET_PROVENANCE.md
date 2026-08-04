# Procedencia de recursos visuales

Los recursos visuales de este repositorio son de primera parte. Salvo que se
indique lo contrario, se distribuyen bajo la misma licencia AGPL-3.0-only del
código. La licencia de copyright no concede derechos sobre las marcas; consulta
[TRADEMARKS.md](./TRADEMARKS.md).

## Fotografía de la portada comunitaria

`assets/brand/fundosmart-community-hero-source.png` se generó expresamente para este
repositorio el 4 de agosto de 2026 mediante la herramienta de generación de
imágenes de OpenAI, sin imágenes de entrada ni material de terceros. La misma
pieza se distribuye optimizada como
`public/landing/fundosmart-community-hero.webp` y se reutiliza en las secciones
fotográficas de la portada.

Prompt final:

> Fotografía editorial panorámica y fotorrealista de un rebaño Holstein sano
> pastando en el sur de Chile, con el volcán Osorno nevado al fondo, luz cálida
> de primera hora y espacio negativo para texto. Sin personas, edificios,
> vehículos, marcas, texto ni marcas de agua; anatomía y geografía plausibles.

## Marca y derivados

- Los SVG `public/fundosmart-ultra-min-*.svg` y
  `assets/brand/linkedin/*.svg` son fuentes editables de primera parte.
- Los PNG e ICO de marca se regeneran con
  `npm run assets:favicon` y `node scripts/assets/generate-brand-assets.mjs`.
- `public/og.png` se deriva de la fotografía comunitaria y del lockup SVG
  mediante `scripts/assets/generate-brand-assets.mjs`.

## Capturas del producto

`public/landing/product-overview.png` y
`public/landing/product-livestock.png` son capturas de la interfaz de la demo
sintética incluida en este repositorio. No contienen datos de clientes.
