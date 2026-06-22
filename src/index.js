import express from 'express';

const app = express();

app.get('/health',(req, res)=>{
    res.json({
        msg:'Servidor en funcionamiento'
    });
});

app.listen(3000, ()=>{
    console.log ("Servidor lansado en http://localhost:3000")
});

