import { Router } from "express";
import { createUser } from "../controllers/user.controller.js";
import { loginUser, renewToken } from "../controllers/auth.controllers.js";
import authenticationUser from "../middleware/autentication.middleware.js";

const router = Router();

router.post('/login', loginUser );

router.post('/register', createUser);

router.get('/renew-token', authenticationUser, renewToken);

export default router;