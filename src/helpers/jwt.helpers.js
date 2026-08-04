import jwt from "jsonwebtoken";

const generarToken = (payload) => {
  return jwt.sign(payload, "REDACTED_HISTORICAL_JWT_SECRET", { expiresIn: "7d" });
};

const validateToken = (token) => {
  try {
    return jwt.verify(token, "REDACTED_HISTORICAL_JWT_SECRET");
  } catch (error) {
    console.error(error);
    return null;
  }
};

export { generarToken, validateToken };
