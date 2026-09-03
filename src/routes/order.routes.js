import { Router } from "express";

import {
  createOrderController,
  listOrdersController,
  getOrderByIdController,
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

export default router;
