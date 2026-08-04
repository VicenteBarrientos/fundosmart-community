import Link from "next/link";
import { RouteFallback } from "@/src/core/layout/RouteFallback";

type AccessDeniedCode =
  | "ACCOUNT_CLOSURE_ACTIVE"
  | "MEMBERSHIP_REQUIRED"
  | "MEMBERSHIP_SUSPENDED"
  | "MEMBERSHIP_AMBIGUOUS"
  | "CAPABILITY_REQUIRED"
  | "FIELD_REQUIRED";

const ACCESS_DENIED_COPY: Record<AccessDeniedCode, { description: string; returnToProduct: boolean; title: string }> = {
  ACCOUNT_CLOSURE_ACTIVE: {
    description:
      "Tu cuenta tiene una solicitud de cierre vigente y el acceso normal permanece suspendido. Revisa su estado y las acciones disponibles desde Cuenta y datos.",
    returnToProduct: false,
    title: "Tu cuenta tiene una solicitud de cierre vigente.",
  },
  MEMBERSHIP_REQUIRED: {
    description:
      "Tu identidad fue reconocida, pero aún no tiene una membresía activa. Pide a un propietario o administrador que te incorpore a la organización.",
    returnToProduct: false,
    title: "Tu cuenta todavía no tiene acceso activo.",
  },
  MEMBERSHIP_SUSPENDED: {
    description:
      "Tu membresía existe, pero está suspendida. Pide a un propietario o administrador que revise su estado antes de intentar ingresar nuevamente.",
    returnToProduct: false,
    title: "Tu membresía está suspendida.",
  },
  MEMBERSHIP_AMBIGUOUS: {
    description:
      "Tu identidad está vinculada a más de una organización. La selección automática está bloqueada para evitar mostrar datos de la organización equivocada; pide a un propietario que deje una sola membresía activa mientras habilitamos el selector de organización.",
    returnToProduct: false,
    title: "Selecciona una organización antes de continuar.",
  },
  CAPABILITY_REQUIRED: {
    description:
      "Tu cuenta está activa, pero tu rol no permite abrir esta función. Puedes volver al inicio del sistema y continuar con las áreas habilitadas.",
    returnToProduct: true,
    title: "Esta función no está habilitada para tu rol.",
  },
  FIELD_REQUIRED: {
    description:
      "Tu cuenta está activa, pero el fundo solicitado no forma parte de tus asignaciones. Vuelve al sistema para elegir uno de los predios disponibles.",
    returnToProduct: true,
    title: "Este fundo no está asignado a tu cuenta.",
  },
};

function deniedCode(value: string | string[] | undefined): AccessDeniedCode {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && candidate in ACCESS_DENIED_COPY ? (candidate as AccessDeniedCode) : "MEMBERSHIP_REQUIRED";
}

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const code = deniedCode((await searchParams).code);
  const copy = ACCESS_DENIED_COPY[code];
  const primaryHref = copy.returnToProduct ? "/app" : "/demo?returnTo=%2Fapp";
  const primaryLabel = copy.returnToProduct ? "Volver al sistema" : "Probar cuenta demo";

  return (
    <RouteFallback
      actions={
        <>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground transition hover:-translate-y-0.5 hover:shadow-md"
            href={primaryHref}
          >
            {primaryLabel}
          </Link>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-6 py-3 text-sm font-semibold text-primary transition hover:bg-secondary"
            href="/"
          >
            Volver a la portada
          </Link>
          {code === "MEMBERSHIP_SUSPENDED" || code === "ACCOUNT_CLOSURE_ACTIVE" ? (
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-6 py-3 text-sm font-semibold text-primary transition hover:bg-secondary"
              href="/app/cuenta/datos"
            >
              Revisar estado del cierre
            </Link>
          ) : null}
        </>
      }
      description={copy.description}
      eyebrow="Acceso protegido"
      title={copy.title}
    />
  );
}
