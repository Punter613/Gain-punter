const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  // Fail fast at boot rather than silently signing/verifying tokens with a
  // hardcoded, publicly-known fallback secret at request time.
  throw new Error('[Auth] JWT_SECRET is not set. Refusing to start in production without it.');
}

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // For now, if no token and in development, we might allow it or just mock it
    // But for a hardened foundation, we should at least check for its existence
    // NOTE: NODE_ENV is often undefined in basic environments, so we also check if it's NOT 'production'
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Auth] Non-production mode: Skipping token verification');
      return next();
    }
    return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ success: false, error: 'Invalid token' });
  }
}

module.exports = verifyToken;
