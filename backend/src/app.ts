import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { errorHandler } from './middlewares/error-handler.js';
import { alertRoutes } from './routes/alert.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { notFound } from './shared/http-error.js';
import { env } from './config/env.js';

const app = express();

// An explicit origin, because a wildcard is illegal alongside credentials. The
// SPA must send `credentials: 'include'` on every /auth call or it will get a
// token and silently drop the cookie.
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));

app.use(express.json());

// Must precede the /auth router: without it `req.cookies` is undefined, and
// reading a property off undefined is a 500 where a 401 was wanted.
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
  });
});

app.use('/auth', authRoutes);
app.use('/alerts', alertRoutes);

// Forwarded as an error so an unknown path gets the same body shape as every
// other failure.
app.use((req, _res, next) => {
  next(notFound(`cannot ${req.method} ${req.path}`));
});

// Must stay last: Express reaches a 4-argument handler only by falling through
// everything in front of it.
app.use(errorHandler);

export { app };
