import express from 'express';

import dbConection from './config/mongo.config.js';

import authRoutes from './routes/authentication.routes.js';
import userRoutes from './routes/user.routes.js';

const app = express();

dbConection();

app.get('/health',(req, res)=>{
    res.json({
        msg:'Servidor en funcionamiento'
    });
});

app.use('/api/auth',authRoutes);
app.use('/api/users',userRoutes);

app.listen(3000, ()=>{
    console.log ("Servidor lansado en http://localhost:3000")
});

