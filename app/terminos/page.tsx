import Link from "next/link";
import { ArrowLeft, CheckCircle2, Scale } from "lucide-react";

export const metadata = {
  title: "Términos de Servicio · FundoSmart",
  description: "Términos y condiciones de uso de la plataforma agrícola FundoSmart.",
};

export default function TerminosPage() {
  return (
    <main className="min-h-screen bg-surface-alt py-12 px-4 sm:px-6 lg:px-8 font-sans text-ink">
      <div className="mx-auto max-w-4xl">
        <Link
          className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wider text-accent hover:underline mb-6"
          href="/"
        >
          <ArrowLeft size={14} /> Volver a FundoSmart
        </Link>

        <div className="rounded-3xl border border-line-steel bg-white p-8 shadow-sm sm:p-12">
          <div className="flex items-center gap-3 text-accent mb-3">
            <Scale size={28} />
            <span className="text-xs font-black uppercase tracking-widest">Contrato de Servicio</span>
          </div>

          <h1 className="text-3xl font-black tracking-tight sm:text-4xl text-ink">
            Términos de Servicio
          </h1>
          <p className="mt-2 text-xs font-bold text-ink-subtle">
            Última actualización: 29 de julio de 2026 · Versión 1.2
          </p>

          <div className="mt-8 space-y-8 text-sm leading-relaxed text-ink-muted">
            <section className="rounded-2xl bg-surface-alt p-6 border border-line-steel">
              <h2 className="text-base font-black text-ink flex items-center gap-2">
                <CheckCircle2 size={18} className="text-accent" /> Resumen para el Productor
              </h2>
              <p className="mt-2">
                FundoSmart provee herramientas de software para la gestión
                lechera y agrícola. Tu organización mantiene el control de sus
                datos operacionales. Las descargas y la suspensión reversible
                están sujetas a las capacidades descritas en la sección 5.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">1. Aceptación del Servicio</h2>
              <p className="mt-2">
                Para acceder a superficies privadas debes confirmar
                expresamente la versión vigente de estos Términos y de la
                Política de Privacidad. FundoSmart registra la versión, fecha,
                SHA-256 del contenido, identidad, solicitud y evidencia técnica
                de esa aceptación. Todo cambio de contenido se publica como una
                nueva versión con su propia huella; debes aceptar esa nueva
                versión antes de recuperar el acceso privado.
              </p>
              <p className="mt-2">
                Si utilizas la plataforma en representación de un fundo u
                organización ganadera, declaras contar con las facultades
                necesarias para vincular a dicha entidad. La aceptación de la
                Política de Privacidad acredita el documento presentado, pero
                no constituye consentimiento general para todo tratamiento ni
                reemplaza autorizaciones específicas.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">2. Planes y Límites de Uso</h2>
              <p className="mt-2">
                FundoSmart ofrece un Plan Gratis de autoservicio (con límite de 2 fundos y 200 potreros) y Planes Pro con capacidades extendidas. Los recursos de cómputo, almacenamiento y mapas se rigen por las cuotas establecidas para cada plan.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">3. Responsabilidad sobre la Información</h2>
              <p className="mt-2">
                El usuario es responsable de la exactitud de los datos ingresados o cargados mediante importación (archivos de control lechero, suelos o guías). Las recomendaciones agronómicas expuestas son herramientas de apoyo operacional y no sustituyen el criterio técnico profesional en terreno.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">4. Disponibilidad y Seguridad</h2>
              <p className="mt-2">
                Mantenemos altos estándares de disponibilidad y seguridad mediante infraestructura en Cloudflare. Nos reservamos el derecho de realizar mantenimientos programados informados previamente a los usuarios.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">
                5. Portabilidad, suspensión y conservación
              </h2>
              <p className="mt-2">
                Las personas con permiso para gestionar importaciones pueden
                descargar respaldos JSON por fundo o importación, con un
                manifiesto de inclusiones y exclusiones. Estos respaldos no
                equivalen a una exportación completa del espacio.
              </p>
              <p className="mt-2">
                Owner y administrador activos de un espacio no demo también
                pueden descargar un portable workspace v2 con 33 secciones D1,
                allowlists, alcance, conteos, exclusiones y SHA-256. No incluye
                archivos R2, todas las categorías personales ni tablas X2/X3;
                las huellas no son una firma autenticada.
              </p>
              <p className="mt-2">
                La cuenta o el espacio pueden suspenderse de forma reversible
                durante una gracia de 30 días. La cuenta revoca sus propias
                sesiones; el espacio conserva las sesiones de sus miembros para
                no cortar otros espacios. Al vencer la gracia, el acceso sigue
                suspendido y los datos permanecen retenidos. No se elimina,
                anonimiza ni purga información y no existe cierre final
                automático. El canal adicional para consultas se encuentra en
                la{" "}
                <Link
                  className="font-bold text-accent underline underline-offset-4 hover:text-accent-hover"
                  href="/privacidad"
                >
                  Política de Privacidad
                </Link>
                .
              </p>
            </section>
          </div>

          <div className="mt-12 pt-6 border-t border-line-steel flex flex-wrap items-center justify-between text-xs text-ink-subtle">
            <p>© 2026 FundoSmart. Todos los derechos reservados.</p>
            <div className="flex items-center gap-4">
              <Link className="hover:text-accent font-bold" href="/privacidad">
                Política de Privacidad
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
