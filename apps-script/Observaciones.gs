// ============================================================
// OBSERVACIONES (lo que realmente pasó cada día)
// Pegar esto como un ARCHIVO NUEVO en el proyecto de Apps Script
// (Editor > "+" al lado de Archivos > Script, nombrarlo "Observaciones").
// No pisa nada de lo que ya existe en Code.gs -- son funciones nuevas que
// reutilizan sameDateStr, ensureHeadersFor y VERIF_HEADERS ya definidas ahí.
//
// Este archivo vive acá para tenerlo versionado, pero Code.gs (el proyecto
// de Apps Script en sí) NO vive en este repo -- solo se puede editar desde
// script.google.com. Además de copiar este archivo hacen falta 2
// inserciones chiquitas ahí, una dentro de doGet y otra dentro de doPost --
// están indicadas al final de este archivo, con el fragmento existente
// como referencia para ubicar dónde pegarlas.
// ============================================================

// Una fila por (ciudad, fecha) -- a diferencia de Verificacion_Pronostico,
// la observación no tiene "plazo": lo que pasó ese día pasó una sola vez,
// sin importar con cuánta antelación se había pronosticado.
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
// Mismo patrón de upsert-con-lock que handleGuardarDisponibilidad en Code.gs.
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
    let importadas = 0;
    filas.forEach(f => {
      if (!f.fecha) return;
      let existingRow = -1;
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][colCiudad] === data.ciudad && sameDateStr(allData[i][colFecha], f.fecha, tz)) {
          existingRow = i + 1;
          break;
        }
      }
      const incoming = {};
      ["tmin_urb", "tmax_urb", "tmin_sub", "tmax_sub", "precip", "v_dir", "v_int"].forEach(k => {
        if (f[k] !== undefined && f[k] !== null && f[k] !== "") incoming[k] = f[k];
      });
      const fila = mergeObservacionRow(
        existingRow > 0 ? allData[existingRow - 1] : null,
        headers, data.ciudad, f.fecha, incoming, data.cargado_por
      );
      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, fila.length).setValues([fila]);
        allData[existingRow - 1] = fila;
      } else {
        sheet.appendRow(fila);
        allData.push(fila);
      }
      importadas++;
    });
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

// ============================================================
// INSERCIÓN 1 de 2 -- dentro de doGet(e), en Code.gs.
// Pegar este bloque justo DESPUÉS del bloque "llave" existente
// (el que empieza con `if (e.parameter.type === "llave") {`) y ANTES de
// la línea `const ss    = SpreadsheetApp.getActiveSpreadsheet();` que
// sigue (esa es la que arma la respuesta del pronóstico normal, no se toca).
//
//   if (e.parameter.type === "observacion") {
//     const result = getObservacion(e.parameter.ciudad, e.parameter.fecha);
//     const out = JSON.stringify(result);
//     return ContentService
//       .createTextOutput(cb ? `${cb}(${out});` : out)
//       .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
//   }
//
//   if (e.parameter.type === "verificacion_comparada") {
//     const result = getVerificacionComparada(e.parameter.ciudad, e.parameter.desde, e.parameter.hasta);
//     const out = JSON.stringify(result);
//     return ContentService
//       .createTextOutput(cb ? `${cb}(${out});` : out)
//       .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
//   }
//
// ============================================================
// INSERCIÓN 2 de 2 -- dentro de doPost(e), en Code.gs.
// Pegar este bloque justo DESPUÉS del bloque de 'actualizar_llave' y ANTES
// de la línea `const ss   = SpreadsheetApp.getActiveSpreadsheet();` que
// sigue (esa es la que arma el guardado del pronóstico normal, no se toca).
//
//   if (data.action === 'guardar_observacion') {
//     const result = handleGuardarObservacion(data);
//     return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
//   }
//
//   if (data.action === 'importar_observaciones_lote') {
//     const result = handleImportarObservacionesLote(data);
//     return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
//   }
//
// ============================================================
