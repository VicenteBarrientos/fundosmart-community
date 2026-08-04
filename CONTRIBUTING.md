# Contribuir a FundoSmart

Gracias por ayudar a construir una plataforma agrícola abierta para Latinoamérica. Buscamos cambios pequeños, verificables y respetuosos de los datos de productores.

## Antes de comenzar

1. Busca una discusión o issue existente.
2. Para una corrección acotada, abre directamente un pull request.
3. Para una capacidad nueva, un cambio de contrato público, migración o decisión de arquitectura, abre primero una propuesta. Explica el problema, los usuarios afectados, compatibilidad, riesgos y alternativa de rollback.

No uses GitHub Issues para vulnerabilidades ni incidentes con datos. Sigue [SECURITY.md](SECURITY.md).

## Desarrollo

Requisitos: Node.js `>=22.13.0` y npm `10.9.3`, la versión fijada por el lockfile.

```bash
npm ci
npm run dev:init
npm run dev
```

`dev:init` genera secretos locales válidos sin imprimirlos y no sobrescribe `.dev.vars`. Nunca reutilices un secreto de staging o producción. Las conexiones externas están inventariadas en [Servicios externos y configuración](docs/operacion/servicios-externos-y-configuracion.md).

La aplicación local usa D1 emulada y datos de demostración. Nunca conectes las pruebas a una base, bucket, identidad o dominio de FundoSmart Cloud.

Durante el desarrollo ejecuta las pruebas específicas del comportamiento que cambiaste. Antes de entregar un cambio de código ejecuta, según corresponda:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:built
npm run deploy:check:built
npm audit
```

Los cambios solo de documentación no necesitan reconstruir el producto.

## Datos y privacidad

Solo se aceptan fixtures evidentemente ficticios. Está prohibido versionar:

- correos, RUT, nombres o identificadores de personas reales;
- coordenadas, inventarios, liquidaciones, costos o documentos de un predio real;
- tokens, secretos, cookies, bases, respaldos, logs o artefactos de soporte;
- material de terceros que no permita su redistribución.

Reduce un caso real a un ejemplo sintético mínimo. Si no puedes demostrar que un dato es publicable, no lo incluyas.

## Compatibilidad

- El núcleo mantiene aislamiento por organización y fundo, autorización interna y auditoría.
- Las migraciones nuevas deben ser aditivas, repetibles en el entorno previsto y contar con rollback operativo.
- Una API o evento público usa versión explícita y política de deprecación.
- Una extensión no recibe acceso directo a D1/R2 ni secretos de la instancia: trabaja mediante capacidades y contratos públicos.
- No se retira ni degrada una función existente sin una decisión explícita y documentada.

## Pull requests

Un pull request debe indicar qué cambia, por qué, cómo se verificó, efectos en seguridad/datos, documentación actualizada y capturas cuando modifica UI. Mantén los commits enfocados y no mezcles refactors no relacionados.

Al contribuir aceptas que tu aporte se distribuya bajo `AGPL-3.0-only`. Cada commit debe incluir la certificación Developer Certificate of Origin:

```bash
git commit -s -m "tipo(área): descripción"
```

La línea `Signed-off-by` declara que tienes derecho a aportar el trabajo bajo la licencia del proyecto. Consulta [developercertificate.org](https://developercertificate.org/) para el texto completo de DCO 1.1.

## Idioma y documentación

La experiencia y la documentación de negocio se mantienen principalmente en español. Los nombres técnicos pueden estar en inglés cuando coinciden con estándares o APIs. Toda decisión operativa o arquitectónica nueva debe enlazarse desde [`docs/index.md`](docs/index.md).
