import jwt from "jsonwebtoken"

const generarToken = (payload) => {
    return jwt.sign(payload, 'jhvyt76',{expiresIn:'1h'} )
}
   
export {
    generarToken
}