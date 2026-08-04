/* Glosario único de la aplicación.
 *
 * Cada entrada explica, en una o dos frases y sin jerga, qué hace un módulo, una
 * pestaña, un indicador o un botón cuyo efecto no se deduce de su etiqueta.
 * Regla de contenido: no se describe lo evidente (Guardar, Cancelar, Volver,
 * Cerrar, Salir, Editar, Eliminar); sí se describen siglas, cálculos y acciones
 * con consecuencias que el nombre no revela.
 *
 * Se consume desde `Hint` / `HelpTip` (src/ui/Hint.tsx) y desde el atributo
 * `data-hint`, así que el texto debe ser corto: cabe en un globo de ~260 px. */

export const HELP = {
  /* ── Módulos de la navegación principal ─────────────────────────────── */
  navResumen:
    "Pantalla de inicio: superficie, animales, leche y resultado del mes en una sola vista, con las alertas de lo que conviene atender hoy.",
  navPotreros:
    "Mapa del campo. Dibuja el límite del fundo, divide potreros, mide superficies y registra qué se hizo en cada uno.",
  navGanado:
    "Todos tus animales: lotes, cada animal con su DIIO, pesajes, ración diaria y la plata del rebaño.",
  navLeche:
    "Producción y pago de la leche: litros por período, liquidaciones de la planta, calidad del estanque y sanidad del rebaño lechero.",
  navCostos:
    "Todo lo que gastas, reunido en un solo lugar y ordenado por origen, tipo y potrero.",
  navAnalitica:
    "Indicadores calculados sobre tus datos, con el detalle de cómo se obtuvo cada número y qué información faltó.",
  navPraderas:
    "Cuánto pasto hay disponible, cuánto necesita el ganado y en qué orden conviene rotar los potreros.",
  navTrazabilidad:
    "Historial de lo que ocurrió en el campo: qué se hizo, cuándo, dónde y con qué animales, para responder ante una fiscalización.",
  navIntegraciones:
    "Importa PDF y planillas de proveedores externos, como Watt's y Cooprinsem, con una vista previa antes de guardar.",
  navBenchmarking:
    "Compara tus resultados con los de fundos parecidos al tuyo. Participar es voluntario y nadie ve tus datos individuales.",
  navReportes:
    "Resúmenes listos para imprimir o enviar: comparación entre fundos, estado de potreros y actividad reciente.",
  navConfiguracion:
    "Quién entra a la cuenta, qué puede ver cada persona y qué funciones están habilitadas.",

  /* ── Barra superior ─────────────────────────────────────────────────── */
  shellEspacio:
    "Espacio de trabajo activo: aquí se guarda todo lo que registres. Ábrelo para cambiar a otro espacio o a la demo.",
  shellCampoActivo: "Campo que estás mirando. Ábrelo para ver su mapa y sus potreros.",
  shellMiCuenta: "Muestra tus datos reales, los que registras tú y tu equipo.",
  shellDemo:
    "Cambia a un campo de ejemplo con datos inventados. Sirve para probar sin tocar tu información real.",
  shellConexion:
    "Estado de la conexión. Sin internet puedes seguir consultando lo descargado y lo que registres se envía al reconectar.",
  shellAyuda: "Preguntas frecuentes sobre cómo funciona FundoSmart.",
  shellAsistente:
    "Asistente que responde preguntas sobre el campo usando los datos que ya tienes cargados.",

  /* ── Resumen (inicio) ───────────────────────────────────────────────── */
  dashFiltroFundo: "Limita todo lo que ves en esta pantalla a un solo fundo.",
  dashSuperficie:
    "Hectáreas totales del campo y cuántas de ellas ya están dibujadas como potreros en el mapa.",
  dashAnimalesActivos:
    "Animales vivos y presentes hoy en el campo. No incluye vendidos ni muertos.",
  dashLeche:
    "Litros del último período con liquidación registrada, y cómo se compara con el período anterior.",
  dashResultadoOperativo:
    "Lo que quedó del mes: ingreso neto de la leche menos los costos registrados en ese mismo período.",
  dashProduccionDiaria: "Litros que da en promedio cada vaca en ordeña por día.",
  dashAlertas:
    "Situaciones que cruzaron un umbral y conviene revisar hoy. Cada tarjeta te lleva al lugar donde se resuelve.",
  dashIndicadores:
    "Tres señales rápidas del estado del campo, calculadas con los registros más recientes.",
  dashTendenciaLeche:
    "Cuánto subió o bajó la producción respecto del período anterior, en porcentaje.",
  dashCoberturaPesaje:
    "Qué porcentaje de tus animales tiene un pesaje reciente. Con poca cobertura, los promedios de peso pierden valor.",
  dashLitrosVacaDia:
    "Litros diarios por vaca en ordeña. Es la medida estándar para comparar la eficiencia del rebaño lechero.",
  dashAgendaRebano:
    "Tareas del ganado con fecha: secado, parto, revisión de preñez, vacunas. Se ordenan por urgencia.",
  dashSuperficiePorPotrero:
    "Cuánto pesa cada potrero dentro de la superficie total ya dibujada.",
  dashDelimitacion:
    "Porcentaje de la superficie del fundo que ya tiene un potrero dibujado sobre el mapa.",
  dashEstudiosSuelo:
    "Fundos que tienen adjunto un análisis de suelo de laboratorio.",
  dashActividadReciente: "Últimos manejos registrados en los potreros del campo.",
  dashDisponibilidadPotreros:
    "Cuántos potreros están libres, ocupados con animales o descansando para que rebrote el pasto.",

  /* ── Potreros y mapa ────────────────────────────────────────────────── */
  potreroFundo:
    "Un fundo es la propiedad completa. Dentro de él se dibujan los potreros.",
  potreroPotrero:
    "Cada división cercada del campo donde entran los animales a pastorear.",
  potreroCelda:
    "Subdivisión temporal de un potrero, normalmente con cerco eléctrico, para pastoreo por franjas.",
  potreroEstado:
    "Disponible: sin animales y con pasto. En pastoreo: hay animales adentro. En descanso: cerrado para que rebrote.",
  potreroLimite:
    "Contorno exterior de la propiedad. Es la base sobre la que se dibujan y validan todos los potreros.",
  potreroSubdivision:
    "Corta un área grande en varios potreros trazando líneas sobre el mapa, en vez de dibujar cada uno por separado.",
  potreroExclusion:
    "Marca zonas que no se pastorean —quebradas, bosque, caminos, cursos de agua— para descontarlas de la superficie útil.",
  potreroMedicion:
    "Mide distancias y superficies sobre el mapa sin crear ni modificar nada.",
  potreroImportar:
    "Carga polígonos ya dibujados desde un archivo KML, KMZ o GeoJSON, por ejemplo exportado de Google Earth.",
  potreroExportar:
    "Descarga tus potreros como archivo para abrirlos en Google Earth u otro programa de mapas.",
  potreroSuelo:
    "Resultados del análisis de laboratorio del suelo: pH, materia orgánica y nutrientes disponibles.",
  potreroHistorial:
    "Todo lo que se ha registrado en este potrero, en orden de fecha.",

  /* ── NDVI y satélite ────────────────────────────────────────────────── */
  ndvi:
    "Índice de verdor medido por satélite. Va de 0 a 1: mientras más alto, más pasto verde y activo hay en el potrero.",
  ndviActualizar:
    "Pide al satélite la observación más reciente de todos los potreros. Solo se consulta cuando tú lo pides, porque tiene costo.",
  ndviNubosidad:
    "Porcentaje de la imagen tapado por nubes. Con mucha nube el valor es menos confiable.",
  ndviSinDatos:
    "Ese mes no hubo imagen utilizable. No significa que el pasto valga cero; simplemente no hay medición.",
  ndviPendientes:
    "Potreros cuya última observación quedó vieja o nunca se consultó.",

  /* ── Ganado ─────────────────────────────────────────────────────────── */
  diio:
    "Dispositivo de Identificación Individual Oficial: el arete numerado con que el SAG identifica a cada animal en Chile.",
  ganadoAgenda:
    "Lo que hay que hacer con los animales según su estado reproductivo y sanitario, ordenado por urgencia.",
  ganadoLotes:
    "Grupos de animales que se manejan juntos: mismo potrero, misma ración, mismo objetivo.",
  ganadoAnimales: "Ficha de cada animal: DIIO, categoría, lote, fechas y estado actual.",
  ganadoPesajes:
    "Sesiones de pesaje. Con dos pesajes del mismo animal se calcula cuánto sube por día.",
  ganadoTerreno:
    "Registra en el potrero, desde el celular y sin internet, leyendo el arete con una balanza o bastón Bluetooth.",
  ganadoGenealogia:
    "Quién es padre y madre de cada animal. Sirve para evitar consanguinidad y seguir líneas que rinden mejor.",
  ganadoSag:
    "Formularios y movimientos que exige el SAG. SIPEC es el sistema oficial donde se declaran los animales.",
  ganadoForraje:
    "Cuánto pasto ofrece cada potrero frente a lo que come cada lote, apoyado en la señal satelital.",
  ganadoPlata:
    "Aportes de los socios, gastos del rebaño y cómo se reparte el resultado entre ellos.",
  ganadoRacion:
    "Qué se le da de comer a cada lote por día y cuánto cuesta esa dieta.",
  ganadoComoVamos:
    "Resumen del rebaño: cuántos animales hay, cuánto suben de peso y cómo va la plata.",
  ganadoFicha360:
    "Todo sobre un animal en una sola pantalla: pesajes, partos, tratamientos, producción y familia.",
  ganadoInventarioForraje:
    "Existencias de alimento comprado o conservado y cuánto se ha consumido.",

  /* ── Leche ──────────────────────────────────────────────────────────── */
  lecheLiquidaciones:
    "Documento con que la planta te paga: litros recibidos, precio base, descuentos, bonos y monto final.",
  analiticaHistoriaPropia:
    "Compara este fundo consigo mismo: el mismo período del año anterior y la banda de valores que cada indicador ha ocupado antes. No se compara con otros fundos ni sale ningún dato de tu cuenta.",
  lecheSimulador:
    "Estimación de tu próximo pago si cambian los litros o la calidad, construida con tus propias liquidaciones. No es una promesa de pago.",
  lecheProduccion: "Litros entregados por período, con su curva a lo largo del tiempo.",
  lecheRebano:
    "Vacas del rebaño lechero con su estado: en ordeña, seca, preñada o vacía.",
  lecheReproduccion:
    "Celos, inseminaciones, diagnósticos de preñez y partos: lo que determina cuántas vacas estarán dando leche.",
  lecheSanidad:
    "Tratamientos, resguardos de leche y el cumplimiento del plantel PABCO.",
  pabco:
    "Plantel Animal Bajo Certificación Oficial del SAG. Certifica buenas prácticas y es requisito para exportar.",
  lecheEstanque:
    "El estanque de frío guarda la leche entre ordeñas. Su muestra define la calidad con que te pagan.",
  lecheGrasa: "Porcentaje de materia grasa. Sube el precio por litro cuando es más alto.",
  lecheProteina: "Porcentaje de proteína. Junto con la grasa determina buena parte del pago.",
  lecheSolidos: "Suma de grasa, proteína y otros sólidos: lo que realmente se paga del litro.",
  rcs:
    "Recuento de Células Somáticas. Mide inflamación de la ubre: mientras más alto, más mastitis y menor precio.",
  ufc:
    "Unidades Formadoras de Colonias: carga de bacterias de la leche. Alta indica problemas de higiene o de frío.",
  lecheResguardo:
    "Período en que la leche de un animal tratado no puede entregarse porque conserva restos del medicamento.",
  lecheConciliacion:
    "Compara los litros que tú registraste con los que la planta declara haber recibido, y muestra la diferencia.",
  lecheControlLechero:
    "Medición individual de cuánto da cada vaca en un día, la base para comparar vacas entre sí.",
  del:
    "Días En Leche: cuántos días lleva la vaca produciendo desde su último parto. La curva normal se mide entre el día 1 y el 305.",
  lecheCurvaLactancia:
    "Cómo sube y baja la producción de una vaca a lo largo de su lactancia. Revela partos con problemas o mala alimentación.",
  lecheDesviacion:
    "Diferencia entre los litros que anotaste al producir y los que la planta dice haber recibido. Sobre 2% conviene revisar el estanque o la medición.",
  lechePrecioReal:
    "Lo que efectivamente recibiste por cada litro que salió del estanque, incluyendo los que se perdieron o no se pagaron.",
  lecheProyeccion305:
    "Estimación de cuántos litros dará la vaca en los 305 días estándar de lactancia. Permite comparar vacas que van en distinto momento.",
  lecheSecado:
    "Secar es dejar de ordeñar a la vaca para que descanse antes del próximo parto. Sin ese descanso, la lactancia siguiente rinde menos.",
  lecheMastitis:
    "Infección de la ubre. Baja la producción, empeora la calidad y obliga a botar la leche del animal tratado.",
  reproDiasAbiertos:
    "Días entre el parto y la nueva preñez. Mientras más largos, más tiempo pasa la vaca sin producir a plena capacidad.",
  reproIntervaloPartos:
    "Meses que pasan entre un parto y el siguiente. El objetivo habitual es un ternero por vaca al año.",
  reproTasaConcepcion:
    "De cada 100 inseminaciones, cuántas resultaron en preñez. Mide la calidad del servicio, no la del programa completo.",
  reproDeteccionCelo:
    "Qué porcentaje de los celos alcanzaste a detectar. Un celo no visto es una inseminación que nunca ocurrió.",

  /* ── Costos y plata ─────────────────────────────────────────────────── */
  costoOrigen: "De qué parte del campo salió el gasto: potreros, ganado, leche o ración.",
  costoTipo: "Qué se compró: insumos, servicios, alimento, sueldos, veterinario.",
  costoPorPotrero: "Cuánto se ha gastado en cada potrero, para ver cuáles salen más caros.",
  costoPorKilo:
    "Cuánto cuesta producir un kilo. Es la cifra que decide si el negocio se sostiene.",
  plataAporte: "Dinero que un socio pone en el negocio.",
  plataEgreso: "Dinero que sale del negocio, con su comprobante.",
  plataSocio: "Cada persona con participación en el rebaño y el porcentaje que le corresponde.",
  plataAuditoria:
    "Registro inalterable de quién creó, cambió o borró cada movimiento de plata, y cuándo.",

  /* ── Analítica ──────────────────────────────────────────────────────── */
  analiticaUmbral:
    "Valor a partir del cual un indicador se considera problema. Puedes ajustarlo para tu campo.",
  analiticaRecalcular:
    "Vuelve a calcular todos los indicadores con los datos actuales. Puede demorar unos minutos.",
  analiticaCobertura:
    "Qué parte de la información necesaria estaba disponible. Con poca cobertura, el indicador es solo referencial.",
  analiticaTrazabilidadCalculo:
    "Qué registros exactos entraron en cada número, para poder revisarlo y defenderlo.",
  analiticaDetalleIndicadores:
    "El numerador, el denominador y el método de cada indicador, sin cajas negras.",
  analiticaLecheDelPeriodo: "Litros totales entregados dentro del período que estás mirando.",
  analiticaTasaPrenez:
    "De las vacas que se intentó preñar, qué porcentaje quedó preñado. Es la señal más temprana de la producción del año que viene.",
  analiticaGananciaDiaria:
    "Kilos que sube en promedio un animal por día, calculado entre dos pesajes. Menos de lo esperado indica falta de comida o un problema sanitario.",
  analiticaIofc:
    "Ingreso Sobre Costo de Alimento: lo que queda del pago de la leche después de descontar lo que comieron las vacas. El alimento es el gasto más grande de una lechería.",
  analiticaCurvaReconstruible:
    "Curva armada solo con controles lecheros realmente enlazados a una lactancia. Los tramos sin muestra quedan vacíos en vez de rellenarse con un supuesto.",
  analiticaProduccionPorVaca:
    "Cada vaca con su producción y su curva, para separar las que rinden de las que arrastran el promedio.",
  analiticaProduccionPorLote:
    "Producción atribuida al lote al que el animal pertenecía el día del control, no al lote donde está hoy.",
  analiticaAlertas:
    "Reglas que se dispararon, cada una con el dato observado, el umbral y cuántos registros la sustentan.",

  /* ── Praderas ───────────────────────────────────────────────────────── */
  materiaSeca:
    "Lo que queda del pasto al quitarle el agua. Se mide así porque es lo que realmente alimenta.",
  kgMsHa:
    "Kilos de materia seca por hectárea: cuánto alimento disponible tiene ese potrero ahora mismo.",
  feedWedge:
    "Gráfico que ordena los potreros de más a menos pasto. La escalera muestra en qué orden conviene entrar.",
  praderaCuadrante:
    "Se corta y pesa el pasto de un marco de superficie conocida, y desde ahí se estima todo el potrero.",
  praderaRotacion:
    "Plan de en qué potrero entra cada lote, cuántos días se queda y cuánto descansa después.",
  praderaResiduo:
    "Pasto que debe quedar en pie al salir los animales. Si se pasa a llevar, la pradera rebrota más lento.",
  praderaUtilizacion:
    "Porcentaje del pasto ofrecido que los animales realmente comen; el resto se pisa o ensucia.",
  praderaDemanda:
    "Lo que come el conjunto de los animales al día, calculado desde los lotes activos y su peso.",

  /* ── Benchmarking y reportes ────────────────────────────────────────── */
  benchmarkingCohorte:
    "Grupo de fundos parecidos al tuyo por tamaño y zona. Necesita un mínimo de participantes para que nadie sea identificable.",
  benchmarkingOptIn:
    "Solo participas si lo autorizas explícitamente, y puedes salir cuando quieras.",
  benchmarkingPosicion:
    "En qué lugar quedas dentro de tu grupo de comparación, sin ver ni exponer datos de otros fundos.",
  reporteComparacion: "Los mismos indicadores lado a lado para todos tus fundos.",
  reporteImprimir: "Genera una versión en papel o PDF para llevar a terreno o a la reunión.",

  /* ── Integraciones ──────────────────────────────────────────────────── */
  cooprinsem:
    "Servicio que hace el control lechero oficial. Desde aquí importas sus planillas sin digitar nada.",
  integracionPrevisualizar:
    "Muestra qué se va a cargar y qué filas tienen problemas, antes de escribir nada.",
  integracionInconsistencias:
    "Filas del archivo que no calzan con tus datos: animales desconocidos, fechas imposibles o duplicados.",
  integracionRespaldo:
    "Copia del estado anterior a una importación, por si necesitas volver atrás.",
  integracionRetencion: "Cuánto tiempo se conservan los archivos y respaldos antes de borrarse.",

  /* ── Estado, sincronización y cuenta ────────────────────────────────── */
  sincronizacion:
    "Lo que registras sin internet queda guardado en el teléfono y sube solo al recuperar la señal.",
  modoDemo:
    "Campo de ejemplo con datos inventados y aislados. Nada de lo que hagas aquí toca tu información real.",
  accesos: "Quién puede entrar a la cuenta y qué puede ver o modificar cada persona.",
  funcionalidades: "Módulos activados para esta cuenta. Los apagados no aparecen en el menú.",
} as const;

export type HelpKey = keyof typeof HELP;

/** Texto de ayuda por clave. Devuelve `undefined` si la clave no existe, para que
 *  una clave mal escrita no rompa la pantalla ni muestre un globo vacío. */
export function helpFor(key: HelpKey | undefined): string | undefined {
  return key ? HELP[key] : undefined;
}
