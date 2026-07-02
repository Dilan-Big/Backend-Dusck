import jwt from "jsonwebtoken"

const generateToken = (payload) => {
    return jwt.sign(payload, 'REDACTED_HISTORICAL_JWT_SECRET',{expiresIn:'1h'});
}




const validadeToken = (token) => { 
    try {
      return jwt.verify(token, 'REDACTED_HISTORICAL_JWT_SECRET');
        
    } catch (error) {
        console.error(error)
        return null
    }
    
}

export {generateToken, validadeToken};