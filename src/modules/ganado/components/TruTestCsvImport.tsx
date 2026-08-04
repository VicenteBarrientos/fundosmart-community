"use client";

import type { LivestockAnimal } from "@/src/core/domain/types";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";
import { useState, type ChangeEvent } from "react";
import {
  MAX_TRU_TEST_CSV_BYTES,
  parseTruTestSessionCsv,
  reconcileTruTestRows,
  TruTestCsvError,
  type TruTestCsvIssue,
  type TruTestReconciliationResult,
  type TruTestSessionCsvResult,
} from "../domain/tru-test-session-csv.mjs";

export type TruTestImportProposal = {
  fileName: string;
  matchedCount: number;
  recordedAt: string | null;
  weights: Record<string, string>;
};

type TruTestCsvImportProps = {
  animals: LivestockAnimal[];
  disabled: boolean;
  onApply: (proposal: TruTestImportProposal) => void;
};

type Preview = {
  fileName: string;
  parsed: TruTestSessionCsvResult;
  reconciliation: TruTestReconciliationResult;
  blockingReason: string | null;
};

export function TruTestCsvImport({ animals, disabled, onApply }: TruTestCsvImportProps) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [applied, setApplied] = useState(false);

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (!file) return;

    setPreview(null);
    setApplied(false);
    setError(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Selecciona un archivo .csv exportado por Tru-Test Data Link.");
      return;
    }
    if (file.size > MAX_TRU_TEST_CSV_BYTES) {
      setError("El CSV Tru-Test supera el máximo de 2 MB.");
      return;
    }

    setReading(true);
    try {
      const parsed = parseTruTestSessionCsv(await file.text());
      const reconciliation = reconcileTruTestRows(parsed.rows, animals);
      const blockingReason = parsed.dates.length > 1
        ? `El archivo contiene ${parsed.dates.length} fechas distintas. Exporta una sola sesión Tru-Test por archivo.`
        : null;
      setPreview({ fileName: file.name, parsed, reconciliation, blockingReason });
    } catch (cause) {
      setError(cause instanceof TruTestCsvError ? cause.message : "No fue posible leer el CSV Tru-Test.");
    } finally {
      setReading(false);
    }
  }

  function applyPreview() {
    if (!preview || preview.blockingReason || preview.reconciliation.matches.length === 0) return;
    onApply({
      fileName: preview.fileName,
      matchedCount: preview.reconciliation.matches.length,
      recordedAt: preview.parsed.dates[0] ?? null,
      weights: Object.fromEntries(
        preview.reconciliation.matches.map((match) => [match.animalId, String(match.weightKg)]),
      ),
    });
    setApplied(true);
  }

  const issues: TruTestCsvIssue[] = preview
    ? [...preview.parsed.issues, ...preview.reconciliation.issues]
    : [];
  const visibleIssues = issues.slice(0, 5);
  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warningCount = issues.length - errorCount;
  const canApply = Boolean(
    preview
    && !preview.blockingReason
    && preview.reconciliation.matches.length > 0
    && !disabled,
  );

  return (
    <section className="mt-4 rounded-2xl border border-dashed border-line-steel bg-surface-alt p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white text-accent shadow-sm">
          <FileSpreadsheet aria-hidden="true" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black text-ink">Importar desde Tru-Test</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-subtle">
            Usa un CSV exportado por Data Link con VID o EID y Weight. Primero verás una conciliación; nada se guarda automáticamente.
          </p>
        </div>
      </div>

      <label className={`mt-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink transition ${disabled || reading ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-accent"}`}>
        {reading ? <LoaderCircle aria-hidden="true" className="animate-spin" size={15} /> : <Upload aria-hidden="true" size={15} />}
        {reading ? "Leyendo CSV" : "Seleccionar CSV Tru-Test"}
        <input
          accept=".csv,text/csv,text/plain"
          aria-label="Seleccionar archivo CSV Tru-Test"
          className="sr-only"
          disabled={disabled || reading}
          onChange={(event) => { void readFile(event); }}
          type="file"
        />
      </label>
      {!animals.length && (
        <p className="mt-2 text-[12px] font-semibold text-ink-subtle">Selecciona primero un lote con animales activos.</p>
      )}
      {error && <p className="mt-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-[12px] font-bold text-red-700">{error}</p>}

      {preview && (
        <div aria-live="polite" className="mt-3 rounded-xl border border-line-steel bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-black text-ink">{preview.fileName}</p>
              <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                {preview.parsed.dataRowCount} filas · {preview.reconciliation.matches.length} conciliadas
                {preview.parsed.dates.length === 1 ? ` · ${preview.parsed.dates[0]}` : ""}
              </p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-black ${preview.blockingReason || !preview.reconciliation.matches.length ? "bg-red-50 text-red-700" : "bg-band text-accent"}`}>
              {preview.blockingReason || !preview.reconciliation.matches.length ? "Revisar archivo" : "Listo para aplicar"}
            </span>
          </div>

          {preview.reconciliation.matches.length > 0 && (
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {preview.reconciliation.matches.slice(0, 6).map((match) => (
                <p className="rounded-lg bg-surface-alt px-2.5 py-1.5 text-[12px] font-bold text-ink-muted" key={match.animalId}>
                  {match.animalTag}: <span className="text-ink">{match.weightKg.toLocaleString("es-CL")} kg</span>
                </p>
              ))}
            </div>
          )}

          {preview.blockingReason && (
            <p className="mt-3 flex gap-2 rounded-lg bg-red-50 px-2.5 py-2 text-[12px] font-bold text-red-700">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={13} /> {preview.blockingReason}
            </p>
          )}

          {visibleIssues.length > 0 && (
            <div className="mt-3 rounded-lg bg-amber-50 px-2.5 py-2">
              <p className="text-[12px] font-black text-amber-900">
                {errorCount > 0 ? `${errorCount} filas rechazadas` : "Observaciones"}
                {warningCount > 0 ? ` · ${warningCount} avisos` : ""}
              </p>
              <ul className="mt-1 space-y-1 text-[12px] font-semibold leading-relaxed text-amber-900">
                {visibleIssues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.rowNumber ?? "general"}-${index}`}>
                    {issue.rowNumber ? `Fila ${issue.rowNumber}: ` : ""}{issue.message}
                  </li>
                ))}
                {issues.length > visibleIssues.length && <li>…y {issues.length - visibleIssues.length} observaciones más.</li>}
              </ul>
            </div>
          )}

          <button
            className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-ink px-3 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!canApply}
            onClick={applyPreview}
            type="button"
          >
            {applied ? <CheckCircle2 aria-hidden="true" size={15} /> : <Upload aria-hidden="true" size={15} />}
            {applied ? "Pesos aplicados al formulario" : `Aplicar ${preview.reconciliation.matches.length} pesos al formulario`}
          </button>
        </div>
      )}
    </section>
  );
}
