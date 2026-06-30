import jwt from "jsonwebtoken"

const generateToken = (payload) => {
    return jwt.sign(payload, 'sdfghjkyuu',{expiresIn:'1h'})
}

export {generateToken};