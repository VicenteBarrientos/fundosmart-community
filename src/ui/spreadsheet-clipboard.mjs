/**
 * Traducción entre el portapapeles y una matriz de celdas.
 *
 * Excel separa columnas con tabulación y filas con salto de línea, y encierra entre
 * comillas dobles la celda que contiene cualquiera de los dos. Respetar eso es lo que
 * permite pegar un bloque de una planilla real sin que una celda con notas parta la
 * tabla en pedazos.
 */

export function parseClipboardMatrix(text) {
  const source = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (source === "") return [];

  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character !== '"') { cell += character; continue; }
      if (source[index + 1] === '"') { cell += '"'; index += 1; continue; }
      quoted = false;
      continue;
    }
    if (character === '"' && cell === "") { quoted = true; continue; }
    if (character === "\t") { row.push(cell); cell = ""; continue; }
    if (character === "\n") { row.push(cell); matrix.push(row); row = []; cell = ""; continue; }
    cell += character;
  }
  row.push(cell);
  matrix.push(row);

  // Excel cierra el bloque con un salto de línea: esa última fila vacía no es un dato.
  if (matrix.length > 1 && matrix[matrix.length - 1].every((value) => value === "")) matrix.pop();
  return matrix;
}

export function serializeClipboardMatrix(matrix) {
  return matrix
    .map((row) => row
      .map((cell) => (/[\t\n"]/.test(cell) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell)))
      .join("\t"))
    .join("\n");
}
