import express from 'express';
import { errorHandler } from './middlewares/error-handler.js';
import { notFound } from './shared/http-error.js';

// Importing the config is what validates the environment, so a bad variable
// fails the boot rather than the first request.
import './config/env.js';

const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
  });
});

// app.use('/alerts', alertRoutes);  <- Phase 2 (docs/alerts-crud-plan.md)

// Forwarded as an error so an unknown path gets the same body shape as every
// other failure.
app.use((req, _res, next) => {
  next(notFound(`cannot ${req.method} ${req.path}`));
});

// Must stay last: Express reaches a 4-argument handler only by falling through
// everything in front of it.
app.use(errorHandler);

export { app };
