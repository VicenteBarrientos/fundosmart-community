# Roadmap del ecosistema open source y extensiones

Este plan convierte la decisión del [ADR 0001](../architecture/0001-open-source-core-and-extensions.md) en entregas graduales. No promete fechas: cada fase se abre al cumplir sus gates de privacidad, seguridad y compatibilidad.

## Fase 0 — publicación segura del núcleo

Entregables:

- licencia AGPL, contribución con DCO, seguridad, conducta, gobierno y marca;
- arranque local reproducible con datos sintéticos;
- árbol e historia pública sin secretos, datos personales, coordenadas ni registros agrícolas reales;
- documentación de bindings y autoalojamiento sin dependencia de recursos oficiales;
- CI de pull requests sin credenciales y reporte de procedencia/licencias de terceros.

Gate: un snapshot desde cero pasa el escáner de datos/secretos, `npm ci`, build, pruebas y dry-run usando solo configuración de ejemplo.

## Fase 1 — personalización sin código

Alcance:

- branding y temas por organización;
- campos y catálogos personalizados con tipos y validación;
- constructor acotado de reportes y vistas guardadas;
- flujos configurables sobre transiciones permitidas;
- exportación/importación versionada de configuración.

Gate: una actualización del core conserva configuración, permisos y rollback; ninguna regla puede ampliar capacidades del actor.

## Fase 2 — contratos y eventos públicos

Alcance:

- catálogo inicial de recursos de fundos, potreros, ganado, leche y costos;
- especificación OpenAPI generada y probada contra runtime;
- claves/clients por instalación, scopes, rate limits e idempotencia;
- outbox durable y webhooks firmados con reintentos, replay y dead-letter;
- catálogo de eventos con procedencia, versión y ejemplos sintéticos.

Gate: aislamiento tenant/fundo, revocación, auditoría, orden y entrega al menos una vez están probados; consumidores toleran duplicados.

## Fase 3 — SDK y host de extensiones v1

Alcance mínimo:

- esquema JSON de manifiesto;
- SDK TypeScript generado desde contratos;
- CLI para validar, probar y empaquetar;
- instalación manual por administrador con capacidades explícitas;
- configuración cifrada por extensión y egreso permitido por lista;
- compatibilidad y migraciones declaradas.

El primer host recomendado es externo al proceso mediante API/webhooks. Un sandbox embebido solo avanza con límites medidos de CPU, memoria, red, almacenamiento y cancelación.

Gate: instalar, actualizar, fallar y desinstalar una extensión no altera datos fuera de su capacidad ni impide arrancar el core.

## Fase 4 — extensiones de referencia

Publicar tres ejemplos antes de prometer universalidad:

1. importador de balanza con conciliación por identificador;
2. reporte de costos configurable para una cooperativa;
3. automatización sobre un evento de dominio con webhook firmado.

Cada ejemplo incluye pruebas de contrato, límites de datos, compatibilidad y receta de despliegue independiente.

## Fase 5 — registro o marketplace

Solo se abre con comunidad y demanda observables. Requiere identidad de publicador, firma y checksum, análisis de permisos, política de retiro, compatibilidad, canal de vulnerabilidades, moderación y transparencia comercial. El registro puede comenzar como catálogo sin pagos.

## Métricas

- tiempo desde clone hasta demo local funcional;
- porcentaje de upgrades sin intervención de extensiones;
- contratos incompatibles introducidos por release;
- fallos de webhooks recuperados y tiempo hasta dead-letter;
- extensiones activas por instalación y permisos rechazados;
- contribuyentes externos con cambios integrados y tiempo de primera revisión.

## Fuera de alcance inicial

- ejecutar npm arbitrario dentro del Worker principal;
- acceso SQL directo para plugins;
- garantizar compatibilidad con forks que importen módulos internos;
- cobros/revenue share antes de estabilizar instalación y seguridad;
- usar datos de clientes para ejemplos, fixtures o documentación.
