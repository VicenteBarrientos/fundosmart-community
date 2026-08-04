# Corpus geométrico de mapa v2

Este directorio contiene el corpus sintético y determinista de MAP-002.
No incluye geometrías, nombres ni identificadores de fundos reales.

## Contrato

- Versión: `fundosmart.map-geometry-corpus.v2`.
- Coordenadas canónicas de aplicación: `[latitud, longitud]`.
- Coordenadas GeoJSON: `[longitud, latitud]`.
- Procedencia de todos los casos: `synthetic`.
- `MAP_GEOMETRY_CORPUS_MANIFEST` es el inventario bloqueante y enlaza cada
  escenario con la cobertura que aporta.
- MAP-404 resuelve las subdivisiones de cuatro y seis intersecciones. Los casos
  `subdivision-partial-tail` y `subdivision-atomic-failure` fijan el contrato
  transaccional: si una cuerda interior no puede aplicarse, no se conserva
  ninguna pieza parcial.

El salto de `v1` a `v2` es deliberado: el escenario
`subdivision-four-plus-intersections` pasó de limitación conocida a
`blocking-pass`.

`createCorpusPaddockGrid()` produce 200 potreros contiguos. La función
`createNearBudgetImportFeatureCollection()` produce exactamente 500 features y
99.500 vértices brutos, justo por debajo del límite de 100.000.

Los archivos bajo `golden/` son salidas exactas de los serializadores GeoJSON y
KML vigentes. No se regeneran automáticamente: cualquier cambio exige revisar
el round-trip y aceptar explícitamente el nuevo contrato.

## Uso

```js
import {
  MAP_GEOMETRY_CASES,
  MAP_GEOMETRY_CORPUS_MANIFEST,
  createCorpusPaddockGrid,
} from "./tests/fixtures/map-geometry-corpus/index.mjs";
```

La prueba funcional canónica es `tests/map-geometry-corpus.test.mjs`.
