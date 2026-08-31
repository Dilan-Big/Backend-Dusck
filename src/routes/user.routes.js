import { Router } from "express";
import { createUser, deleteUserById, getUser, getUserById, updateUserById, updateUserRole, updateUserStatus } from "../controllers/user.controller.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import { requireAdmin, verifyUserPermission } from "../middleware/role.middleware.js";

const router = Router();

// Crear usuario (solo administrador)
router.post('/', autenticationUser, requireAdmin, createUser);

// Obtener todos los usuarios (solo administrador)
router.get('/', autenticationUser, requireAdmin, getUser);

// Obtener un usuario por ID (solo administrador)
router.get('/:id', autenticationUser, requireAdmin, getUserById);

// Cambiar el rol de un usuario (solo administrador)
router.patch('/:id/role', autenticationUser, requireAdmin, updateUserRole);

// Activar / desactivar un usuario (solo administrador)
router.patch('/:id/status', autenticationUser, requireAdmin, updateUserStatus);

// Actualizar el perfil propio (dueño o administrador) - sin campos de privilegios
router.patch('/:id', autenticationUser,  verifyUserPermission, updateUserById);


// Eliminar un usuario (solo administrador)
router.delete('/:id', autenticationUser, requireAdmin, deleteUserById);

export default router;
