import express from 'express';
import cors from 'cors';

import { guardNoSqlInjection } from './middleware/mongoSanitize.middleware.js';

import authRoutes from './routes/authentication.routes.js';
import userRoutes from './routes/user.routes.js';

import categoryRoutes from './routes/category.routes.js'
import productRoutes from './routes/product.routes.js'
import roleRoutes from './routes/role.routes.js'
import cartRoutes from './routes/cart.routes.js'

// App Express ya configurada, SIN abrir conexion a Mongo ni escuchar puerto.
// El arranque real (conexion + listen) vive en index.js; asi los tests de
// seguridad pueden montar la app contra una base de datos de prueba.
const app = express();

app.use(express.json());
app.use( cors() );

// FASE 2 / S4: defensa global contra operadores MongoDB enviados en req.body.
// Se ejecuta despues de parsear el JSON y antes de cualquier ruta.
app.use(guardNoSqlInjection);

app.get('/health',(req, res)=>{
    res.json({
        msg:'Servidor en funcionamiento'
    });
});

app.use('/api/auth',authRoutes);
app.use('/api/users',userRoutes);
app.use('/api/category', categoryRoutes);
app.use('/api/product', productRoutes)
app.use('/api/cart',cartRoutes);
app.use('/api/roles',roleRoutes);

export default app;
