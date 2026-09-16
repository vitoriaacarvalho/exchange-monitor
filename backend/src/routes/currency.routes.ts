import { Router } from 'express';
import * as currencyController from '../controllers/currency.controller.js';
import { requireAuth } from '../middlewares/require-auth.js';
import { validate } from '../middlewares/validate.js';
import { currencyPairParamSchema } from '../schemas/currency.schema.js';

const router = Router();

// Every call spends quota that belongs to this account, so an open route is a
// free drain for anyone who finds the host.
router.use(requireAuth);

// No extra rate limiter: the cache is the quota's real defence, and a logged-in
// user hammering one pair costs one upstream call a day.
router.get('/:pair', validate({ params: currencyPairParamSchema }), currencyController.getPair);

export { router as currencyRoutes };
