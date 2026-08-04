export const DEMO_EMAIL = "demo@fundosmart.local";
export const DEMO_MEMBERSHIP_ID = "membership-fundo-el-ejemplo-demo";
export const DEMO_FIELD_ID = "fundo-el-ejemplo";
export const DEMO_CREATED_AT = "2026-07-01T12:00:00.000Z";
export const DEMO_DATA_PROVENANCE = Object.freeze({
  kind: "deterministic-synthetic",
  privateSources: false,
  version: "public-demo-v1",
});

// Geometría ficticia creada para el repositorio comunitario. No representa
// un predio, levantamiento, camino ni límite real.
const DEMO_PADDOCK_SPECS = [
  ["demo-potrero-ternerera", "Ternerera", "Sector Norte", 9.295714285714286, 5.8, 20.4, 188.7, "Mantención de bebederos · 14 jul 2026", "En pastoreo"],
  ["demo-potrero-los-maitenes", "Los Maitenes", "Sector Norte", 9.295714285714286, 5.7, 19.8, 185.2, "Mantención de cercos · 12 jul 2026", "Disponible"],
  ["demo-potrero-casa-vieja", "Casa Vieja", "Sector Norte", 9.295714285714286, 5.9, 22.1, 201.3, "Cosecha de silo · 28 jun 2026", "Disponible"],
  ["demo-potrero-la-vega", "La Vega", "Sector Norte", 9.295714285714286, 5.8, 21.2, 192.4, "Pastoreo · 16 jul 2026", "En pastoreo"],
  ["demo-potrero-el-bajo", "El Bajo", "Sector Norte", 9.295714285714286, 5.6, 18.5, 178.6, "Fertilización · 8 jul 2026", "En descanso"],
  ["demo-potrero-loma-norte", "Loma Norte", "Sector Norte", 9.295714285714286, 5.5, 17.9, 174.8, "Pastoreo · 15 jul 2026", "En pastoreo"],
  ["demo-potrero-el-molino", "El Molino", "Sector Norte", 9.295714285714286, 5.8, 20.6, 194.1, "Siembra de ballica · 20 jun 2026", "Disponible"],
  ["demo-potrero-loma-sur", "Loma Sur", "Sector Sur", 9.295714285714286, 5.6, 18.7, 181.5, "Análisis de suelo · 2 jul 2026", "En pastoreo"],
  ["demo-potrero-las-quilas", "Las Quilas", "Sector Sur", 9.295714285714286, 5.7, 20.1, 187.3, "Pastoreo · 18 jul 2026", "En descanso"],
  ["demo-potrero-el-estero", "El Estero", "Sector Sur", 9.295714285714286, 5.4, 16.8, 169.5, "Riego · 17 jul 2026", "Disponible"],
  ["demo-potrero-la-manga", "La Manga", "Sector Sur", 9.295714285714286, 5.9, 23, 205.7, "Mantención · 13 jul 2026", "Disponible"],
  ["demo-potrero-los-robles", "Los Robles", "Sector Sur", 9.295714285714286, 5.6, 18.9, 180.4, "Fertilización · 10 jul 2026", "En descanso"],
  ["demo-potrero-la-canada", "La Cañada", "Sector Sur", 9.295714285714286, 5.8, 21.5, 196.2, "Cosecha · 5 jul 2026", "Disponible"],
  ["demo-potrero-el-tranque", "El Tranque", "Sector Sur", 9.295714285714286, 5.5, 17.3, 172.9, "Análisis de suelo · 3 jul 2026", "Disponible"],
];

const DEMO_GRID_LATITUDE = -40.75;
const DEMO_GRID_LONGITUDE = -72.75;
const DEMO_GRID_CELL_HEIGHT = 0.003;
const DEMO_GRID_CELL_WIDTH = 0.0033078886477523467;

function demoRectangle(index) {
  const row = Math.floor(index / 7);
  const column = index % 7;
  const north = DEMO_GRID_LATITUDE + row * DEMO_GRID_CELL_HEIGHT;
  const south = north + DEMO_GRID_CELL_HEIGHT;
  const west = DEMO_GRID_LONGITUDE + column * DEMO_GRID_CELL_WIDTH;
  const east = west + DEMO_GRID_CELL_WIDTH;
  return [[north, west], [north, east], [south, east], [south, west]];
}

export const DEMO_FIELD = {
  id: DEMO_FIELD_ID,
  name: "Fundo El Ejemplo",
  location: "Ubicación ficticia",
  areaHectares: 130.14,
  coordinates: [
    [-40.75, -72.75],
    [-40.75, -72.72684477946573],
    [-40.744, -72.72684477946573],
    [-40.744, -72.75],
  ],
};

export const DEMO_PADDOCKS = DEMO_PADDOCK_SPECS.map(([
  id,
  name,
  sector,
  areaHectares,
  ph,
  phosphorus,
  potassium,
  lastActivity,
  status,
], index) => ({
  id,
  fieldId: DEMO_FIELD_ID,
  name,
  sector,
  areaHectares,
  coordinates: demoRectangle(index),
  grazeableAreaHectares: null,
  landUse: "pradera_permanente",
  holeKinds: [],
  soil: { ph, nitrogen: null, phosphorus, potassium },
  lastActivity,
  status,
}));

const DEMO_CURRENT_ACTIVITIES = [
  { id: "demo-activity-01", potreroId: "demo-potrero-la-vega", type: "grazing", occurredAt: "2026-07-16", description: "Ingreso de 48 vacas en ordeña por franja", quantity: 48, unit: "cabezas", costClp: null },
  { id: "demo-activity-02", potreroId: "demo-potrero-loma-norte", type: "grazing", occurredAt: "2026-07-15", description: "Ingreso de vacas secas con pastoreo controlado", quantity: 12, unit: "cabezas", costClp: null },
  { id: "demo-activity-03", potreroId: "demo-potrero-ternerera", type: "maintenance", occurredAt: "2026-07-14", description: "Limpieza de bebederos y revisión de cierres", quantity: 4, unit: "horas", costClp: 85000 },
  { id: "demo-activity-04", potreroId: "demo-potrero-los-maitenes", type: "maintenance", occurredAt: "2026-07-12", description: "Reposición de aisladores y alambre eléctrico", quantity: 320, unit: "m", costClp: 214000 },
  { id: "demo-activity-05", potreroId: "demo-potrero-el-bajo", type: "fertilization", occurredAt: "2026-07-08", description: "Aplicación de mezcla 20-10-10 posterior al pastoreo", quantity: 865, unit: "kg", costClp: 612000 },
  { id: "demo-activity-06", potreroId: "demo-potrero-loma-sur", type: "soil", occurredAt: "2026-07-02", description: "Muestreo compuesto para ajuste de encalado", quantity: 12, unit: "muestras", costClp: 148000 },
  { id: "demo-activity-07", potreroId: "demo-potrero-casa-vieja", type: "harvest", occurredAt: "2026-06-28", description: "Cosecha de ensilaje de pradera", quantity: 386, unit: "t MV", costClp: 1730000 },
  { id: "demo-activity-08", potreroId: "demo-potrero-el-molino", type: "other", occurredAt: "2026-06-20", description: "Siembra de ballica anual y trébol", quantity: 820, unit: "kg semilla", costClp: 984000 },
  { id: "demo-activity-09", potreroId: "demo-potrero-las-quilas", type: "grazing", occurredAt: "2026-07-18", description: "Salida de 26 vaquillas después de pastoreo rotativo", quantity: 26, unit: "cabezas", costClp: null },
  { id: "demo-activity-10", potreroId: "demo-potrero-el-estero", type: "other", occurredAt: "2026-07-17", description: "Riego de establecimiento de pradera", quantity: 25, unit: "mm", costClp: 96000 },
  { id: "demo-activity-11", potreroId: "demo-potrero-la-manga", type: "maintenance", occurredAt: "2026-07-13", description: "Revisión de manga, puertas y bebedero", quantity: 3, unit: "horas", costClp: 68000 },
  { id: "demo-activity-12", potreroId: "demo-potrero-los-robles", type: "fertilization", occurredAt: "2026-07-10", description: "Aplicación de nitrógeno posterior a pastoreo", quantity: 420, unit: "kg", costClp: 356000 },
  { id: "demo-activity-13", potreroId: "demo-potrero-la-canada", type: "harvest", occurredAt: "2026-07-05", description: "Corte de pradera para conservación", quantity: 74, unit: "t MV", costClp: 284000 },
  { id: "demo-activity-14", potreroId: "demo-potrero-el-tranque", type: "soil", occurredAt: "2026-07-03", description: "Muestreo compuesto de fertilidad", quantity: 8, unit: "muestras", costClp: 96000 },
];

const DEMO_HISTORICAL_ACTIVITIES = [
  { id: "demo-activity-ternerera-2026-05-09", potreroId: "demo-potrero-ternerera", type: "maintenance", occurredAt: "2026-05-09", description: "Ajuste de refugio y cama seca para terneras", quantity: 6, unit: "horas", costClp: 126000 },
  { id: "demo-activity-ternerera-2026-02-12", potreroId: "demo-potrero-ternerera", type: "grazing", occurredAt: "2026-02-12", description: "Salida de 14 terneras a pradera por bloque diurno", quantity: 14, unit: "cabezas", costClp: null },
  { id: "demo-activity-ternerera-2025-10-06", potreroId: "demo-potrero-ternerera", type: "fertilization", occurredAt: "2025-10-06", description: "Aplicación de fertilizante de establecimiento", quantity: 310, unit: "kg", costClp: 268000 },
  { id: "demo-activity-ternerera-2025-08-18", potreroId: "demo-potrero-ternerera", type: "soil", occurredAt: "2025-08-18", description: "Muestreo inicial de fertilidad para renovación", quantity: 8, unit: "muestras", costClp: 96000 },

  { id: "demo-activity-los-maitenes-2026-06-05", potreroId: "demo-potrero-los-maitenes", type: "grazing", occurredAt: "2026-06-05", description: "Pastoreo rotativo de vacas en ordeña", quantity: 32, unit: "cabezas", costClp: null },
  { id: "demo-activity-los-maitenes-2026-04-18", potreroId: "demo-potrero-los-maitenes", type: "fertilization", occurredAt: "2026-04-18", description: "Aplicación de nitrógeno después del pastoreo", quantity: 620, unit: "kg", costClp: 476000 },
  { id: "demo-activity-los-maitenes-2026-01-22", potreroId: "demo-potrero-los-maitenes", type: "soil", occurredAt: "2026-01-22", description: "Muestreo de fertilidad y pH", quantity: 10, unit: "muestras", costClp: 118000 },
  { id: "demo-activity-los-maitenes-2025-11-25", potreroId: "demo-potrero-los-maitenes", type: "harvest", occurredAt: "2025-11-25", description: "Primer corte para ensilaje de pradera", quantity: 148, unit: "t MV", costClp: 642000 },

  { id: "demo-activity-casa-vieja-2026-04-06", potreroId: "demo-potrero-casa-vieja", type: "fertilization", occurredAt: "2026-04-06", description: "Fertilización de recuperación posterior al pastoreo", quantity: 255, unit: "kg", costClp: 218000 },
  { id: "demo-activity-casa-vieja-2026-02-18", potreroId: "demo-potrero-casa-vieja", type: "grazing", occurredAt: "2026-02-18", description: "Pastoreo de vacas en ordeña por dos días", quantity: 36, unit: "cabezas", costClp: null },
  { id: "demo-activity-casa-vieja-2025-12-04", potreroId: "demo-potrero-casa-vieja", type: "soil", occurredAt: "2025-12-04", description: "Control de pH y disponibilidad de fósforo", quantity: 8, unit: "muestras", costClp: 96000 },
  { id: "demo-activity-casa-vieja-2025-09-20", potreroId: "demo-potrero-casa-vieja", type: "maintenance", occurredAt: "2025-09-20", description: "Reparación del cerco junto al camino interior", quantity: 180, unit: "m", costClp: 155000 },

  { id: "demo-activity-la-vega-2026-06-03", potreroId: "demo-potrero-la-vega", type: "fertilization", occurredAt: "2026-06-03", description: "Aplicación de nitrógeno para recuperación de pradera", quantity: 710, unit: "kg", costClp: 526000 },
  { id: "demo-activity-la-vega-2026-04-28", potreroId: "demo-potrero-la-vega", type: "grazing", occurredAt: "2026-04-28", description: "Pastoreo en franjas con vacas en ordeña", quantity: 46, unit: "cabezas", costClp: null },
  { id: "demo-activity-la-vega-2026-01-15", potreroId: "demo-potrero-la-vega", type: "soil", occurredAt: "2026-01-15", description: "Muestreo compuesto de fertilidad", quantity: 12, unit: "muestras", costClp: 142000 },
  { id: "demo-activity-la-vega-2025-11-10", potreroId: "demo-potrero-la-vega", type: "harvest", occurredAt: "2025-11-10", description: "Corte de excedente para ensilaje", quantity: 226, unit: "t MV", costClp: 960000 },

  { id: "demo-activity-el-bajo-2026-06-18", potreroId: "demo-potrero-el-bajo", type: "grazing", occurredAt: "2026-06-18", description: "Pastoreo controlado con vacas en ordeña", quantity: 42, unit: "cabezas", costClp: null },
  { id: "demo-activity-el-bajo-2026-03-22", potreroId: "demo-potrero-el-bajo", type: "soil", occurredAt: "2026-03-22", description: "Muestreo de fertilidad en sectores bajos", quantity: 12, unit: "muestras", costClp: 148000 },
  { id: "demo-activity-el-bajo-2026-01-10", potreroId: "demo-potrero-el-bajo", type: "maintenance", occurredAt: "2026-01-10", description: "Limpieza de drenajes superficiales", quantity: 7, unit: "horas", costClp: 168000 },
  { id: "demo-activity-el-bajo-2025-11-30", potreroId: "demo-potrero-el-bajo", type: "harvest", occurredAt: "2025-11-30", description: "Cosecha de pradera para ensilaje", quantity: 238, unit: "t MV", costClp: 1040000 },

  { id: "demo-activity-loma-norte-2026-06-09", potreroId: "demo-potrero-loma-norte", type: "fertilization", occurredAt: "2026-06-09", description: "Aplicación de nitrógeno posterior al pastoreo", quantity: 450, unit: "kg", costClp: 342000 },
  { id: "demo-activity-loma-norte-2026-04-22", potreroId: "demo-potrero-loma-norte", type: "grazing", occurredAt: "2026-04-22", description: "Pastoreo de vacas secas por tres días", quantity: 14, unit: "cabezas", costClp: null },
  { id: "demo-activity-loma-norte-2026-02-04", potreroId: "demo-potrero-loma-norte", type: "soil", occurredAt: "2026-02-04", description: "Muestreo compuesto para ajuste de fertilización", quantity: 10, unit: "muestras", costClp: 118000 },
  { id: "demo-activity-loma-norte-2025-12-08", potreroId: "demo-potrero-loma-norte", type: "harvest", occurredAt: "2025-12-08", description: "Cosecha de excedente de primavera", quantity: 168, unit: "t MV", costClp: 724000 },

  { id: "demo-activity-el-molino-2026-06-05", potreroId: "demo-potrero-el-molino", type: "soil", occurredAt: "2026-06-05", description: "Muestreo previo a la renovación de pradera", quantity: 12, unit: "muestras", costClp: 148000 },
  { id: "demo-activity-el-molino-2026-05-14", potreroId: "demo-potrero-el-molino", type: "maintenance", occurredAt: "2026-05-14", description: "Preparación de suelo y nivelación de sectores húmedos", quantity: 8, unit: "horas", costClp: 224000 },
  { id: "demo-activity-el-molino-2026-02-25", potreroId: "demo-potrero-el-molino", type: "harvest", occurredAt: "2026-02-25", description: "Último corte antes de renovar la pradera", quantity: 132, unit: "t MV", costClp: 588000 },
  { id: "demo-activity-el-molino-2026-01-12", potreroId: "demo-potrero-el-molino", type: "grazing", occurredAt: "2026-01-12", description: "Pastoreo de limpieza previo al descanso", quantity: 28, unit: "cabezas", costClp: null },

  { id: "demo-activity-loma-sur-2026-06-10", potreroId: "demo-potrero-loma-sur", type: "grazing", occurredAt: "2026-06-10", description: "Ingreso de vaquillas preñadas", quantity: 18, unit: "cabezas", costClp: null },
  { id: "demo-activity-loma-sur-2026-04-24", potreroId: "demo-potrero-loma-sur", type: "fertilization", occurredAt: "2026-04-24", description: "Fertilización de otoño posterior al pastoreo", quantity: 540, unit: "kg", costClp: 412000 },
  { id: "demo-activity-loma-sur-2026-02-15", potreroId: "demo-potrero-loma-sur", type: "maintenance", occurredAt: "2026-02-15", description: "Reparación del cerco eléctrico de ladera", quantity: 240, unit: "m", costClp: 184000 },
  { id: "demo-activity-loma-sur-2025-11-18", potreroId: "demo-potrero-loma-sur", type: "harvest", occurredAt: "2025-11-18", description: "Corte para ensilaje de primavera", quantity: 188, unit: "t MV", costClp: 806000 },

  { id: "demo-activity-las-quilas-2026-06-21", potreroId: "demo-potrero-las-quilas", type: "fertilization", occurredAt: "2026-06-21", description: "Aplicación de nitrógeno para recuperación", quantity: 505, unit: "kg", costClp: 386000 },
  { id: "demo-activity-las-quilas-2026-05-12", potreroId: "demo-potrero-las-quilas", type: "grazing", occurredAt: "2026-05-12", description: "Pastoreo rotativo de vaquillas", quantity: 24, unit: "cabezas", costClp: null },
  { id: "demo-activity-las-quilas-2026-03-05", potreroId: "demo-potrero-las-quilas", type: "soil", occurredAt: "2026-03-05", description: "Control de fertilidad de fin de verano", quantity: 10, unit: "muestras", costClp: 118000 },
  { id: "demo-activity-las-quilas-2025-12-02", potreroId: "demo-potrero-las-quilas", type: "harvest", occurredAt: "2025-12-02", description: "Corte de excedente de primavera", quantity: 172, unit: "t MV", costClp: 742000 },

  { id: "demo-activity-el-estero-2026-06-14", potreroId: "demo-potrero-el-estero", type: "grazing", occurredAt: "2026-06-14", description: "Pastoreo de vacas en ordeña por franjas", quantity: 30, unit: "cabezas", costClp: null },
  { id: "demo-activity-el-estero-2026-04-30", potreroId: "demo-potrero-el-estero", type: "fertilization", occurredAt: "2026-04-30", description: "Fertilización de otoño en la franja alta", quantity: 390, unit: "kg", costClp: 305000 },
  { id: "demo-activity-el-estero-2026-02-21", potreroId: "demo-potrero-el-estero", type: "maintenance", occurredAt: "2026-02-21", description: "Limpieza de acequia y salida de agua", quantity: 9, unit: "horas", costClp: 196000 },
  { id: "demo-activity-el-estero-2025-12-15", potreroId: "demo-potrero-el-estero", type: "soil", occurredAt: "2025-12-15", description: "Muestreo de fertilidad en sector ribereño", quantity: 8, unit: "muestras", costClp: 96000 },

  { id: "demo-activity-la-manga-2026-06-27", potreroId: "demo-potrero-la-manga", type: "grazing", occurredAt: "2026-06-27", description: "Paso de vacas en ordeña durante cambio de franja", quantity: 48, unit: "cabezas", costClp: null },
  { id: "demo-activity-la-manga-2026-04-02", potreroId: "demo-potrero-la-manga", type: "maintenance", occurredAt: "2026-04-02", description: "Calibración de puertas y ajuste del brete", quantity: 5, unit: "horas", costClp: 112000 },
  { id: "demo-activity-la-manga-2026-01-27", potreroId: "demo-potrero-la-manga", type: "soil", occurredAt: "2026-01-27", description: "Muestreo de la superficie de tránsito", quantity: 6, unit: "muestras", costClp: 84000 },
  { id: "demo-activity-la-manga-2025-10-12", potreroId: "demo-potrero-la-manga", type: "fertilization", occurredAt: "2025-10-12", description: "Fertilización de recuperación de la pradera", quantity: 260, unit: "kg", costClp: 212000 },

  { id: "demo-activity-los-robles-2026-06-20", potreroId: "demo-potrero-los-robles", type: "grazing", occurredAt: "2026-06-20", description: "Pastoreo rotativo de vacas en ordeña", quantity: 34, unit: "cabezas", costClp: null },
  { id: "demo-activity-los-robles-2026-03-08", potreroId: "demo-potrero-los-robles", type: "harvest", occurredAt: "2026-03-08", description: "Segundo corte para conservación", quantity: 154, unit: "t MV", costClp: 674000 },
  { id: "demo-activity-los-robles-2026-01-08", potreroId: "demo-potrero-los-robles", type: "soil", occurredAt: "2026-01-08", description: "Muestreo compuesto bajo cobertura arbórea", quantity: 10, unit: "muestras", costClp: 118000 },
  { id: "demo-activity-los-robles-2025-10-22", potreroId: "demo-potrero-los-robles", type: "maintenance", occurredAt: "2025-10-22", description: "Poda de ramas sobre el cerco eléctrico", quantity: 6, unit: "horas", costClp: 146000 },

  { id: "demo-activity-la-canada-2026-05-25", potreroId: "demo-potrero-la-canada", type: "grazing", occurredAt: "2026-05-25", description: "Pastoreo de vaquillas en franja seca", quantity: 22, unit: "cabezas", costClp: null },
  { id: "demo-activity-la-canada-2026-03-30", potreroId: "demo-potrero-la-canada", type: "fertilization", occurredAt: "2026-03-30", description: "Aplicación de fertilizante de otoño", quantity: 220, unit: "kg", costClp: 184000 },
  { id: "demo-activity-la-canada-2026-01-18", potreroId: "demo-potrero-la-canada", type: "soil", occurredAt: "2026-01-18", description: "Muestreo de fertilidad en la franja alta", quantity: 6, unit: "muestras", costClp: 84000 },
  { id: "demo-activity-la-canada-2025-09-12", potreroId: "demo-potrero-la-canada", type: "maintenance", occurredAt: "2025-09-12", description: "Limpieza de drenaje y acceso lateral", quantity: 7, unit: "horas", costClp: 158000 },

  { id: "demo-activity-el-tranque-2026-06-07", potreroId: "demo-potrero-el-tranque", type: "grazing", occurredAt: "2026-06-07", description: "Pastoreo controlado en la franja alejada del agua", quantity: 16, unit: "cabezas", costClp: null },
  { id: "demo-activity-el-tranque-2026-04-12", potreroId: "demo-potrero-el-tranque", type: "maintenance", occurredAt: "2026-04-12", description: "Limpieza de entrada de agua y revisión del bebedero", quantity: 6, unit: "horas", costClp: 142000 },
  { id: "demo-activity-el-tranque-2026-02-28", potreroId: "demo-potrero-el-tranque", type: "fertilization", occurredAt: "2026-02-28", description: "Fertilización de recuperación de verano", quantity: 330, unit: "kg", costClp: 256000 },
  { id: "demo-activity-el-tranque-2025-11-05", potreroId: "demo-potrero-el-tranque", type: "harvest", occurredAt: "2025-11-05", description: "Corte temprano para ensilaje", quantity: 112, unit: "t MV", costClp: 492000 },
];

export const DEMO_ACTIVITIES = [
  ...DEMO_CURRENT_ACTIVITIES,
  ...DEMO_HISTORICAL_ACTIVITIES,
];

const LOT_SPECS = [
  { id: "demo-lot-vacas-ordena", paddockId: "demo-potrero-la-vega", name: "Vacas en ordeña", category: "dairy_cow", count: 48, weightBase: 574, birthYear: 2020, tagBase: 99010001 },
  { id: "demo-lot-vacas-secas", paddockId: "demo-potrero-loma-norte", name: "Vacas secas", category: "dry_cow", count: 12, weightBase: 618, birthYear: 2019, tagBase: 99020001 },
  { id: "demo-lot-vaquillas", paddockId: "demo-potrero-loma-sur", name: "Vaquillas preñadas", category: "heifer", count: 18, weightBase: 382, birthYear: 2024, tagBase: 99030001 },
  { id: "demo-lot-terneras", paddockId: "demo-potrero-ternerera", name: "Terneras de reemplazo", category: "calf", count: 14, weightBase: 112, birthYear: 2025, tagBase: 99040001 },
];

function dateFor(year, index) {
  const month = index % 12;
  const day = 3 + ((index * 7) % 24);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export const DEMO_ANIMALS = LOT_SPECS.flatMap((lot) => Array.from({ length: lot.count }, (_, index) => ({
  id: `demo-animal-${lot.id}-${index + 1}`,
  lotId: lot.id,
  tag: String(lot.tagBase + index),
  sex: "female",
  status: "active",
  statusDate: null,
  statusReason: null,
  birthDate: dateFor(lot.birthYear, index),
  purchasePriceClp: null,
  purchaseDate: null,
  origin: "Crianza propia",
  notes: "Registro ficticio preparado para la cuenta demo.",
  source: "Demo FundoSmart",
  weightKg: lot.weightBase + ((index * 7) % 43),
})));

export const DEMO_LOTS = LOT_SPECS.map((lot) => {
  const animals = DEMO_ANIMALS.filter((animal) => animal.lotId === lot.id);
  const averageWeightKg = Math.round((animals.reduce((sum, animal) => sum + animal.weightKg, 0) / animals.length) * 10) / 10;
  return {
    id: lot.id,
    fieldId: DEMO_FIELD_ID,
    paddockId: lot.paddockId,
    name: lot.name,
    category: lot.category,
    animalCount: lot.count,
    averageWeightKg,
    entryDate: "2026-04-01",
    status: "active",
    ownerName: "Fundo El Ejemplo",
    trackingMode: "individual",
    notes: "Lote ficticio con trazabilidad individual para demostración.",
  };
});

export const DEMO_WEIGHINGS = DEMO_ANIMALS.flatMap((animal) => {
  const records = [{ id: `demo-weight-${animal.id}-2026-07-10`, lotId: animal.lotId, animalId: animal.id, recordedAt: "2026-07-10", weightKg: animal.weightKg, notes: "Pesaje ficticio de control mensual.", source: "Demo FundoSmart" }];
  if (animal.lotId === "demo-lot-vaquillas" || animal.lotId === "demo-lot-terneras") {
    records.unshift({ id: `demo-weight-${animal.id}-2026-06-10`, lotId: animal.lotId, animalId: animal.id, recordedAt: "2026-06-10", weightKg: animal.weightKg - (animal.lotId === "demo-lot-vaquillas" ? 22 : 14), notes: "Pesaje ficticio anterior para mostrar la curva de crecimiento.", source: "Demo FundoSmart" });
  }
  return records;
});

export const DEMO_FEEDING_PLANS = [
  { id: "demo-feed-vacas-ordena", lotId: "demo-lot-vacas-ordena", productName: "Concentrado alta producción", kgPerAnimalDay: 6.5, sackWeightKg: 25, notes: "Ajustado a producción promedio de 19 litros por vaca." },
  { id: "demo-feed-vacas-secas", lotId: "demo-lot-vacas-secas", productName: "Preparto mineralizado", kgPerAnimalDay: 2.5, sackWeightKg: 25, notes: "Últimos 45 días de gestación." },
  { id: "demo-feed-vaquillas", lotId: "demo-lot-vaquillas", productName: "Concentrado vaquillas", kgPerAnimalDay: 2, sackWeightKg: 25, notes: "Meta de ganancia diaria: 0,75 kg." },
  { id: "demo-feed-terneras", lotId: "demo-lot-terneras", productName: "Concentrado iniciador", kgPerAnimalDay: 2.2, sackWeightKg: 25, notes: "Agua y heno disponibles a libre consumo." },
];

export const DEMO_EXPENSES = [
  { id: "demo-expense-01", fieldId: DEMO_FIELD_ID, date: "2026-07-15", description: "Concentrado vacas en ordeña", category: "alimento", amountClp: 1284000, paymentSource: "society", paidById: null, lotId: "demo-lot-vacas-ordena" },
  { id: "demo-expense-02", fieldId: DEMO_FIELD_ID, date: "2026-07-11", description: "Sales minerales y preparto", category: "alimento", amountClp: 246500, paymentSource: "society", paidById: null, lotId: "demo-lot-vacas-secas" },
  { id: "demo-expense-03", fieldId: DEMO_FIELD_ID, date: "2026-07-09", description: "Vacunación clostridial y antiparasitario", category: "sanidad", amountClp: 318000, paymentSource: "society", paidById: null, lotId: "demo-lot-vaquillas" },
  { id: "demo-expense-04", fieldId: DEMO_FIELD_ID, date: "2026-07-06", description: "Petróleo tractor y generador", category: "combustible", amountClp: 240000, paymentSource: "society", paidById: null, lotId: null },
  { id: "demo-expense-05", fieldId: DEMO_FIELD_ID, date: "2026-06-28", description: "Servicio cosecha de ensilaje", category: "flete", amountClp: 680000, paymentSource: "society", paidById: null, lotId: null },
  { id: "demo-expense-06", fieldId: DEMO_FIELD_ID, date: "2026-06-20", description: "Semilla ballica y trébol", category: "otro", amountClp: 420000, paymentSource: "society", paidById: null, lotId: null },
];

function createSettlement({ period, totalLiters, litersFirstHalf, litersSecondHalf, netPricePerLiterClp, purchaseOrder }) {
  const netAmountClp = Math.round(totalLiters * netPricePerLiterClp);
  const taxAmountClp = Math.round(netAmountClp * 0.19);
  const grossAmountClp = netAmountClp + taxAmountClp;
  const base = Math.round(netAmountClp * 0.76);
  const quality = Math.round(netAmountClp * 0.14);
  const seasonal = netAmountClp - base - quality;
  return {
    id: `demo-milk-${period}`,
    fieldId: DEMO_FIELD_ID,
    period,
    generatedAt: `${period}-28T12:00:00.000Z`,
    plant: "Planta Osorno",
    purchaseOrder,
    producerCode: "DEMO-001",
    producerName: "Fundo El Ejemplo",
    buyerName: "Lácteos del Sur S.A.",
    litersFirstHalf,
    litersSecondHalf,
    totalLiters,
    netAmountClp,
    taxAmountClp,
    grossAmountClp,
    netPricePerLiterClp: netAmountClp / totalLiters,
    grossPricePerLiterClp: grossAmountClp / totalLiters,
    sourceDocumentName: `liquidacion-demo-${period}.pdf`,
    notes: "Liquidación ficticia para demostrar conciliación de litros, precio y bonos.",
    lineItems: [
      { description: "Precio base", measurement: `${totalLiters.toLocaleString("es-CL")} L`, unitPriceClp: null, amountClp: base },
      { description: "Bonificación por calidad", measurement: "Grasa 4,18% · Proteína 3,54%", unitPriceClp: null, amountClp: quality },
      { description: "Bono estacional", measurement: null, unitPriceClp: null, amountClp: seasonal },
    ],
  };
}

export const DEMO_MILK_SETTLEMENTS = [
  createSettlement({ period: "2026-04", totalLiters: 26880, litersFirstHalf: 13620, litersSecondHalf: 13260, netPricePerLiterClp: 452.6, purchaseOrder: "DEMO-OC-2026-04" }),
  createSettlement({ period: "2026-05", totalLiters: 28640, litersFirstHalf: 14180, litersSecondHalf: 14460, netPricePerLiterClp: 461.8, purchaseOrder: "DEMO-OC-2026-05" }),
  createSettlement({ period: "2026-06", totalLiters: 27920, litersFirstHalf: 13840, litersSecondHalf: 14080, netPricePerLiterClp: 468.4, purchaseOrder: "DEMO-OC-2026-06" }),
];
