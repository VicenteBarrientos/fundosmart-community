import Link from "next/link";
import { ArrowLeft, ShieldCheck, Lock } from "lucide-react";

export const metadata = {
  title: "Política de Privacidad · FundoSmart",
  description: "Política de privacidad, transparencia de datos almacenados y derechos del usuario en FundoSmart.",
};

export default function PrivacidadPage() {
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
            <ShieldCheck size={28} />
            <span className="text-xs font-black uppercase tracking-widest">Protección de Datos</span>
          </div>

          <h1 className="text-3xl font-black tracking-tight sm:text-4xl text-ink">
            Política de Privacidad
          </h1>
          <p className="mt-2 text-xs font-bold text-ink-subtle">
            Última actualización: 29 de julio de 2026 · Versión 1.2
          </p>

          <div className="mt-8 space-y-8 text-sm leading-relaxed text-ink-muted">
            <section className="rounded-2xl bg-surface-alt p-6 border border-line-steel">
              <h2 className="text-base font-black text-ink flex items-center gap-2">
                <Lock size={18} className="text-accent" /> Principios Fundamentales
              </h2>
              <p className="mt-2">
                FundoSmart no vende ni comercializa tus datos agrícolas,
                pecuarios, personales u operacionales. Para prestar las
                funciones actuales, esos datos sí pueden ser procesados por
                FundoSmart y por los proveedores descritos en la sección 3,
                cuando corresponde a la función utilizada.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">1. Datos que recopilamos</h2>
              <p className="mt-2">
                Las funciones actuales tratan, entre otras, las siguientes
                categorías de información:
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>
                  <strong>Identidad y cuenta:</strong> correo verificado,
                  identificador estable del proveedor de ingreso e
                  identificadores internos de cuenta y sesión.
                </li>
                <li><strong>Datos Agrícolas y Ganaderos:</strong> Delimitación de fundos/potreros, existencias animales, eventos reproductivos y de salud mamaria.</li>
                <li><strong>Registros de Producción:</strong> Entregas de leche, análisis de calidad (RCS, grasa, proteína) e importaciones de control lechero.</li>
                <li>
                  <strong>Finanzas y cumplimiento:</strong> aportes, egresos,
                  costos, liquidaciones, establecimientos, movimientos y
                  evidencia regulatoria cuando se utilizan esos módulos.
                </li>
                <li>
                  <strong>Archivos y evidencia:</strong> originales de
                  importación, fotografías y documentos privados cuando se
                  utilizan esas funciones.
                </li>
                <li>
                  <strong>Personas y contrapartes operacionales:</strong> nombre,
                  correo, RUT, dirección y patentes que la organización ingresa
                  para socios, titulares, transportistas o trazabilidad.
                </li>
                <li>
                  <strong>Feedback y soporte:</strong> nombre y correo de quien
                  reporta, mensaje libre, ruta, versión, user agent, tamaño del
                  viewport y estado de conexión.
                </li>
                <li>
                  <strong>Captura offline en el dispositivo:</strong> IndexedDB
                  conserva localmente la cola de mutaciones, modelos de lectura,
                  cursores, una sesión offline acotada y adjuntos pendientes.
                </li>
                <li>
                  <strong>Actividad técnica:</strong> métricas de operación y
                  uso necesarias para seguridad, diagnóstico y rendimiento,
                  minimizadas según cada flujo.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">2. Finalidad del tratamiento</h2>
              <p className="mt-2">
                La información se utiliza para:
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>Generar la agenda diaria operacional y alertas del fundo.</li>
                <li>Calcular indicadores de producción, salud animal y costos.</li>
                <li>Permitir la importación y conciliación de archivos técnicos de control lechero y suelo.</li>
                <li>
                  Autenticar cuentas, aplicar permisos, proteger el servicio,
                  auditar cambios y responder consultas de soporte.
                </li>
                <li>
                  Enviar recordatorios operacionales cuando una organización
                  habilita esa función.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">
                3. Proveedores y servicios
              </h2>
              <p className="mt-2">
                Las funciones vigentes utilizan los siguientes servicios, de
                forma permanente o solo cuando se activa la función indicada:
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-2">
                <li>
                  <strong>Cloudflare:</strong> Workers ejecuta la aplicación;
                  D1 conserva datos de cuenta y operación; R2 conserva archivos
                  privados cuando se usan cargas o evidencia. Cloudflare
                  también recibe telemetría técnica y, si se habilitan alertas,
                  la dirección destinataria y el contenido del recordatorio.
                </li>
                <li>
                  <strong>Google OpenID Connect:</strong> el ingreso personal
                  solicita el alcance <code>openid email</code>. FundoSmart
                  conserva el identificador estable de Google y el correo
                  verificado, pero no guarda access ni refresh tokens.
                </li>
                <li>
                  <strong>OpenStreetMap Standard y Esri ArcGIS:</strong> cuando
                  una de estas capas está activa, el navegador les solicita
                  directamente las teselas. Los servicios reciben los
                  metadatos de red de la solicitud y los índices de tesela que
                  representan el área visible. Satélite, Topográfico y Relieve
                  usan Esri; estas capas en línea no se incorporan a descargas
                  offline ni a exportaciones impresas.
                </li>
                <li>
                  <strong>Copernicus Data Space Ecosystem (CDSE):</strong> al
                  ejecutar una actualización NDVI, FundoSmart envía la
                  geometría del potrero y el intervalo consultado para obtener
                  estadísticas Sentinel-2.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">4. Conservación</h2>
              <p className="mt-2">
                No aplicamos un plazo único a todos los datos. Determinados
                datos de identidad y operación vigente se conservan mientras
                la cuenta u organización permanece activa. La historia
                necesaria para trazabilidad permanece ligada al fundo o a su
                fuente sin expiración automática.
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                <li>
                  Los originales de importación se conservan actualmente por
                  tiempo indefinido bajo una política de solo conservación.
                </li>
                <li>
                  Los calendarios específicos para información financiera,
                  regulatoria y de soporte siguen pendientes de definición; la
                  antigüedad por sí sola no activa un borrado.
                </li>
                <li>
                  Las sesiones tienen vigencia de 30 días y los intentos de
                  ingreso OIDC de 10 minutos; su limpieza ocurre durante
                  operaciones posteriores.
                </li>
              </ul>
              <p className="mt-2">
                Los párrafos anteriores describen los registros persistidos en
                los servidores de FundoSmart y no fijan plazos propios de
                Google, Cloudflare, OpenStreetMap, Esri o CDSE.
              </p>
              <p className="mt-2">
                Cuando se usa la captura offline, el navegador mantiene además
                una copia local en IndexedDB. Cerrar sesión no elimina de forma
                global esos datos locales y hoy no existe un TTL general para
                esa base. Tras una carga exitosa se retira el archivo binario de
                la foto, pero permanecen sus metadatos. En un dispositivo
                compartido, la copia se elimina manualmente desde los datos del
                sitio de FundoSmart en el navegador.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">
                5. Respaldos, portabilidad y cierre
              </h2>
              <p className="mt-2">
                Las personas autorizadas para gestionar importaciones pueden
                descargar respaldos JSON por fundo o importación, acompañados
                por un manifiesto de inclusiones y exclusiones. Estos respaldos
                no equivalen a una exportación completa del espacio. El formato
                portable v1 permanece disponible.
              </p>
              <p className="mt-2">
                Además, cada owner o administrador activo de un espacio no demo
                puede descargar su exportación portable workspace v2. Incluye
                33 secciones D1 mediante allowlists de columnas, el alcance
                exacto de organización y fundos, versión de política, omisiones
                declaradas, conteos y SHA-256 por sección y del contenido lógico
                completo. No incluye archivos R2 ni todas las categorías de
                datos personales o tablas clasificadas X2/X3. Sus SHA-256
                permiten comprobar integridad interna, pero no son una firma ni
                acreditan autoría frente a terceros.
              </p>
              <p className="mt-2">
                Una solicitud de cierre de cuenta suspende de inmediato sus
                membresías y revoca únicamente las sesiones de esa cuenta. Una
                solicitud de cierre de espacio suspende sus membresías, pero
                conserva las sesiones porque esas personas pueden usar otros
                espacios. En ambos casos existe una gracia de 30 días para que
                quien inició la solicitud la revoque. Si el plazo vence, el
                acceso permanece suspendido y los datos siguen retenidos: esta
                función no elimina, anonimiza ni purga datos y no ejecuta un
                cierre final automático.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">
                6. Aceptación y evidencia
              </h2>
              <p className="mt-2">
                Antes de acceder a superficies privadas, la persona autenticada
                debe aceptar expresamente la versión vigente de esta política y
                de los Términos. FundoSmart registra por documento la versión,
                fecha de publicación, SHA-256 del contenido exacto, fecha de
                aceptación, identidad, identificador de solicitud y, cuando
                está disponible, el SHA-256 del user agent. Los recibos pueden
                descargarse en JSON desde Cuenta y datos.
              </p>
              <p className="mt-2">
                Esta evidencia acredita la aceptación de los documentos
                publicados; no constituye un consentimiento general para todo
                tratamiento ni sustituye las autorizaciones específicas que
                una función pueda requerir. Todo cambio de contenido se publica
                como una nueva versión con su propia huella, y el acceso privado
                vuelve a exigir su aceptación expresa.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-black text-ink">7. Contacto y solicitudes</h2>
              <p className="mt-2">
                Para consultas o solicitudes relacionadas con acceso,
                rectificación, exportación o eliminación, escribe a{" "}
                <a
                  className="font-bold text-accent underline underline-offset-4 hover:text-accent-hover"
                  href="mailto:soporte@fundosmart.com?subject=Solicitud%20de%20privacidad%20FundoSmart"
                >
                  soporte@fundosmart.com
                </a>
                .
              </p>
              <p className="mt-2">
                Este correo es un canal de contacto: no activa automáticamente
                una exportación, una suspensión, una revocación ni un borrado.
              </p>
            </section>
          </div>

          <div className="mt-12 pt-6 border-t border-line-steel flex flex-wrap items-center justify-between text-xs text-ink-subtle">
            <p>© 2026 FundoSmart. Todos los derechos reservados.</p>
            <div className="flex items-center gap-4">
              <Link className="hover:text-accent font-bold" href="/terminos">
                Términos de Servicio
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
