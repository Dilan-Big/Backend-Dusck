import { Router } from "express";
import { createUser, deleteUserById, getUser, getUserById, updateUserById } from "../controllers/user.controller.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import { isAdmin, verifyUserPermission } from "../middleware/role.middleware.js";
import authorizationUser from "../middleware/authorizationUser.middelware.js";

const router = Router();

// Crear usuario (solo administrador)
router.post('/', autenticationUser, authorizationUser(['administrador']), createUser);

// Obtener todos los usuarios (solo administrador)
router.get('/', autenticationUser, authorizationUser(['administrador']), getUser);

// Obtener un usuario por ID (solo administrador)
router.get('/:id', autenticationUser, authorizationUser(['administrador']), getUserById);

// Actualizar un usuario
router.patch('/:id', autenticationUser,  verifyUserPermission, updateUserById);


// Eliminar un usuario (solo administrador)
router.delete('/:id', autenticationUser, authorizationUser(['administrador']), deleteUserById);

export default router;