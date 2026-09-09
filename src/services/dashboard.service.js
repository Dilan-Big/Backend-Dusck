import OrderModel from "../models/order.model.js";
import ProductModel from "../models/product.model.js";
import {
  ORDER_STATUS,
  ORDER_STATUSES,
  ORDER_CURRENCY,
  PAYMENT_STATUS,
} from "../helpers/orderWorkflow.helper.js";
import { PRODUCT_STATUS } from "../helpers/productWorkflow.helper.js";
import {
  BOGOTA_TZ,
  DASHBOARD_LOW_STOCK_THRESHOLD,
  DASHBOARD_STALE_PENDING_HOURS,
  bogotaToday,
  enumerateBuckets,
} from "../helpers/dashboard.helper.js";

// UI-5.3 — Dashboard Service (solo lectura).
//
// Capa de dominio para los AGREGADOS del panel de indicadores. Consulta
// DIRECTAMENTE los modelos existentes (`OrderModel`, `ProductModel`) — nunca vía
// HTTP interno ni reimplementando reglas de negocio. NO muta nada. Recibe un
// rango YA validado por `dashboard.helper.js::resolveRange` (el controller no
// construye filtros con `req.query` en crudo).
//
// Todas las cifras monetarias son enteros COP (contrato F4.2). "Ventas" = suma
// de `totals.grandTotal` de órdenes FINALIZADAS y NO CANCELADAS (reserva de
// venta al momento del checkout COD); `collectedRevenue` es el eje aparte del
// efectivo ya confirmado (`payment.status === "paid"`).
//
// Optimización: NUNCA se cargan colecciones completas. Todo es `$group` / `$count`
// acotado por `$match` sobre índices existentes:
//   { finalized, createdAt }  -> pipeline de órdenes del período y de hoy
//   { status, isActive }      -> alerta de producto agotado
// Las 6 consultas son independientes -> `Promise.all`.

// Órdenes que cuentan como venta: cualquier estado MENOS cancelada.
const NON_CANCELLED = { $ne: ORDER_STATUS.CANCELLED };

// --- Pipeline principal: órdenes finalizadas dentro del rango ---------------
// Un solo `$match` inicial (indexado) + `$facet` con las 6 vistas que salen del
// mismo conjunto de documentos.
const buildPeriodPipeline = (from, to, granularity) => {
  const dateFormat = granularity === "month" ? "%Y-%m" : "%Y-%m-%d";
  return [
    { $match: { finalized: true, createdAt: { $gte: from, $lte: to } } },
    {
      $facet: {
        // Ventas brutas del período (excluye canceladas).
        summaryPeriod: [
          { $match: { status: NON_CANCELLED } },
          {
            $group: {
              _id: null,
              salesTotal: { $sum: "$totals.grandTotal" },
              ordersCount: { $sum: 1 },
            },
          },
        ],
        // Efectivo ya cobrado (eje independiente de `status`).
        collected: [
          { $match: { "payment.status": PAYMENT_STATUS.PAID } },
          { $group: { _id: null, total: { $sum: "$totals.grandTotal" } } },
        ],
        // Total de pedidos del período (TODOS los estados, incl. cancelados).
        totalOrders: [{ $count: "n" }],
        // Pedidos agrupados por estado (TODOS los estados).
        byStatus: [{ $group: { _id: "$status", n: { $sum: 1 } } }],
        // Serie temporal de ventas (excluye canceladas). Corte de día/mes en
        // la zona local de Bogotá.
        series: [
          { $match: { status: NON_CANCELLED } },
          {
            $group: {
              _id: {
                $dateToString: { format: dateFormat, date: "$createdAt", timezone: BOGOTA_TZ },
              },
              ordersCount: { $sum: 1 },
              salesTotal: { $sum: "$totals.grandTotal" },
            },
          },
        ],
        // Productos más vendidos (unidades). Usa el SNAPSHOT de `items[]`
        // (`productName`/`slug` congelados) -> resistente a productos borrados;
        // NO hace `$lookup` a la colección de productos.
        topProducts: [
          { $match: { status: NON_CANCELLED } },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.productId",
              unitsSold: { $sum: "$items.quantity" },
              salesTotal: { $sum: "$items.subtotal" },
              productName: { $first: "$items.productName" },
              slug: { $first: "$items.slug" },
            },
          },
          { $sort: { unitsSold: -1, salesTotal: -1 } },
          { $limit: 5 },
        ],
      },
    },
  ];
};

// --- Pipeline del día de HOY (Bogotá) --------------------------------------
// Separado del `$facet` a propósito: "hoy" puede quedar FUERA del rango elegido
// por el usuario, así que se calcula con su propio `$match` indexado.
const buildTodayPipeline = () => {
  const { start, end } = bogotaToday();
  return [
    {
      $match: {
        finalized: true,
        status: NON_CANCELLED,
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        salesTotal: { $sum: "$totals.grandTotal" },
        ordersCount: { $sum: 1 },
      },
    },
  ];
};

// --- Pipeline de inventario ----------------------------------------------
// Excluye ARCHIVED (retirado del catálogo, no es inventario "vivo"). `stock` es
// el agregado que el modelo ya mantiene (derivado de variantes cuando las hay).
const buildInventoryPipeline = () => [
  { $match: { status: { $ne: PRODUCT_STATUS.ARCHIVED } } },
  {
    $group: {
      _id: null,
      totalProducts: { $sum: 1 },
      publishedProducts: {
        $sum: { $cond: [{ $eq: ["$status", PRODUCT_STATUS.PUBLISHED] }, 1, 0] },
      },
      outOfStock: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } },
      lowStock: {
        $sum: {
          $cond: [
            {
              $and: [
                { $gt: ["$stock", 0] },
                { $lte: ["$stock", DASHBOARD_LOW_STOCK_THRESHOLD] },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  },
];

/**
 * Construye el payload completo del dashboard para un rango YA validado.
 *
 * @param {{from: Date, to: Date, granularity: "day"|"month", timezone: string}} range
 * @returns {Promise<object>}  contrato descrito en `dashboard.controller.js`.
 */
export const getDashboardData = async ({ from, to, granularity, timezone }) => {
  const staleThreshold = new Date(
    Date.now() - DASHBOARD_STALE_PENDING_HOURS * 3_600_000,
  );

  const [periodAgg, todayAgg, inventoryAgg, stalePending, deliveredUnpaid, publishedOutOfStock] =
    await Promise.all([
      OrderModel.aggregate(buildPeriodPipeline(from, to, granularity)),
      OrderModel.aggregate(buildTodayPipeline()),
      ProductModel.aggregate(buildInventoryPipeline()),
      OrderModel.countDocuments({
        finalized: true,
        status: ORDER_STATUS.PENDING_CONFIRMATION,
        createdAt: { $lt: staleThreshold },
      }),
      OrderModel.countDocuments({
        finalized: true,
        status: ORDER_STATUS.DELIVERED,
        "payment.status": { $ne: PAYMENT_STATUS.PAID },
      }),
      ProductModel.countDocuments({
        status: PRODUCT_STATUS.PUBLISHED,
        isActive: true,
        stock: { $lte: 0 },
      }),
    ]);

  const facet = periodAgg[0] || {};
  const periodRow = facet.summaryPeriod?.[0] || { salesTotal: 0, ordersCount: 0 };
  const collectedRevenue = facet.collected?.[0]?.total || 0;
  const totalOrders = facet.totalOrders?.[0]?.n || 0;
  const todayRow = todayAgg[0] || { salesTotal: 0, ordersCount: 0 };

  // byStatus: los 8 estados SIEMPRE presentes, rellenados con 0.
  const byStatus = {};
  for (const status of ORDER_STATUSES) byStatus[status] = 0;
  for (const row of facet.byStatus || []) {
    if (row && row._id != null && Object.prototype.hasOwnProperty.call(byStatus, row._id)) {
      byStatus[row._id] = row.n;
    }
  }

  // salesSeries: un bucket por día/mes del rango, con ceros donde no hubo ventas.
  const seriesByBucket = new Map((facet.series || []).map((r) => [r._id, r]));
  const salesSeries = enumerateBuckets(from, to, granularity).map((bucket) => {
    const hit = seriesByBucket.get(bucket);
    return {
      bucket,
      ordersCount: hit ? hit.ordersCount : 0,
      salesTotal: hit ? hit.salesTotal : 0,
    };
  });

  const topProducts = (facet.topProducts || []).map((r) => ({
    productId: r._id != null ? String(r._id) : null,
    productName: r.productName ?? null,
    slug: r.slug ?? null,
    unitsSold: r.unitsSold ?? 0,
    salesTotal: r.salesTotal ?? 0,
  }));

  const inv = inventoryAgg[0] || {
    totalProducts: 0,
    publishedProducts: 0,
    lowStock: 0,
    outOfStock: 0,
  };

  const periodSales = periodRow.salesTotal || 0;
  const periodCount = periodRow.ordersCount || 0;
  const averageTicket = periodCount > 0 ? Math.round(periodSales / periodCount) : 0;

  const alerts = [];
  if (stalePending > 0) {
    alerts.push({
      code: "stale_pending_confirmation",
      severity: "warn",
      count: stalePending,
      message: `${stalePending} pedido(s) llevan más de ${DASHBOARD_STALE_PENDING_HOURS} h sin confirmar`,
    });
  }
  if (deliveredUnpaid > 0) {
    alerts.push({
      code: "delivered_unpaid",
      severity: "warn",
      count: deliveredUnpaid,
      message: `${deliveredUnpaid} pedido(s) entregados sin pago registrado`,
    });
  }
  if (publishedOutOfStock > 0) {
    alerts.push({
      code: "published_out_of_stock",
      severity: "danger",
      count: publishedOutOfStock,
      message: `${publishedOutOfStock} producto(s) publicados y activos están agotados`,
    });
  }

  return {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone,
      granularity,
    },
    summary: {
      today: {
        ordersCount: todayRow.ordersCount || 0,
        salesTotal: todayRow.salesTotal || 0,
      },
      period: {
        ordersCount: periodCount,
        salesTotal: periodSales,
        averageTicket,
      },
      collectedRevenue: { period: collectedRevenue },
      currency: ORDER_CURRENCY,
    },
    salesSeries,
    orders: { total: totalOrders, byStatus },
    topProducts,
    inventory: {
      totalProducts: inv.totalProducts || 0,
      publishedProducts: inv.publishedProducts || 0,
      lowStock: inv.lowStock || 0,
      outOfStock: inv.outOfStock || 0,
      lowStockThreshold: DASHBOARD_LOW_STOCK_THRESHOLD,
    },
    alerts,
  };
};
