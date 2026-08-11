import express from 'express';
import cors from 'cors';

import dbConection from './config/mongo.config.js';

import authRoutes from './routes/authentication.routes.js';
import userRoutes from './routes/user.routes.js';

import categoryRoutes from './routes/category.routes.js'
import productRoutes from './routes/product.routes.js'
import roleRoutes from './routes/role.routes.js'
import cartRoutes from './routes/cart.routes.js'


const app = express();

app.use(express.json());
app.use( cors() );

dbConection();

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


app.listen(3000, ()=>{
    console.log ("Servidor lansado en http://localhost:3000")
});