# Autoalojamiento de FundoSmart Community

El núcleo funciona localmente sin credenciales remotas. Los mapas y las integraciones opcionales pueden realizar las conexiones descritas en [Servicios externos y configuración](./servicios-externos-y-configuracion.md).

Esta receta crea una instalación aislada en una cuenta Cloudflare propia. No contiene ni reutiliza infraestructura, credenciales o automatizaciones de FundoSmart Cloud. Practícala primero en `staging` y repítela para producción con Worker, D1, R2, dominio, configuración y secretos diferentes.

## Desarrollo local

Requisitos: Node.js `>=22.13.0` y npm `10.9.3`.

Comprueba ambos antes de instalar: `node --version` debe cumplir el mínimo y `npm --version` debe devolver exactamente `10.9.3`. Los gates remotos fallan cerrado con otra versión; usa tu administrador de Node/npm para seleccionar la declarada en `package.json` en vez de continuar con una instalación distinta.

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
```

`git status --short` debe quedar vacío. Los archivos operativos de esta guía están ignorados y no ensucian el checkout. El preflight aborta si no puede resolver `HEAD`, si el SHA declarado difiere o si el índice, el worktree o archivos no ignorados tienen cambios.

Crea un API token acotado en Cloudflare. Como punto de partida usa la plantilla oficial [`Edit Cloudflare Workers`](https://developers.cloudflare.com/fundamentals/api/reference/template/), agrega el permiso de cuenta `D1: Edit` y restringe `Account Resources` a la cuenta que declararás en `CLOUDFLARE_ACCOUNT_ID` y `Zone Resources` al dominio de esta instalación. La receta necesita escritura sobre Workers Scripts/Routes, R2 y D1, además de los permisos de lectura de identidad y cuenta incluidos por la plantilla; contrasta siempre la selección con el [catálogo oficial de permisos](https://developers.cloudflare.com/fundamentals/api/reference/permissions/). No uses un token sin restricciones ni la Global API Key.

El wrapper ejecuta Wrangler con HOME y directorios de configuración privados y nuevos en cada invocación. Por diseño no lee el perfil OAuth creado por `wrangler login` y tampoco admite `--profile`: la vía soportada es entregar `CLOUDFLARE_API_TOKEN` desde el entorno del proceso. Cárgalo mediante una entrada oculta para que el valor no quede en el historial.

PowerShell:

```powershell
$cloudflareToken = Read-Host "Cloudflare API token" -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new("", $cloudflareToken).Password
$cloudflareToken.Dispose()
Remove-Variable cloudflareToken
```

Bash:

```bash
read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
```

No guardes el token en `.env.staging.local`, `.env.production.local`, `.wrangler/*.secrets.env`, `.npmrc` ni en un argumento de comando. El wrapper copia solo esta credencial al proceso privado de Wrangler y no la incorpora al artefacto ni a la atestación.

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
FUNDOSMART_DATA_JURISDICTION=
```

El wrapper `self-host:wrangler` exige una selección explícita de entorno que debe coincidir con el nombre y contenido del archivo. Solo permite las operaciones documentadas, aporta por sí mismo el manifiesto y el archivo de variables, fija la cuenta e instala Wrangler desde el lockfile del SHA seleccionado en un workspace privado para cada invocación; nunca ejecuta el `node_modules` ignorado del checkout original. Toda escritura exige repetir el nombre exacto del Worker en `--confirm-staging` o `--confirm-production`; una restauración, rollback o borrado de secreto exige además el objetivo literal en `--confirm-destructive`. No uses un `npx wrangler` directo para las escrituras de esta receta.

## 2. Crear recursos aislados

Verifica primero la identidad efectiva y no continúes si la cuenta no es la esperada:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- whoami
```

Los siguientes comandos crean recursos remotos con un *location hint* de rendimiento. Mantén `FUNDOSMART_DATA_JURISDICTION=` vacío y cambia `wnam` si la mayoría de los accesos ocurrirá en otra región. Un hint es de mejor esfuerzo: no garantiza residencia de datos.

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- d1 create fundosmart-community-staging --location wnam
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- r2 bucket create fundosmart-community-staging-files --location wnam
```

Si necesitas una restricción jurisdiccional, define antes `FUNDOSMART_DATA_JURISDICTION=eu` o `FUNDOSMART_DATA_JURISDICTION=fedramp` y usa el mismo valor literal para ambos recursos:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- d1 create fundosmart-community-staging --jurisdiction eu
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- r2 bucket create fundosmart-community-staging-files --jurisdiction eu
```

No combines `--location` con `--jurisdiction`: Wrangler ignora el hint de D1 cuando existe una jurisdicción y el wrapper rechaza la mezcla. D1 y R2 solo admiten fijar la jurisdicción al crear el recurso; no puede agregarse ni cambiarse después. Confirma además que tu plan habilite la jurisdicción elegida, especialmente `fedramp`.

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
npm run self-host:check -- --environment staging --env-file .env.staging.local --secrets-file .wrangler/community.staging.secrets.env
```

El preflight usa listas exactas de variables y sintaxis `KEY=value` estricta; rechaza líneas que otro parser pudiera interpretar de forma diferente, placeholders, identidades `DEV_AUTH_*`, claves repetidas, Account ID/UUID inválidos, un Account ID ambiental conflictivo y orígenes o SHA divergentes. `self-host:check` crea un worktree efímero y separado desde el SHA exacto, sin copiar `.wrangler` ni los archivos locales de entorno. Allí ejecuta una instalación reproducible sin scripts de instalación y llama cada etapa mediante el npm `10.9.3` de la instalación activa de Node, con HOME, caché, temporales y entorno de proceso acotados. El archivo de secretos se abre recién después de que termina el build.

El gate ejecuta lint, TypeScript, build, pruebas, dry-run de Wrangler y auditoría. Después toma una copia estable de `dist`, inspecciona el manifiesto y exige cuenta, Worker, entrypoint, recursos, dominio, variables, bindings y opciones de runtime exactos. Finalmente publica esa copia como el `dist` canónico y escribe una atestación ignorada en `.wrangler/self-hosting/staging.attestation.json`, ligada al SHA, los bytes validados de entorno/secretos, las rutas normalizadas y bytes de cada archivo regular desplegable, y el árbol `drizzle/` exacto de los blobs de Git. Enlaces y entradas especiales se rechazan; directorios vacíos y modos de filesystem no forman parte del artefacto que sube Workers. El wrapper vuelve a comprobar la atestación y opera sobre copias estables. Cambiar `dist`, una migración o el entorno obliga a repetir el gate; cambiar secretos invalida el próximo deploy, aunque las consultas remotas que no consumen secretos pueden seguir verificando el resto de la atestación.

Este aislamiento evita que cambios locales ocultos o archivos operativos entren accidentalmente al artefacto; no es un sandbox para ejecutar código fuente hostil ni para compensar un sistema operativo, una instalación de Node/npm o un ejecutable Git comprometidos. Construye únicamente un tag o SHA que hayas revisado, usa un host confiable y conserva el checkout original limpio mientras corre el gate. No mantengas lectores locales de `dist` activos durante su reemplazo: la publicación usa rollback transaccional y puede existir una ventana breve entre los dos renombres del directorio.

No despliegues un `dist/server/wrangler.json` generado con defaults. Cada entorno necesita ejecutar su propio `self-host:check`; el segundo build reemplaza al anterior.

## 5. Registrar recuperación y migrar

Todas las órdenes remotas pasan por el wrapper de cuenta fijada:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- d1 info DB
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- r2 bucket info fundosmart-community-staging-files
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- d1 time-travel info DB --json
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- versions list --json
```

Si `FUNDOSMART_DATA_JURISDICTION=eu` o `fedramp`, la consulta R2 también debe declarar el mismo valor; por ejemplo:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- r2 bucket info fundosmart-community-staging-files --jurisdiction eu
```

En el primer despliegue, `versions list` puede responder `not found` porque el Worker aún no existe. Registra ese resultado como “sin versión anterior” solo después de comprobar `whoami`, D1 y R2; cualquier otro error sigue siendo bloqueo.

Time Travel tiene retención finita y no reemplaza un respaldo externo. Un export remoto bloquea las demás solicitudes a D1 mientras se ejecuta. Antes de actualizar una base con datos, programa una ventana de mantenimiento, cerca las escrituras y crea fuera del repositorio el directorio privado hermano `../fundosmart-backups/staging/`. El wrapper trata el export como una operación con impacto, exige la confirmación del entorno, limita el destino a `../fundosmart-backups/<entorno>/<archivo-nuevo>.sql` y publica el resultado sin sobrescribir archivos existentes:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- d1 export DB --remote --output ../fundosmart-backups/staging/staging-before-release.sql
```

Cuando termine el export, verifica D1 antes de reabrir tráfico. Conserva además el bookmark de Time Travel y un inventario/copia restaurable de R2 mediante su API compatible con S3. Prueba la restauración en una cuenta o recursos aislados; crear un archivo no demuestra que el respaldo sea utilizable.

Para una instalación nueva o una actualización compatible y aditiva:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- d1 migrations list DB --remote
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging -- d1 migrations apply DB --remote
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- d1 migrations list DB --remote
```

El resultado esperado es cero migraciones pendientes. `0000` crea el esquema, `0001` instala invariantes y `0002` carga únicamente la demo sintética usada por el smoke.

No apliques una migración incompatible mientras el Worker anterior acepta escrituras. Para esos cambios necesitas una ventana de mantenimiento con todas las escrituras cercadas, respaldo restaurado de prueba y una secuencia de código/esquema revisada. Prefiere expand/contract: primero esquema compatible, después código, y la contracción en un release posterior.

## 6. Desplegar y reconciliar secretos

El wrapper establece `CI=true`; por eso `--strict` aborta en vez de aceptar interactivamente cuando Wrangler detecta una configuración remota conflictiva. No es un sello desde la hora del build: vuelve a comprobar versión y cuenta inmediatamente antes de esta escritura.

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --secrets-file .wrangler/community.staging.secrets.env --confirm-staging fundosmart-community-staging -- deploy --strict --message "FundoSmart Community staging release"
```

`--secrets-file` agrega o actualiza, pero no borra secretos omitidos. Lista el estado remoto y compáralo con las siete claves obligatorias documentadas arriba, más las dos de CDSE solo si están activas:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- secret list --format json
```

Al desactivar Copernicus, elimina explícitamente ambas claves y vuelve a listar:

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging --confirm-destructive secret:CDSE_CLIENT_ID -- secret delete CDSE_CLIENT_ID
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local --confirm-staging fundosmart-community-staging --confirm-destructive secret:CDSE_CLIENT_SECRET -- secret delete CDSE_CLIENT_SECRET
```

`npm run deploy` continúa bloqueado deliberadamente para evitar publicar defaults o confundir esta receta comunitaria con la cadena protegida de FundoSmart Cloud.

## 7. Verificar staging

```bash
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- deployments status --json
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- versions list --json
npm run self-host:wrangler -- --environment staging --env-file .env.staging.local -- secret list --format json
npm run self-host:smoke -- --environment staging --env-file .env.staging.local
```

El smoke exige el entorno explícito, vuelve a verificar el archivo con el parser estricto y comprueba la atestación canónica contra `dist`, `drizzle`, Git y el SHA completo antes de abrir la red. No permite que variables heredadas cambien el objetivo ni acepta un origen con puerto, path, query o fragment. `/healthz` debe declarar el entorno y el SHA completo esperado; así una URL sana que todavía sirve otro release también falla. Después valida portada, inicio Google, API anónima cerrada, demo aislada, producto, D1 y NDVI demo. Si falla, no promociones ese SHA.

## 8. Repetir para producción

No renombres ni reutilices los archivos de staging. Crea `.env.production.local` y `.wrangler/community.production.secrets.env`, con nombres de recursos, dominio y secretos de producción. Repite desde la creación de recursos y ejecuta el gate otra vez para producir un manifiesto y una atestación de producción. En los comandos siguientes reemplaza `YOUR_PRODUCTION_WORKER_NAME` por el valor exacto de `FUNDOSMART_WORKER_NAME`.

```bash
cp .env.production.example .env.production.local
npm run self-host:init-secrets -- --output .wrangler/community.production.secrets.env
npm run self-host:validate -- --env-file .env.production.local --secrets-file .wrangler/community.production.secrets.env
npm run self-host:check -- --environment production --env-file .env.production.local --secrets-file .wrangler/community.production.secrets.env
```

En PowerShell usa `Copy-Item` para la copia. Promueve exactamente el SHA probado en staging; no muevas ni reescribas un tag publicado.

## 9. Rollback

Un rollback del Worker no revierte D1 ni R2. Usa el ID exacto registrado en la evidencia, sustituyendo `PREVIOUS_VERSION_ID` antes de ejecutar:

```bash
npm run self-host:wrangler -- --environment production --env-file .env.production.local --confirm-production YOUR_PRODUCTION_WORKER_NAME --confirm-destructive worker-version:PREVIOUS_VERSION_ID -- rollback PREVIOUS_VERSION_ID -m "Rollback por smoke fallido" -y
```

Esto solo es seguro si la versión anterior sigue siendo compatible con el esquema actual. Si se requiere restaurar D1, activa primero mantenimiento y cerca todas las escrituras. Sustituye `PREVIOUS_D1_BOOKMARK` por el bookmark verificado:

```bash
npm run self-host:wrangler -- --environment production --env-file .env.production.local --confirm-production YOUR_PRODUCTION_WORKER_NAME --confirm-destructive d1-bookmark:PREVIOUS_D1_BOOKMARK -- d1 time-travel restore DB --bookmark PREVIOUS_D1_BOOKMARK
```

La restauración reemplaza el estado y pierde toda escritura posterior al bookmark. Verifica D1 antes de reabrir tráfico. No hay rollback R2 automático en este repositorio: restaura objetos desde la copia/inventario externo y reconcilia referencias antes de levantar el modo mantenimiento.

## Actualizaciones posteriores

1. Fija el nuevo tag/SHA y conserva el anterior sin modificar tags publicados.
2. Clasifica migraciones como aditivas o incompatibles y elige expand/contract o mantenimiento.
3. Ejecuta un build limpio y respalda/restaura de prueba D1/R2.
4. Ensaya en staging con recursos separados.
5. Registra cuenta, versión Worker, bookmark D1, export, inventario R2 y lista de secretos.
6. Promueve exactamente el SHA aprobado, ejecuta smoke contra el archivo correcto y conserva la evidencia.

Al terminar la ventana de operación, elimina el token de la shell actual con `Remove-Item Env:CLOUDFLARE_API_TOKEN` en PowerShell o `unset CLOUDFLARE_API_TOKEN` en una shell POSIX.

Una instalación pública debe informar dónde obtener el código fuente correspondiente de su versión modificada, como exige AGPL. El operador también asume seguridad, disponibilidad, identidad, correo, privacidad, retención, costos y cumplimiento legal.
