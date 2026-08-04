"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import {
  AppWindow,
  ArrowUpFromLine,
  Check,
  Compass,
  Download,
  Plus,
  Smartphone,
} from "lucide-react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Target =
  | "pending"
  | "installed"
  | "prompt"
  | "ios"
  | "ios-in-app"
  | "macos-safari"
  | "no-install";

// Chrome fires `beforeinstallprompt` on load, which can precede hydration.
// Capturing at module scope keeps the event instead of losing it to a late listener.
let deferredPrompt: InstallPrompt | null = null;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPrompt;
    window.dispatchEvent(new Event("fundosmart:install-available"));
  });
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  const ua = window.navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS 13+ reports a desktop Mac user agent and is only distinguishable by touch.
  return /macintosh/i.test(ua) && window.navigator.maxTouchPoints > 1;
}

// Facebook, Instagram and WhatsApp open links in an embedded browser where
// "add to home screen" is missing or produces a broken shortcut.
function isInAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(window.navigator.userAgent);
}

function isMacosSafari(): boolean {
  const ua = window.navigator.userAgent;
  return /macintosh/i.test(ua)
    && window.navigator.maxTouchPoints <= 1
    && /safari/i.test(ua)
    && !/chrome|chromium|edg\//i.test(ua);
}

function resolveTarget(): Target {
  if (isStandalone()) return "installed";
  if (isIos()) return isInAppBrowser() ? "ios-in-app" : "ios";
  if (deferredPrompt) return "prompt";
  if (isMacosSafari()) return "macos-safari";
  return "no-install";
}

function subscribe(onChange: () => void): () => void {
  const display = window.matchMedia("(display-mode: standalone)");
  window.addEventListener("fundosmart:install-available", onChange);
  window.addEventListener("appinstalled", onChange);
  display.addEventListener("change", onChange);
  return () => {
    window.removeEventListener("fundosmart:install-available", onChange);
    window.removeEventListener("appinstalled", onChange);
    display.removeEventListener("change", onChange);
  };
}

export function InstallGuide() {
  // The target depends on `window`, so the server and the first client render
  // must agree on "pending" and settle once hydration exposes the real platform.
  const target = useSyncExternalStore<Target>(subscribe, resolveTarget, () => "pending");
  const [outcome, setOutcome] = useState<"idle" | "accepted" | "dismissed">("idle");

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    setOutcome(choice.outcome);
    // The event is single-use; Chrome re-fires it if the install is dismissed.
    deferredPrompt = null;
    window.dispatchEvent(new Event("fundosmart:install-available"));
  }, []);

  return (
    <div className="rounded-3xl border border-line-steel bg-white p-8 shadow-sm sm:p-12">
      <div className="mb-3 flex items-center gap-3 text-accent">
        <Download size={28} />
        <span className="text-xs font-black uppercase tracking-widest">Instalar FundoSmart</span>
      </div>

      <h1 className="text-2xl font-black tracking-tight sm:text-3xl">
        Deja FundoSmart a un toque de distancia
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-ink/70">
        Instalado, FundoSmart abre en su propia ventana, sin barra del navegador, y
        conserva la captura de terreno aunque te quedes sin señal en el potrero.
      </p>

      <div className="mt-8">
        {target === "pending" ? <Pending /> : null}
        {target === "installed" ? <Installed /> : null}
        {target === "prompt" ? <Prompt onInstall={install} outcome={outcome} /> : null}
        {target === "ios" ? <Ios /> : null}
        {target === "ios-in-app" ? <IosInApp /> : null}
        {target === "macos-safari" ? <MacosSafari /> : null}
        {target === "no-install" ? <NoInstall /> : null}
      </div>
    </div>
  );
}

function Pending() {
  return <p className="text-sm text-ink/60">Detectando tu dispositivo…</p>;
}

function Installed() {
  return (
    <Panel icon={<Check size={20} />} title="Ya está instalado">
      <p>Estás usando FundoSmart instalado. No hay nada más que hacer aquí.</p>
      <Link
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-black text-white"
        href="/app"
      >
        Ir a FundoSmart
      </Link>
    </Panel>
  );
}

function Prompt({ onInstall, outcome }: { onInstall: () => void; outcome: string }) {
  return (
    <Panel icon={<AppWindow size={20} />} title="Instalación directa">
      <p>Tu navegador permite instalar FundoSmart en un paso.</p>
      <button
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-black text-white transition hover:opacity-90"
        onClick={onInstall}
        type="button"
      >
        <Download size={16} /> Instalar FundoSmart
      </button>
      {outcome === "dismissed" ? (
        <p className="mt-3 text-xs text-ink/60">
          Cancelaste la instalación. Puedes volver a intentarlo cuando quieras.
        </p>
      ) : null}
    </Panel>
  );
}

function Ios() {
  return (
    <Panel icon={<Smartphone size={20} />} title="En iPhone y iPad">
      <p>Safari instala desde el menú de compartir. Son tres pasos:</p>
      <Steps
        items={[
          <>Toca <ArrowUpFromLine className="inline" size={14} /> <strong>Compartir</strong>, en la barra inferior.</>,
          <>Desliza y elige <strong>Agregar a pantalla de inicio</strong>.</>,
          <>Confirma con <strong>Agregar</strong>. El ícono queda junto al resto de tus apps.</>,
        ]}
      />
      <p className="mt-4 text-xs text-ink/60">
        Apple no permite que un sitio se instale solo: el último toque siempre lo das tú.
      </p>
    </Panel>
  );
}

function IosInApp() {
  return (
    <Panel icon={<Compass size={20} />} title="Abre esto en Safari">
      <p>
        Estás dentro del navegador de otra aplicación, y ahí iOS no ofrece instalar.
        Toca el menú <strong>···</strong> y elige <strong>Abrir en Safari</strong>; desde
        Safari podrás agregar FundoSmart a tu pantalla de inicio.
      </p>
    </Panel>
  );
}

function MacosSafari() {
  return (
    <Panel icon={<AppWindow size={20} />} title="En Mac con Safari">
      <p>
        Abre el menú <strong>Archivo</strong> y elige <strong>Agregar al Dock</strong>.
        FundoSmart quedará como una aplicación con su propia ventana.
      </p>
    </Panel>
  );
}

function NoInstall() {
  return (
    <Panel icon={<Plus size={20} />} title="Instalación no disponible aquí">
      <p>
        Este navegador no ofreció instalar FundoSmart. Suele pasar en Firefox de
        escritorio, que no admite aplicaciones web instalables, y también cuando la
        aplicación ya está instalada en este equipo.
      </p>
      <p>
        FundoSmart funciona igual en una pestaña. Si quieres instalarlo, usa Chrome o
        Edge en el computador, o abre <strong>fundosmart.com/instalar</strong> en tu
        teléfono.
      </p>
    </Panel>
  );
}

function Panel({ icon, title, children }: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line-steel bg-surface-alt p-6">
      <div className="flex items-center gap-2 text-accent">
        {icon}
        <h2 className="text-sm font-black uppercase tracking-wider">{title}</h2>
      </div>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink/80">{children}</div>
    </div>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-4 space-y-3">
      {items.map((item, index) => (
        <li className="flex gap-3 text-sm leading-relaxed" key={index}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-black text-white">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}
