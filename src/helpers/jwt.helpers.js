import jwt from "jsonwebtoken";

import { env } from "../config/env.config.js";

const generateToken = (payload) => {
    return jwt.sign(payload, env.jwtSecret, { expiresIn: '1h' });
}


const validateToken = (token) => {
    try {
      return jwt.verify(token, env.jwtSecret);

    } catch (error) {
        // Solo el tipo/mensaje del error, nunca el secreto ni el token.
        console.error(`JWT invalido -> ${error.name}: ${error.message}`);
        return null
    }

}

export {generateToken, validateToken};
