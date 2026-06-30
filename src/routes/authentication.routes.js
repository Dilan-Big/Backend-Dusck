import { Router } from "express";
import { createUser } from "../controllers/user.controller.js";

const router = Router();

router.post('/login', (req, res) => {
    res.json({
        msg: "Se genera logeo"
    });
});

router.post('/register', createUser);

router.get('/renew-token', (req, res) => {
    res.json({
        msg: "Renovar Token"
    });
});

export default router;