"use client";

import {
  BarChart3,
  Beef,
  Building2,
  Check,
  ChevronDown,
  CircleDollarSign,
  Cloud,
  CloudOff,
  Download,
  FileUp,
  HelpCircle,
  House,
  LayoutDashboard,
  LogOut,
  Map,
  MapPin,
  Menu,
  Milk,
  Settings,
  ShieldCheck,
  LoaderCircle,
  Sparkles,
  Sprout,
  Tags,
  UserRound,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { FundoSmartLogo } from "../brand/FundoSmartLogo";
import { AsistenteFundoSmart } from "@/src/modules/asistente/AsistenteFundoSmart";
import { FeedbackDialog } from "@/src/modules/feedback/FeedbackDialog";
import { HELP, type HelpKey } from "@/src/ui/help-copy";
import { ModuleRefreshControl } from "@/src/ui/ModuleRefreshControl";

type SectionKey =
  | "summary"
  | "potreros"
  | "praderas"
  | "ganado"
  | "trazabilidad"
  | "leche"
  | "costos"
  | "integraciones"
  | "analitica"
  | "benchmarking"
  | "reportes"
  | "settings";

type AppShellProps = {
  children: ReactNode;
  fieldName?: string;
  activeSection?: SectionKey;
  isDemo?: boolean;
  organizationId?: string;
  organizationName?: string;
  userName?: string;
  isStaff?: boolean;
  onRefresh?: () => Promise<void> | void;
  snapshotGeneratedAt?: string;
};

type AccessibleSpace = {
  id: string;
  name: string;
  kind: "shared" | "personal" | "demo";
  role: "owner" | "admin" | "manager" | "operator" | "viewer";
  fieldNames: string[];
};

const SPACE_ROLE_LABELS: Record<AccessibleSpace["role"], string> = {
  owner: "Propietario",
  admin: "Administrador",
  manager: "Encargado",
  operator: "Operador",
  viewer: "Solo lectura",
};

const SPACE_KIND_LABELS: Record<AccessibleSpace["kind"], string> = {
  shared: "Espacio compartido",
  personal: "Espacio personal",
  demo: "Demostración",
};

/* `help` apunta al glosario de src/ui/help-copy.ts. El nombre de un módulo no
   dice qué hace: quien entra por primera vez necesita leerlo antes de hacer clic. */
type NavItem = { key: SectionKey; label: string; icon: LucideIcon; href: string; help: HelpKey };

const NAV: NavItem[] = [
  { key: "summary", label: "Resumen", icon: LayoutDashboard, href: "/app", help: "navResumen" },
  { key: "potreros", label: "Potreros", icon: Map, href: "/app/potreros", help: "navPotreros" },
  { key: "ganado", label: "Ganado", icon: Beef, href: "/app/ganado", help: "navGanado" },
  { key: "leche", label: "Leche", icon: Milk, href: "/app/leche", help: "navLeche" },
  { key: "costos", label: "Costos", icon: CircleDollarSign, href: "/app/costos", help: "navCostos" },
  { key: "analitica", label: "Analítica", icon: BarChart3, href: "/app/analitica", help: "navAnalitica" },
  { key: "praderas", label: "Praderas", icon: Sprout, href: "/app/praderas", help: "navPraderas" },
  { key: "trazabilidad", label: "Trazabilidad", icon: Tags, href: "/app/trazabilidad", help: "navTrazabilidad" },
  {
    key: "integraciones",
    label: "Importaciones",
    icon: FileUp,
    href: "/app/importaciones",
    help: "navIntegraciones",
  },
  { key: "benchmarking", label: "Benchmarking", icon: UsersRound, href: "/app/benchmarking", help: "navBenchmarking" },
  { key: "reportes", label: "Reportes", icon: BarChart3, href: "/app/reportes", help: "navReportes" },
];

const PRIMARY_KEYS: SectionKey[] = ["summary", "potreros", "ganado", "leche", "costos", "analitica"];
const MOBILE_KEYS: SectionKey[] = ["summary", "potreros", "ganado", "leche"];

const primaryNav = NAV.filter((item) => PRIMARY_KEYS.includes(item.key));
const overflowNav = NAV.filter((item) => !PRIMARY_KEYS.includes(item.key));
const mobileNav = NAV.filter((item) => MOBILE_KEYS.includes(item.key));

/* Cada módulo es `force-dynamic`, y el prefetch automático de Link descarta las
   rutas dinámicas: la carga RSC recién arrancaba con el clic, así que el módulo
   tardaba toda la ida y vuelta al servidor en aparecer. Anticiparla al gesto que
   precede al clic —puntero encima, foco de teclado o primer toque— la deja lista
   antes de que haga falta. `router.prefetch` ya deduplica y expira sola, así que
   pasar por encima de la barra no acumula pedidos. */
const NavigationStartContext = createContext<(() => void) | null>(null);

function useIntentPrefetch() {
  const router = useRouter();
  const onNavigate = useContext(NavigationStartContext);
  return useCallback(
    (href: string) => {
      const prefetch = () => router.prefetch(href);
      return {
        onFocus: prefetch,
        onMouseEnter: prefetch,
        onNavigate: onNavigate ?? undefined,
        onTouchStart: prefetch,
      };
    },
    [onNavigate, router],
  );
}

/* El destino se marca solo, pero en el celular la barra inferior queda lejos de
   la vista: una barra en el borde superior confirma el viaje sin importar dónde
   se tocó. Se apaga cuando `usePathname` cambia —es decir, cuando la navegación
   ya se aplicó— y tiene una salida por tiempo para no quedarse encendida si el
   usuario cancela el viaje volviendo atrás. */
function useNavigationPending(pathname: string) {
  const [pending, setPending] = useState(false);
  /* Ajuste durante el render, no en un efecto: cuando la ruta ya cambió el viaje
     terminó, y apagarlo aquí evita pintar un fotograma con la barra encendida
     sobre el módulo nuevo. */
  const [renderedPathname, setRenderedPathname] = useState(pathname);
  if (renderedPathname !== pathname) {
    setRenderedPathname(pathname);
    setPending(false);
  }
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(() => setPending(false), 20_000);
    return () => clearTimeout(timer);
  }, [pending]);
  return [pending, useCallback(() => setPending(true), [])] as const;
}

/* El proveedor va por fuera del chrome para que los enlaces que el propio shell
   dibuja —barra inferior, menú «Más»— lean el mismo contexto que `TopNavLink`. */
export function AppShell(props: AppShellProps) {
  const pathname = usePathname();
  const [navPending, startNavigation] = useNavigationPending(pathname);
  return (
    <NavigationStartContext.Provider value={startNavigation}>
      <AppShellChrome {...props} navPending={navPending} />
    </NavigationStartContext.Provider>
  );
}

function AppShellChrome({
  children,
  fieldName,
  activeSection = "summary",
  isDemo = false,
  navPending,
  onRefresh,
  organizationId,
  organizationName = "Tu espacio",
  snapshotGeneratedAt,
  userName = "Usuario FundoSmart",
  isStaff = false,
}: AppShellProps & { navPending: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const intentPrefetch = useIntentPrefetch();
  const pathname = usePathname();
  const initials = getInitials(userName);
  const returnTo = productPath(pathname);
  const moduleLabel = NAV.find((item) => item.key === activeSection)?.label ?? "módulo";
  const personalAccountHref = `/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`;
  const demoAccountHref = `/demo?returnTo=${encodeURIComponent(returnTo)}`;
  /* Al cambiar de espacio la ruta exacta deja de existir: la ficha de un animal o
     el mapa de un potrero llevan identificadores que no viven en el otro espacio.
     El regreso apunta a la raíz del módulo, que sí existe en todos. */
  const switchReturnTo = moduleRootPath(returnTo);

  useEffect(() => {
    const updateConnection = () => setOnline(window.navigator.onLine);
    updateConnection();
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, []);

  return (
    <div className="min-h-screen bg-bg-steel">
      <div
        aria-hidden={!navPending}
        className={`fixed inset-x-0 top-0 z-[1200] h-0.5 overflow-hidden transition-opacity ${
          navPending ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="h-full w-2/5 animate-nav-progress bg-hivis" />
      </div>

      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[1100] focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
      >
        Saltar al contenido
      </a>

      <header className="sticky top-0 z-[1001] bg-chrome text-white">
        <div className="flex h-14 items-center gap-3 px-4">
          <Link aria-label="FundoSmart, ir al resumen" href="/app" className="shrink-0">
            <FundoSmartLogo height={30} inverse />
          </Link>

          <EspacioSwitcher
            demoAccountHref={demoAccountHref}
            isDemo={isDemo}
            organizationId={organizationId}
            organizationName={organizationName}
            personalAccountHref={personalAccountHref}
            returnTo={switchReturnTo}
            variant="header"
          />

          {/* El campo sólo se anuncia cuando el módulo mira uno: la consola de
              staff y el tablero de accesos no son de un campo, y un rótulo vacío
              ahí decía «Campo activo» sobre datos que no lo son. */}
          {fieldName && (
            <Link
              data-hint={HELP.shellCampoActivo}
              data-hint-side="bottom"
              href="/app/potreros"
              className="hidden items-center gap-2 rounded border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs text-white/80 hover:bg-white/10 sm:flex"
            >
              <MapPin size={14} className="text-accent" />
              <span className="max-w-[13rem] truncate">{fieldName}</span>
            </Link>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <ModuleRefreshControl
              generatedAt={snapshotGeneratedAt}
              label={moduleLabel}
              moduleKey={activeSection}
              onRefresh={onRefresh}
            />
            <span
              className="grid size-8 place-items-center"
              data-hint={`${online ? "Con conexión." : "Sin conexión."} ${HELP.shellConexion}`}
              data-hint-side="bottom"
            >
              {online ? (
                <Cloud size={16} className="text-accent" aria-label="Con conexión" />
              ) : (
                <CloudOff size={16} className="text-hivis" aria-label="Sin conexión" />
              )}
            </span>

            <FeedbackDialog isDemo={isDemo} />
            {!isDemo && (
              <Link
                aria-label="Cuenta y datos"
                className="hidden size-8 place-items-center rounded hover:bg-white/10 sm:grid"
                data-hint="Exportaciones, recibos y cierre reversible"
                data-hint-side="bottom"
                href="/app/cuenta/datos"
              >
                <Download size={17} />
              </Link>
            )}
            <Link
              href="/#preguntas"
              aria-label="Ayuda"
              data-hint={HELP.shellAyuda}
              data-hint-side="bottom"
              className="hidden size-8 place-items-center rounded hover:bg-white/10 sm:grid"
            >
              <HelpCircle size={17} />
            </Link>
            <Link
              href="/app/configuracion/accesos"
              aria-label="Configuración"
              aria-current={activeSection === "settings" ? "page" : undefined}
              data-hint={HELP.navConfiguracion}
              data-hint-side="bottom"
              className={`hidden size-8 place-items-center rounded hover:bg-white/10 sm:grid ${
                activeSection === "settings" ? "bg-white/10" : ""
              }`}
            >
              <Settings size={17} />
            </Link>

            {isStaff && (
              <Link
                href="/app/staff"
                aria-label="Panel de Staff"
                data-hint="Administración Global"
                data-hint-side="bottom"
                className={`hidden size-8 place-items-center rounded hover:bg-white/10 sm:grid ${
                  pathname?.startsWith("/app/staff") ? "bg-white/10" : ""
                }`}
              >
                <ShieldCheck size={17} />
              </Link>
            )}

            <form action="/auth/logout" className="hidden sm:block" method="post">
              <button
                aria-label="Cerrar sesión"
                className="grid size-8 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white"
                type="submit"
              >
                <LogOut size={17} />
              </button>
            </form>

            <span className="ml-1 flex items-center gap-2">
              <span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-black text-white">
                {initials}
              </span>
              <span className="hidden max-w-[10rem] truncate text-xs font-semibold md:block">{userName}</span>
            </span>
          </div>
        </div>

        <nav aria-label="Navegación principal" className="hidden border-b-2 border-hivis bg-chrome-2 lg:block">
          <div className="flex items-stretch px-2">
            {primaryNav.map((item) => (
              <TopNavLink item={item} active={item.key === activeSection} key={item.key} />
            ))}

            <div className="relative ml-auto flex items-stretch">
              <button
                aria-expanded={moreOpen}
                aria-haspopup="true"
                className={`flex items-center gap-1.5 px-4 text-xs font-bold uppercase tracking-[0.06em] ${
                  overflowNav.some((item) => item.key === activeSection)
                    ? "text-white"
                    : "text-white/60 hover:text-white"
                }`}
                onClick={() => setMoreOpen((value) => !value)}
                type="button"
              >
                Más <ChevronDown size={14} className={moreOpen ? "rotate-180 transition" : "transition"} />
              </button>
              {moreOpen && (
                <div
                  className="absolute right-0 top-full z-[1002] mt-0 w-[21rem] max-w-[calc(100vw-2rem)] rounded-b border border-white/10 bg-chrome-2 py-1 shadow-2xl"
                  role="menu"
                >
                  {overflowNav.map((item) => {
                    const active = item.key === activeSection;
                    return (
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={`relative flex flex-col gap-1 px-4 py-2.5 ${
                          active ? "bg-accent text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                        }`}
                        href={item.href}
                        key={item.key}
                        onClick={() => setMoreOpen(false)}
                        role="menuitem"
                        {...intentPrefetch(item.href)}
                      >
                        <NavPendingWash className="bg-accent/70" />
                        <span className="relative flex items-center gap-3 text-xs font-bold uppercase tracking-[0.05em]">
                          <NavIcon icon={item.icon} size={16} strokeWidth={1.8} /> {item.label}
                        </span>
                        <span className="relative text-[12px] font-medium normal-case leading-[1.35] text-white/50">
                          {HELP[item.help]}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </nav>
      </header>

      {moreOpen && (
        <button
          aria-label="Cerrar menú"
          className="fixed inset-0 z-[999] hidden lg:block"
          onClick={() => setMoreOpen(false)}
          type="button"
        />
      )}

      <main
        aria-busy={navPending || undefined}
        className="min-w-0 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-0"
        id="contenido"
      >
        {!online && (
          <div
            className="flex items-center justify-center gap-2 border-b border-warn-bar/40 bg-warn-bg px-4 py-2 text-center text-[12px] font-black text-warn-ink"
            role="status"
          >
            <CloudOff size={14} /> Sin conexión: el caché disponible sigue visible y los nuevos registros quedarán
            pendientes de sincronización.
          </div>
        )}
        {children}
      </main>

      <nav
        aria-label="Navegación rápida"
        className="fixed inset-x-0 bottom-0 z-[998] grid grid-cols-5 border-t border-line-strong bg-white px-1 pt-1 lg:hidden"
        style={{ paddingBottom: "max(0.45rem, env(safe-area-inset-bottom))" }}
      >
        {mobileNav.map((item) => {
          const active = item.key === activeSection;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded text-[12px] font-black uppercase tracking-wide ${
                active ? "bg-band text-chrome" : "text-ink-subtle"
              }`}
              href={item.href}
              key={item.key}
              {...intentPrefetch(item.href)}
            >
              <NavPendingWash className="rounded bg-band/60" />
              <NavIcon icon={item.icon} size={18} strokeWidth={active ? 2.5 : 1.9} />
              <span className="relative">{item.key === "potreros" ? "Potreros" : item.label}</span>
            </Link>
          );
        })}
        <button
          aria-expanded={mobileOpen}
          className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded text-[12px] font-black uppercase tracking-wide ${
            mobileOpen ? "bg-band text-chrome" : "text-ink-subtle"
          }`}
          onClick={() => setMobileOpen(true)}
          type="button"
        >
          <Menu size={18} />
          <span>Más</span>
        </button>
      </nav>

      {mobileOpen && (
        <button
          aria-label="Cerrar navegación"
          className="fixed inset-0 z-[1000] bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          type="button"
        />
      )}

      <aside
        className={`${
          mobileOpen ? "translate-x-0" : "translate-x-full"
        } fixed inset-y-0 right-0 z-[1001] flex w-[290px] flex-col bg-chrome p-4 text-white shadow-2xl transition-transform duration-200 lg:hidden`}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold uppercase tracking-[0.05em]">Menú</span>
          <button
            aria-label="Cerrar navegación"
            className="grid size-9 place-items-center rounded bg-white/10"
            onClick={() => setMobileOpen(false)}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4">
          <EspacioSwitcher
            demoAccountHref={demoAccountHref}
            isDemo={isDemo}
            onNavigate={() => setMobileOpen(false)}
            organizationId={organizationId}
            organizationName={organizationName}
            personalAccountHref={personalAccountHref}
            returnTo={switchReturnTo}
            variant="menu"
          />
        </div>

        {/* En pantallas táctiles no hay cursor, así que la descripción de cada
            módulo se muestra siempre en vez de esperar un globo que no llegará. */}
        <nav aria-label="Todas las secciones" className="mt-3 space-y-1 overflow-y-auto">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = item.key === activeSection;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`flex gap-3 rounded px-3 py-2.5 text-sm ${
                  active ? "bg-accent font-bold text-white" : "text-white/70 hover:bg-white/[0.06] hover:text-white"
                }`}
                href={item.href}
                key={item.key}
                onClick={() => setMobileOpen(false)}
                {...intentPrefetch(item.href)}
              >
                <Icon className="mt-0.5 shrink-0" size={18} />
                <span className="min-w-0">
                  {item.label}
                  <span
                    className={`mt-0.5 block text-[12px] font-medium leading-[1.35] ${
                      active ? "text-white/70" : "text-white/45"
                    }`}
                  >
                    {HELP[item.help]}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1 border-t border-white/10 pt-3">
          <FeedbackDialog
            isDemo={isDemo}
            onAfterClose={() => setMobileOpen(true)}
            onBeforeOpen={() => setMobileOpen(false)}
            variant="menu"
          />
          {!isDemo && (
            <Link
              className="flex items-center gap-3 rounded px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.06]"
              href="/app/cuenta/datos"
              onClick={() => setMobileOpen(false)}
            >
              <Download size={17} /> Cuenta y datos
            </Link>
          )}
          <Link
            className="flex items-center gap-3 rounded px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.06]"
            href="/#preguntas"
            onClick={() => setMobileOpen(false)}
          >
            <HelpCircle size={17} /> Ayuda
          </Link>
          <Link
            aria-current={activeSection === "settings" ? "page" : undefined}
            className={`flex items-center gap-3 rounded px-3 py-2.5 text-sm hover:bg-white/[0.06] ${
              activeSection === "settings" ? "bg-white/10 text-white" : "text-white/70"
            }`}
            href="/app/configuracion/accesos"
            onClick={() => setMobileOpen(false)}
          >
            <Settings size={17} /> Configuración
          </Link>
          {isStaff && (
            <Link
              className={`flex items-center gap-3 rounded px-3 py-2.5 text-sm hover:bg-white/[0.06] ${
                pathname?.startsWith("/app/staff") ? "bg-white/10 text-white" : "text-white/70"
              }`}
              href="/app/staff"
              onClick={() => setMobileOpen(false)}
            >
              <ShieldCheck size={17} /> Panel de Staff
            </Link>
          )}
          <div className="flex items-center gap-3 pt-2">
            <span className="grid size-9 place-items-center rounded-full bg-accent text-xs font-black text-white">
              {initials}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">{userName}</p>
              <p className="truncate text-[12px] text-white/50">{isDemo ? "Cuenta demo" : "Acceso con Google"}</p>
            </div>
            <form action="/auth/logout" className="ml-auto" method="post">
              <button
                aria-label="Cerrar sesión"
                className="grid size-9 place-items-center rounded bg-white/10 text-white/70 hover:bg-white/15 hover:text-white"
                type="submit"
              >
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <AsistenteFundoSmart context={{ activeSection, fieldName, isDemo, pathname }} />
    </div>
  );
}

/* El espacio activo decide dónde se escribe: un fundo, un animal o un costo caen
   en el espacio que esté seleccionado. Antes eso sólo se contestaba una vez, en
   la pantalla de selección al entrar, y adentro de la app no se veía en ninguna
   parte. Aquí queda a la vista en cada pantalla y se cambia sin salir del módulo.

   El cambio viaja como POST nativo al mismo endpoint que valida la membresía en
   el servidor: sin fetch ni `router.refresh`, la navegación completa vacía de
   paso el caché del router y no queda nada del espacio anterior en pantalla. */
function EspacioSwitcher({
  demoAccountHref,
  isDemo,
  onNavigate,
  organizationId,
  organizationName,
  personalAccountHref,
  returnTo,
  variant,
}: {
  demoAccountHref: string;
  isDemo: boolean;
  onNavigate?: () => void;
  organizationId?: string;
  organizationName: string;
  personalAccountHref: string;
  returnTo: string;
  variant: "header" | "menu";
}) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<AccessibleSpace[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  /* El listado se pide al abrir, no al render: el espacio activo ya llega con la
     página, así que ninguna pantalla paga esta consulta hasta que alguien la usa. */
  useEffect(() => {
    if (!open || spaces || unavailable) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/cuenta/organizacion", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          setUnavailable(true);
          return;
        }
        const payload = (await response.json()) as { organizations?: AccessibleSpace[] };
        setSpaces(payload.organizations ?? []);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
    })();
    return () => controller.abort();
  }, [open, spaces, unavailable]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const label = isDemo ? "Demo pública" : organizationName;
  const panel = (
    <div
      className={
        variant === "header"
          ? "absolute left-0 top-full z-[1002] mt-1 w-[20rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded border border-white/10 bg-chrome-2 shadow-2xl"
          : "mt-1 overflow-hidden rounded border border-white/10 bg-black/25"
      }
      role="menu"
    >
      <p className="px-3 pb-1 pt-2.5 text-[11px] font-black uppercase tracking-[0.14em] text-white/40">
        Espacios de trabajo
      </p>

      {!spaces && !unavailable && (
        <p className="flex items-center gap-2 px-3 py-3 text-xs text-white/50">
          <LoaderCircle aria-hidden className="animate-spin" size={14} /> Buscando tus espacios…
        </p>
      )}
      {unavailable && (
        <p className="px-3 py-3 text-xs leading-5 text-white/50">
          No pudimos leer tus espacios. Sigues trabajando en {label}.
        </p>
      )}

      {spaces?.map((space) => {
        /* El nombre es presentación y no es único: todos los espacios autoservicio
           nacen como «Mi FundoSmart». La identidad visual usa el mismo id sellado que
           gobierna el acceso para que sólo un tenant pueda aparecer como actual. */
        const active = !isDemo && space.id === organizationId;
        const Icon = space.kind === "personal" ? House : UsersRound;
        return (
          <form action="/api/cuenta/organizacion" key={space.id} method="post">
            <input name="organizationId" type="hidden" value={space.id} />
            <input name="returnTo" type="hidden" value={returnTo} />
            {/* El texto visible del botón es el nombre más su tipo y rol; leído de
                corrido no es un nombre accesible, así que la acción se declara. */}
            <button
              aria-current={active ? "true" : undefined}
              aria-label={`Entrar a ${space.name}`}
              className={`flex w-full items-start gap-3 px-3 py-2.5 text-left ${
                active ? "bg-white/[0.08]" : "hover:bg-white/[0.06]"
              }`}
              role="menuitem"
              type="submit"
            >
              <Icon className="mt-0.5 shrink-0 text-accent" size={16} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-bold text-white">
                  <span className="truncate">{space.name}</span>
                  {active && <Check aria-label="Espacio actual" className="shrink-0 text-accent" size={14} />}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-white/45">
                  {SPACE_KIND_LABELS[space.kind]} · {SPACE_ROLE_LABELS[space.role]}
                </span>
              </span>
            </button>
          </form>
        );
      })}

      <div className="border-t border-white/10">
        {isDemo ? (
          <a
            className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.06] hover:text-white"
            data-hint={HELP.shellMiCuenta}
            href={personalAccountHref}
            role="menuitem"
          >
            <UserRound className="shrink-0" size={16} /> Volver a Mi cuenta
          </a>
        ) : (
          <a
            aria-label="Abrir demo pública"
            className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.06] hover:text-white"
            data-hint={HELP.shellDemo}
            href={demoAccountHref}
            role="menuitem"
          >
            <Sparkles className="shrink-0" size={16} /> Demo pública
            <span className="ml-auto text-[12px] text-white/40">Solo lectura</span>
          </a>
        )}
        <Link
          className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/70 hover:bg-white/[0.06] hover:text-white"
          href={`/app/espacios?returnTo=${encodeURIComponent(returnTo)}`}
          onClick={() => {
            setOpen(false);
            onNavigate?.();
          }}
          role="menuitem"
        >
          <Settings className="shrink-0" size={16} /> Gestionar espacios
        </Link>
      </div>
    </div>
  );

  return (
    <div className={variant === "header" ? "relative shrink-0" : ""}>
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Espacio de trabajo: ${label}. Cambiar de espacio`}
        className={
          variant === "header"
            ? "flex items-center gap-2 rounded border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/10 sm:px-3"
            : "flex w-full items-center gap-2 rounded bg-white/[0.06] px-3 py-2.5 text-sm font-bold text-white"
        }
        data-hint={HELP.shellEspacio}
        data-hint-side="bottom"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {isDemo ? (
          <Sparkles className="shrink-0 text-accent" size={14} />
        ) : (
          <Building2 className="shrink-0 text-accent" size={14} />
        )}
        <span className={variant === "header" ? "max-w-[7rem] truncate sm:max-w-[11rem]" : "min-w-0 flex-1 truncate text-left"}>
          {label}
        </span>
        <ChevronDown className={`shrink-0 transition ${open ? "rotate-180" : ""}`} size={14} />
      </button>
      {open && variant === "header" && (
        <button
          aria-label="Cerrar selector de espacio"
          className="fixed inset-0 z-[1001] cursor-default"
          onClick={() => setOpen(false)}
          type="button"
        />
      )}
      {open && panel}
    </div>
  );
}

/* Cada módulo resuelve en el servidor, así que entre el clic y el primer píxel
   nuevo pasan cientos de milisegundos —segundos en terreno, con la latencia del
   celular en el campo—. Sin acuse de recibo el gesto parece perdido y la gente
   vuelve a tocar. `useLinkStatus` marca el destino en el instante del clic:
   el ícono pasa a girar y el ítem se pinta como si ya estuviera abierto. */
function NavIcon({
  icon: Icon,
  size,
  strokeWidth,
}: {
  icon: LucideIcon;
  size: number;
  strokeWidth: number;
}) {
  const { pending } = useLinkStatus();
  return pending ? (
    <LoaderCircle aria-hidden className="animate-spin" size={size} strokeWidth={2.4} />
  ) : (
    <Icon size={size} strokeWidth={strokeWidth} />
  );
}

/* El resalte vive dentro del <Link> porque `useLinkStatus` sólo lee el estado de
   su propio enlace; una capa absoluta evita tocar las clases del ítem activo. */
function NavPendingWash({ className }: { className: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <span aria-hidden className={`pointer-events-none absolute inset-0 ${className}`} />;
}

function TopNavLink({ item, active }: { item: NavItem; active: boolean }) {
  const intentPrefetch = useIntentPrefetch();
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-[0.06em] ${
        active ? "bg-accent text-white" : "text-white/60 hover:bg-white/[0.05] hover:text-white"
      }`}
      data-hint={HELP[item.help]}
      data-hint-side="bottom"
      href={item.href}
      {...intentPrefetch(item.href)}
    >
      <NavPendingWash className="bg-accent/70" />
      <span className="relative flex items-center gap-2">
        <NavIcon icon={item.icon} size={16} strokeWidth={active ? 2.4 : 1.8} /> {item.label}
      </span>
    </Link>
  );
}

function productPath(pathname: string): string {
  if (pathname === "/app" || pathname.startsWith("/app/")) return pathname;
  if (pathname === "/dashboard") return "/app";
  if (
    ["/potreros", "/ganado", "/leche", "/costos", "/importaciones", "/integraciones", "/configuracion"].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return `/app${pathname}`;
  }
  return "/app";
}

/* Las raíces válidas en cualquier espacio: los módulos de la navegación y la
   configuración, que existe igual en todos. Todo lo demás vuelve al resumen. */
const MODULE_ROOTS = [...NAV.map((item) => item.href), "/app/configuracion/accesos"];
const MODULE_ROOT_ALIASES: ReadonlyArray<{ path: string; root: string }> = [
  { path: "/app/integraciones/cooprinsem", root: "/app/importaciones" },
];

function moduleRootPath(path: string): string {
  const pathname = path.split("?")[0] ?? path;
  const alias = MODULE_ROOT_ALIASES.find(({ path: candidate }) =>
    pathname === candidate || pathname.startsWith(`${candidate}/`));
  if (alias) return alias.root;
  const matches = MODULE_ROOTS.filter((root) => pathname === root || pathname.startsWith(`${root}/`));
  return matches.sort((left, right) => right.length - left.length)[0] ?? "/app";
}

function getInitials(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "FS";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
