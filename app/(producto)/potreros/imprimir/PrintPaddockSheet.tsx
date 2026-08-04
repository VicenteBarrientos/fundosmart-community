"use client";

import type { Fundo, Potrero } from "@/src/modules/potreros/types";
import { splitPrintLegendRows } from "@/src/modules/potreros/export/print-layout";
import { ArrowLeft, LoaderCircle, Printer } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import styles from "./print.module.css";

const PrintPaddockMap = dynamic(
  () => import("./PrintPaddockMap").then((module) => module.PrintPaddockMap),
  {
    ssr: false,
    loading: () => <div className={styles.mapLoading}>Preparando mapa…</div>,
  },
);

const STATUS_COLORS: Record<Potrero["status"], string> = {
  Disponible: "#59a96a",
  "En pastoreo": "#d49a3a",
  "En descanso": "#718096",
};

type PrintPaddockSheetProps = {
  fundo: Fundo;
  paddocks: Potrero[];
  generatedLabel: string;
};

export function PrintPaddockSheet({ fundo, generatedLabel, paddocks }: PrintPaddockSheetProps) {
  const [mapReady, setMapReady] = useState(false);
  const legendColumns = useMemo(() => splitPrintLegendRows(paddocks, 15), [paddocks]);
  return (
    <main className={styles.page}>
      <div className={`${styles.toolbar} ${styles.noPrint}`}>
        <a href="/app/potreros"><ArrowLeft size={15} /> Volver</a>
        <span className={styles.loadStatus}>
          {!mapReady && <LoaderCircle className={styles.spinner} size={14} />}
          {mapReady ? "Plano vectorial listo para imprimir" : "Preparando plano vectorial"}
        </span>
        <button disabled={!mapReady} onClick={() => window.print()} type="button">
          <Printer size={15} /> Imprimir
        </button>
      </div>

      <article className={styles.sheet}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Plano de potreros · FundoSmart</p>
            <h1>{fundo.name}</h1>
            <p>{fundo.location}</p>
          </div>
          <div className={styles.headerFacts}>
            <span><strong>{paddocks.length}</strong> potreros</span>
            <span><strong>{fundo.areaHectares.toLocaleString("es-CL")}</strong> ha del fundo</span>
            <span>Generado {generatedLabel}</span>
          </div>
        </header>

        <div className={styles.bodyGrid}>
          <section className={styles.mapFrame} aria-label={`Mapa de potreros de ${fundo.name}`}>
            <PrintPaddockMap
              fundo={fundo}
              onReady={() => setMapReady(true)}
              paddocks={paddocks}
            />
            <div aria-label="Norte" className={styles.northArrow}><span>N</span><b>↑</b></div>
            <div className={styles.muteBadge}>Sin mapa base</div>
          </section>

          <aside className={styles.legend} aria-label="Leyenda de potreros">
            <div className={styles.legendHeader}>
              <h2>Leyenda</h2>
              <div className={styles.statusLegend}>
                {Object.entries(STATUS_COLORS).map(([status, color]) => (
                  <span key={status}><i style={{ backgroundColor: color }} />{status}</span>
                ))}
              </div>
            </div>
            <div className={styles.legendColumns}>
              {legendColumns.map((column, columnIndex) => (
                <ol key={`column-${columnIndex}`} start={columnIndex * 15 + 1}>
                  {column.map((paddock, rowIndex) => (
                    <li data-paddock-row key={paddock.id}>
                      <i style={{ backgroundColor: STATUS_COLORS[paddock.status] }} />
                      <span><b>{columnIndex * 15 + rowIndex + 1}. {paddock.name}</b><small>{paddock.sector} · {paddock.areaHectares.toLocaleString("es-CL")} ha</small></span>
                    </li>
                  ))}
                </ol>
              ))}
            </div>
            {paddocks.length === 0 && <p className={styles.emptyLegend}>Este fundo todavía no tiene potreros registrados.</p>}
          </aside>
        </div>

        <footer className={styles.footer}>
          <span>Coordenadas WGS84 · Escala gráfica dentro del plano · Sin teselas de terceros</span>
          <strong>Los límites y la leyenda se conservan e imprimen aunque el proveedor de mapas online no esté disponible.</strong>
        </footer>
      </article>
    </main>
  );
}
