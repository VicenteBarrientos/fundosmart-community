# FundoSmart Community

> Plataforma open source para la gestión agrícola, ganadera y lechera.

[Licencia AGPL-3.0](LICENSE) · [Avisos de terceros](THIRD_PARTY_NOTICES.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md) · [Gobierno](GOVERNANCE.md)

Este repositorio contiene el núcleo comunitario de FundoSmart: aplicación web, Worker, esquema D1, migraciones públicas, demo sintética y pruebas. El servicio administrado en `fundosmart.com` opera por separado; sus credenciales, infraestructura, datos y automatizaciones de publicación no forman parte de este repositorio.

## Qué incluye

- Dashboard operacional de ganado, leche, costos y alertas.
- Fundos y potreros con límites, actividades y subdivisiones persistentes.
- Ganado, lotes, pesajes, alimentación, ficha animal, reproducción y sanidad.
- Liquidaciones de leche y libro financiero ganadero separados.
- Membresías por organización, roles, capacidades y alcance por fundo.
- Importaciones auditables, trazabilidad, trabajo offline y recuperación.
- Demo de solo lectura con datos deterministas y completamente ficticios.

El núcleo usa [AGPL-3.0-only](LICENSE). Puedes estudiarlo, modificarlo, desplegarlo y redistribuirlo bajo esos términos. Si ofreces una versión modificada a través de una red, debes poner a disposición de sus usuarios el código fuente correspondiente. El uso del nombre y los logotipos se rige además por [TRADEMARKS.md](TRADEMARKS.md).

## Arquitectura

- Next.js 16 y React 19 sobre vinext/Vite.
- Cloudflare Worker con D1, R2 e Images; AI, correo y Analytics Engine son opcionales.
- Drizzle ORM con un baseline público consolidado y 81 invariantes SQL.
- Google OpenID Connect para identidad personal y sesiones propias en D1.
- Autorización interna por organización, rol y alcance territorial.

La [decisión de arquitectura](docs/architecture/0001-open-source-core-and-extensions.md) define la frontera entre núcleo, API, extensiones y servicio administrado. El [roadmap](docs/roadmap/ecosistema-open-source.md) ordena configuración, eventos, SDK y marketplace.

## Inicio rápido

Requisitos: Node.js `>=22.13.0` y npm `10.9.3` para reproducir exactamente el
lockfile multiplataforma.

```bash
git clone https://github.com/VicenteBarrientos/fundosmart-community.git
cd fundosmart-community
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

En PowerShell, reemplaza `cp` por:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Abre `http://localhost:3000/demo` para recorrer la demo o `http://localhost:3000/app` para usar la identidad local configurada en `.dev.vars`.

`predev` aplica las tres migraciones públicas exclusivamente a la D1 local en `.wrangler/state/`:

1. esquema actual generado desde `db/schema.ts`;
2. invariantes y triggers de integridad;
3. semilla demo sintética.

No se conecta a ninguna base remota. La semilla no contiene datos de clientes, coordenadas operativas ni historial privado.

## Configuración

Los valores no secretos están documentados en [.env.example](.env.example); los secretos y la identidad local, en [.dev.vars.example](.dev.vars.example). Ambos archivos reales están ignorados por Git.

Para desarrollo local bastan:

```dotenv
AUTH_ORIGIN=http://localhost:3000
DEV_AUTH_EMAIL=developer@example.com
DEV_AUTH_NAME=Desarrollador local
FUNDOSMART_OWNER_EMAIL=developer@example.com
```

Para un entorno remoto debes usar recursos y credenciales propios. `AUTH_ORIGIN` es obligatorio en producción y debe ser un origen HTTPS sin ruta, query ni fragmento. AI remoto, correo y telemetría están desactivados por omisión.

Consulta la [guía de autoalojamiento](docs/operacion/autoalojamiento.md) para la topología y variables completas. El repositorio no contiene un workflow de despliegue automático: cada operador debe revisar y aprobar su propia cadena de publicación.

## Calidad

```bash
npm run check
```

La barrera completa ejecuta ESLint, TypeScript, build, pruebas, empaquetado seco del Worker y auditoría de dependencias. También puedes ejecutar cada paso por separado:

```bash
npm run lint
npm run typecheck
npm test
npm run deploy:check
npm audit
```

`npm run deploy:check` usa `wrangler deploy --dry-run`; no publica ni modifica recursos. `npm run deploy` está bloqueado intencionalmente.

## Base de datos y demo

El esquema canónico vive en [db/schema.ts](db/schema.ts).

```bash
npm run db:generate
npm run db:bootstrap:generate
npm run db:migrations:local
npm run db:migrate:local
```

`db:bootstrap:generate` reconstruye `drizzle/0002_public_demo.sql` únicamente desde `src/modules/demo/data/demo-data.mjs`. El contrato de publicación exige procedencia `deterministic-synthetic` y prohíbe fuentes privadas.

## Participar

- Lee [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un cambio.
- Usa Issues para errores y propuestas sin datos sensibles.
- Reporta vulnerabilidades de forma privada según [SECURITY.md](SECURITY.md).
- Consulta [GOVERNANCE.md](GOVERNANCE.md) para roles y toma de decisiones.

Las contribuciones se aceptan bajo `AGPL-3.0-only` y certificación DCO. No subas correos personales, RUT, credenciales, respaldos, documentos ni datos agrícolas reales.

## Estructura

- `app/`: rutas, páginas, API y autenticación.
- `src/core/`: layout, tipos y servicios compartidos.
- `src/modules/`: módulos funcionales y repositorios de servidor.
- `db/` y `drizzle/`: esquema, invariantes y demo pública.
- `worker/`: entrada del Worker, seguridad, routing y tareas programadas.
- `tests/`: pruebas de dominio, integración, seguridad y portabilidad.
- `docs/`: arquitectura, autoalojamiento y roadmap comunitario.

## Licencia

Código fuente: [GNU Affero General Public License v3.0](LICENSE), SPDX `AGPL-3.0-only`. La licencia del código no concede derechos sobre las marcas FundoSmart.

Las licencias, atribuciones y correcciones documentadas de metadatos para
dependencias están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), con los
textos que deben acompañar builds redistribuidos en
[`third_party_licenses/`](third_party_licenses/).
