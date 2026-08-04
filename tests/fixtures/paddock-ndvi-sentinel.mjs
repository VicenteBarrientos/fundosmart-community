export const OSORNO_NDVI_RINGS = {
  outer: [
    [-40.579, -73.148],
    [-40.579, -73.132],
    [-40.565, -73.132],
    [-40.565, -73.148],
  ],
  holes: [[
    [-40.574, -73.143],
    [-40.574, -73.139],
    [-40.57, -73.139],
    [-40.57, -73.143],
  ]],
};

export const NDVI_SUCCESS_RESPONSE = JSON.stringify({
  data: [
    statisticalInterval("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", {
      mean: 0.41,
      sampleCount: 80,
      noDataCount: 8,
    }),
    statisticalInterval("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", {
      mean: null,
      sampleCount: 120,
      noDataCount: 120,
    }),
    statisticalInterval("2026-06-01T00:00:00Z", "2026-07-01T00:00:00Z", {
      mean: 0.64,
      sampleCount: 100,
      noDataCount: 25,
    }),
  ],
});

export const NDVI_NO_DATA_RESPONSE = JSON.stringify({
  data: [
    statisticalInterval("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", {
      mean: null,
      sampleCount: 0,
      noDataCount: 0,
    }),
    statisticalInterval("2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", {
      mean: null,
      sampleCount: 120,
      noDataCount: 120,
    }),
  ],
});

export function statisticalInterval(from, to, stats) {
  return {
    interval: { from, to },
    outputs: {
      default: {
        bands: {
          B0: { stats },
        },
      },
    },
  };
}
