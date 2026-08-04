# Servicios externos y configuración

La demo y D1 funcionan localmente sin credenciales remotas. Al abrir mapas, el navegador sí puede solicitar teselas de OpenStreetMap. Las demás integraciones solo operan cuando se configuran o habilitan explícitamente.

## Matriz de servicios y salida de datos

| Servicio | Cuándo se necesita | Configuración | Datos enviados y comportamiento sin servicio |
|---|---|---|---|
| Cloudflare Worker, D1, R2, Images y Assets | Obligatorios para una instalación remota con la configuración actual | `CLOUDFLARE_ACCOUNT_ID`, `FUNDOSMART_WORKER_NAME`, `FUNDOSMART_D1_DATABASE_NAME`, `FUNDOSMART_D1_DATABASE_ID`, `FUNDOSMART_R2_BUCKET_NAME`, `FUNDOSMART_DATA_JURISDICTION` | Alojan ejecución, base, archivos privados, transformaciones y estáticos. La demo local usa emulación, pero no existe fallback remoto si falta un binding. Images debe habilitarse y puede tener plan, límites y costos propios. |
| Google OpenID Connect | Opcional en demo local; necesario para usuarios autenticados remotos | Secretos `AUTH_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Callback exacto: `${AUTH_ORIGIN}/auth/google/callback` | Google recibe la solicitud OIDC y devuelve identidad `openid email`. Sin credenciales solo funciona la demo; `DEV_AUTH_*` está prohibido remotamente. |
| OpenStreetMap Standard | Mapa base predeterminado | Sin clave | El navegador pide teselas a `tile.openstreetmap.org`, con IP y parámetros de tesela. Sin red, el resto del formulario sigue disponible pero el fondo queda sin teselas. Deben respetarse la atribución y política de uso del proveedor. |
| Nominatim | No activo en el runtime actual | Ninguna | Existe un cliente reservado y pruebas, pero ningún flujo de producto lo invoca en esta versión. |
| ArcGIS | Opcional para Satélite, Topográfico y Relieve | `NEXT_PUBLIC_ARCGIS_BASEMAP_KEY` durante el build | La clave es pública y queda disponible en el navegador. Sin ella, esos fondos no se habilitan y OpenStreetMap permanece disponible. |
| Cloudflare Workers AI | Opcional para respuesta generativa alojada en Cloudflare | `FUNDOSMART_ENABLE_AI=true`. `FUNDOSMART_ENABLE_REMOTE_AI` solo controla desarrollo | Envía a Workers AI la consulta y el contexto autorizado. Sin binding, el asistente conserva sus caminos deterministas y BYOK cuando estén configurados. |
| Gemini, OpenAI o Anthropic BYOK | Opcional por organización | Clave desde la UI y `AI_KEYS_ENCRYPTION_SECRET` estable | La clave queda cifrada en D1. El proveedor seleccionado recibe el prompt y contexto autorizado de fundos, potreros, ganado o leche necesarios para responder. |
| Correo saliente | Opcional | `FUNDOSMART_EMAIL_FROM` durante el build y Send Email autorizado; `FUNDOSMART_APP_BASE_URL` para enlaces | Envía notificaciones por el binding `EMAIL`. Sin binding, los procesos no envían correo. |
| Correo entrante | Opcional | Email Routing dirigido al handler del Worker y `FUNDOSMART_INBOX_DOMAIN` | Recibe adjuntos enviados al dominio configurado. Sin routing, la bandeja no recibe mensajes. |
| Analytics Engine | Opcional | `FUNDOSMART_ENABLE_ANALYTICS=true`, `FUNDOSMART_METRICS_DATASET`, `FUNDOSMART_MAP_USAGE_DATASET` | Registra eventos operativos pseudónimos y consumo de mapas. Sin bindings, esas métricas no se escriben. |
| Workers Observability | Siempre activo en el manifiesto actual | Sin variable | Cloudflare conserva logs de invocación al 100 % y trazas con muestreo del 5 %. Es independiente de Analytics Engine. |
| Copernicus Data Space Ecosystem | Opcional para NDVI real | Secretos `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` | Envía geometría completa del potrero y rango temporal a los endpoints de Copernicus. Sin credenciales, NDVI real informa que la integración no está configurada. |
| Monitor y smoke | Operación opcional | `FUNDOSMART_MONITOR_BASE_URL`, `FUNDOSMART_BASE_URL`, `FUNDOSMART_SMOKE_ATTEMPTS` | Hacen solicitudes al origen desplegado; no son bindings del Worker. |

## Variables obligatorias para un build remoto

- `CLOUDFLARE_ACCOUNT_ID`: cuenta propietaria de todos los recursos.
- `FUNDOSMART_DEPLOY_ENVIRONMENT`: exactamente `staging` o `production`.
- `FUNDOSMART_RELEASE_SHA`: SHA completo del commit construido.
- `NEXT_PUBLIC_APP_URL`, `FUNDOSMART_APP_BASE_URL` y `FUNDOSMART_BASE_URL`: el mismo origen HTTPS con dominio propio.
- `FUNDOSMART_WORKER_NAME`, `FUNDOSMART_D1_DATABASE_NAME`, `FUNDOSMART_D1_DATABASE_ID` y `FUNDOSMART_R2_BUCKET_NAME`: recursos pertenecientes a la instalación.
- `FUNDOSMART_DATA_JURISDICTION`: vacío para crear D1 y R2 con un *location hint* de mejor esfuerzo, o exactamente `eu`/`fedramp` para restringir ambos recursos a esa jurisdicción. Una jurisdicción solo se fija al crear cada recurso y no puede combinarse con `--location`.
- `FUNDOSMART_ENABLE_AI`, `FUNDOSMART_ENABLE_REMOTE_AI` y `FUNDOSMART_ENABLE_ANALYTICS`: booleanos explícitos. `FUNDOSMART_ENABLE_REMOTE_AI` debe quedar `false` en builds remotos.

El archivo versionado [.env.production.example](../../.env.production.example) contiene el contrato completo de build. Usa copias ignoradas distintas, por ejemplo `.env.staging.local` y `.env.production.local`. El manifiesto remoto incorpora `account_id`; el gate genera una atestación por entorno sobre el SHA y todo `dist`, y el wrapper solo admite operaciones declaradas, verifica esa atestación, aporta una copia estable del manifiesto y reemplaza cualquier Account ID heredado por el del archivo seleccionado.

## Secretos obligatorios para usuarios remotos

- `AUTH_ORIGIN`: el mismo origen HTTPS del build.
- `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`: cliente OAuth de tipo aplicación web.
- `FUNDOSMART_OWNER_EMAIL`: identidad inicial del propietario; no puede ser un dominio de ejemplo.
- `OFFLINE_SESSION_SECRET`: valor aleatorio de al menos 32 bytes.
- `ASSISTANT_CONFIRMATION_SECRET`: exactamente 32 bytes aleatorios codificados como Base64URL canónico.
- `AI_KEYS_ENCRYPTION_SECRET`: valor aleatorio y estable de al menos 32 caracteres. Cambiarlo inutiliza las claves BYOK ya cifradas.

`npm run self-host:init-secrets -- --output RUTA_IGNORADA` escribe los tres secretos criptográficos sin mostrarlos en la terminal. Usa rutas distintas como `.wrangler/community.staging.secrets.env` y `.wrangler/community.production.secrets.env`; después completa el origen, cliente Google y correo propietario. El preflight rechaza claves desconocidas, placeholders, dominios reservados, secretos repetidos y cualquier `DEV_AUTH_EMAIL` o `DEV_AUTH_NAME`.

Los secretos de Copernicus son opcionales, pero deben aparecer juntos. La carga de secretos de Wrangler es aditiva: al desactivar la integración hay que borrar ambos nombres del Worker y verificar la lista remota. No guardes secretos en `.env*.local`, el panel de GitHub, issues, capturas ni logs.

## Configuración de red e identidad

La instalación remota exige un dominio propio activo en la misma cuenta de Cloudflare. El build genera una única ruta de Custom Domain y desactiva `workers.dev` y las preview URLs. Registra en Google exactamente:

```text
https://tu-dominio.example/auth/google/callback
```

Sustituye el dominio por el mismo valor usado en `AUTH_ORIGIN`. No agregues una barra final, ruta adicional, query ni fragmento.

La receta ejecutable, migraciones, smoke y rollback están en [Autoalojamiento](./autoalojamiento.md).
