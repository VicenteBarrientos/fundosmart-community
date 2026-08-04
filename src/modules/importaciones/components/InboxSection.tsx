"use client";

import { AlertTriangle, Check, Copy, Mail, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  InboxAddressRecord,
  InboxQuarantineRecord,
  InboxSenderWhitelistRecord,
} from "../domain/inbox-types";

type Props = {
  fieldId: string;
  isDemo?: boolean;
};

export function InboxSection({ fieldId }: Props) {
  const [address, setAddress] = useState<InboxAddressRecord | null>(null);
  const [whitelists, setWhitelists] = useState<InboxSenderWhitelistRecord[]>([]);
  const [quarantine, setQuarantine] = useState<InboxQuarantineRecord[]>([]);
  const [, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [newSenderEmail, setNewSenderEmail] = useState("");
  const [newSenderLabel, setNewSenderLabel] = useState("");
  const [addingSender, setAddingSender] = useState(false);
  const [rotating, setRotating] = useState(false);

  const loadInboxData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [addrRes, whiteRes, quaranRes] = await Promise.all([
        fetch(`/api/importaciones/inbox?action=address&fieldId=${encodeURIComponent(fieldId)}`),
        fetch(`/api/importaciones/inbox?action=whitelists`),
        fetch(`/api/importaciones/inbox?action=quarantine&fieldId=${encodeURIComponent(fieldId)}`),
      ]);

      if (addrRes.ok) {
        const data = (await addrRes.json()) as { address: InboxAddressRecord | null };
        setAddress(data.address);
      }
      if (whiteRes.ok) {
        const data = (await whiteRes.json()) as { whitelists: InboxSenderWhitelistRecord[] };
        setWhitelists(data.whitelists || []);
      }
      if (quaranRes.ok) {
        const data = (await quaranRes.json()) as { quarantine: InboxQuarantineRecord[] };
        setQuarantine(data.quarantine || []);
      }
    } catch (err) {
      console.error("Error al cargar datos de bandeja de entrada:", err);
    } finally {
      setIsLoading(false);
    }
  }, [fieldId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadInboxData();
  }, [loadInboxData]);

  const handleCreateOrRotateAddress = async (rotate = false) => {
    setRotating(true);
    try {
      const res = await fetch("/api/importaciones/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: rotate ? "rotate_address" : "create_or_get_address",
          fieldId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { address: InboxAddressRecord };
        setAddress(data.address);
      }
    } catch (err) {
      console.error("Error al gestionar dirección de correo:", err);
    } finally {
      setRotating(false);
    }
  };

  const handleCopyAddress = () => {
    if (!address) return;
    navigator.clipboard.writeText(address.emailAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddWhitelist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSenderEmail.trim()) return;

    setAddingSender(true);
    try {
      const res = await fetch("/api/importaciones/inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_whitelist",
          senderEmail: newSenderEmail,
          label: newSenderLabel,
        }),
      });
      if (res.ok) {
        setNewSenderEmail("");
        setNewSenderLabel("");
        loadInboxData();
      }
    } catch (err) {
      console.error("Error al agregar a lista blanca:", err);
    } finally {
      setAddingSender(false);
    }
  };

  const handleRemoveWhitelist = async (senderId: string) => {
    try {
      const res = await fetch(`/api/importaciones/inbox?senderId=${encodeURIComponent(senderId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        loadInboxData();
      }
    } catch (err) {
      console.error("Error al remover de lista blanca:", err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Dynamic Header & Address Box */}
      <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-950 p-6 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-emerald-400 font-semibold mb-1">
              <Mail className="h-5 w-5" />
              <span>Bandeja de Entrada por Correo Electrónico</span>
            </div>
            <p className="text-sm text-slate-300 max-w-2xl">
              Reciba planillas, controles lecheros y reportes de laboratorio directamente por correo.
              Los adjuntos recibidos de remitentes autorizados quedarán como borradores en Staging para revisión y confirmación.
            </p>
          </div>

          {!address ? (
            <button
              onClick={() => handleCreateOrRotateAddress(false)}
              disabled={rotating}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg text-sm transition shadow flex items-center justify-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Activar Dirección de Correo
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="bg-slate-900 border border-slate-700 px-3 py-2 rounded-lg text-sm font-mono text-emerald-300 select-all">
                {address.emailAddress}
              </div>
              <button
                onClick={handleCopyAddress}
                title="Copiar correo"
                className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
              <button
                onClick={() => handleCreateOrRotateAddress(true)}
                disabled={rotating}
                title="Rotar / Cambiar dirección"
                className="p-2 bg-slate-800 hover:bg-slate-700 text-amber-400 rounded-lg border border-slate-700 transition"
              >
                <RefreshCw className={`h-4 w-4 ${rotating ? "animate-spin" : ""}`} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sender Whitelist Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-emerald-400" />
              <h3 className="font-semibold text-slate-100">Lista Blanca de Remitentes</h3>
            </div>
            <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
              {whitelists.length} Autorizados
            </span>
          </div>

          <form onSubmit={handleAddWhitelist} className="flex gap-2">
            <input
              type="email"
              placeholder="correo@laboratorio.cl"
              value={newSenderEmail}
              onChange={(e) => setNewSenderEmail(e.target.value)}
              required
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            <input
              type="text"
              placeholder="Etiqueta (opcional)"
              value={newSenderLabel}
              onChange={(e) => setNewSenderLabel(e.target.value)}
              className="w-1/3 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={addingSender}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition flex items-center gap-1"
            >
              <Plus className="h-4 w-4" />
              Añadir
            </button>
          </form>

          <div className="divide-y divide-slate-800/60 max-h-60 overflow-y-auto pr-1">
            {whitelists.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">
                No hay remitentes autorizados. Agregue direcciones de correo para permitir el ingreso de adjuntos.
              </p>
            ) : (
              whitelists.map((w) => (
                <div key={w.id} className="py-2.5 flex items-center justify-between text-sm">
                  <div>
                    <div className="font-mono text-emerald-300">{w.senderEmail}</div>
                    {w.label && <div className="text-xs text-slate-400">{w.label}</div>}
                  </div>
                  <button
                    onClick={() => handleRemoveWhitelist(w.id)}
                    className="p-1 text-slate-500 hover:text-rose-400 transition"
                    title="Eliminar de lista blanca"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Quarantine Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              <h3 className="font-semibold text-slate-100">Mensajes en Cuarentena</h3>
            </div>
            <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
              {quarantine.length} Retenidos
            </span>
          </div>

          <div className="divide-y divide-slate-800/60 max-h-80 overflow-y-auto pr-1">
            {quarantine.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">
                No hay correos en cuarentena. Los correos no autorizados o sospechosos aparecerán aquí.
              </p>
            ) : (
              quarantine.map((q) => (
                <div key={q.id} className="py-3 space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-amber-300">{q.senderEmail}</span>
                    <span className="text-xs text-slate-500">{new Date(q.createdAt).toLocaleDateString("es-CL")}</span>
                  </div>
                  {q.subject && <div className="text-xs text-slate-300 truncate">{q.subject}</div>}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-rose-400 bg-rose-950/40 px-2 py-0.5 rounded border border-rose-900/50">
                      {q.reason === "unauthorized_sender" ? "Remitente no autorizado" : q.reason}
                    </span>
                    <button
                      onClick={() => {
                        setNewSenderEmail(q.senderEmail);
                      }}
                      className="text-xs text-emerald-400 hover:underline"
                    >
                      + Autorizar Remitente
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
