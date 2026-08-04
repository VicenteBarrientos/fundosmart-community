"use client";

import type { PedigreeNode } from "../domain/operations";
import { Dna, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

export function GenealogiaSection({ pedigree }: { pedigree: PedigreeNode[] }) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => pedigree.filter((entry) => !query.trim() || [entry.animalTag, entry.damTag, entry.sireTag].some((value) => value?.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es")))), [pedigree, query]);
  return <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="eyebrow">Genealogía vinculada</p><h2 className="mt-1 text-lg font-black text-ink">Pedigrí de tres generaciones</h2><p className="mt-1 text-xs text-ink-muted">Los toros escritos por DIIO se enlazan automáticamente cuando existen en el fundo.</p></div><label className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={14} /><input className="input-base pl-9 sm:w-72" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar DIIO o progenitor" value={query} /></label></div>
    <div className="mt-5 grid gap-3 xl:grid-cols-2">{visible.map((entry) => <article className="rounded-2xl border border-line-steel bg-surface-alt p-4" key={entry.animalId}><div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-band text-accent"><Dna size={16} /></span><div><Link className="text-sm font-black text-ink" href={`/ganado/ficha?animalId=${encodeURIComponent(entry.animalId)}`}>{entry.animalTag}</Link><p className="text-[12px] text-ink-subtle">Animal seleccionado</p></div></div><div className="mt-4 grid grid-cols-2 gap-2 text-[12px]"><Parent label="Madre" value={entry.damTag} /><Parent label="Padre" value={entry.sireTag} /><Parent label="Abuela materna" value={entry.maternalGranddamTag} /><Parent label="Abuelo materno" value={entry.maternalGrandsireTag} /><Parent label="Abuela paterna" value={entry.paternalGranddamTag} /><Parent label="Abuelo paterno" value={entry.paternalGrandsireTag} /></div></article>)}</div>
    {visible.length === 0 && <div className="mt-5 rounded-xl bg-surface-alt p-6 text-center text-sm font-bold text-ink-muted">Aún no hay nacimientos enlazados que formen un pedigrí para esta búsqueda.</div>}
  </section>;
}

function Parent({ label, value }: { label: string; value: string | null }) { return <div className="rounded-lg bg-white px-3 py-2"><p className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">{label}</p><p className={`mt-1 font-black ${value ? "text-ink" : "text-ink-subtle"}`}>{value ?? "Sin registrar"}</p></div>; }
