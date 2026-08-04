export const OSORNO_RING = [
  [-73.13, -40.57],
  [-73.13, -40.568],
  [-73.127, -40.568],
  [-73.127, -40.57],
  [-73.13, -40.57],
];

export const OSORNO_GEOJSON = {
  type: "FeatureCollection",
  crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC::CRS84" } },
  features: [
    {
      type: "Feature",
      id: "with-hole",
      properties: { name: "Pradera & Estero", sector: "Caracol", nested: { uso: "pradera" } },
      geometry: {
        type: "Polygon",
        coordinates: [
          OSORNO_RING,
          [
            [-73.1292, -40.5695],
            [-73.1292, -40.569],
            [-73.1286, -40.569],
            [-73.1286, -40.5695],
            [-73.1292, -40.5695],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Dos paños" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[-73.14, -40.58], [-73.14, -40.579], [-73.139, -40.579], [-73.139, -40.58], [-73.14, -40.58]]],
          [[[-73.138, -40.58], [-73.138, -40.579], [-73.137, -40.579], [-73.137, -40.58], [-73.138, -40.58]]],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Bebedero" },
      geometry: { type: "Point", coordinates: [-73.128, -40.569, 12] },
    },
    {
      type: "Feature",
      properties: { name: "Cerco eléctrico" },
      geometry: { type: "LineString", coordinates: [[-73.13, -40.57], [-73.127, -40.568]] },
    },
  ],
};

export const OSORNO_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>Potrero &amp; KML</name>
  <ExtendedData><Data name="sector"><value>Caracol &amp; Norte</value></Data></ExtendedData>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    ${OSORNO_RING.map(([longitude, latitude]) => `${longitude},${latitude},0`).join(" ")}
  </coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark></Document></kml>`;

export const WGS84_PRJ = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AXIS["Latitude",NORTH],AXIS["Longitude",EAST]]';

export function buildPolygonShp(points = OSORNO_RING) {
  const contentBytes = 48 + points.length * 16;
  const bytes = new Uint8Array(108 + contentBytes);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 9994, false);
  view.setInt32(24, bytes.byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, 5, true);
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  writeBounds(view, 36, longitudes, latitudes);
  view.setInt32(100, 1, false);
  view.setInt32(104, contentBytes / 2, false);
  view.setInt32(108, 5, true);
  writeBounds(view, 112, longitudes, latitudes);
  view.setInt32(144, 1, true);
  view.setInt32(148, points.length, true);
  view.setInt32(152, 0, true);
  points.forEach(([longitude, latitude], index) => {
    view.setFloat64(156 + index * 16, longitude, true);
    view.setFloat64(164 + index * 16, latitude, true);
  });
  return bytes;
}

export function buildDbf(properties = { NAME: "Potrero SHP", SECTOR: "Caracol" }) {
  const fields = [
    { name: "NAME", length: 24 },
    { name: "SECTOR", length: 20 },
  ];
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const bytes = new Uint8Array(headerLength + recordLength + 1);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x03;
  bytes[1] = 126;
  bytes[2] = 7;
  bytes[3] = 20;
  view.setUint32(4, 1, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  let fieldOffset = 1;
  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    writeAscii(bytes, offset, field.name, 11);
    bytes[offset + 11] = "C".charCodeAt(0);
    view.setUint32(offset + 12, fieldOffset, true);
    bytes[offset + 16] = field.length;
    fieldOffset += field.length;
  });
  bytes[headerLength - 1] = 0x0d;
  bytes[headerLength] = 0x20;
  let recordOffset = headerLength + 1;
  fields.forEach((field) => {
    writeAscii(bytes, recordOffset, String(properties[field.name] ?? "").padEnd(field.length, " "), field.length);
    recordOffset += field.length;
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

function writeBounds(view, offset, longitudes, latitudes) {
  view.setFloat64(offset, Math.min(...longitudes), true);
  view.setFloat64(offset + 8, Math.min(...latitudes), true);
  view.setFloat64(offset + 16, Math.max(...longitudes), true);
  view.setFloat64(offset + 24, Math.max(...latitudes), true);
}

function writeAscii(bytes, offset, value, length) {
  for (let index = 0; index < length; index += 1) bytes[offset + index] = value.charCodeAt(index) || 0;
}
