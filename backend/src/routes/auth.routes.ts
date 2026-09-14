import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { credentialsLimiter, refreshLimiter } from '../middlewares/rate-limit.js';
import { requireAuth } from '../middlewares/require-auth.js';
import { validate } from '../middlewares/validate.js';
import { loginSchema, registerSchema } from '../schemas/auth.schema.js';

const router = Router();

router.post(
  '/register',
  credentialsLimiter,
  validate({ body: registerSchema }),
  authController.register,
);
router.post('/login', credentialsLimiter, validate({ body: loginSchema }), authController.login);
router.post('/refresh', refreshLimiter, authController.refresh);

// Deliberately not behind `requireAuth`. The usual reason to log out is an
// access token that expired while the tab sat open, and answering that with a
// 401 would leave the session alive server-side. The cookie is the credential.
router.post('/logout', authController.logout);

router.get('/me', requireAuth, authController.me);

export { router as authRoutes };
