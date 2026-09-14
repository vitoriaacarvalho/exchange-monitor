import { Router } from 'express';
import * as alertController from '../controllers/alert.controller.js';
import { requireAuth } from '../middlewares/require-auth.js';
import { validate } from '../middlewares/validate.js';
import {
  alertIdParamSchema,
  createAlertSchema,
  listAlertsQuerySchema,
  updateAlertSchema,
} from '../schemas/alert.schema.js';

const router = Router();

// Every alert belongs to someone, so there is no public route to exempt.
router.use(requireAuth);

router.post('/', validate({ body: createAlertSchema }), alertController.create);
router.get('/', validate({ query: listAlertsQuerySchema }), alertController.list);
router.get('/:id', validate({ params: alertIdParamSchema }), alertController.getById);
router.patch(
  '/:id',
  validate({ params: alertIdParamSchema, body: updateAlertSchema }),
  alertController.update,
);
router.delete('/:id', validate({ params: alertIdParamSchema }), alertController.remove);

export { router as alertRoutes };
