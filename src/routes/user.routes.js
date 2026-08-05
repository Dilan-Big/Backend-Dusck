import { Router } from "express";
import { createUser, deleteUserById, getUser, getUserById, updateUserById } from "../controllers/user.controller.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import { isAdmin, verifyUserPermission } from "../middleware/role.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

router.post('/', [autenticationUser, authorizationUser(['administrador'])], createUser);
router.get('/', [autenticationUser, authorizationUser(['administrador'])], getUser);
router.get('/:id', [autenticationUser, authorizationUser(['administrador'])], getUserById);
router.patch('/:id', [autenticationUser, authorizationUser(['administrador'])], verifyUserPermission, updateUserById);
router.delete('/:id', [autenticationUser, authorizationUser(['administrador'])], isAdmin, deleteUserById);

export default router;