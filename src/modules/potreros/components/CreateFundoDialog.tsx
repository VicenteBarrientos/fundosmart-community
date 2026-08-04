"use client";

import { ArrowRight, MapPinned, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useDialogA11y } from "@/src/ui/useDialogA11y";

export type NewFundoDetails = {
  name: string;
  location: string;
};

type CreateFundoDialogProps = {
  onClose: () => void;
  onStart: (details: NewFundoDetails) => void;
};

export function CreateFundoDialog({ onClose, onStart }: CreateFundoDialogProps) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !location.trim()) {
      setError("Completa el nombre y la ubicación.");
      return;
    }
    onStart({ name: name.trim(), location: location.trim() });
  }

  return (
    <div className="fixed inset-0 z-[2100] grid place-items-center bg-chrome/65 p-4 backdrop-blur-sm" role="presentation">
      <div aria-labelledby="create-fundo-title" aria-modal="true" className="w-full max-w-lg rounded-[24px] bg-white shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between border-b border-line-steel px-5 py-5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-band text-accent"><MapPinned size={18} /></span>
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.15em] text-accent">Plan Gratis</p>
              <h2 className="mt-1 text-xl font-black tracking-[-0.035em] text-ink" id="create-fundo-title">Crear un fundo</h2>
            </div>
          </div>
          <button aria-label="Cerrar" className="grid size-9 place-items-center rounded-xl bg-surface-alt text-ink-muted" onClick={onClose} type="button"><X size={17} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="space-y-4 px-5 py-5 sm:px-6">
            <p className="rounded-2xl bg-surface-alt px-4 py-3 text-sm font-semibold leading-5 text-ink-muted">
              Primero identifica el fundo. En el paso siguiente dibujarás su límite directamente sobre el mapa.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-black uppercase tracking-[0.09em] text-ink-muted">Nombre</span>
              <input autoFocus className="input-base" onChange={(event) => setName(event.target.value)} placeholder="Ej. Fundo Los Robles" value={name} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-black uppercase tracking-[0.09em] text-ink-muted">Sector o localidad</span>
              <input className="input-base" onChange={(event) => setLocation(event.target.value)} placeholder="Ej. Osorno, Los Lagos" value={location} />
            </label>
            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700" role="alert">{error}</p>}
          </div>

          <div className="flex gap-3 border-t border-line-steel p-4 sm:px-6">
            <button className="h-11 flex-1 rounded-xl border border-line-steel text-xs font-black text-ink-muted" onClick={onClose} type="button">Cancelar</button>
            <button className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white" type="submit">
              Dibujar límite <ArrowRight size={15} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
