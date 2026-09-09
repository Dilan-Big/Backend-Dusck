import { getDashboardData } from "../services/dashboard.service.js";
import { resolveRange } from "../helpers/dashboard.helper.js";

// UI-5.3 — GET /api/dashboard (panel de indicadores administrativo).
//
// Adapter HTTP puro: valida/normaliza `req.query` vía `resolveRange` (jamás
// `{ ...req.query }`), delega TODO el cálculo en `dashboard.service.js` y
// devuelve el contrato estándar `{ msg, data }`. NO consulta Mongo aquí.
//
// Auth/rol: los aplica la ruta (`autenticationUser` +
// `authorizationUser(["administrador","shop_manager"])`), misma política que
// `GET /api/orders`. NO se crea ningún rol ni permiso nuevo.
//
// Contrato de `data`:
//   range              { from, to, timezone: "America/Bogota", granularity: "day"|"month" }
//   summary.today      { ordersCount, salesTotal }                 pedidos NO cancelados creados HOY (Bogotá)
//   summary.period     { ordersCount, salesTotal, averageTicket }  pedidos NO cancelados del rango
//   summary.collectedRevenue.period                                 Σ grandTotal con payment.status = "paid"
//   summary.currency   "COP"
//   salesSeries[]      { bucket, ordersCount, salesTotal }         un bucket por día/mes del rango (ceros incluidos)
//   orders.total       nº de pedidos finalizados del rango (todos los estados)
//   orders.byStatus    { <cada uno de los 8 estados>: nº }         zero-filled
//   topProducts[]      { productId, productName, slug, unitsSold, salesTotal }   top 5 del rango, sin canceladas
//   inventory          { totalProducts, publishedProducts, lowStock, outOfStock, lowStockThreshold }
//   alerts[]           { code, severity: "warn"|"danger", count, message }       solo alertas activas
//
// Estados vacíos (0 pedidos / 0 ventas / 0 productos vendidos) NO son error:
// se devuelven contadores en 0 y `salesSeries` con todos los buckets a 0.

const getDashboardController = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const data = await getDashboardData(range);
    return res.status(200).json({
      msg: "Panel de indicadores",
      data,
    });
  } catch (error) {
    if (error && error.isDashboardQueryError) {
      return res.status(400).json({ msg: error.message });
    }
    console.error(`[dashboard.controller] ${error && error.name}`);
    return res.status(500).json({ msg: "No se pudo obtener el panel de indicadores" });
  }
};

export { getDashboardController };
