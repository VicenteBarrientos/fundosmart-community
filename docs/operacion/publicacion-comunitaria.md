# Publicación de FundoSmart Community

Este procedimiento publica una versión de código fuente en GitHub. No despliega Workers, no ejecuta migraciones D1, no escribe en R2 y no recibe credenciales de Cloudflare. El único comando Wrangler alcanzable es el `deploy --dry-run` que forma parte de `npm run check` y el job mantiene vacías todas las variables de autenticación de Cloudflare.

La versión `v0.2.0` se publica exclusivamente mediante [`.github/workflows/release.yml`](../../.github/workflows/release.yml). El workflow se despacha desde `main`, exige el SHA completo visible en `main` y la confirmación literal `publish v0.2.0`. No responde a pushes de tags ni admite otra versión.

## Configuración remota obligatoria

Un administrador debe completar estas cuatro configuraciones antes del primer dispatch. El workflow vuelve a consultar mediante API todas las propiedades observables justo antes de cualquier escritura y falla si no coinciden. Sólo el bypass administrativo del environment, que no forma parte de la respuesta REST, se revisa manualmente durante la aprobación protegida. Salvo la normalización documentada de `parameters` exclusiva de una regla `update` con target `tag`, ninguna propiedad de seguridad omitida se infiere como segura.

1. En **Settings → General → Releases**, habilitar **release immutability**. GitHub sólo aplica esta protección a releases futuros.
2. Crear el environment `public-release` con un único required reviewer de tipo `User`, ID `175753145` (`VicenteBarrientos`), `prevent_self_review: false` y **Deployment branches and tags → Protected branches only**. Deshabilitar manualmente **Allow administrators to bypass configured protection rules**. La respuesta REST pública no contiene ese ajuste, por lo que el reviewer debe comprobarlo en Settings; el workflow valida por API todas las demás propiedades exactas.
3. Crear un ruleset activo cuyo target sea **Tags**, tenga exactamente `include: ["refs/tags/v*"]`, `exclude: []`, `bypass_actors: []` y sólo las reglas **Restrict updates** y **Restrict deletions**. La creación permanece permitida porque el workflow crea la referencia exacta una sola vez. GitHub omite actualmente `parameters` al leer una regla `update` de tags, incluso si el API aceptó `update_allows_fetch_and_merge: false`; el publicador admite esa omisión sólo bajo este contrato exacto. Si `parameters` aparece, debe contener únicamente ese valor en `false`. Si GitHub omite `bypass_actors`, el release falla cerrado; no se acepta la omisión como evidencia de una lista vacía.
4. Crear en el environment el secret `PUBLIC_RELEASE_ADMIN_READ_TOKEN` con un fine-grained PAT limitado únicamente a `VicenteBarrientos/fundosmart-community` y permiso **Administration: read**. Este token sólo consulta `immutable-releases` y el ruleset mediante `GET`; el cliente rechaza cualquier otro método. El `github.token` separado conserva las únicas escrituras de tag, release y assets. Si Administration read no expone el contrato exacto anterior, se aborta en vez de elevar el PAT a Administration write. Para este release puntual, elimínalo del environment después de verificar `v0.2.0`.

No basta con escribir `environment: public-release` en YAML: GitHub crea un environment vacío si no existe. Por eso el publicador valida mediante el API la identidad exacta del reviewer, `prevent_self_review`, la política de ramas y todo el ruleset. Sólo la desactivación del bypass administrativo del environment queda como precondición manual, porque ese campo no existe en la respuesta REST pública.

Referencias: [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [environments protegidos](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) y [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Protección del release histórico

GitHub no vuelve inmutable retroactivamente un release publicado antes de habilitar la opción. `v0.1.0` no se debe borrar, recrear ni retaggear para intentar cambiar esa limitación. El ruleset protege su tag y el workflow comprueba este fingerprint antes de crear `v0.2.0` y después de publicarlo:

| Evidencia | Valor fijo |
|---|---|
| Objeto de tag | `4c919d577f76b98de8732a9ce6597ca08b294659` |
| Commit apuntado | `939c400e56fd7ca6838784fe7d4ca7d939f96262` |
| Release ID | `364821011` |
| Asset | `sbom.cdx.json`, 678652 bytes |
| Digest del asset | `sha256:30d88796747c7c3f2c8256338ed5435b03d1f39448608868a4938e5449ade358` |

Cualquier divergencia bloquea la publicación. El workflow no contiene solicitudes `DELETE` y sólo permite un `PATCH` al ID del draft que acaba de crear en esa misma ejecución.

## Preparación de la versión

Antes del dispatch, el commit integrado en `main` debe tener la misma identidad en:

- `package.json.version`;
- `package-lock.json.version` y `package-lock.json.packages[""].version`;
- `sbom.cdx.json`, incluido `metadata.component.version` y su purl;
- estas notas en [`docs/releases/v0.2.0.md`](../releases/v0.2.0.md).

El SBOM se genera y revisa en el cambio de dependencias. El workflow no instala un generador fuera del lockfile: valida el CycloneDX versionado y lo copia con un nombre ligado al release. Luego crea desde los objetos Git un tar reproducible, comprime con cabecera determinista y calcula `SHA256SUMS`.

El job `gate` tiene sólo `contents: read`. Primero compara el input con el SHA confiable de `workflow_dispatch`, reconcilia `origin/main`, crea el bundle y lo sube con `overwrite: false`. Sólo después ejecuta npm 10.9.3, `npm ci` y `npm run check`. Así las dependencias no pueden modificar el artefacto que cruza a los jobs protegidos; si el gate posterior falla, `attest` y `publish` no se ejecutan. El job `attest` es distinto y es el único que recibe permisos OIDC/attestations; nunca instala ni ejecuta dependencias. El job `publish` vuelve a usar `${{ github.sha }}`, obtiene `contents: write` únicamente después de la aprobación del environment y tampoco instala dependencias.

## Dispatch

Obtén el SHA actual sin usar una rama de trabajo:

```bash
git fetch origin main
git rev-parse origin/main
```

Despacha exactamente desde `main`:

```bash
gh workflow run release.yml \
  --ref main \
  -f version=0.2.0 \
  -f release_sha=<SHA_COMPLETO_DE_ORIGIN_MAIN> \
  -f confirmation='publish v0.2.0'
```

Si `main` avanza durante el gate, el workflow falla antes de publicar y se debe revisar el nuevo delta antes de un dispatch nuevo.

## Orden de publicación y estados parciales

Después del gate y las atestaciones, el publicador sigue este orden:

1. comprueba `main`, ausencia de tag/release `v0.2.0`, inmutabilidad, reviewer/política exactos del environment, ruleset exacto sin bypass y fingerprint de `v0.1.0`; el bypass administrativo del environment ya fue comprobado manualmente al aprobar;
2. crea `refs/tags/v0.2.0` directamente sobre el SHA confirmado y relee la referencia;
3. crea un release draft nuevo para ese tag;
4. carga y vuelve a leer los tres assets, verificando nombre, tamaño y digest del API;
5. vuelve a comprobar todas las precondiciones;
6. cambia a publicado únicamente el ID de draft recién creado;
7. exige `immutable: true`, tag exacto, tres assets exactos y fingerprint histórico intacto.

La creación previa del tag evita depender de cuándo GitHub decide crear implícitamente un tag durante la API de Releases. Tanto `createRef` como `createRelease` son operaciones de creación: si otro actor ganó la carrera, GitHub responde con conflicto y el workflow no actualiza nada existente.

Un fallo posterior a la creación del tag puede dejar un tag correcto sin release; uno posterior a la creación del draft puede dejar un draft parcial. En ambos casos, **no se reintenta automáticamente y no se borra nada**. Un mantenedor debe comparar tag, SHA, draft y assets con la ejecución original y aprobar un procedimiento de recuperación separado. Esta política conserva evidencia y evita que un reintento convierta una operación de creación en una actualización implícita.

## Artefactos y verificación

El release contiene exactamente:

- `fundosmart-community-v0.2.0.tar.gz`;
- `fundosmart-community-v0.2.0.cdx.json`;
- `SHA256SUMS`.

GitHub almacena provenance SLSA para los tres archivos y una atestación SBOM que vincula CycloneDX al tarball. Al habilitar releases inmutables, GitHub también crea la atestación del release publicado.

Una persona consumidora puede comprobarlo con:

```bash
sha256sum --check SHA256SUMS
gh attestation verify fundosmart-community-v0.2.0.tar.gz \
  --repo VicenteBarrientos/fundosmart-community
gh release verify v0.2.0 \
  --repo VicenteBarrientos/fundosmart-community
gh release verify-asset v0.2.0 fundosmart-community-v0.2.0.tar.gz \
  --repo VicenteBarrientos/fundosmart-community
```

Los tarballs y ZIP generados dinámicamente por GitHub no sustituyen el tarball adjunto: `gh release verify-asset` sólo puede comprobar assets explícitos del release.
