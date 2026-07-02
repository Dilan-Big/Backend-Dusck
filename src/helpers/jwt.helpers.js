import jwt from "jsonwebtoken"

const generateToken = (payload) => {
    return jwt.sign(payload, 'sdfghjkyuu',{expiresIn:'1h'});
}




const validadeToken = (token) => { 
    try {
      return jwt.verify(token, 'sdfghjkyuu');
        
    } catch (error) {
        console.error(error)
        return null
    }
    
}

export {generateToken, validadeToken};