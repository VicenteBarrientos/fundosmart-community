# Third-party notices

This file records material third-party runtime and build-time dependencies used
by FundoSmart Community. It does not grant rights to ArcGIS basemap data,
styles, fonts, sprites, or imagery; those remain subject to the applicable
ArcGIS Location Platform terms and the provider attribution rendered in the
map.

## Esri Leaflet Vector 4.3.2

- Package: `esri-leaflet-vector@4.3.2`
- Source: <https://github.com/Esri/esri-leaflet-vector>
- License: Apache License 2.0
- Copyright: 2014–2024 Environmental Systems Research Institute, Inc.
- Purpose: official Leaflet adapter for authenticated ArcGIS vector basemap
  styles.
- Maintenance review: exact version published 2025-10-24; maintained in the
  official Esri repository; package includes TypeScript declarations and its
  Apache-2.0 `LICENSE`.

The package is used without copying source files into FundoSmart. Its API key is
public browser configuration by design and is restricted operationally to the
Basemaps privilege.

## Required peer runtime

`esri-leaflet-vector` declares the following peers. Their resolved versions are
locked by `package-lock.json` and included in `sbom.cdx.json`.

### Leaflet 1.9.4

- Package: `leaflet@1.9.4`
- Source: <https://github.com/Leaflet/Leaflet>
- License: BSD 2-Clause
- Copyright: 2010–2023 Vladimir Agafonkin and 2010–2011 CloudMade.

FundoSmart's React lifecycle adapter lives in
`src/core/maps/leaflet-react.tsx` and is first-party AGPL code. The dependency
graph intentionally does not include `react-leaflet` or `@react-leaflet/core`.

### Esri Leaflet 3.0.19

- Package: `esri-leaflet@3.0.19`
- Source: <https://github.com/Esri/esri-leaflet>
- License: Apache License 2.0
- Copyright: 2014–2019 Environmental Systems Research Institute, Inc.
- Bundled notices retained by its license include portions of `leaflet-ags`
  (MIT, Copyright 2013 Sanborn Map Company, Inc.) and
  `arcgis-level-fixer` (MIT, Copyright 2014 Geographic Information Services,
  Inc.).

### MapLibre GL JS 4.7.1

- Package: `maplibre-gl@4.7.1`
- Source: <https://github.com/maplibre/maplibre-gl-js>
- License: BSD 3-Clause
- Copyright: 2023 MapLibre contributors.
- Its distributed license also retains notices for Mapbox GL JS v1.13 and
  earlier (BSD 3-Clause, Copyright 2020 Mapbox), `glfx.js` (MIT, Copyright 2011
  Evan Wallace), and a portion of `d3-color` (BSD 3-Clause, Copyright
  2010–2016 Mike Bostock).

MapLibre is present only as the renderer required by the official basemap
plugin. It does not replace Leaflet, the map interaction adapter, or FundoSmart's
geometry engine.

## Browser compatibility data

### caniuse-lite 1.0.30001793

- Package: `caniuse-lite@1.0.30001793`
- Source: <https://github.com/browserslist/caniuse-lite>
- License: Creative Commons Attribution 4.0 International (`CC-BY-4.0`)
- Attribution: Ben Briggs and the caniuse-lite contributors.
- Purpose: browser compatibility data consumed by the frontend build toolchain.

The package contains data rather than application source code. Its license is
not an OSI software license, but it permits sharing and adaptation with
attribution. FundoSmart does not remove its notices or claim authorship of the
data.

## Build-time image pipeline

### Sharp 0.35.3 and platform packages

- Package: `sharp@0.35.3`
- Source: <https://github.com/lovell/sharp>
- License: Apache License 2.0 (`Apache-2.0`)
- Purpose: deterministic generation of first-party brand and icon assets.

`sharp` is a direct development dependency and is also an optional image
dependency in the frontend toolchain. Its optional `@img/sharp-*` packages
include Apache-2.0 code. Variants that bundle libvips also declare GNU Lesser
General Public License 3.0 or later (`LGPL-3.0-or-later`), and the WebAssembly
variant additionally declares MIT components. The separate
`@img/sharp-libvips-*` packages declare `LGPL-3.0-or-later`. The SBOM preserves
each exact SPDX expression from the lockfile, and each npm tarball retains its
own license material.

The checked-in SBOM is a pre-build, full lockfile inventory, so it records all
locked operating-system and CPU variants even though npm installs only the
variant compatible with a particular machine. Inclusion in that inventory does
not claim that every variant is shipped in every built artifact.

## Geometry engine transitive dependencies

### JSTS 2.7.1 and @turf/jsts 2.7.2

- Packages: `jsts@2.7.1` and `@turf/jsts@2.7.2`
- Sources: <https://github.com/bjornharrtell/jsts/tree/2.7.1> and
  <https://github.com/Turfjs/turf-jsts/tree/v2.7.2>
- Declared license expression: `(EDL-1.0 OR EPL-1.0)`. This distribution elects
  the permissive EDL 1.0 option.
- Retained text: [JSTS-EDL-1.0.txt](third_party_licenses/JSTS-EDL-1.0.txt)
- Purpose: topology operations used transitively by Turf geometry modules.

The npm tarballs omit their license texts. Their expression contains
`EDL-1.0`, which is not a recognized SPDX identifier and is therefore omitted
by npm's native CycloneDX output. The checked-in text is the exact EDL 1.0 file
from the tagged JSTS 2.7.1 source repository; the normalized SBOM records the
selected license by name and source URL rather than inventing an SPDX
identifier.

### splaytree-ts 1.0.2

- Package: `splaytree-ts@1.0.2`
- Source: <https://github.com/SBanksX/splaytree-ts>
- License: BSD 3-Clause (`BSD-3-Clause`)
- Copyright: 2022 Luiz Felipe Machado Barboza.
- Retained text:
  [splaytree-ts-BSD-3-Clause.txt](third_party_licenses/splaytree-ts-BSD-3-Clause.txt)
- Purpose: spatial indexing used by the geometry engine.

The package manifest misspells the identifier as `BDS-3-Clause`; its bundled
license is the standard BSD 3-Clause text. The SBOM records the corrected
identifier and this repository retains the exact bundled license.

## Operational and data boundary

- OpenStreetMap remains the default and unconditional online fallback.
- ArcGIS layers are interactive and online-only. They are excluded from the
  service worker, offline downloads, and printed exports.
- Runtime attribution remains visible in the active map and includes the
  provider-specific credits returned by the official plugin.
- Each operator must supply its own ArcGIS credentials, accept the applicable
  provider terms and configure origin/privilege restrictions before enabling it.
- The checked-in SBOM is generated deterministically from the complete
  `package-lock.json`, including development and optional packages. Run
  `npm run sbom:check` and the unfiltered `npm audit` against the current
  lockfile before a release.
