import { createHash } from "node:crypto";
import path from "node:path";

export const EXPECTED_NPM_VERSION = "10.9.3";
export const LOCKFILE_PATH_PROPERTY = "cdx:npm:package:path";

const CYCLONEDX_SCHEMA = "http://cyclonedx.org/schema/bom-1.5.schema.json";
const UUID_URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const NORMALIZER_VERSION = "1";

const LICENSE_OVERRIDES = new Map([
  [
    "node_modules/@turf/jsts",
    {
      version: "2.7.2",
      declaredLicense: "(EDL-1.0 OR EPL-1.0)",
      integrity: "sha512-zAezGlwWHPyU0zxwcX2wQY3RkRpwuoBmhhNE9HY9kWhFDkCxZ3aWK5URKwa/SWKJbj9aztO+8vtdiBA28KVJFg==",
      licenses: [
        {
          license: {
            name: "Eclipse Distribution License 1.0",
            url: "https://raw.githubusercontent.com/bjornharrtell/jsts/2.7.1/LICENSE_EDLv1.txt",
          },
        },
      ],
    },
  ],
  [
    "node_modules/jsts",
    {
      version: "2.7.1",
      declaredLicense: "(EDL-1.0 OR EPL-1.0)",
      integrity: "sha512-x2wSZHEBK20CY+Wy+BPE7MrFQHW6sIsdaGUMEqmGAio+3gFzQaBYPwLRonUfQf9Ak8pBieqj9tUofX1+WtAEIg==",
      licenses: [
        {
          license: {
            name: "Eclipse Distribution License 1.0",
            url: "https://raw.githubusercontent.com/bjornharrtell/jsts/2.7.1/LICENSE_EDLv1.txt",
          },
        },
      ],
    },
  ],
  [
    "node_modules/splaytree-ts",
    {
      version: "1.0.2",
      declaredLicense: "BDS-3-Clause",
      integrity: "sha512-0kGecIZNIReCSiznK3uheYB8sbstLjCZLiwcQwbmLhgHJj2gz6OnSPkVzJQCMnmEz1BQ4gPK59ylhBoEWOhGNA==",
      licenses: [{ license: { id: "BSD-3-Clause" } }],
    },
  ],
]);

export function normalizeSbom({
  rawSbom,
  manifest,
  lockfile,
  lockfileSha256,
  localComponentHashes = new Map(),
}) {
  validateInputs({ rawSbom, manifest, lockfile, lockfileSha256 });

  const packages = lockfile.packages;
  const expectedPaths = Object.entries(packages)
    .filter(([packagePath, metadata]) => packagePath !== "" && metadata.link !== true)
    .map(([packagePath]) => packagePath)
    .sort(compareOrdinal);
  const rawByPath = indexRawComponents(rawSbom.components, expectedPaths);
  const normalizedByPath = new Map();

  validateLicenseOverrideBoundary(rawByPath, packages);

  for (const packagePath of expectedPaths) {
    const rawComponent = rawByPath.get(packagePath);
    const packageMetadata = packages[packagePath];
    const component = normalizeComponent({
      rawComponent,
      packageMetadata,
      packagePath,
      localComponentHashes,
    });
    normalizedByPath.set(packagePath, component);
  }

  const rootPurl = npmPurl(manifest.name, manifest.version);
  const rootComponent = createRootComponent(manifest, rootPurl);
  const dependencies = buildDependencyGraph({
    packages,
    normalizedByPath,
    rootRef: rootComponent["bom-ref"],
  });

  const rawEdgeCount = countEdges(rawSbom.dependencies, "native npm dependency graph");
  const normalizedEdgeCount = countEdges(dependencies, "normalized dependency graph");
  assert(
    normalizedEdgeCount === rawEdgeCount,
    `The normalized dependency graph has ${normalizedEdgeCount} edges, but npm 10.9.3 emitted ${rawEdgeCount}`,
  );

  const draft = {
    $schema: CYCLONEDX_SCHEMA,
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      lifecycles: [{ phase: "pre-build" }],
      tools: [{ vendor: "npm", name: "cli", version: EXPECTED_NPM_VERSION }],
      component: rootComponent,
      properties: sortProperties([
        { name: "fundosmart:sbom:lockfile-sha256", value: lockfileSha256 },
        { name: "fundosmart:sbom:normalizer-version", value: NORMALIZER_VERSION },
        { name: "fundosmart:sbom:optional-policy", value: "full-lockfile" },
      ]),
    },
    components: [...normalizedByPath.values()].sort(compareComponentsByPath),
    dependencies,
  };

  const canonicalDraft = stableValue(draft);
  const contentDigest = createHash("sha256")
    .update(JSON.stringify(canonicalDraft), "utf8")
    .digest("hex");
  const normalized = stableValue({
    ...draft,
    serialNumber: `urn:uuid:${uuidV5(`fundosmart-community-sbom:sha256:${contentDigest}`)}`,
  });

  validateNormalizedSbom(normalized, {
    expectedPaths,
    manifest,
    lockfile,
    normalizedByPath,
  });
  return normalized;
}

export function serializeSbom(sbom) {
  return `${JSON.stringify(stableValue(sbom), null, 2)}\n`;
}

export function componentPath(component) {
  const matches = Array.isArray(component?.properties)
    ? component.properties.filter((property) => property?.name === LOCKFILE_PATH_PROPERTY)
    : [];
  assert(matches.length === 1, "Every component must have exactly one cdx:npm:package:path property");
  assert(typeof matches[0].value === "string", "The cdx:npm:package:path value must be a string");
  return matches[0].value;
}

export function bomRefFor(purl, packagePath) {
  assert(typeof purl === "string" && purl.startsWith("pkg:"), "A canonical package URL is required for bom-ref");
  assert(!purl.includes("#"), `Package URL must not already contain a fragment: ${purl}`);
  const identityPath = packagePath === "" ? "." : packagePath;
  return `${purl}#npm-path=${encodeURIComponent(identityPath)}`;
}

function validateInputs({ rawSbom, manifest, lockfile, lockfileSha256 }) {
  assert(isRecord(rawSbom), "npm did not emit a JSON object");
  assert(rawSbom.$schema === CYCLONEDX_SCHEMA, `Unexpected CycloneDX schema: ${rawSbom.$schema}`);
  assert(rawSbom.bomFormat === "CycloneDX", "npm must emit CycloneDX JSON");
  assert(rawSbom.specVersion === "1.5", `Unexpected CycloneDX version: ${rawSbom.specVersion}`);
  assert(rawSbom.version === 1, `Unexpected native SBOM version: ${rawSbom.version}`);
  assert(Array.isArray(rawSbom.components), "The native SBOM has no components array");
  assert(Array.isArray(rawSbom.dependencies), "The native SBOM has no dependency graph");
  assert(rawSbom.metadata?.lifecycles?.length === 1, "The native SBOM must declare one lifecycle");
  assert(rawSbom.metadata.lifecycles[0]?.phase === "pre-build", "The native SBOM must be generated from the lockfile");
  assert(rawSbom.metadata?.tools?.length === 1, "The native SBOM must identify exactly one generator");
  assert(rawSbom.metadata.tools[0]?.vendor === "npm", "The native SBOM generator vendor must be npm");
  assert(rawSbom.metadata.tools[0]?.name === "cli", "The native SBOM generator must be the npm CLI");
  assert(
    rawSbom.metadata.tools[0]?.version === EXPECTED_NPM_VERSION,
    `The native SBOM must come from npm ${EXPECTED_NPM_VERSION}`,
  );

  assert(isRecord(manifest), "package.json must contain a JSON object");
  assert(manifest.name === "fundosmart-community", `Unexpected package name: ${manifest.name}`);
  assert(typeof manifest.version === "string" && manifest.version !== "", "package.json must declare a version");
  assert(manifest.license === "AGPL-3.0-only", `Unexpected project license: ${manifest.license}`);
  assert(
    manifest.packageManager === `npm@${EXPECTED_NPM_VERSION}`,
    `packageManager must be npm@${EXPECTED_NPM_VERSION}`,
  );

  assert(isRecord(lockfile), "package-lock.json must contain a JSON object");
  assert(lockfile.lockfileVersion === 3, `Only package-lock v3 is supported, received ${lockfile.lockfileVersion}`);
  assert(isRecord(lockfile.packages), "package-lock.json has no packages map");
  const rootMetadata = lockfile.packages[""];
  assert(isRecord(rootMetadata), "package-lock.json has no root package entry");
  assert(lockfile.name === manifest.name, "package-lock.json name differs from package.json");
  assert(lockfile.version === manifest.version, "package-lock.json version differs from package.json");
  assert(rootMetadata.name === manifest.name, "The lockfile root name differs from package.json");
  assert(rootMetadata.version === manifest.version, "The lockfile root version differs from package.json");
  assert(rootMetadata.license === manifest.license, "The lockfile root license differs from package.json");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert(
      JSON.stringify(stableValue(rootMetadata[field] ?? {})) === JSON.stringify(stableValue(manifest[field] ?? {})),
      `The lockfile root ${field} differ from package.json`,
    );
  }

  const expectedRootPurl = npmPurl(manifest.name, manifest.version);
  assert(
    rawSbom.metadata?.component?.purl === expectedRootPurl,
    `The native root PURL differs from package.json: ${rawSbom.metadata?.component?.purl}`,
  );
  assert(/^[0-9a-f]{64}$/u.test(lockfileSha256), "The lockfile SHA-256 must be lowercase hexadecimal");
}

function indexRawComponents(rawComponents, expectedPaths) {
  const rawByPath = new Map();
  for (const component of rawComponents) {
    const packagePath = componentPath(component);
    validatePackagePath(packagePath, false);
    assert(!rawByPath.has(packagePath), `npm emitted duplicate component path: ${packagePath}`);
    rawByPath.set(packagePath, component);
  }

  const actualPaths = [...rawByPath.keys()].sort(compareOrdinal);
  assert(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    `Native SBOM paths do not match the complete lockfile:\n${describeSetDifference(expectedPaths, actualPaths)}`,
  );
  return rawByPath;
}

function validateLicenseOverrideBoundary(rawByPath, packages) {
  const expectedMissing = [...LICENSE_OVERRIDES.keys()]
    .filter((packagePath) => rawByPath.has(packagePath))
    .sort(compareOrdinal);
  const actualMissing = [...rawByPath.entries()]
    .filter(([, component]) => !Array.isArray(component.licenses) || component.licenses.length === 0)
    .map(([packagePath]) => packagePath)
    .sort(compareOrdinal);
  assert(
    JSON.stringify(actualMissing) === JSON.stringify(expectedMissing),
    `Native SBOM license omissions changed:\n${describeSetDifference(expectedMissing, actualMissing)}`,
  );

  for (const packagePath of expectedMissing) {
    const policy = LICENSE_OVERRIDES.get(packagePath);
    const metadata = packages[packagePath];
    assert(metadata.version === policy.version, `${packagePath} version changed; review its license evidence`);
    assert(
      metadata.license === policy.declaredLicense,
      `${packagePath} declared license changed; review its license evidence`,
    );
    assert(metadata.integrity === policy.integrity, `${packagePath} integrity changed; review its retained license evidence`);
  }
}

function normalizeComponent({
  rawComponent,
  packageMetadata,
  packagePath,
  localComponentHashes,
}) {
  assert(rawComponent.version === packageMetadata.version, `${packagePath} version differs between npm and the lockfile`);
  assert(typeof rawComponent.purl === "string", `${packagePath} has no package URL`);
  const policy = LICENSE_OVERRIDES.get(packagePath);
  const licenses = policy ? policy.licenses : rawComponent.licenses;
  validateLicenses(licenses, packagePath);

  const properties = [...(rawComponent.properties ?? [])];
  let hashes = rawComponent.hashes ? rawComponent.hashes.map((hash) => ({ ...hash })) : undefined;
  if (!packagePath.startsWith("node_modules/")) {
    const localHash = getMapValue(localComponentHashes, packagePath);
    assert(/^[0-9a-f]{64}$/u.test(localHash ?? ""), `Missing canonical SHA-256 for local component ${packagePath}`);
    hashes = [{ alg: "SHA-256", content: localHash }];
    properties.push({ name: "fundosmart:sbom:local-component", value: "true" });
  } else if (packageMetadata.integrity) {
    assert(Array.isArray(hashes) && hashes.length > 0, `${packagePath} lost its lockfile integrity hash`);
  } else {
    assert(packageMetadata.inBundle === true, `${packagePath} has neither integrity nor an in-bundle provenance boundary`);
  }

  return stableValue({
    ...rawComponent,
    "bom-ref": bomRefFor(rawComponent.purl, packagePath),
    properties: sortProperties(properties),
    externalReferences: sortExternalReferences(rawComponent.externalReferences ?? []),
    ...(hashes ? { hashes: sortByJson(hashes) } : {}),
    licenses: sortByJson(licenses),
  });
}

function createRootComponent(manifest, rootPurl) {
  const properties = [{ name: LOCKFILE_PATH_PROPERTY, value: "" }];
  if (manifest.private === true) {
    properties.push({ name: "cdx:npm:package:private", value: "true" });
  }

  const externalReferences = [];
  if (manifest.repository?.url) {
    externalReferences.push({ type: "vcs", url: manifest.repository.url });
  }
  if (manifest.homepage) {
    externalReferences.push({ type: "website", url: manifest.homepage });
  }
  if (manifest.bugs?.url) {
    externalReferences.push({ type: "issue-tracker", url: manifest.bugs.url });
  }

  return stableValue({
    "bom-ref": bomRefFor(rootPurl, ""),
    type: "application",
    name: manifest.name,
    version: manifest.version,
    scope: "required",
    ...(manifest.description ? { description: manifest.description } : {}),
    purl: rootPurl,
    properties: sortProperties(properties),
    externalReferences: sortExternalReferences(externalReferences),
    licenses: [{ license: { id: manifest.license } }],
  });
}

function buildDependencyGraph({ packages, normalizedByPath, rootRef }) {
  const refByPath = new Map(
    [...normalizedByPath.entries()].map(([packagePath, component]) => [packagePath, component["bom-ref"]]),
  );
  const graph = [];

  for (const [packagePath, metadata] of Object.entries(packages)) {
    if (metadata.link === true) {
      continue;
    }
    const sourceRef = packagePath === "" ? rootRef : refByPath.get(packagePath);
    assert(sourceRef, `No component reference exists for ${packagePath || "the root package"}`);
    const declarations = dependencyDeclarations(metadata, packagePath === "");
    const dependsOn = [];

    for (const [dependencyName, declaration] of declarations) {
      const targetPath = resolveDependencyPath({ packages, packagePath, dependencyName });
      if (!targetPath) {
        assert(
          declaration.optional,
          `Missing required dependency ${dependencyName} from ${packagePath || "the root package"}`,
        );
        continue;
      }
      const targetRef = refByPath.get(targetPath);
      assert(targetRef, `Resolved dependency ${dependencyName} points to a non-component path: ${targetPath}`);
      dependsOn.push(targetRef);
    }

    graph.push({ ref: sourceRef, dependsOn: [...new Set(dependsOn)].sort(compareOrdinal) });
  }

  return graph.sort((left, right) => compareOrdinal(left.ref, right.ref));
}

function dependencyDeclarations(metadata, isRoot) {
  const declarations = new Map();
  const add = (values, optional, overwrite) => {
    for (const dependencyName of Object.keys(values ?? {}).sort(compareOrdinal)) {
      validateDependencyName(dependencyName);
      if (overwrite || !declarations.has(dependencyName)) {
        declarations.set(dependencyName, { optional });
      }
    }
  };

  add(metadata.dependencies, false, false);
  if (isRoot) {
    add(metadata.devDependencies, false, false);
  }
  add(metadata.optionalDependencies, true, true);
  for (const dependencyName of Object.keys(metadata.peerDependencies ?? {}).sort(compareOrdinal)) {
    validateDependencyName(dependencyName);
    if (!declarations.has(dependencyName)) {
      const peerMetadata = metadata.peerDependenciesMeta?.[dependencyName];
      declarations.set(dependencyName, { optional: peerMetadata?.optional === true });
    }
  }
  return declarations;
}

function resolveDependencyPath({ packages, packagePath, dependencyName }) {
  let cursor = packagePath;
  const candidates = new Set();
  while (true) {
    const candidate = `${cursor ? `${cursor}/` : ""}node_modules/${dependencyName}`;
    if (!candidates.has(candidate)) {
      candidates.add(candidate);
      const resolved = followLockfileLink(packages, candidate);
      if (resolved) {
        return resolved;
      }
    }
    if (cursor === "") {
      break;
    }
    const nestedMarker = cursor.lastIndexOf("/node_modules/");
    if (nestedMarker >= 0) {
      cursor = cursor.slice(0, nestedMarker);
    } else if (cursor.startsWith("node_modules/")) {
      cursor = "";
    } else {
      cursor = path.posix.dirname(cursor);
      if (cursor === ".") {
        cursor = "";
      }
    }
  }
  return null;
}

function followLockfileLink(packages, candidate) {
  let current = candidate;
  const seen = new Set();
  while (packages[current]?.link === true) {
    assert(!seen.has(current), `Lockfile link cycle detected at ${current}`);
    seen.add(current);
    const resolved = packages[current].resolved;
    assert(typeof resolved === "string" && resolved !== "", `Lockfile link ${current} has no target`);
    validatePackagePath(resolved, false);
    const directTarget = path.posix.normalize(resolved);
    const relativeTarget = path.posix.normalize(path.posix.join(path.posix.dirname(current), resolved));
    if (packages[directTarget]) {
      current = directTarget;
    } else if (packages[relativeTarget]) {
      current = relativeTarget;
    } else {
      throw new Error(`Lockfile link ${current} points outside the package graph: ${resolved}`);
    }
  }
  return packages[current] ? current : null;
}

function validateNormalizedSbom(sbom, { expectedPaths, manifest, lockfile, normalizedByPath }) {
  assert(sbom.metadata?.timestamp === undefined, "A deterministic SBOM must not contain a generation timestamp");
  assert(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sbom.serialNumber),
    "The deterministic serial must be an RFC 4122 UUIDv5",
  );
  assert(sbom.metadata.component.name === manifest.name, "The normalized root name differs from package.json");
  assert(sbom.metadata.component.version === manifest.version, "The normalized root version differs from package.json");

  const actualPaths = sbom.components.map(componentPath).sort(compareOrdinal);
  assert(JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), "The normalized SBOM is not a full lockfile inventory");
  const componentRefs = sbom.components.map((component) => component["bom-ref"]);
  assert(new Set(componentRefs).size === componentRefs.length, "Component bom-ref values must be unique");

  const graphRefs = sbom.dependencies.map((dependency) => dependency.ref);
  assert(new Set(graphRefs).size === graphRefs.length, "Dependency graph refs must be unique");
  const expectedGraphRefs = new Set([sbom.metadata.component["bom-ref"], ...componentRefs]);
  assert(graphRefs.length === expectedGraphRefs.size, "The dependency graph must contain the root and every component exactly once");
  for (const dependency of sbom.dependencies) {
    assert(expectedGraphRefs.has(dependency.ref), `Unknown dependency graph source: ${dependency.ref}`);
    assert(new Set(dependency.dependsOn).size === dependency.dependsOn.length, `${dependency.ref} has duplicate dependency edges`);
    assert(!dependency.dependsOn.includes(dependency.ref), `${dependency.ref} has a self dependency`);
    for (const target of dependency.dependsOn) {
      assert(expectedGraphRefs.has(target), `${dependency.ref} points to unknown component ${target}`);
    }
  }

  const graph = new Map(sbom.dependencies.map((dependency) => [dependency.ref, dependency.dependsOn]));
  const reached = new Set([sbom.metadata.component["bom-ref"]]);
  const pending = [...reached];
  while (pending.length > 0) {
    for (const target of graph.get(pending.pop()) ?? []) {
      if (!reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  assert(reached.size === expectedGraphRefs.size, "Every locked component must be reachable from the root package");

  const sharpVersion = manifest.devDependencies?.sharp;
  if (sharpVersion) {
    const sharp = normalizedByPath.get("node_modules/sharp");
    assert(sharp?.version === lockfile.packages["node_modules/sharp"]?.version, "The direct sharp tool is absent from the SBOM");
    const rootNode = graph.get(sbom.metadata.component["bom-ref"]);
    assert(rootNode.includes(sharp["bom-ref"]), "The root dependency graph does not include the direct sharp tool");
  }

  for (const component of sbom.components) {
    validateLicenses(component.licenses, componentPath(component));
  }
}

function validateLicenses(licenses, packagePath) {
  assert(Array.isArray(licenses) && licenses.length > 0, `${packagePath} has no license evidence`);
  for (const entry of licenses) {
    const hasExpression = typeof entry?.expression === "string" && entry.expression !== "";
    const license = entry?.license;
    const hasLicense = isRecord(license)
      && ((typeof license.id === "string" && license.id !== "")
        || (typeof license.name === "string" && license.name !== ""));
    assert(hasExpression !== hasLicense, `${packagePath} has malformed CycloneDX license evidence`);
  }
}

function countEdges(dependencies, label) {
  assert(Array.isArray(dependencies), `${label} is missing`);
  let count = 0;
  for (const dependency of dependencies) {
    assert(Array.isArray(dependency?.dependsOn), `${label} contains a node without dependsOn`);
    count += dependency.dependsOn.length;
  }
  return count;
}

function npmPurl(name, version) {
  let encodedName;
  if (name.startsWith("@")) {
    const [scope, packageName, ...extra] = name.split("/");
    assert(scope.length > 1 && packageName && extra.length === 0, `Invalid scoped npm name: ${name}`);
    encodedName = `%40${encodeURIComponent(scope.slice(1))}/${encodeURIComponent(packageName)}`;
  } else {
    assert(!name.includes("/"), `Invalid npm name: ${name}`);
    encodedName = encodeURIComponent(name);
  }
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function validatePackagePath(packagePath, allowRoot) {
  assert(typeof packagePath === "string", "Package paths must be strings");
  if (packagePath === "") {
    assert(allowRoot, "The root path is not a component path");
    return;
  }
  assert(!packagePath.includes("\\"), `Package path must use POSIX separators: ${packagePath}`);
  assert(!path.posix.isAbsolute(packagePath), `Package path must be relative: ${packagePath}`);
  const segments = packagePath.split("/");
  assert(
    segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    `Package path is not canonical: ${packagePath}`,
  );
}

function validateDependencyName(dependencyName) {
  assert(typeof dependencyName === "string" && dependencyName !== "", "Dependency names must be non-empty strings");
  assert(!dependencyName.includes("\\"), `Dependency name must not contain backslashes: ${dependencyName}`);
  const parts = dependencyName.split("/");
  const valid = dependencyName.startsWith("@")
    ? parts.length === 2 && parts.every((part) => part !== "" && part !== "." && part !== "..")
    : parts.length === 1 && parts[0] !== "." && parts[0] !== "..";
  assert(valid, `Dependency name is not canonical: ${dependencyName}`);
}

function uuidV5(name) {
  const digest = createHash("sha1")
    .update(UUID_URL_NAMESPACE)
    .update(Buffer.from(name, "utf8"))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function sortProperties(properties) {
  return properties
    .map((property) => ({ ...property }))
    .sort((left, right) => compareOrdinal(`${left.name}\0${left.value}`, `${right.name}\0${right.value}`));
}

function sortExternalReferences(references) {
  return references
    .map((reference) => ({ ...reference }))
    .sort((left, right) => compareOrdinal(`${left.type}\0${left.url}`, `${right.type}\0${right.url}`));
}

function sortByJson(values) {
  return values
    .map((value) => stableValue(value))
    .sort((left, right) => compareOrdinal(JSON.stringify(left), JSON.stringify(right)));
}

function compareComponentsByPath(left, right) {
  return compareOrdinal(componentPath(left), componentPath(right));
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describeSetDifference(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  return `missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`;
}

function getMapValue(mapLike, key) {
  if (mapLike instanceof Map) {
    return mapLike.get(key);
  }
  return mapLike?.[key];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
