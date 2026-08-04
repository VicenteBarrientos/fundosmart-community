# Política de seguridad

## Versiones mantenidas

La rama `main` es la única versión comunitaria con soporte activo de seguridad mientras el proyecto esté en la serie `0.x`. Los forks y despliegues de terceros son responsabilidad de sus operadores.

## Reportar una vulnerabilidad

No abras un issue público. Usa el formulario privado **Report a vulnerability** de GitHub en:

<https://github.com/VicenteBarrientos/fundosmart-community/security/advisories/new>

Incluye una descripción, impacto, versión o commit afectado, pasos mínimos de reproducción y una mitigación sugerida si la conoces. No incluyas datos reales de clientes; usa una instancia local y fixtures sintéticos.

Confirmaremos recepción dentro de tres días hábiles e intentaremos entregar una evaluación inicial dentro de siete. Coordinaremos corrección, advisory y reconocimiento con quien reportó. No prometemos recompensas económicas.

## Alcance

Son especialmente relevantes fallos de aislamiento entre organizaciones/fundos, autorización, autenticación, exposición D1/R2, importaciones, recuperación, ejecución de extensiones, inyección, SSRF, XSS y filtración de secretos.

Quedan fuera los ataques destructivos contra producción, ingeniería social, denegación de servicio, escaneo masivo, informes automáticos sin prueba de impacto y vulnerabilidades exclusivamente en una dependencia sin camino explotable demostrado en FundoSmart.

## Divulgación responsable

Da tiempo razonable para corregir antes de publicar detalles. No accedas a más datos de los necesarios, no mantengas persistencia y elimina de forma segura cualquier dato obtenido accidentalmente. Esta política no autoriza pruebas sobre `fundosmart.com` ni sobre infraestructura o cuentas de terceros.
