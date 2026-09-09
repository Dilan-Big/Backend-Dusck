// UI-5.3 — Dashboard administrativo (agregados de solo lectura).
//
// Constantes y parsing de rango de fechas del panel de indicadores. NO consulta
// Mongo ni conoce Express: solo normaliza `req.query` a un rango { from, to,
// granularity } y expone utilidades de calendario en la zona operativa de DUSCK.
//
// Zona horaria: Colombia usa un offset FIJO UTC-5 (sin horario de verano), así
// que una fecha simple `YYYY-MM-DD` se ancla a `-05:00` para obtener el instante
// UTC correcto — MISMO criterio que `order.controller.js` (F4.3-C.3.1). Las
// agregaciones que agrupan por día/mes usan `timezone: "America/Bogota"` en
// `$dateToString` para que el corte de día sea el local, no UTC.

export const BOGOTA_OFFSET = "-05:00";
export const BOGOTA_TZ = "America/Bogota";

// Umbral de "stock bajo": el backend de producto NO tiene este concepto (solo
// `product.stock`). Se adopta el mismo valor que ya usa el panel
// (`STOCK_LOW_THRESHOLD` en `admin.models.ts`), declarado aquí como constante
// del dominio Dashboard y devuelto en el contrato para que el frontend no lo
// vuelva a hardcodear.
export const DASHBOARD_LOW_STOCK_THRESHOLD = 5;

// Antigüedad a partir de la cual un pedido sin confirmar se considera una alerta
// operativa (pedido "estancado" en pending_confirmation).
export const DASHBOARD_STALE_PENDING_HOURS = 48;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

// Ventana por defecto cuando no llega `from` (incluye el día de hoy).
const DEFAULT_RANGE_DAYS = 30;
// Techo defensivo: evita una agregación con series de miles de buckets.
const MAX_RANGE_DAYS = 366;
// Por encima de esto, la granularidad por defecto pasa de día a mes.
const GRANULARITY_DAY_MAX_DAYS = 92;

const MS_PER_DAY = 86_400_000;

const isPlainString = (value) => typeof value === "string";

// Error de parámetro de query -> HTTP 400. Sin PII, mismo patrón que
// `QueryParamError` en `order.controller.js`.
export class DashboardQueryError extends Error {
  constructor(message) {
    super(message);
    this.isDashboardQueryError = true;
  }
}

// `YYYY-MM-DD` de una fecha en America/Bogota (por defecto, ahora).
export const bogotaDateString = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: BOGOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

export const bogotaDayStart = (ymd) => new Date(`${ymd}T00:00:00.000${BOGOTA_OFFSET}`);
export const bogotaDayEnd = (ymd) => new Date(`${ymd}T23:59:59.999${BOGOTA_OFFSET}`);

// Rango [start, end] del día de HOY en America/Bogota, como instantes UTC.
export const bogotaToday = () => {
  const ymd = bogotaDateString();
  return { start: bogotaDayStart(ymd), end: bogotaDayEnd(ymd) };
};

const parseDateParam = (raw, { field, endOfDay }) => {
  if (raw === undefined) return undefined;
  if (!isPlainString(raw)) {
    throw new DashboardQueryError(`El parámetro '${field}' no es una fecha válida`);
  }
  let iso;
  if (DATE_ONLY_RE.test(raw)) {
    iso = `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${BOGOTA_OFFSET}`;
  } else if (ISO_DATETIME_RE.test(raw)) {
    iso = raw;
  } else {
    throw new DashboardQueryError(`El parámetro '${field}' no es una fecha ISO-8601 válida`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new DashboardQueryError(`El parámetro '${field}' no es una fecha válida`);
  }
  return d;
};

/**
 * Normaliza `req.query` a un rango de análisis.
 *
 *   from        `YYYY-MM-DD` (día calendario Bogotá) o ISO-8601 con zona. Default: hace 29 días.
 *   to          idem (fin de día si es fecha simple). Default: hoy (fin de día).
 *   granularity "day" | "month". Default: "day" si el rango <= 92 días, si no "month".
 *
 * @returns {{from: Date, to: Date, granularity: "day"|"month", timezone: string}}
 * @throws  {DashboardQueryError} 400 ante cualquier parámetro inválido.
 */
export const resolveRange = (query = {}) => {
  const q = query && typeof query === "object" ? query : {};

  let from = parseDateParam(q.from, { field: "from", endOfDay: false });
  let to = parseDateParam(q.to, { field: "to", endOfDay: true });

  if (!to) to = bogotaDayEnd(bogotaDateString());
  if (!from) {
    const start = new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * MS_PER_DAY);
    from = bogotaDayStart(bogotaDateString(start));
  }

  if (from.getTime() > to.getTime()) {
    throw new DashboardQueryError("'from' no puede ser posterior a 'to'");
  }

  const spanDays = Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY);
  if (spanDays > MAX_RANGE_DAYS) {
    throw new DashboardQueryError(`El rango de fechas no puede superar los ${MAX_RANGE_DAYS} días`);
  }

  let granularity = q.granularity;
  if (granularity === undefined) {
    granularity = spanDays > GRANULARITY_DAY_MAX_DAYS ? "month" : "day";
  } else if (granularity !== "day" && granularity !== "month") {
    throw new DashboardQueryError("El parámetro 'granularity' debe ser 'day' o 'month'");
  }

  return { from, to, granularity, timezone: BOGOTA_TZ };
};

/**
 * Enumera TODOS los buckets de calendario entre `from` y `to` (ambos inclusive)
 * a la granularidad indicada, en la zona de Bogotá. Se usa para rellenar con
 * ceros los buckets sin pedidos (un día sin ventas no es un hueco: es un 0).
 *
 * @returns {string[]}  `["2026-09-01", "2026-09-02", ...]` (day) o
 *                       `["2026-07", "2026-08", ...]` (month).
 */
export const enumerateBuckets = (from, to, granularity) => {
  const buckets = [];

  if (granularity === "month") {
    const startYmd = bogotaDateString(from);
    let year = Number(startYmd.slice(0, 4));
    let month = Number(startYmd.slice(5, 7));
    const endKey = bogotaDateString(to).slice(0, 7);

    for (let guard = 0; guard < 1200; guard += 1) {
      const key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
      buckets.push(key);
      if (key === endKey) break;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return buckets;
  }

  let cursor = bogotaDateString(from);
  const endKey = bogotaDateString(to);
  for (let guard = 0; guard < 4000; guard += 1) {
    buckets.push(cursor);
    if (cursor === endKey) break;
    // Ancla al mediodía para que sumar un día nunca caiga en el día anterior.
    const next = new Date(`${cursor}T12:00:00.000${BOGOTA_OFFSET}`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = bogotaDateString(next);
  }
  return buckets;
};
