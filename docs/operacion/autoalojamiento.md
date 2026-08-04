# Autoalojamiento de FundoSmart Community

El núcleo funciona localmente sin credenciales remotas. Los mapas y las integraciones opcionales pueden realizar las conexiones descritas en [Servicios externos y configuración](./servicios-externos-y-configuracion.md).

Esta receta crea una instalación aislada en una cuenta Cloudflare propia. No contiene ni reutiliza infraestructura, credenciales o automatizaciones de FundoSmart Cloud. Practícala primero en `staging` y repítela para producción con Worker, D1, R2, dominio, configuración y secretos diferentes.

## Desarrollo local

Requisitos: Node.js `>=22.13.0` y npm `10.9.3`.

```bash
git clone https://github.com/VicenteBarrientos/fundosmart-community.git
cd fundosmart-community
npm ci
npm run dev:init
npm run dev
```

Abre `http://localhost:3000/demo`. `dev:init` escribe `.dev.vars` con secretos locales aleatorios y falla sin sobrescribirlo si ya existe. `predev` aplica las tres migraciones públicas a una D1 local en `.wrangler/state/`.

No copies `.dev.vars`, `.env*`, `.wrangler/state` ni respaldos desde otra instalación. Los valores `DEV_AUTH_*` sirven solo para desarrollo y están prohibidos en una configuración remota.

## Requisitos remotos

- una cuenta Cloudflare y un dominio activo bajo su control;
- Wrangler autenticado contra la cuenta correcta;
- D1, R2 y Cloudflare Images habilitados y con costos aceptados;
- un cliente Google OIDC de tipo aplicación web para usuarios autenticados;
- secretos propios y distintos para staging y producción;
- almacenamiento externo al repositorio para bookmarks, exports y evidencia del release.

`ASSETS`, `IMAGES`, `DB` y `FILES` son bindings obligatorios. El Worker incluye el cron `17 */6 * * *` y Workers Observability. AI, Email y Analytics Engine son opcionales.

## 1. Fijar la fuente y autenticar Wrangler

Usa una versión publicada o un SHA completo. Sustituye primero `TAG_OR_FULL_SHA`; no ejecutes el ejemplo literalmente ni construyas desde una rama móvil.

```bash
git checkout TAG_OR_FULL_SHA
git status --short
node --version
npm ci
npx wrangler login
npx wrangler whoami
```

`git status --short` debe quedar vacío. Los archivos operativos de esta guía están ignorados y no ensucian el checkout. El preflight aborta si no puede resolver `HEAD`, si el SHA declarado difiere o si el índice, el worktree o archivos no ignorados tienen cambios.

Crea la configuración de staging y completa Account ID, dominio, SHA completo y estos nombres exactos; deja pendiente solo el UUID D1:

```bash
cp .env.production.example .env.staging.local
```

En PowerShell usa `Copy-Item .env.production.example .env.staging.local`. Configura:

```dotenv
FUNDOSMART_DEPLOY_ENVIRONMENT=staging
FUNDOSMART_WORKER_NAME=fundosmart-community-staging
FUNDOSMART_D1_DATABASE_NAME=fundosmart-community-staging
FUNDOSMART_R2_BUCKET_NAME=fundosmart-community-staging-files
```

El wrapper `self-host:wrangler` carga el archivo seleccionado, elimina cualquier Account ID heredado, fija `CLOUDFLARE_ACCOUNT_ID` al valor del archivo, usa la versión local bloqueada de Wrangler y ejecuta en modo no interactivo. También exige SHA y checkout limpios. No uses un `npx wrangler` directo para las escrituras de esta receta.

## 2. Crear recursos aislados

Verifica primero la identidad efectiva y no continúes si la cuenta no es la esperada:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- whoami
```

Los siguientes comandos crean recursos remotos. `wnam` es solo una elección de ejemplo; cámbiala antes si tus obligaciones de residencia requieren otra ubicación.

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 create fundosmart-community-staging --location wnam
npm run self-host:wrangler -- --env-file .env.staging.local -- r2 bucket create fundosmart-community-staging-files --location wnam
```

Conserva el UUID devuelto por D1 en `FUNDOSMART_D1_DATABASE_ID`. Habilita Cloudflare Images en esa misma cuenta y revisa plan, límites y costos. El Worker y el binding de Assets se crean al desplegar.

## 3. Preparar secretos separados

```bash
npm run self-host:init-secrets -- --output .wrangler/community.staging.secrets.env
```

El generador escribe tres secretos aleatorios sin imprimirlos y falla sin sobrescribir un archivo existente. Completa en ese archivo:

```dotenv
AUTH_ORIGIN=https://staging.tu-dominio.cl
GOOGLE_CLIENT_ID=cliente-web.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=VALOR_EMITIDO_POR_GOOGLE
FUNDOSMART_OWNER_EMAIL=propietario@tu-dominio.cl
```

En `.env.staging.local`, los tres orígenes deben coincidir exactamente con `AUTH_ORIGIN` y usar HTTPS:

```dotenv
NEXT_PUBLIC_APP_URL=https://staging.tu-dominio.cl
FUNDOSMART_BASE_URL=https://staging.tu-dominio.cl
FUNDOSMART_APP_BASE_URL=https://staging.tu-dominio.cl
```

Registra en Google el callback exacto `https://staging.tu-dominio.cl/auth/google/callback`.

Ambos archivos reales están ignorados por Git. No muevas secretos a `vars`, no los pases como argumentos y no los muestres en logs. Las únicas claves privadas admitidas son `AUTH_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FUNDOSMART_OWNER_EMAIL`, los tres secretos criptográficos y, opcionalmente como pareja, `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET`.

## 4. Validar y construir el artefacto

```bash
npm run self-host:validate -- --env-file .env.staging.local --secrets-file .wrangler/community.staging.secrets.env
npm run self-host:check -- --env-file .env.staging.local --secrets-file .wrangler/community.staging.secrets.env
```

El preflight usa listas exactas de variables, rechaza placeholders, identidades `DEV_AUTH_*`, claves repetidas, Account ID/UUID inválidos, un Account ID ambiental conflictivo y orígenes o SHA divergentes. `self-host:check` crea un entorno saneado para el gate: no entrega el archivo de secretos, opciones de Node/npm ni credenciales Cloudflare al proceso de build.

El gate ejecuta lint, TypeScript, build, pruebas, dry-run de Wrangler y auditoría. Después inspecciona `dist/server/wrangler.json`: exige `account_id`, recursos exactos, Custom Domain único, `workers_dev=false`, preview URLs desactivadas, variables públicas exactas, bindings, remitente permitido, cron y observabilidad. También rechaza nombres o valores secretos en el manifiesto.

No despliegues un `dist/server/wrangler.json` generado con defaults. Cada entorno necesita ejecutar su propio `self-host:check`; el segundo build reemplaza al anterior.

## 5. Registrar recuperación y migrar

Todas las órdenes remotas pasan por el wrapper de cuenta fijada:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 info DB -c dist/server/wrangler.json
npm run self-host:wrangler -- --env-file .env.staging.local -- r2 bucket info fundosmart-community-staging-files
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 time-travel info DB -c dist/server/wrangler.json --json
npm run self-host:wrangler -- --env-file .env.staging.local -- versions list -c dist/server/wrangler.json --json
```

En el primer despliegue, `versions list` puede responder `not found` porque el Worker aún no existe. Registra ese resultado como “sin versión anterior” solo después de comprobar `whoami`, D1 y R2; cualquier otro error sigue siendo bloqueo.

Time Travel tiene retención finita y no reemplaza un respaldo externo. Antes de actualizar una D1 con datos, crea fuera del repositorio un directorio privado y un export verificable:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 export DB --remote -c dist/server/wrangler.json --output ../fundosmart-backups/staging-before-release.sql
```

Conserva además el bookmark de Time Travel y un inventario/copia restaurable de R2 mediante su API compatible con S3. Prueba la restauración en una cuenta o recursos aislados; crear un archivo no demuestra que el respaldo sea utilizable.

Para una instalación nueva o una actualización compatible y aditiva:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 migrations list DB --remote -c dist/server/wrangler.json
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 migrations apply DB --remote -c dist/server/wrangler.json
npm run self-host:wrangler -- --env-file .env.staging.local -- d1 migrations list DB --remote -c dist/server/wrangler.json
```

El resultado esperado es cero migraciones pendientes. `0000` crea el esquema, `0001` instala invariantes y `0002` carga únicamente la demo sintética usada por el smoke.

No apliques una migración incompatible mientras el Worker anterior acepta escrituras. Para esos cambios necesitas una ventana de mantenimiento con todas las escrituras cercadas, respaldo restaurado de prueba y una secuencia de código/esquema revisada. Prefiere expand/contract: primero esquema compatible, después código, y la contracción en un release posterior.

## 6. Desplegar y reconciliar secretos

El wrapper establece `CI=true`; por eso `--strict` aborta en vez de aceptar interactivamente cuando Wrangler detecta una configuración remota conflictiva. No es un sello desde la hora del build: vuelve a comprobar versión y cuenta inmediatamente antes de esta escritura.

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- deploy -c dist/server/wrangler.json --secrets-file .wrangler/community.staging.secrets.env --strict --message "FundoSmart Community staging release"
```

`--secrets-file` agrega o actualiza, pero no borra secretos omitidos. Lista el estado remoto y compáralo con las siete claves obligatorias documentadas arriba, más las dos de CDSE solo si están activas:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- secret list -c dist/server/wrangler.json --format json
```

Al desactivar Copernicus, elimina explícitamente ambas claves y vuelve a listar:

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- secret delete CDSE_CLIENT_ID -c dist/server/wrangler.json
npm run self-host:wrangler -- --env-file .env.staging.local -- secret delete CDSE_CLIENT_SECRET -c dist/server/wrangler.json
```

`npm run deploy` continúa bloqueado deliberadamente para evitar publicar defaults o confundir esta receta comunitaria con la cadena protegida de FundoSmart Cloud.

## 7. Verificar staging

```bash
npm run self-host:wrangler -- --env-file .env.staging.local -- deployments status -c dist/server/wrangler.json --json
npm run self-host:wrangler -- --env-file .env.staging.local -- versions list -c dist/server/wrangler.json --json
npm run self-host:wrangler -- --env-file .env.staging.local -- secret list -c dist/server/wrangler.json --format json
npm run self-host:smoke -- --env-file .env.staging.local
```

El smoke lee únicamente el archivo seleccionado, verifica que sus tres orígenes coincidan y no permite que `FUNDOSMART_BASE_URL` heredado cambie el objetivo. Valida portada, inicio Google, API anónima cerrada, demo aislada, producto, D1 y NDVI demo. Si falla, no promociones ese SHA.

## 8. Repetir para producción

No renombres ni reutilices los archivos de staging. Crea `.env.production.local` y `.wrangler/community.production.secrets.env`, con nombres de recursos, dominio y secretos de producción. Repite desde la creación de recursos y ejecuta el gate otra vez para producir un manifiesto de producción.

```bash
cp .env.production.example .env.production.local
npm run self-host:init-secrets -- --output .wrangler/community.production.secrets.env
npm run self-host:validate -- --env-file .env.production.local --secrets-file .wrangler/community.production.secrets.env
npm run self-host:check -- --env-file .env.production.local --secrets-file .wrangler/community.production.secrets.env
```

En PowerShell usa `Copy-Item` para la copia. Promueve exactamente el SHA probado en staging; no muevas ni reescribas un tag publicado.

## 9. Rollback

Un rollback del Worker no revierte D1 ni R2. Usa el ID exacto registrado en la evidencia, sustituyendo `PREVIOUS_VERSION_ID` antes de ejecutar:

```bash
npm run self-host:wrangler -- --env-file .env.production.local -- rollback PREVIOUS_VERSION_ID -c dist/server/wrangler.json -m "Rollback por smoke fallido" -y
```

Esto solo es seguro si la versión anterior sigue siendo compatible con el esquema actual. Si se requiere restaurar D1, activa primero mantenimiento y cerca todas las escrituras. Sustituye `PREVIOUS_D1_BOOKMARK` por el bookmark verificado:

```bash
npm run self-host:wrangler -- --env-file .env.production.local -- d1 time-travel restore DB -c dist/server/wrangler.json --bookmark PREVIOUS_D1_BOOKMARK
```

La restauración reemplaza el estado y pierde toda escritura posterior al bookmark. Verifica D1 antes de reabrir tráfico. No hay rollback R2 automático en este repositorio: restaura objetos desde la copia/inventario externo y reconcilia referencias antes de levantar el modo mantenimiento.

## Actualizaciones posteriores

1. Fija el nuevo tag/SHA y conserva el anterior sin modificar tags publicados.
2. Clasifica migraciones como aditivas o incompatibles y elige expand/contract o mantenimiento.
3. Ejecuta un build limpio y respalda/restaura de prueba D1/R2.
4. Ensaya en staging con recursos separados.
5. Registra cuenta, versión Worker, bookmark D1, export, inventario R2 y lista de secretos.
6. Promueve exactamente el SHA aprobado, ejecuta smoke contra el archivo correcto y conserva la evidencia.

Una instalación pública debe informar dónde obtener el código fuente correspondiente de su versión modificada, como exige AGPL. El operador también asume seguridad, disponibilidad, identidad, correo, privacidad, retención, costos y cumplimiento legal.
