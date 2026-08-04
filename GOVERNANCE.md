# Gobierno de FundoSmart

## Principios

FundoSmart se desarrolla en público, prioriza la utilidad para productores latinoamericanos, protege los datos agrícolas y mantiene una frontera estable para integraciones. Las decisiones técnicas se justifican por evidencia y compatibilidad, no por el tamaño comercial de quien las propone.

## Roles

- **Contribuidor:** participa en issues, documentación, diseño o código.
- **Revisor:** puede aprobar cambios en un área por experiencia demostrada y revisiones consistentes.
- **Mantenedor:** integra cambios, publica versiones comunitarias, modera y cuida la dirección del proyecto.

Los mantenedores nombran nuevos revisores y mantenedores mediante una decisión pública que considere calidad, criterio de seguridad, colaboración y continuidad. La inactividad no elimina el crédito histórico; los permisos operativos pueden retirarse después de seis meses sin actividad o de inmediato ante un riesgo de seguridad.

## Decisiones

Los cambios rutinarios se deciden en pull requests por consenso aproximado: se atienden objeciones fundamentadas, pero no se exige unanimidad. Un mantenedor sin conflicto resuelve un bloqueo y deja la razón por escrito.

Requieren propuesta pública y período razonable de comentarios:

- contratos de API, eventos o SDK;
- cambios incompatibles o de deprecación;
- modelo de permisos o aislamiento;
- licencia, gobierno o política de marca;
- incorporación de una dependencia estratégica o servicio obligatorio.

Las decisiones arquitectónicas aceptadas se registran como ADR en `docs/architecture/` y se enlazan desde `docs/index.md`. Una emergencia de seguridad puede resolverse en privado y documentarse después del release coordinado.

## Núcleo y servicio administrado

El repositorio comunitario contiene el núcleo que cualquiera puede ejecutar. FundoSmart Cloud ofrece operación, soporte, backups, integraciones administradas y otros servicios; no recibe privilegios ocultos en el contrato público del core. Credenciales, datos de clientes y configuración productiva permanecen fuera del repositorio.

## Licencia y contribuciones

El núcleo se distribuye como `AGPL-3.0-only`. Las contribuciones entran bajo la misma licencia y requieren DCO. Cambiar la licencia del trabajo existente exige respetar los derechos de todas las personas titulares; una futura oferta comercial alternativa no puede revocar las libertades de versiones ya publicadas.

## Conflictos de interés

Quien tenga una relación financiera, laboral o comercial relevante debe declararla y abstenerse de ser la única persona que aprueba o resuelve el asunto. Las decisiones de moderación se rigen por [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
