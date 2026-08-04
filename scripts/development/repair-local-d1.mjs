/* Repara la base D1 **local** cuando su esquema y su registro `d1_migrations`
 * se desfasan, conservando los datos de desarrollo.
 *
 * Síntoma: `npm run db:migrate:local` aborta con «table X already exists» y,
 * como `predev` falla, `npm run dev` no arranca. Ocurre cuando algún objeto se
 * creó fuera del registro de migraciones, así que wrangler intenta recrearlo.
 *
 * Aquí cada migración pendiente se ejecuta sentencia por sentencia dentro de su
 * propia transacción, tolerando solo los errores de objeto ya presente. Cualquier
 * otro error revierte esa migración y detiene el proceso: es preferible fallar
 * ruidosamente a dejar un esquema a medias.
 *
 *   node scripts/development/repair-local-d1.mjs            # pasada en seco
 *   node scripts/development/repair-local-d1.mjs --aplicar  # escribe de verdad
 *
 * Detén el servidor de desarrollo antes de usar --aplicar: miniflare mantiene la
 * base abierta en modo WAL.
 *
 * Nunca toca producción. Solo abre el archivo SQLite de `.wrangler/state`.
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const RAIZ_ESTADO = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const DIRECTORIO_MIGRACIONES = "drizzle";
const TOLERABLES = [/already exists/i, /duplicate column name/i];

/* Miniflare deja varios .sqlite en la carpeta (uno por base que haya existido).
   La vigente es la mayor: las demás son restos de configuraciones anteriores. */
function ubicarBaseActiva() {
  if (!existsSync(RAIZ_ESTADO)) {
    throw new Error(`No existe ${RAIZ_ESTADO}. Ejecuta el servidor de desarrollo al menos una vez.`);
  }
  const candidatos = readdirSync(RAIZ_ESTADO)
    .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
    .map((f) => ({ archivo: path.join(RAIZ_ESTADO, f), tamano: statSync(path.join(RAIZ_ESTADO, f)).size }))
    .sort((a, b) => b.tamano - a.tamano);
  if (candidatos.length === 0) throw new Error(`No se encontró ninguna base D1 en ${RAIZ_ESTADO}.`);
  return candidatos[0].archivo;
}

function respaldar(rutaBase) {
  const destino = path.join(".wrangler", "respaldos-d1", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(destino, { recursive: true });
  for (const sufijo of ["", "-wal", "-shm"]) {
    const origen = `${rutaBase}${sufijo}`;
    if (existsSync(origen)) cpSync(origen, path.join(destino, path.basename(origen)));
  }
  return destino;
}

const aplicar = process.argv.includes("--aplicar");
const rutaBase = ubicarBaseActiva();
const rutaTrabajo = aplicar ? rutaBase : `${rutaBase}.ensayo`;

if (aplicar) {
  console.log(`respaldo en ${respaldar(rutaBase)}`);
} else {
  copyFileSync(rutaBase, rutaTrabajo);
}

const db = new DatabaseSync(rutaTrabajo);
const registradas = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((fila) => fila.name));
const pendientes = readdirSync(DIRECTORIO_MIGRACIONES)
  .filter((archivo) => archivo.endsWith(".sql"))
  .sort()
  .filter((archivo) => !registradas.has(archivo));

console.log(`base: ${rutaBase}`);
console.log(`registradas: ${registradas.size} · pendientes: ${pendientes.length}\n`);

let abortada = null;
let procesadas = 0;

for (const archivo of pendientes) {
  const sentencias = readFileSync(path.join(DIRECTORIO_MIGRACIONES, archivo), "utf8")
    .split("--> statement-breakpoint")
    .map((sentencia) => sentencia.trim())
    .filter(Boolean);
  let aplicadas = 0;
  let omitidas = 0;
  db.exec("BEGIN");
  try {
    for (const sentencia of sentencias) {
      try {
        db.exec(sentencia);
        aplicadas += 1;
      } catch (causa) {
        if (!TOLERABLES.some((patron) => patron.test(causa.message))) throw causa;
        omitidas += 1;
      }
    }
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)").run(archivo);
    db.exec("COMMIT");
    procesadas += 1;
    console.log(`${archivo}: ${aplicadas} aplicadas, ${omitidas} ya presentes`);
  } catch (causa) {
    db.exec("ROLLBACK");
    abortada = { archivo, mensaje: causa.message };
    break;
  }
}

db.close();
if (!aplicar) rmSync(rutaTrabajo, { force: true });

console.log(`\nprocesadas: ${procesadas}/${pendientes.length}`);
if (abortada) {
  console.log(`ABORTADA en ${abortada.archivo}: ${abortada.mensaje}`);
  console.log("Nada quedó a medias: esa migración se revirtió por completo.");
  process.exitCode = 1;
} else if (aplicar) {
  console.log("Reparación aplicada. Confirma con: npm run db:migrations:local");
} else {
  console.log("Ensayo correcto, no se escribió nada. Repite con --aplicar.");
}
