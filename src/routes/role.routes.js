import { Router } from "express";
import getRoles from "../controllers/roles.controllers.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

router.get(
    '/',
    autenticationUser,
    authorizationUser(['administrador']),
    getRoles
);

export default router;