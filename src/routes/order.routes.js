import { Router } from "express";

import {
  createOrderController,
  listOrdersController,
  getOrderByIdController,
  updateOrderStatusController,
  updateOrderPaymentController,
} from "../controllers/order.controller.js";
import autenticationUser, {
  authenticateOptionalStrict,
} from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

// FASE 4.3-C — Órdenes.
//
// POST /  (F4.3-C.1) — checkout COD. Invitado o usuario autenticado
//   (authenticateOptionalStrict); token presente pero inválido -> 401. Sin rol.
//
// GET  /     (F4.3-C.3.1) — listado administrativo de pedidos FINALIZADOS, SOLO
//   LECTURA. Requiere sesión (autenticationUser) y rol administrativo u
//   operativo (authorizationUser) — misma convención que las rutas admin de
//   cart/category. `editor`, `subscriber` e invitado quedan fuera.
//
// GET  /:id  (F4.3-C.3.2) — detalle administrativo de UNA orden FINALIZADA por
//   su `_id`, SOLO LECTURA. Misma política de auth/rol que el listado.
const router = Router();

router.post("/", authenticateOptionalStrict, createOrderController);

router.get(
  "/",
  autenticationUser,
  authorizationUser(["administrador", "shop_manager"]),
  listOrdersController,
);

router.get(
  "/:id",
  autenticationUser,
  authorizationUser(["administrador", "shop_manager"]),
  getOrderByIdController,
);

// PATCH /:id/status  (UI-5.1) — transición del ciclo de vida del pedido
//   (pending_confirmation -> confirmed -> ready_to_ship -> shipped -> delivered,
//   y cancelación desde los 3 estados previos al despacho). Misma política de
//   auth/rol que el listado y el detalle. La máquina de estados
//   (`orderWorkflow.helper.js`) revalida el rol por transición: la guarda de
//   ruta es la primera línea, no la única.
router.patch(
  "/:id/status",
  autenticationUser,
  authorizationUser(["administrador", "shop_manager"]),
  updateOrderStatusController,
);

// PATCH /:id/payment  (UI-5.1) — estado del cobro COD (pending -> paid | failed).
//   Eje independiente de `status`. Nunca accesible a invitado ni usuario normal.
router.patch(
  "/:id/payment",
  autenticationUser,
  authorizationUser(["administrador", "shop_manager"]),
  updateOrderPaymentController,
);

export default router;
