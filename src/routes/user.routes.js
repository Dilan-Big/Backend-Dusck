import { Router } from "express";
import { createUser, deleteUserById, getUser, getUserById, updateUserById } from "../controllers/user.controller.js";
import autenticationUser from "../middleware/autentication.middleware.js";
import { isAdmin, verifyUserPermission } from "../middleware/role.middleware.js";

const router = Router();

router.post('/', createUser);
router.get('/', autenticationUser, isAdmin, getUser);
router.get('/:id', autenticationUser, verifyUserPermission, getUserById);
router.patch('/:id', autenticationUser, verifyUserPermission, updateUserById);
router.delete('/:id', autenticationUser, isAdmin, deleteUserById);

export default router;