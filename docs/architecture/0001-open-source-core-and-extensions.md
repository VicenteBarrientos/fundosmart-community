# ADR 0001: núcleo open source y frontera de extensiones

- Estado: aceptado
- Fecha: 2026-08-04
- Decisores: mantenedores de FundoSmart

## Contexto

FundoSmart necesita crecer desde un producto agrícola integrado hacia una plataforma que empresas, cooperativas y desarrolladores puedan adaptar sin mantener forks permanentes. El producto ya separa módulos, repositorios de servidor, autorización por organización/fundo y recursos Cloudflare, pero todavía no existe un contrato de plugins.

Abrir un repositorio no es suficiente: la licencia debe proteger las libertades de quienes usan el software por red; los datos e infraestructura del SaaS no deben confundirse con el código; y una extensión no puede saltarse aislamiento, permisos, auditoría o compatibilidad.

## Decisión

### 1. Licencia y edición comunitaria

El núcleo se distribuye bajo `AGPL-3.0-only`. Una persona puede usarlo, estudiarlo, modificarlo, redistribuirlo y operar una instancia propia. Quien ofrezca una versión modificada por red debe entregar a sus usuarios el código fuente correspondiente en los términos de AGPL.

No se crea una edición comunitaria artificialmente degradada. Las diferencias comerciales se basan en operación administrada, soporte, capacidad contratada, conectores con credenciales/licencias de terceros y servicios que no son código del núcleo.

### 2. FundoSmart Cloud

FundoSmart Cloud es una instancia administrada del núcleo. Permanecen fuera del repositorio:

- datos, originales, respaldos y evidencia de clientes;
- secretos, tokens, identidades, IDs y configuración específica de producción;
- contratos comerciales y material de terceros no redistribuible;
- runbooks con información que aumente el riesgo operativo sin aportar al core.

El SaaS no obtiene un bypass oculto de permisos. Usa los mismos contratos de aplicación y puede añadir adaptadores operacionales mediante interfaces públicas.

### 3. Capas de personalización

La plataforma tendrá cuatro niveles, en este orden:

1. **Configuración:** campos, formularios, branding, permisos, reportes y flujos versionados por organización.
2. **API pública:** recursos tenant-scoped, OpenAPI, idempotencia, paginación, límites y webhooks firmados.
3. **Eventos de dominio:** nombres y payloads versionados como `ganado.animal.v1.created`; entrega durable mediante outbox y reintentos observables.
4. **Extensiones:** paquetes con manifiesto, versión de SDK, capacidades solicitadas, configuración declarativa y ejecución aislada.

Un marketplace se construirá solo cuando existan contratos estables, firma/verificación de paquetes, desinstalación reversible y demanda comunitaria.

### 4. Modelo de extensión

La unidad será un paquete independiente con, como mínimo:

```json
{
  "id": "cl.cooperativa.reporte-costos",
  "version": "1.0.0",
  "sdk": "^1.0.0",
  "capabilities": ["costos:read", "reportes:write"],
  "events": ["costos.movimiento.v1.created"]
}
```

Las extensiones no importan módulos internos, no acceden directamente a D1/R2, no reciben secretos globales y no ejecutan SQL arbitrario. Todo acceso pasa por capacidades explícitas, actor/organización/fundo, cuotas, auditoría y contratos versionados. La primera implementación preferirá webhooks o Workers externos; código de terceros dentro del proceso requiere un sandbox demostrado y no es requisito inicial.

### 5. Compatibilidad

- Los contratos públicos usan una versión independiente de la versión del producto.
- Antes de `1.0`, un cambio incompatible exige versión de contrato nueva y ruta de migración.
- Después de `1.0`, se aplicará SemVer y una deprecación mínima de 180 días o dos releases menores, lo que sea mayor.
- Los eventos son append-only dentro de una versión: se pueden agregar campos opcionales, no reinterpretar campos existentes.
- Una extensión incompatible queda deshabilitada de forma reversible con diagnóstico; no puede bloquear el arranque del núcleo.

### 6. Gobierno y seguridad

Los contratos públicos se deciden mediante propuesta y ADR. Cada capacidad se mapea al autorizador canónico del núcleo. Instalación, actualización, habilitación, error y desinstalación generan auditoría. Los plugins declaran telemetría y destinos de datos; una instancia debe poder impedir egreso de información.

## Consecuencias

Ventajas:

- mejoras del core ofrecidas como servicio permanecen disponibles para sus usuarios;
- clientes pueden adaptar el producto sin mantener un fork del núcleo;
- integraciones agrícolas evolucionan fuera del ciclo de release principal;
- la oferta administrada compite por operación y confianza, no por ocultar el código.

Costos y riesgos:

- AGPL reduce la compatibilidad con algunos componentes propietarios enlazados directamente;
- API, eventos y SDK exigen disciplina de versiones y soporte;
- ejecutar código de terceros aumenta la superficie de ataque;
- separar datos/configuración histórica es un gate previo a la primera publicación.

## Alternativas descartadas

- **MIT/Apache-2.0 para todo el core:** maximiza adopción, pero permite que un proveedor ofrezca una versión modificada por red sin compartir sus mejoras.
- **Source available:** no entrega libertades open source reconocibles y contradice el objetivo declarado.
- **Plugins mediante imports internos:** es rápido al inicio, pero acopla cada extensión al release del core y expone datos sin una frontera verificable.
- **Marketplace inmediato:** crea revisión, pagos y confianza antes de validar el contrato básico.
