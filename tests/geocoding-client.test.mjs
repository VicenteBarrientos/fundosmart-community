import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeocodingUrl,
  parseGeocodingResponse,
} from "../src/modules/potreros/api/geocoding-client.ts";

test("buildGeocodingUrl construye URL para Chile y maneja opciones opcionales", () => {
  const url = buildGeocodingUrl("Osorno");
  assert.ok(url.includes("nominatim.openstreetmap.org"));
  assert.ok(url.includes("q=Osorno%2C+Chile"));
  assert.ok(url.includes("countrycodes=cl"));

  const customUrl = buildGeocodingUrl("Puerto Varas, Chile", { limit: 10 });
  assert.ok(customUrl.includes("q=Puerto+Varas%2C+Chile"));
  assert.ok(customUrl.includes("limit=10"));
});

test("buildGeocodingUrl rechaza consultas vacías", () => {
  assert.throws(() => buildGeocodingUrl("   "), TypeError);
});

test("parseGeocodingResponse procesa resultados válidos de forma inmutable", () => {
  const mockResponse = [
    {
      place_id: 12345,
      display_name: "Osorno, Provincia de Osorno, Región de Los Lagos, Chile",
      lat: "-40.5739",
      lon: "-73.1353",
      boundingbox: ["-40.6", "-40.5", "-73.2", "-73.1"],
    },
  ];

  const parsed = parseGeocodingResponse(mockResponse);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].displayName, "Osorno, Provincia de Osorno, Región de Los Lagos, Chile");
  assert.equal(parsed[0].latitude, -40.5739);
  assert.equal(parsed[0].longitude, -73.1353);
  assert.ok(Object.isFrozen(parsed[0]));
});

test("parseGeocodingResponse maneja respuestas malformadas sin fallar", () => {
  assert.deepEqual(parseGeocodingResponse(null), []);
  assert.deepEqual(parseGeocodingResponse([{ invalid: true }]), []);
});
