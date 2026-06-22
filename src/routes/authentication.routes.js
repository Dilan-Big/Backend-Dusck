import { Router } from "express";

const router = Router();

router.post('/login', (req, res) => {
    res.json({
        msg: "Se genera logeo"
    });
});

router.post('/register', (req, res) => {
    res.json({
        msg: "Registro publico de usuarios"
    });
});

router.get('/renew-token', (req, res) => {
    res.json({
        msg: "Renovar Token"
    });
});

export default router;