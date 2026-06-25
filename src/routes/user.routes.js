import { Router } from "express";
import { createUser, deleteUserById, getUser, getUserById, updateUserById } from "../controllers/user.controller.js";

const router = Router();

router.post('/', createUser);

router.get('/',getUser);

router.get('/:id',getUserById);

router.patch('/:id', updateUserById);

router.delete('/:id', deleteUserById);

export default router;