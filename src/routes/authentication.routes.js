import { Router } from "express";
import { createUser } from "../controllers/user.controller.js";
import { loginUser } from "../controllers/auth.controllers.js";

const router = Router();

router.post('/login', loginUser);

router.post('/register', createUser);

router.get('/renew-token', (req, res) => {
    res.json({
        msg: "Renovar Token"
    });
});

export default router;