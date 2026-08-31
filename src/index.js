import { env } from './config/env.config.js';
import dbConection from './config/mongo.config.js';

import app from './app.js';

dbConection();

app.listen(env.port, ()=>{
    console.log (`Servidor lansado en http://localhost:${env.port}`)
});
