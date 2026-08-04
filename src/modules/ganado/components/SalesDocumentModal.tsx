"use client";

import { DollarSign, FileText, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AnimalMarginResult } from "../domain/livestock-margin.mjs";

type SaleDocRecord = {
  id: string;
  documentType: string;
  documentNumber: string | null;
  buyerOrSupplierName: string;
  documentDate: string;
  totalAmountClp: number;
  status: string;
  links?: Array<{
    id: string;
    animalId: string | null;
    lotId: string | null;
    allocatedAmountClp: number;
  }>;
};

type Props = {
  fieldId: string;
  animalId?: string;
  animalTag?: string;
  onClose(): void;
};

export function SalesDocumentModal({ fieldId, animalId, animalTag, onClose }: Props) {
  const [documents, setDocuments] = useState<SaleDocRecord[]>([]);
  const [margin, setMargin] = useState<AnimalMarginResult | null>(null);
  const [, setLoading] = useState(true);

  // Form state
  const [buyerName, setBuyerName] = useState("");
  const [docDate, setDocDate] = useState(new Date().toISOString().split("T")[0]);
  const [docType, setDocType] = useState<"liquidacion_feria" | "guia_despacho" | "factura_venta">("liquidacion_feria");
  const [docNum, setDocNum] = useState("");
  const [totalAmount, setTotalAmount] = useState<number | "">("");
  const [creating, setCreating] = useState(false);

  // Link state
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [allocatedAmount, setAllocatedAmount] = useState<number | "">("");
  const [linking, setLinking] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const promises: Array<Promise<Response>> = [
        fetch(`/api/ganado/ventas?action=documents&fieldId=${encodeURIComponent(fieldId)}`),
      ];
      if (animalId) {
        promises.push(fetch(`/api/ganado/ventas?action=margin&animalId=${encodeURIComponent(animalId)}`));
      }

      const [docsRes, marginRes] = await Promise.all(promises);
      if (docsRes.ok) {
        const data = (await docsRes.json()) as { documents: SaleDocRecord[] };
        setDocuments(data.documents || []);
      }
      if (marginRes && marginRes.ok) {
        const data = (await marginRes.json()) as { margin: AnimalMarginResult };
        setMargin(data.margin);
      }
    } catch (err) {
      console.error("Error al cargar comprobantes de venta:", err);
    } finally {
      setLoading(false);
    }
  }, [fieldId, animalId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
  }, [loadData]);

  const handleCreateDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!buyerName.trim() || !docDate || typeof totalAmount !== "number" || totalAmount <= 0) return;

    setCreating(true);
    try {
      const res = await fetch("/api/ganado/ventas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_document",
          fieldId,
          documentType: docType,
          documentNumber: docNum,
          buyerOrSupplierName: buyerName,
          documentDate: docDate,
          totalAmountClp: totalAmount,
        }),
      });

      if (res.ok) {
        setBuyerName("");
        setDocNum("");
        setTotalAmount("");
        loadData();
      }
    } catch (err) {
      console.error("Error al crear documento de venta:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleLinkDocument = async (docId: string) => {
    if (!animalId || typeof allocatedAmount !== "number" || allocatedAmount <= 0) return;

    setLinking(true);
    try {
      const res = await fetch("/api/ganado/ventas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "link_document",
          documentId: docId,
          animalId,
          allocatedAmountClp: allocatedAmount,
        }),
      });

      if (res.ok) {
        setSelectedDocId(null);
        setAllocatedAmount("");
        loadData();
      }
    } catch (err) {
      console.error("Error al conciliar venta:", err);
    } finally {
      setLinking(false);
    }
  };

  const formatClp = (val: number | null | undefined) => {
    if (val === null || val === undefined) return "—";
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(val);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 text-slate-100 shadow-2xl p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
              <DollarSign className="h-4 w-4" />
              <span>Cierre Económico y Comprobantes de Venta</span>
            </div>
            <h2 className="text-xl font-bold text-slate-100 mt-1">
              {animalTag ? `Animal DIIO: ${animalTag}` : "Comprobantes de Venta del Predio"}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Animal Margin Summary Card */}
        {margin && (
          <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-950/30 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-emerald-400 font-bold">
                Margen Económico por Animal
              </span>
              <span
                className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${
                  margin.isReconciled
                    ? "bg-emerald-950 text-emerald-300 border-emerald-800"
                    : "bg-amber-950 text-amber-300 border-amber-800"
                }`}
              >
                {margin.isReconciled ? "✓ Venta Conciliada con Comprobante" : "⚠️ Venta Pendiente de Comprobante"}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="text-xs text-slate-400">Ingreso por Venta</div>
                <div className="text-lg font-mono font-bold text-emerald-400">{formatClp(margin.revenueClp)}</div>
              </div>
              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="text-xs text-slate-400">Costo Alimento</div>
                <div className="text-lg font-mono font-bold text-rose-400">{formatClp(margin.feedCostClp)}</div>
                <div className="text-[10px] text-slate-500">{margin.isFeedMeasured ? "Medido" : "Imputado por categoría"}</div>
              </div>
              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="text-xs text-slate-400">Gastos Directos</div>
                <div className="text-lg font-mono font-bold text-amber-400">{formatClp(margin.expensesCostClp)}</div>
              </div>
              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="text-xs text-slate-400">Margen Neto</div>
                <div className="text-lg font-mono font-bold text-slate-100">{formatClp(margin.marginClp)}</div>
              </div>
            </div>

            <p className="text-xs text-slate-400 bg-slate-950/60 p-2.5 rounded border border-slate-800 italic">
              📌 {margin.imputationExplanation}
            </p>
          </div>
        )}

        {/* Create Document Form */}
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <Plus className="h-4 w-4 text-emerald-400" />
            Registrar Liquidación de Feria o Guía de Venta
          </h3>

          <form onSubmit={handleCreateDocument} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Tipo de Comprobante</label>
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value as "liquidacion_feria" | "guia_despacho" | "factura_venta")}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100"
              >
                <option value="liquidacion_feria">Liquidación de Feria</option>
                <option value="guia_despacho">Guía de Despacho</option>
                <option value="factura_venta">Factura de Venta</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Comprador / Feria</label>
              <input
                type="text"
                placeholder="Feria Tattersall, Bioleche, etc."
                value={buyerName}
                onChange={(e) => setBuyerName(e.target.value)}
                required
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">N° Documento (opcional)</label>
              <input
                type="text"
                placeholder="LIQ-8899"
                value={docNum}
                onChange={(e) => setDocNum(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Fecha Emisión</label>
              <input
                type="date"
                value={docDate}
                onChange={(e) => setDocDate(e.target.value)}
                required
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1">Monto Total CLP</label>
              <input
                type="number"
                placeholder="650000"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value === "" ? "" : Number(e.target.value))}
                required
                min={1}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100"
              />
            </div>

            <div className="flex items-end">
              <button
                type="submit"
                disabled={creating}
                className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium text-sm transition shadow"
              >
                {creating ? "Guardando..." : "Guardar Comprobante"}
              </button>
            </div>
          </form>
        </div>

        {/* Document List & Conciliation */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">
            Comprobantes Registrados ({documents.length})
          </h3>

          <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl bg-slate-950 overflow-hidden">
            {documents.length === 0 ? (
              <p className="text-sm text-slate-500 p-6 text-center">
                No hay comprobantes de venta registrados para este fundo.
              </p>
            ) : (
              documents.map((doc) => (
                <div key={doc.id} className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-slate-100 text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4 text-emerald-400" />
                        <span>{doc.buyerOrSupplierName}</span>
                        {doc.documentNumber && (
                          <span className="text-xs font-mono text-slate-400">#{doc.documentNumber}</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {doc.documentType === "liquidacion_feria" ? "Liquidación Feria" : doc.documentType} • Fecha: {doc.documentDate}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="font-mono font-bold text-emerald-400">{formatClp(doc.totalAmountClp)}</div>
                      <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                        doc.status === "reconciled" ? "bg-emerald-950 text-emerald-400" : "bg-amber-950 text-amber-400"
                      }`}>
                        {doc.status === "reconciled" ? "Conciliado" : "Pendiente"}
                      </span>
                    </div>
                  </div>

                  {/* Conciliate button if viewing for specific animal */}
                  {animalId && (
                    <div className="pt-2 border-t border-slate-900 flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        {doc.links?.some((l) => l.animalId === animalId)
                          ? "✓ Conciliado con este animal"
                          : "Vincular comprobante a este DIIO"}
                      </span>

                      {selectedDocId !== doc.id ? (
                        <button
                          onClick={() => {
                            setSelectedDocId(doc.id);
                            setAllocatedAmount(doc.totalAmountClp);
                          }}
                          className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-xs rounded font-medium border border-slate-700 transition"
                        >
                          Conciliar con este Animal
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            placeholder="Monto asignado"
                            value={allocatedAmount}
                            onChange={(e) => setAllocatedAmount(e.target.value === "" ? "" : Number(e.target.value))}
                            className="bg-slate-900 border border-slate-700 text-xs px-2 py-1 rounded text-slate-100 w-32"
                          />
                          <button
                            onClick={() => handleLinkDocument(doc.id)}
                            disabled={linking}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded font-medium transition"
                          >
                            Confirmar
                          </button>
                          <button
                            onClick={() => setSelectedDocId(null)}
                            className="p-1 text-slate-400 hover:text-slate-200"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
