# Autoalojamiento de FundoSmart Community

FundoSmart Community funciona localmente sin conectarse a servicios remotos. Para una instalación accesible por Internet, cada operador debe crear recursos Cloudflare, secretos, dominio y flujo de despliegue propios. Este repositorio no contiene credenciales ni automatizaciones de FundoSmart Cloud.

## Desarrollo local

Requisitos: Node.js `>=22.13.0` y npm.

```bash
git clone https://github.com/VicenteBarrientos/fundosmart-community.git
cd fundosmart-community
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

En PowerShell usa `Copy-Item .dev.vars.example .dev.vars`. Abre `http://localhost:3000/demo`.

El comando `predev` aplica las migraciones a una D1 local en `.wrangler/state/`. No copies `.dev.vars`, archivos `.env`, `.wrangler/state` ni respaldos desde otra instalación.

## Topología remota

Una instalación independiente necesita, como mínimo:

- un Worker y un dominio propios;
- una D1 vacía con las migraciones de `drizzle/`;
- un bucket R2 privado para archivos originales;
- un cliente Google OIDC propio si habilita inicio de sesión con Google;
- secretos de sesión, confirmación y cifrado generados para esa instalación;
- staging separado, backups verificados, monitorización, smoke tests y rollback.

Images forma parte de la configuración base. Workers AI, correo transaccional y Analytics Engine son opcionales y permanecen desactivados salvo configuración explícita.

## Configuración

Parte de [.env.example](../../.env.example) para valores no secretos y de [.dev.vars.example](../../.dev.vars.example) para secretos locales. Los archivos reales están ignorados por Git.

Variables de recursos y build:

```text
NEXT_PUBLIC_APP_URL
FUNDOSMART_DEPLOY_ENVIRONMENT
FUNDOSMART_WORKER_NAME
FUNDOSMART_D1_DATABASE_NAME
FUNDOSMART_D1_DATABASE_ID
FUNDOSMART_R2_BUCKET_NAME
FUNDOSMART_APP_BASE_URL
FUNDOSMART_EMAIL_FROM
FUNDOSMART_ENABLE_AI
FUNDOSMART_ENABLE_REMOTE_AI
FUNDOSMART_ENABLE_ANALYTICS
FUNDOSMART_METRICS_DATASET
FUNDOSMART_MAP_USAGE_DATASET
```

Secretos y valores privados habituales:

```text
AUTH_ORIGIN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
FUNDOSMART_OWNER_EMAIL
OFFLINE_SESSION_SECRET
ASSISTANT_CONFIRMATION_SECRET
AI_KEYS_ENCRYPTION_SECRET
CDSE_CLIENT_ID
CDSE_CLIENT_SECRET
```

En producción, `AUTH_ORIGIN` debe ser un origen HTTPS exacto y sin ruta, query ni fragmento. Usa tokens de menor privilegio y nunca publiques secretos en commits, imágenes, issues o logs.

## Preparar un despliegue

`npm run deploy` está bloqueado para evitar publicar por accidente con valores genéricos. Primero crea una configuración de release específica para tu cuenta y sométela a revisión. Antes de cualquier escritura remota ejecuta:

```bash
npm run check
```

La validación incluye lint, tipos, build, pruebas, `wrangler deploy --dry-run` y auditoría de dependencias. Luego valida tu pipeline en staging con una cuenta vacía. El comando seco no crea ni modifica recursos.

## Aislamiento y datos

- Empieza con D1/R2 vacíos y la demo sintética incluida.
- No reutilices IDs, dumps, migraciones privadas ni respaldos de otra organización.
- Configura un dominio bajo tu control y redirect URIs exactas.
- Mantén staging y producción en recursos separados.
- Prueba aislamiento entre dos organizaciones, exportación, restauración y fallos de proveedores externos.
- Informa a los usuarios dónde obtener el código fuente correspondiente de tu versión modificada, como exige AGPL.

El autoalojamiento implica operar seguridad, disponibilidad, correo, identidad, privacidad, retención y cumplimiento legal; un build correcto no sustituye esas responsabilidades.
