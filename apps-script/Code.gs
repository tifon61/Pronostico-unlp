// ============================================================
// APPS SCRIPT - PRONÓSTICO UNLP (CON METADATA, VIGENCIA, ANTELACIÓN
// Y HOJA DE VERIFICACIÓN POR PLAZO)
// ============================================================

function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}

const BASE_HEADERS = [
  // Metadata (6 columnas)
  "forecast_date","city","emission_time","timestamp_guardado","publicado_por","es_correccion",

  // DÍA 1 (24 columnas)
  "d1_fecha","d1_dia","d1_min","d1_max","d1_min_sub","d1_max_sub",
  "d1_p1_cielo","d1_p1_pop","d1_p1_temp","d1_p1_viento","d1_p1_dir","d1_p1_rafagas",
  "d1_p2_cielo","d1_p2_pop","d1_p2_temp","d1_p2_viento","d1_p2_dir","d1_p2_rafagas",
  "d1_p3_cielo","d1_p3_pop","d1_p3_temp","d1_p3_viento","d1_p3_dir","d1_p3_rafagas",

  // DÍA 2 (30 columnas)
  "d2_fecha","d2_dia","d2_min","d2_max","d2_min_sub","d2_max_sub",
  "d2_p1_cielo","d2_p1_pop","d2_p1_temp","d2_p1_viento","d2_p1_dir","d2_p1_rafagas",
  "d2_p2_cielo","d2_p2_pop","d2_p2_temp","d2_p2_viento","d2_p2_dir","d2_p2_rafagas",
  "d2_p3_cielo","d2_p3_pop","d2_p3_temp","d2_p3_viento","d2_p3_dir","d2_p3_rafagas",
  "d2_p4_cielo","d2_p4_pop","d2_p4_temp","d2_p4_viento","d2_p4_dir","d2_p4_rafagas",

  // DÍA 3 (16 columnas)
  "d3_fecha","d3_dia","d3_min","d3_max","d3_min_sub","d3_max_sub",
  "d3_p1_cielo","d3_p1_pop","d3_p1_viento","d3_p1_dir","d3_p1_rafagas",
  "d3_p2_cielo","d3_p2_pop","d3_p2_viento","d3_p2_dir","d3_p2_rafagas",

  // DÍA 4 (16 columnas)
  "d4_fecha","d4_dia","d4_min","d4_max","d4_min_sub","d4_max_sub",
  "d4_p1_cielo","d4_p1_pop","d4_p1_viento","d4_p1_dir","d4_p1_rafagas",
  "d4_p2_cielo","d4_p2_pop","d4_p2_viento","d4_p2_dir","d4_p2_rafagas",

  // Payload crudo (1 columna)
  "json_completo"
];

// Columnas nuevas que se agregan AL FINAL, sin mover ninguna columna
// de datos existente.
const EXTRA_HEADERS = [
  "emision_real_date", "vigente", "reemplazada_en",
  "d1_lead", "d2_lead", "d3_lead", "d4_lead"
];

const ALL_HEADERS = BASE_HEADERS.concat(EXTRA_HEADERS);

// Hoja de verificación: una fila por (ciudad, fecha_pronostico, plazo),
// con las mismas variables que se venían llevando a mano en Excel por
// plazo de antelación (d+1/d+2/d+3), consolidadas acá en una sola hoja.
// "es_correccion" se agregó al final (no en el medio) por la misma razón
// que EXTRA_HEADERS: para no correr los datos de las filas ya cargadas.
const VERIF_HEADERS = [
  "ciudad", "pronosticador", "fecha_emision", "fecha_pronostico", "plazo",
  "tmin_urb", "tmax_urb", "tmin_sub", "tmax_sub",
  "precip", "precip_tipo", "v_dir", "v_int", "niebla", "tormenta", "min_noc",
  "comentarios", "vigente", "reemplazada_en",
  "es_correccion"
];

// Novedades del grupo (talleres, charlas, etc.) para la sección de
// divulgación de la página pública (reemplaza la sección de WordPress de
// la facultad): cubre las secciones que existen en el HTML -- Informes
// Especiales, Extensión Universitaria, Divulgación en Redes y Agenda --
// distinguidas por "tipo". Cualquiera del equipo las publica/edita/borra
// desde novedades-admin.html.
const NOVEDADES_HEADERS = [
  "id", "tipo", "titulo", "texto", "tag", "link_url", "link_label",
  "fecha", "imagen_url", "imagen_file_id", "publicado_por", "timestamp"
];

function getNovedadesSheet(ss) {
  let sheet = ss.getSheetByName("Novedades");
  if (!sheet) sheet = ss.insertSheet("Novedades");
  ensureHeadersFor(sheet, NOVEDADES_HEADERS);
  return sheet;
}

// Carpeta de Drive del equipo donde se guardan las imágenes de Novedades.
// Es la carpeta compartida del grupo (no una creada por el script), para
// que el equipo pueda ver y ordenar las fotos directamente desde su Drive.
// Se puede cambiar sin tocar código: Configuración del proyecto >
// Propiedades del script > NOVEDADES_FOLDER_ID.
const DEFAULT_NOVEDADES_FOLDER_ID = '1NHAEuebbqAgLZZV5hHQgn5f6D6l6hX2G';

function getNovedadesFolder() {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty('NOVEDADES_FOLDER_ID') || DEFAULT_NOVEDADES_FOLDER_ID;
  try {
    return DriveApp.getFolderById(folderId);
  } catch (e) {
    // La carpeta configurada no existe o el script no tiene acceso: se crea
    // una de respaldo para no perder la imagen, y se recuerda para no
    // repetir la falla en cada publicación.
    const folder = DriveApp.createFolder('Novedades - Pronóstico UNLP');
    props.setProperty('NOVEDADES_FOLDER_ID', folder.getId());
    return folder;
  }
}

function saveNovedadImage(base64Data, mimeType, fileName) {
  const folder = getNovedadesFolder();
  const bytes = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(bytes, mimeType || 'image/jpeg', fileName || 'novedad.jpg');
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // La carpeta del equipo puede tener restringido compartir "con
    // cualquiera que tenga el link" (típico en Drives compartidos de
    // organización). Si esto falla, mejor publicar la novedad igual
    // (sin la imagen pública) que perderla en silencio: antes, esta
    // excepción cortaba todo handleNovedadAction antes del appendRow,
    // y como el POST usa no-cors, el panel mostraba "publicado" aunque
    // nunca se hubiera guardado nada.
    Logger.log('No se pudo compartir el archivo ' + file.getId() + ': ' + e.toString());
  }
  return { url: `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w2000`, fileId: file.getId() };
}

function getNovedadesList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getNovedadesSheet(ss);
  const headers = NOVEDADES_HEADERS;
  const rows = sheet.getDataRange().getValues().slice(1);
  const items = rows
    .filter(r => r[headers.indexOf('id')])
    .map(r => ({
      id: r[headers.indexOf('id')],
      tipo: r[headers.indexOf('tipo')],
      titulo: r[headers.indexOf('titulo')],
      texto: r[headers.indexOf('texto')],
      tag: r[headers.indexOf('tag')],
      link_url: r[headers.indexOf('link_url')],
      link_label: r[headers.indexOf('link_label')],
      fecha: r[headers.indexOf('fecha')],
      imagen_url: r[headers.indexOf('imagen_url')],
      publicado_por: r[headers.indexOf('publicado_por')],
      timestamp: r[headers.indexOf('timestamp')]
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // más reciente primero
  return { items: items };
}

// Crear/editar/borrar novedades. Se llama desde doPost cuando data.action
// es una de estas tres acciones (si no, doPost sigue con la publicación
// normal de pronóstico, sin tocar nada de esto).
function handleNovedadAction(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getNovedadesSheet(ss);
  const headers = NOVEDADES_HEADERS;
  const colId = headers.indexOf('id');

  // Campos de texto simples que se guardan tal cual (la imagen se maneja aparte).
  const TEXT_FIELDS = ['tipo', 'titulo', 'texto', 'tag', 'link_url', 'link_label', 'fecha'];

  if (data.action === 'crear_novedad') {
    let imagenUrl = '', imagenFileId = '';
    if (data.imagen_base64) {
      const img = saveNovedadImage(data.imagen_base64, data.imagen_mime, data.imagen_nombre);
      imagenUrl = img.url; imagenFileId = img.fileId;
    }
    const id = Utilities.getUuid();
    const fila = headers.map(h => {
      if (h === 'id') return id;
      if (h === 'imagen_url') return imagenUrl;
      if (h === 'imagen_file_id') return imagenFileId;
      if (h === 'publicado_por') return data.publicado_por || '';
      if (h === 'timestamp') return new Date().toISOString();
      return data[h] || '';
    });
    sheet.appendRow(fila);
    return { status: 'ok', id: id };
  }

  if (data.action === 'editar_novedad' || data.action === 'borrar_novedad') {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][colId] !== data.id) continue;
      const rowNum = i + 1;

      if (data.action === 'borrar_novedad') {
        const oldFileId = rows[i][headers.indexOf('imagen_file_id')];
        if (oldFileId) { try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) {} }
        sheet.deleteRow(rowNum);
        return { status: 'ok' };
      }

      // editar_novedad
      TEXT_FIELDS.forEach(f => {
        if (data[f] !== undefined) sheet.getRange(rowNum, headers.indexOf(f) + 1).setValue(data[f]);
      });
      if (data.imagen_base64) {
        const oldFileId = rows[i][headers.indexOf('imagen_file_id')];
        if (oldFileId) { try { DriveApp.getFileById(oldFileId).setTrashed(true); } catch (e) {} }
        const img = saveNovedadImage(data.imagen_base64, data.imagen_mime, data.imagen_nombre);
        sheet.getRange(rowNum, headers.indexOf('imagen_url') + 1).setValue(img.url);
        sheet.getRange(rowNum, headers.indexOf('imagen_file_id') + 1).setValue(img.fileId);
      }
      return { status: 'ok' };
    }
    return { status: 'error', message: 'No se encontró la novedad' };
  }

  return { status: 'error', message: 'Acción de novedad desconocida' };
}

// Turnos del equipo: cada pronosticador carga qué días de un mes puede
// pronosticar (turnos-admin.html), y ese panel arma el cronograma del mes
// leyendo estas filas. Una fila por (pronosticador, mes): si ya cargó algo
// para ese mes y lo vuelve a guardar (por ejemplo para corregirlo), se
// sobreescribe en el lugar en vez de acumular filas viejas.
const DISPONIBILIDAD_HEADERS = [
  "pronosticador", "mes", "dias_disponibles", "dias_doble", "timestamp_guardado"
];

function getDisponibilidadSheet(ss) {
  let sheet = ss.getSheetByName("Disponibilidad");
  if (!sheet) sheet = ss.insertSheet("Disponibilidad");
  ensureHeadersFor(sheet, DISPONIBILIDAD_HEADERS);
  return sheet;
}

// Mismo cuidado que sameDateStr: "mes" se guarda como texto "yyyy-MM", pero
// por las dudas Sheets lo haya autoconvertido a Date al escribirlo.
function sameMonthStr(cellValue, mesStr, tz) {
  if (!mesStr) return false;
  if (cellValue instanceof Date) {
    return Utilities.formatDate(cellValue, tz, "yyyy-MM") === mesStr;
  }
  return String(cellValue) === mesStr;
}

function handleGuardarDisponibilidad(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getDisponibilidadSheet(ss);
  const headers = DISPONIBILIDAD_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colPronosticador = headers.indexOf("pronosticador");
  const colMes = headers.indexOf("mes");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const allData = sheet.getDataRange().getValues();
    let existingRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][colPronosticador] === data.pronosticador && sameMonthStr(allData[i][colMes], data.mes, tz)) {
        existingRow = i + 1;
        break;
      }
    }

    const fila = [
      data.pronosticador || "",
      data.mes || "",
      (data.dias_disponibles || []).join(","),
      (data.dias_doble || []).join(","),
      new Date().toISOString()
    ];

    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
    } else {
      sheet.appendRow(fila);
    }
  } finally {
    lock.releaseLock();
  }

  return { status: "ok" };
}

function getDisponibilidadList(mes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getDisponibilidadSheet(ss);
  const headers = DISPONIBILIDAD_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colPronosticador = headers.indexOf("pronosticador");
  const colMes = headers.indexOf("mes");
  const colDias = headers.indexOf("dias_disponibles");
  const colDoble = headers.indexOf("dias_doble");
  const rows = sheet.getDataRange().getValues().slice(1);

  const toIntArray = (v) => String(v || "").split(",").map(s => parseInt(s, 10)).filter(n => !isNaN(n));

  const items = rows
    .filter(r => r[colPronosticador] && sameMonthStr(r[colMes], mes, tz))
    .map(r => ({
      pronosticador: r[colPronosticador],
      dias_disponibles: toIntArray(r[colDias]),
      dias_doble: toIntArray(r[colDoble])
    }));
  return { items: items };
}

// Historial de turnos: cada vez que se guarda un cronograma ya definitivo
// (turnos-admin.html, botón "Guardar cronograma del mes"), se registra cuánto
// terminó haciendo cada pronosticador ese mes y cuánto se había calculado como
// su "parte pareja" (saldo_delta = total - parte pareja). El mes siguiente, el
// generador lee este historial y le da prioridad a quien quedó con saldo
// negativo (le deben turnos) para ir emparejando de a poco, mes a mes.
const HISTORIAL_HEADERS = [
  "pronosticador", "mes", "total_turnos", "cuota_asignada", "saldo_delta", "la_plata", "timestamp_guardado"
];

function getHistorialSheet(ss) {
  let sheet = ss.getSheetByName("HistorialTurnos");
  if (!sheet) sheet = ss.insertSheet("HistorialTurnos");
  ensureHeadersFor(sheet, HISTORIAL_HEADERS);
  return sheet;
}

// Guarda (o sobreescribe) una fila por cada pronosticador del cronograma que
// se está dando por definitivo, todo en un mismo lote/lock para que no se
// entrevere con otro guardado simultáneo.
function handleGuardarHistorialTurnos(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getHistorialSheet(ss);
  const headers = HISTORIAL_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colPronosticador = headers.indexOf("pronosticador");
  const colMes = headers.indexOf("mes");
  const registros = data.registros || [];

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const allData = sheet.getDataRange().getValues();
    registros.forEach(reg => {
      let existingRow = -1;
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][colPronosticador] === reg.pronosticador && sameMonthStr(allData[i][colMes], data.mes, tz)) {
          existingRow = i + 1;
          break;
        }
      }
      const fila = [
        reg.pronosticador || "",
        data.mes || "",
        reg.total ?? 0,
        reg.cuota ?? 0,
        reg.saldoDelta ?? 0,
        reg.laPlata ?? 0,
        new Date().toISOString()
      ];
      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
        allData[existingRow - 1] = fila;
      } else {
        sheet.appendRow(fila);
        allData.push(fila);
      }
    });
  } finally {
    lock.releaseLock();
  }
  return { status: "ok" };
}

function getHistorialTurnosList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getHistorialSheet(ss);
  const headers = HISTORIAL_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colPronosticador = headers.indexOf("pronosticador");
  const colMes = headers.indexOf("mes");
  const colTotal = headers.indexOf("total_turnos");
  const colCuota = headers.indexOf("cuota_asignada");
  const colSaldo = headers.indexOf("saldo_delta");
  const colLaPlata = headers.indexOf("la_plata");
  const rows = sheet.getDataRange().getValues().slice(1);

  const items = rows
    .filter(r => r[colPronosticador])
    .map(r => ({
      pronosticador: r[colPronosticador],
      mes: (r[colMes] instanceof Date) ? Utilities.formatDate(r[colMes], tz, "yyyy-MM") : String(r[colMes] || ""),
      total: Number(r[colTotal]) || 0,
      cuota: Number(r[colCuota]) || 0,
      saldoDelta: Number(r[colSaldo]) || 0,
      laPlata: Number(r[colLaPlata]) || 0
    }));
  return { items: items };
}

// Cronograma publicado: la versión detallada (día por día, ciudad por ciudad)
// del cronograma que el admin da por definitiva, para que cualquiera del
// equipo la pueda consultar en cronograma-equipo.html sin necesitar generarla
// de nuevo. Una fila por mes -- se sobreescribe en el lugar si ya había una
// publicación anterior de ese mes (por ejemplo, tras corregir algo a mano).
const CRONOGRAMA_PUB_HEADERS = ["mes", "json_cronograma", "publicado_por", "timestamp_guardado"];

function getCronogramaPubSheet(ss) {
  let sheet = ss.getSheetByName("CronogramaPublicado");
  if (!sheet) sheet = ss.insertSheet("CronogramaPublicado");
  ensureHeadersFor(sheet, CRONOGRAMA_PUB_HEADERS);
  return sheet;
}

function handlePublicarCronograma(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getCronogramaPubSheet(ss);
  const headers = CRONOGRAMA_PUB_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colMes = headers.indexOf("mes");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const allData = sheet.getDataRange().getValues();
    let existingRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (sameMonthStr(allData[i][colMes], data.mes, tz)) { existingRow = i + 1; break; }
    }
    const fila = [
      data.mes || "",
      JSON.stringify(data.cronograma || {}),
      data.publicado_por || "",
      new Date().toISOString()
    ];
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
    } else {
      sheet.appendRow(fila);
    }
  } finally {
    lock.releaseLock();
  }
  return { status: "ok" };
}

function getCronogramaPublicado(mes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getCronogramaPubSheet(ss);
  const headers = CRONOGRAMA_PUB_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colMes = headers.indexOf("mes");
  const colJson = headers.indexOf("json_cronograma");
  const rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (sameMonthStr(rows[i][colMes], mes, tz)) {
      try {
        return { mes: mes, cronograma: JSON.parse(rows[i][colJson]) };
      } catch (e) {
        return { error: "No se pudo leer el cronograma guardado de " + mes };
      }
    }
  }
  return { error: "Todavía no se publicó el cronograma de " + mes };
}

// ============================================================
// LLAVE DE LA OFICINA (llave-admin.html)
// Registro simple tipo "log": cada vez que alguien retira la llave o se la
// pasa a otra persona, se agrega una fila nueva con quién la tiene ahora.
// No hace falta anotar "la devolví": si no hay ninguna fila de HOY, se
// considera directamente "En Intendencia" (ver getLlaveStatus). Así el
// reinicio de cada día es automático, sin ninguna acción extra del equipo.
// ============================================================
const HOJA_LLAVE = 'Llave'; // nombre de la pestaña del Sheet (se crea sola si no existe)

function getLlaveStatus() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(HOJA_LLAVE);
  if (!sheet) return { persona: null, en_intendencia: true, historial: [] };

  const values = sheet.getDataRange().getValues();
  const filas = values.slice(1).filter(r => r[0]); // saca el encabezado y filas vacías

  const zona = ss.getSpreadsheetTimeZone() || 'America/Argentina/Buenos_Aires';
  const hoyStr = Utilities.formatDate(new Date(), zona, 'yyyy-MM-dd');
  const deHoy = filas.filter(r => Utilities.formatDate(new Date(r[0]), zona, 'yyyy-MM-dd') === hoyStr);

  const historial = deHoy.map(r => ({
    hora: Utilities.formatDate(new Date(r[0]), zona, 'HH:mm'),
    persona: r[1],
    nota: r[2] || ''
  }));

  if (!deHoy.length) {
    // Nadie anotó nada hoy todavía -> se considera "En Intendencia" solo,
    // sin que nadie tenga que avisar que la devolvió el día anterior.
    return { persona: null, en_intendencia: true, historial: [] };
  }

  const ultima = deHoy[deHoy.length - 1];
  return {
    persona: ultima[1],
    hora: Utilities.formatDate(new Date(ultima[0]), zona, 'HH:mm'),
    en_intendencia: false,
    historial: historial
  };
}

function registrarLlave(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(HOJA_LLAVE);
  if (!sheet) {
    sheet = ss.insertSheet(HOJA_LLAVE);
    sheet.appendRow(['Fecha y hora', 'Persona', 'Nota']);
  }
  sheet.appendRow([new Date(), data.persona || '', data.nota || '']);
  return { status: 'ok' };
}

// ============================================================
// OBSERVACIONES (lo que realmente pasó cada día -- verificacion-admin.html)
// Una fila por (ciudad, fecha) -- a diferencia de Verificacion_Pronostico,
// la observación no tiene "plazo": lo que pasó ese día pasó una sola vez,
// sin importar con cuánta antelación se había pronosticado.
// ============================================================
const OBSERVACIONES_HEADERS = [
  "ciudad", "fecha", "tmin_urb", "tmax_urb", "tmin_sub", "tmax_sub",
  "precip", "precip_tipo", "v_dir", "v_int", "niebla", "tormenta", "min_noc",
  "comentarios", "cargado_por", "timestamp_guardado"
];

function getObservacionesSheet(ss) {
  let sheet = ss.getSheetByName("Observaciones");
  if (!sheet) sheet = ss.insertSheet("Observaciones");
  ensureHeadersFor(sheet, OBSERVACIONES_HEADERS);
  return sheet;
}

// Guarda (o sobreescribe si ya había una) la observación de una ciudad+fecha.
// Mismo patrón de upsert-con-lock que handleGuardarDisponibilidad.
function handleGuardarObservacion(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getObservacionesSheet(ss);
  const headers = OBSERVACIONES_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colCiudad = headers.indexOf("ciudad");
  const colFecha = headers.indexOf("fecha");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const allData = sheet.getDataRange().getValues();
    let existingRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][colCiudad] === data.ciudad && sameDateStr(allData[i][colFecha], data.fecha, tz)) {
        existingRow = i + 1;
        break;
      }
    }
    const fila = [
      data.ciudad || "",
      data.fecha || "",
      data.tmin_urb ?? "", data.tmax_urb ?? "", data.tmin_sub ?? "", data.tmax_sub ?? "",
      data.precip || "", data.precip_tipo || "", data.v_dir || "", data.v_int || "",
      data.niebla || "", data.tormenta || "", data.min_noc || "",
      data.comentarios || "",
      data.cargado_por || "",
      new Date().toISOString()
    ];
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
    } else {
      sheet.appendRow(fila);
    }
  } finally {
    lock.releaseLock();
  }
  return { status: "ok" };
}

// Importación en lote desde una estación automática (CSV tipo IEM/ASOS,
// ver verificacion-admin.html). A diferencia de handleGuardarObservacion
// (que sobreescribe la fila entera porque viene de un formulario que ya
// tiene el estado completo), acá cada fila del lote solo trae un
// SUBCONJUNTO de campos (temperatura, viento, a veces precip) -- si la
// fecha ya tenía una fila cargada a mano con tipo de precipitación /
// niebla / tormenta / comentarios, esos campos NO se tocan. Si la fecha
// es nueva, los campos que no vinieron en el lote quedan en blanco (se
// pueden completar después a mano).
function mergeObservacionRow(existingRow, headers, ciudad, fecha, incoming, cargadoPor) {
  const val = (h) => {
    if (incoming[h] !== undefined && incoming[h] !== null) return incoming[h];
    if (existingRow) return existingRow[headers.indexOf(h)];
    return "";
  };
  return [
    ciudad, fecha,
    val("tmin_urb"), val("tmax_urb"), val("tmin_sub"), val("tmax_sub"),
    val("precip"), val("precip_tipo"), val("v_dir"), val("v_int"),
    val("niebla"), val("tormenta"), val("min_noc"),
    val("comentarios"),
    existingRow ? existingRow[headers.indexOf("cargado_por")] : (cargadoPor || ""),
    new Date().toISOString()
  ];
}

// Igual que sameDateStr pero devuelve la fecha como string "yyyy-MM-dd" en
// vez de comparar contra una -- para armar una clave de índice por fecha.
function fechaKeyStr(cellValue, tz) {
  if (cellValue instanceof Date) return Utilities.formatDate(cellValue, tz, "yyyy-MM-dd");
  return String(cellValue);
}

function handleImportarObservacionesLote(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getObservacionesSheet(ss);
  const headers = OBSERVACIONES_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const colCiudad = headers.indexOf("ciudad");
  const colFecha = headers.indexOf("fecha");
  const filas = data.filas || [];

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const allData = sheet.getDataRange().getValues();

    // Índice ciudad+fecha -> número de fila real, armado una sola vez. Con
    // una importación de varios años (miles de fechas) buscar cada una con
    // un for lineal contra todas las filas existentes (miles x miles) era
    // el cuello de botella real -- esto lo deja en una sola pasada.
    const indice = new Map();
    for (let i = 1; i < allData.length; i++) {
      indice.set(allData[i][colCiudad] + "||" + fechaKeyStr(allData[i][colFecha], tz), i + 1);
    }

    const nuevasFilas = [];
    let importadas = 0;

    filas.forEach(f => {
      if (!f.fecha) return;
      const existingRow = indice.get(data.ciudad + "||" + f.fecha) || -1;

      const incoming = {};
      ["tmin_urb", "tmax_urb", "tmin_sub", "tmax_sub", "precip", "v_dir", "v_int"].forEach(k => {
        if (f[k] !== undefined && f[k] !== null && f[k] !== "") incoming[k] = f[k];
      });
      const fila = mergeObservacionRow(
        existingRow > 0 ? allData[existingRow - 1] : null,
        headers, data.ciudad, f.fecha, incoming, data.cargado_por
      );

      if (existingRow > 0) {
        // Fecha que ya tenía fila (reimportación/corrección): se
        // sobreescribe en el lugar -- son las menos, una llamada cada una.
        sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
        allData[existingRow - 1] = fila;
      } else {
        // Fecha nueva: se junta para escribirlas todas de una en vez de un
        // appendRow() por cada una (miles de llamadas sueltas a Sheets es
        // lo que hace que una importación grande tarde minutos en vez de
        // segundos, o directamente se corte por el límite de ejecución).
        nuevasFilas.push(fila);
      }
      importadas++;
    });

    if (nuevasFilas.length > 0) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, nuevasFilas.length, headers.length).setValues(nuevasFilas);
    }

    return { status: "ok", importadas: importadas };
  } finally {
    lock.releaseLock();
  }
}

// Trae la observación de una ciudad+fecha puntual, para precargar el
// formulario cuando el usuario vuelve a abrir una fecha ya cargada.
function getObservacion(ciudad, fecha) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getObservacionesSheet(ss);
  const headers = OBSERVACIONES_HEADERS;
  const tz = ss.getSpreadsheetTimeZone();
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][headers.indexOf("ciudad")] === ciudad && sameDateStr(rows[i][headers.indexOf("fecha")], fecha, tz)) {
      const r = rows[i];
      const val = (h) => r[headers.indexOf(h)];
      return {
        ciudad: ciudad, fecha: fecha,
        tmin_urb: val("tmin_urb"), tmax_urb: val("tmax_urb"), tmin_sub: val("tmin_sub"), tmax_sub: val("tmax_sub"),
        precip: val("precip"), precip_tipo: val("precip_tipo"), v_dir: val("v_dir"), v_int: val("v_int"),
        niebla: val("niebla"), tormenta: val("tormenta"), min_noc: val("min_noc"),
        comentarios: val("comentarios"), cargado_por: val("cargado_por")
      };
    }
  }
  return { error: "Sin observación cargada para " + ciudad + " " + fecha };
}

// Para una ciudad y un rango de fechas: cada fecha con sus 3 pronósticos
// (plazo 1/2/3, sacados de Verificacion_Pronostico) y la observación
// correspondiente (si ya se cargó), todo junto en una sola respuesta para
// que el visualizador los muestre uno al lado del otro sin pedir cada
// pieza por separado.
function getVerificacionComparada(ciudad, desde, hasta) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();

  const verifSheet = ss.getSheetByName("Verificacion_Pronostico");
  const vHeaders = verifSheet ? ensureHeadersFor(verifSheet, VERIF_HEADERS) : VERIF_HEADERS;
  const vRows = verifSheet ? verifSheet.getDataRange().getValues().slice(1) : [];

  const obsSheet = getObservacionesSheet(ss);
  const oHeaders = OBSERVACIONES_HEADERS;
  const oRows = obsSheet.getDataRange().getValues().slice(1);

  const fechaStr = (cellValue) => (cellValue instanceof Date) ? Utilities.formatDate(cellValue, tz, "yyyy-MM-dd") : String(cellValue);
  const enRango = (cellValue) => { const f = fechaStr(cellValue); return f >= desde && f <= hasta; };

  const porFecha = {};
  const getBucket = (fecha) => {
    if (!porFecha[fecha]) porFecha[fecha] = { fecha: fecha, pronosticos: {}, observacion: null };
    return porFecha[fecha];
  };

  vRows.forEach(r => {
    if (r[vHeaders.indexOf("ciudad")] !== ciudad) return;
    if (!enRango(r[vHeaders.indexOf("fecha_pronostico")])) return;
    const val = (h) => r[vHeaders.indexOf(h)];
    const bucket = getBucket(fechaStr(val("fecha_pronostico")));
    bucket.pronosticos["plazo" + Number(val("plazo"))] = {
      pronosticador: val("pronosticador"), fecha_emision: fechaStr(val("fecha_emision")),
      tmin_urb: val("tmin_urb"), tmax_urb: val("tmax_urb"), tmin_sub: val("tmin_sub"), tmax_sub: val("tmax_sub"),
      precip: val("precip"), precip_tipo: val("precip_tipo"), v_dir: val("v_dir"), v_int: val("v_int"),
      niebla: val("niebla"), tormenta: val("tormenta"), min_noc: val("min_noc"), comentarios: val("comentarios")
    };
  });

  oRows.forEach(r => {
    if (r[oHeaders.indexOf("ciudad")] !== ciudad) return;
    if (!enRango(r[oHeaders.indexOf("fecha")])) return;
    const val = (h) => r[oHeaders.indexOf(h)];
    const bucket = getBucket(fechaStr(val("fecha")));
    bucket.observacion = {
      tmin_urb: val("tmin_urb"), tmax_urb: val("tmax_urb"), tmin_sub: val("tmin_sub"), tmax_sub: val("tmax_sub"),
      precip: val("precip"), precip_tipo: val("precip_tipo"), v_dir: val("v_dir"), v_int: val("v_int"),
      niebla: val("niebla"), tormenta: val("tormenta"), min_noc: val("min_noc"),
      comentarios: val("comentarios"), cargado_por: val("cargado_por")
    };
  });

  const items = Object.keys(porFecha).sort().map(f => porFecha[f]);
  return { ciudad: ciudad, desde: desde, hasta: hasta, items: items };
}

// Fuerza que la fila 1 de una hoja tenga EXACTAMENTE estos nombres de
// columna (corrige encabezados viejos/desactualizados). No toca
// ninguna fila de datos, solo la fila 1.
function ensureHeadersFor(sheet, expectedHeaders) {
  if (sheet.getMaxColumns() < expectedHeaders.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), expectedHeaders.length - sheet.getMaxColumns());
  }
  const current = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
  const matches = expectedHeaders.every((h, i) => current[i] === h);
  if (!matches) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
  }
  return expectedHeaders;
}

function ensureHeaders(sheet) {
  return ensureHeadersFor(sheet, ALL_HEADERS);
}

// ── GET: El portal pide el pronóstico actual de una ciudad, o la lista
//        de novedades (type=novedades), disponibilidad, historial de
//        turnos, cronograma publicado, el estado de la llave, una
//        observación puntual o la comparación observación-vs-pronóstico ───
function doGet(e) {
  const cb = e.parameter.callback;

  if (e.parameter.type === "novedades") {
    const result = getNovedadesList();
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "disponibilidad") {
    const result = getDisponibilidadList(e.parameter.mes);
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "historial_turnos") {
    const result = getHistorialTurnosList();
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "cronograma_publicado") {
    const result = getCronogramaPublicado(e.parameter.mes);
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "llave") {
    const result = getLlaveStatus();
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  // Verifica la clave de acceso del equipo (cortina de admin.html y las
  // demás páginas de administración) SIN que la clave real viaje nunca al
  // código fuente que se sirve al navegador -- antes estaba escrita en
  // texto plano en cada HTML (cualquiera que abriera "ver código fuente"
  // la veía). Ahora solo vive acá, en Script Properties, y esta respuesta
  // no devuelve la clave en ningún caso, solo si coincidió o no.
  if (e.parameter.type === "verificar_clave") {
    const expected = PropertiesService.getScriptProperties().getProperty('TEAM_PASSWORD');
    const ok = !expected || e.parameter.clave === expected;
    const out = JSON.stringify({ ok: ok });
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "observacion") {
    const result = getObservacion(e.parameter.ciudad, e.parameter.fecha);
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  if (e.parameter.type === "verificacion_comparada") {
    const result = getVerificacionComparada(e.parameter.ciudad, e.parameter.desde, e.parameter.hasta);
    const out = JSON.stringify(result);
    return ContentService
      .createTextOutput(cb ? `${cb}(${out});` : out)
      .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Pronosticos");
  const city  = e.parameter.city;

  let result = { error: "Sin datos para " + (city || "ciudad desconocida") };

  if (sheet && city) {
    const headers   = ensureHeaders(sheet);
    const colCity   = headers.indexOf("city");
    const colJson   = headers.indexOf("json_completo");
    const data      = sheet.getDataRange().getValues();
    const todayStr  = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd");

    // Recorre de abajo hacia arriba (más reciente primero) y se queda con la
    // primera publicación cuya fecha de pronóstico (forecast_date) ya llegó.
    // Esto es a propósito INDEPENDIENTE de la columna "vigente": si a la
    // noche se publica con "turno noche" (para mañana), esa fila marca como
    // superada la de hoy por compartir el mismo emision_real_date (mismo
    // turno real), pero acá igual hay que seguir mostrando la de hoy hasta
    // que llegue la fecha de mañana. Ídem para correcciones del mismo día:
    // como se escanea de abajo hacia arriba, la corrección más nueva
    // siempre se encuentra antes que la original, sin necesitar "vigente".
    for (let i = data.length - 1; i > 0; i--) {
      const row = data[i];
      if (row[colCity] && row[colCity].toString().toLowerCase() === city.toLowerCase()) {
        let parsed;
        try { parsed = JSON.parse(row[colJson]); }
        catch (err) { continue; }
        if (parsed.forecast_date && parsed.forecast_date <= todayStr) {
          result = parsed;
          break;
        }
      }
    }
  }

  // "result" es el payload tal cual se guardó con doPost (json_completo),
  // que incluye team_password porque admin.html lo manda en cada
  // publicación -- eso NUNCA debería salir en una respuesta pública (esto
  // alimenta tanto el portal público como data/forecasts.json, que queda
  // committeado en el repo). Se saca acá, en el único lugar por donde pasa
  // toda respuesta de esta ruta.
  delete result.team_password;

  const out = JSON.stringify(result);
  return ContentService
    .createTextOutput(cb ? `${cb}(${out});` : out)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

// Compara una celda leída de la hoja contra una fecha "yyyy-MM-dd" (string).
// Hace falta porque Sheets suele autoconvertir un texto con pinta de fecha
// (como "2026-08-13") a un valor de tipo Date apenas se escribe con
// appendRow/setValues -- al releerlo con getValues() vuelve como objeto
// Date, no como el string original, así que compararlo con "===" contra el
// string nunca da igual aunque sea el mismo día. Por eso "sobrescribir en
// vez de appendear" nunca encontraba la fila existente.
function sameDateStr(cellValue, isoStr, tz) {
  if (!isoStr) return false;
  if (cellValue instanceof Date) {
    return Utilities.formatDate(cellValue, tz, "yyyy-MM-dd") === isoStr;
  }
  return String(cellValue) === isoStr;
}

const WIND_DIR_ABBR = {
  "norte":"N", "noreste":"NE", "este":"E", "sudeste":"SE",
  "sur":"S", "sudoeste":"SW", "oeste":"W", "noroeste":"NW"
};

function uniqueJoin(values) {
  const seen = [];
  values.forEach(v => { if (v && seen.indexOf(v) === -1) seen.push(v); });
  return seen.join(", ");
}

// Deriva las variables de verificación de un bloque de día (Día 2/3/4)
// a partir de lo que ya carga el equipo por tramo en admin.html. No
// depende de campos nuevos en el formulario.
function deriveDayVerification(dayBlock, customDescription) {
  const periods = dayBlock.period_forecasts || [];
  const precipDescs = periods.map(p => p.precipitation_description).filter(Boolean);
  const skyConds    = periods.map(p => p.sky_condition).filter(Boolean);
  const windDirs    = periods.map(p => WIND_DIR_ABBR[(p.wind_direction || '').toLowerCase()] || p.wind_direction).filter(Boolean);
  const windInts    = periods.map(p => (p.wind_intensity || '').toUpperCase()).filter(Boolean);

  const precip      = precipDescs.length > 0;
  const precip_tipo = uniqueJoin(precipDescs);
  const niebla      = skyConds.some(s => /niebla|neblina/i.test(s));
  const tormenta    = precipDescs.some(s => /tormenta/i.test(s));
  const v_dir       = uniqueJoin(windDirs);
  const v_int       = uniqueJoin(windInts);

  // min_noc (¿la mínima se espera de noche/madrugada?): solo se puede
  // derivar cuando hay temperatura por tramo (Día 2). Día 3/4 no tienen
  // temperatura por tramo en el formulario actual, queda en blanco.
  let min_noc = "";
  const withTemp = periods.filter(p => p.temperature != null);
  if (withTemp.length > 0) {
    const minTemp = Math.min.apply(null, withTemp.map(p => p.temperature));
    min_noc = withTemp.some(p => p.temperature === minTemp && (p.period === 'noche' || p.period === 'madrugada'));
  }

  return {
    tmin_urb: dayBlock.temp_min ?? "",
    tmax_urb: dayBlock.temp_max ?? "",
    tmin_sub: dayBlock.temp_min_suburban ?? "",
    tmax_sub: dayBlock.temp_max_suburban ?? "",
    precip: precip ? "SI" : "NO",
    precip_tipo: precip_tipo,
    v_dir: v_dir,
    v_int: v_int,
    niebla: niebla ? "SI" : "NO",
    tormenta: tormenta ? "SI" : "NO",
    min_noc: min_noc === "" ? "" : (min_noc ? "SI" : "NO"),
    comentarios: customDescription || ""
  };
}

// Escribe/actualiza las filas de verificación (Día 2/3/4 → plazo 1/2/3)
// para una publicación. No interesa guardar versiones intermedias de una
// corrección, solo el pronóstico definitivo de cada (ciudad, fecha
// pronosticada, plazo): si ya existe una fila para esa combinación, se
// sobreescribe en el lugar; si es la primera vez, se agrega una fila nueva.
function writeVerificationRows(ss, data, emisionRealDate, now) {
  let sheet = ss.getSheetByName("Verificacion_Pronostico");
  if (!sheet) sheet = ss.insertSheet("Verificacion_Pronostico");
  const headers = ensureHeadersFor(sheet, VERIF_HEADERS);
  const tz = ss.getSpreadsheetTimeZone();

  const colCiudad = headers.indexOf("ciudad");
  const colFecha  = headers.indexOf("fecha_pronostico");
  const colPlazo  = headers.indexOf("plazo");

  const d = data.daily_forecasts || [];
  // Día 2/3/4 (índices 1,2,3) = plazo 1/2/3. Día 1 (plazo 0) no se
  // trackea acá, igual que en el Excel de referencia (no tiene d+0).
  const bloques = [
    { idx: 1, plazo: 1, desc: null },
    { idx: 2, plazo: 2, desc: (data.daily_forecasts || [])[2]?.custom_description },
    { idx: 3, plazo: 3, desc: (data.daily_forecasts || [])[3]?.custom_description }
  ];

  // Se lee una sola vez: como cada bloque de abajo escribe en un plazo
  // distinto, nunca compiten entre sí por la misma fila dentro de este loop.
  const allData = sheet.getDataRange().getValues();

  bloques.forEach(b => {
    const dayBlock = d[b.idx];
    if (!dayBlock || !dayBlock.date) return;

    // Busca si ya hay una fila para esta misma ciudad+fecha pronosticada+plazo.
    let existingRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][colCiudad] === data.city
          && sameDateStr(allData[i][colFecha], dayBlock.date, tz)
          && Number(allData[i][colPlazo]) === b.plazo) {
        existingRow = i + 1; // fila real de la hoja (1-based, +1 por el encabezado)
        break;
      }
    }

    const derived = deriveDayVerification(dayBlock, b.desc);
    const fila = [
      data.city || "",
      data.publicado_por || "",
      emisionRealDate,
      dayBlock.date,
      b.plazo,
      derived.tmin_urb, derived.tmax_urb, derived.tmin_sub, derived.tmax_sub,
      derived.precip, derived.precip_tipo, derived.v_dir, derived.v_int,
      derived.niebla, derived.tormenta, derived.min_noc,
      derived.comentarios,
      "SI",
      "",
      data.es_correccion ? "SI" : "NO"
    ];

    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
    } else {
      sheet.appendRow(fila);
    }
  });
}

// Le avisa a GitHub Actions que hay un pronóstico nuevo para que actualice
// el caché estático que lee el portal (así el portal no consulta esta
// planilla en cada visita). Requiere un Personal Access Token guardado en
// Configuración del proyecto → Propiedades del script → GITHUB_TOKEN.
// Si no está configurado, no hace nada (las corridas de respaldo programadas
// igual van a actualizar el caché unas horas más tarde).
//
// VERSIÓN TEMPORAL DE DIAGNÓSTICO: loguea el resultado en vez de tragarlo
// en silencio. Una vez confirmado que funciona (status 204), se puede volver
// a la versión silenciosa si se quiere.
function notifyGithubOfPublish() {
  try {
    const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) {
      Logger.log('GITHUB_TOKEN no está configurado en Script Properties.');
      return;
    }
    const resp = UrlFetchApp.fetch('https://api.github.com/repos/tifon61/pronostico-unlp/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
      payload: JSON.stringify({ event_type: 'forecast-published' }),
      muteHttpExceptions: true
    });
    Logger.log('GitHub dispatch status: ' + resp.getResponseCode() + ' body: ' + resp.getContentText());
  } catch (err) {
    Logger.log('Error notificando a GitHub: ' + err.toString());
  }
}

// ── POST: El admin publica un pronóstico (Guarda aplanado + JSON) ──
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Clave compartida del equipo (Script Properties > TEAM_PASSWORD). Si está configurada,
    // rechaza la publicación cuando no coincide con la que mandó admin.html. Esto protege el
    // guardado real aunque alguien se salte la pantalla de acceso del HTML (por ejemplo
    // llamando a esta URL directo), no solo la interfaz.
    const expectedPassword = PropertiesService.getScriptProperties().getProperty('TEAM_PASSWORD');
    if (expectedPassword && data.team_password !== expectedPassword) {
      return ContentService
        .createTextOutput(JSON.stringify({ status: "error", message: "Clave de equipo inválida" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Publicar/editar/borrar una novedad (novedades-admin.html) es una acción aparte de
    // publicar un pronóstico: no toca nada de lo que sigue abajo.
    if (data.action === 'crear_novedad' || data.action === 'editar_novedad' || data.action === 'borrar_novedad') {
      const result = handleNovedadAction(data);
      notifyGithubOfPublish();
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Guardar la disponibilidad mensual de un pronosticador (turnos-admin.html).
    // No toca nada de la publicación de pronósticos de acá abajo.
    if (data.action === 'guardar_disponibilidad') {
      const result = handleGuardarDisponibilidad(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Guardar como definitivo el cronograma de turnos de un mes (turnos-admin.html),
    // para que el mes siguiente el reparto tenga en cuenta quién quedó con saldo.
    if (data.action === 'guardar_historial_turnos') {
      const result = handleGuardarHistorialTurnos(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Publicar el cronograma detallado (día por día) para que todo el equipo
    // lo consulte en cronograma-equipo.html.
    if (data.action === 'publicar_cronograma') {
      const result = handlePublicarCronograma(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Anotar quién tiene la llave de la oficina ahora (llave-admin.html).
    // No toca nada de la publicación de pronósticos de acá abajo.
    if (data.action === 'actualizar_llave') {
      const result = registrarLlave(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Guardar (o editar) la observación de una ciudad+fecha desde el
    // formulario de verificacion-admin.html.
    if (data.action === 'guardar_observacion') {
      const result = handleGuardarObservacion(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    // Importar de una sola vez varias fechas de observación desde un CSV de
    // estación automática (verificacion-admin.html).
    if (data.action === 'importar_observaciones_lote') {
      const result = handleImportarObservacionesLote(data);
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    const ss   = SpreadsheetApp.getActiveSpreadsheet();
    const tz   = ss.getSpreadsheetTimeZone();

    const d   = data.daily_forecasts || [];
    const gd  = (i)    => d[i] || {};
    const gp  = (i, j) => ((d[i] || {}).period_forecasts || [])[j] || {};
    const sky = (p)    => p.sky_condition || p.precipitation_description || "";

    let sheet = ss.getSheetByName("Pronosticos");
    if (!sheet) sheet = ss.insertSheet("Pronosticos");

    const headers = ensureHeaders(sheet);

    // Fecha real de emisión (server-side, no la del checkbox "para mañana").
    // Es la clave para detectar correcciones/duplicados del mismo turno.
    const now = new Date();
    const emisionRealDate = Utilities.formatDate(now, tz, "yyyy-MM-dd");

    // Antelación en días de cada bloque, respecto a cuándo se publicó de verdad.
    const leadDias = (fechaStr) => {
      if (!fechaStr) return "";
      const target = new Date(fechaStr + "T00:00:00");
      const base   = new Date(emisionRealDate + "T00:00:00");
      return Math.round((target - base) / 86400000);
    };

    // Evita que dos publicaciones casi simultáneas (dos personas publicando
    // a la vez, o un doble clic que se coló a pesar del guard del lado del
    // cliente) lean la hoja al mismo tiempo y ninguna vea la fila de la otra
    // -- eso es lo que generaba filas duplicadas idénticas en Pronosticos y
    // Verificacion_Pronostico.
    const lock = LockService.getScriptLock();
    lock.waitLock(30000); // hasta 30s esperando su turno antes de tirar error
    try {
      // No interesa guardar versiones intermedias de una corrección, solo el
      // pronóstico definitivo de cada día: si ya hay una fila de esta misma
      // ciudad publicada en el mismo día real (sea una corrección o un
      // reintento accidental), se sobreescribe en el lugar en vez de
      // agregar una fila nueva y dejar la vieja dando vueltas.
      const colCity   = headers.indexOf("city");
      const colEmis   = headers.indexOf("emision_real_date");
      const allData   = sheet.getDataRange().getValues();

      let existingRow = -1;
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][colCity] === data.city && sameDateStr(allData[i][colEmis], emisionRealDate, tz)) {
          existingRow = i + 1; // fila real de la hoja (1-based, +1 por el encabezado)
          break;
        }
      }

      const fila = [
        data.forecast_date  || "",
        data.city           || "",
        data.emission_time  || "",
        now.toISOString(),
        data.publicado_por  || "",
        data.es_correccion ? "SI" : "NO",

        gd(0).date || "", gd(0).day_name || "", gd(0).temp_min ?? "", gd(0).temp_max ?? "", gd(0).temp_min_suburban ?? "", gd(0).temp_max_suburban ?? "",
        sky(gp(0,0)), gp(0,0).probability_of_precipitation || "", gp(0,0).temperature ?? "", gp(0,0).wind_intensity || "", gp(0,0).wind_direction || "", gp(0,0).wind_gusts ?? "",
        sky(gp(0,1)), gp(0,1).probability_of_precipitation || "", gp(0,1).temperature ?? "", gp(0,1).wind_intensity || "", gp(0,1).wind_direction || "", gp(0,1).wind_gusts ?? "",
        sky(gp(0,2)), gp(0,2).probability_of_precipitation || "", gp(0,2).temperature ?? "", gp(0,2).wind_intensity || "", gp(0,2).wind_direction || "", gp(0,2).wind_gusts ?? "",

        gd(1).date || "", gd(1).day_name || "", gd(1).temp_min ?? "", gd(1).temp_max ?? "", gd(1).temp_min_suburban ?? "", gd(1).temp_max_suburban ?? "",
        sky(gp(1,0)), gp(1,0).probability_of_precipitation || "", gp(1,0).temperature ?? "", gp(1,0).wind_intensity || "", gp(1,0).wind_direction || "", gp(1,0).wind_gusts ?? "",
        sky(gp(1,1)), gp(1,1).probability_of_precipitation || "", gp(1,1).temperature ?? "", gp(1,1).wind_intensity || "", gp(1,1).wind_direction || "", gp(1,1).wind_gusts ?? "",
        sky(gp(1,2)), gp(1,2).probability_of_precipitation || "", gp(1,2).temperature ?? "", gp(1,2).wind_intensity || "", gp(1,2).wind_direction || "", gp(1,2).wind_gusts ?? "",
        sky(gp(1,3)), gp(1,3).probability_of_precipitation || "", gp(1,3).temperature ?? "", gp(1,3).wind_intensity || "", gp(1,3).wind_direction || "", gp(1,3).wind_gusts ?? "",

        gd(2).date || "", gd(2).day_name || "", gd(2).temp_min ?? "", gd(2).temp_max ?? "", gd(2).temp_min_suburban ?? "", gd(2).temp_max_suburban ?? "",
        sky(gp(2,0)), gp(2,0).probability_of_precipitation || "", gp(2,0).wind_intensity || "", gp(2,0).wind_direction || "", gp(2,0).wind_gusts ?? "",
        sky(gp(2,1)), gp(2,1).probability_of_precipitation || "", gp(2,1).wind_intensity || "", gp(2,1).wind_direction || "", gp(2,1).wind_gusts ?? "",

        gd(3).date || "", gd(3).day_name || "", gd(3).temp_min ?? "", gd(3).temp_max ?? "", gd(3).temp_min_suburban ?? "", gd(3).temp_max_suburban ?? "",
        sky(gp(3,0)), gp(3,0).probability_of_precipitation || "", gp(3,0).wind_intensity || "", gp(3,0).wind_direction || "", gp(3,0).wind_gusts ?? "",
        sky(gp(3,1)), gp(3,1).probability_of_precipitation || "", gp(3,1).wind_intensity || "", gp(3,1).wind_direction || "", gp(3,1).wind_gusts ?? "",

        JSON.stringify(data),

        // Columnas nuevas (van al final, en el mismo orden que EXTRA_HEADERS)
        emisionRealDate,
        "SI",
        "",
        leadDias(gd(0).date),
        leadDias(gd(1).date),
        leadDias(gd(2).date),
        leadDias(gd(3).date)
      ];

      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
      } else {
        sheet.appendRow(fila);
      }
      writeVerificationRows(ss, data, emisionRealDate, now);
    } finally {
      lock.releaseLock();
    }

    notifyGithubOfPublish();

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", city: data.city, emision_real_date: emisionRealDate }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
