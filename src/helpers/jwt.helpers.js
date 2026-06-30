import jwt from "jsonwebtoken"

const generarToken = (payload) => {
    return jwt.sign(payload, 'REDACTED_HISTORICAL_JWT_SECRET',{expiresIn:'1h'} )
}
   
export {
    generarToken
}