import { Router } from "express";

import { getDashboardController } from "../controllers/dashboard.controller.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

// UI-5.3 — Dashboard administrativo.
//
// GET /  — panel de indicadores (agregados de solo lectura sobre pedidos e
//   inventario). Requiere sesión (`autenticationUser`) y rol administrativo u
//   operativo (`authorizationUser`), EXACTAMENTE la misma política que
//   `GET /api/orders` (el dashboard son agregados de esos mismos pedidos). Sin
//   roles ni permisos nuevos. `invitado` / `editor` / `subscriber` quedan fuera.
const router = Router();

router.get(
  "/",
  autenticationUser,
  authorizationUser(["administrador", "shop_manager"]),
  getDashboardController,
);

export default router;
