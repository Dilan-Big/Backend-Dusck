import express from 'express';

import authRoutes from './routes/authentication.routes.js';

import userRoutes from './routes/user.routes.js';

const app = express();

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

